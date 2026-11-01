// Voice conversation with Claude Code, run on the bundled engine: the same
// listening as the aglink desktop app (desktop/frontend/src/voice.svelte.js),
// carried over to Node with the engine's mic in place of the WebView's.
//
// - While voice is on, the engine's mic streams 50 ms pieces. With the
//   conversation off they go to the wake listener, which cuts them into short
//   pieces and looks for "아글링크" at the start of each; with it on they go to
//   the recorder, which ends a clip at a pause and has it recognised.
// - A clip is only taken if it sounds like the enrolled voice (ECAPA, scored
//   here against the embedding saved at enrollment), is not quiet talk from
//   across the room, and is not our own reading coming back through the
//   speakers. Then it is either a voice command ("더 천천히 말해 줘") or sent
//   to Claude Code with send().
// - Claude Code's answer comes back through onReply() (the Stop hook) and is
//   read aloud — a spoken summary of it — after which the mic opens again.
//
// Nothing here knows VS Code: standalone.js gives it the engine, the settings,
// a store for what it learns, and send().
"use strict";

const { EventEmitter } = require("events");
const T = require("./text");
const A = require("./audio");

const CHUNK_MS = 50; // the engine's mic pieces
const CONV_SILENCE_STOP_MS = 2200; // room for "음…" mid-sentence pauses
const EARLY_STOP_MS = 800; // with fast recognition a pause this long is tried as the end
const ECHO_TAIL_MS = 1000; // speech starting this soon after the reading may be its tail
const CONV_NO_SPEECH_MS = 20000; // the mic is re-opened after this much silence
const CONV_RETRY_MS = 5000;
const NOISE_LEARN_MS = 400;
const MIN_THRESHOLD = 0.012;
const BARGE_SEGMENT_MS = 700;
const BARGE_MAX_SEGMENT_MS = 3000;
const BARGE_MIN_SPEECH_MS = 400;
const BARGE_MIN_LOUD_CHUNKS = 8; // ~0.4 s above the echo floor
const BARGE_PREROLL_CHUNKS = 14;
const MAX_CLIP_MS = 60000;
const PREROLL_MS = 300;
const ENROLL_MS = 15000;
const ENROLL_MIN_S = 5;
const SPEAKER_MIXED_DROP = 0.1;
const SPEAKER_SHORT_S = 1.2;
const QUIET_RATIO = 0.4; // under this share of the user's level = far away
const QUIET_EXTRA_BAR = 0.15;
// A clip of at least ADAPT_SECONDS scoring ADAPT_MIN is surely the user, so
// the enrolled voice is nudged toward it — as long as it still matches the
// enrollment itself (ANCHOR_MIN). Same as the desktop's speaker_server.py.
const ADAPT_MIN = 0.6;
const ADAPT_SECONDS = 2.0;
const ADAPT_WEIGHT = 0.1;
const ANCHOR_MIN = 0.45;
const WAKE_SEGMENT_END_MS = 600;
const WAKE_MAX_SEGMENT_MS = 4000;
const WAKE_MIN_SPEECH_MS = 300;
const WAKE_MIN_LOUD_CHUNKS = 5;
const WAKE_PREROLL_CHUNKS = 5;
const WAKE_PAD_S = 0.4;
// The echo floor: the mic level our voice alone makes is the reading's
// loudness envelope times a room gain learned while it plays.
const REF_BEFORE_MS = 450; // speaker + mic latency
const REF_AFTER_MS = 100;
const ECHO_MARGIN = 2.5;
const ANSWER_WAIT_MS = 15 * 60000; // an answer never reported stops holding the mic after this
const FLASH_MS = 2500;
const SPEED_RANGE = [0.7, 2.0];
const DEFAULT_SPEED = 0.98;

const quote = (text, n = 40) => {
  const s = String(text || "");
  return `"${s.length > n ? `${s.slice(0, n)}…` : s}"`;
};

class Conversation extends EventEmitter {
  // engine: Engine (core/engine.js) or a stand-in with call() and on().
  // settings: get() → {voice, speed, speakerMin, listenMode, wakeIdleMin,
  //   summary, wakeNames, wakeDefault, stopWords, stopDefault, textOnly, readTyped, barge}; set(patch).
  // store: get(key) / set(key, value) for what is learned (the enrolled
  //   voice, the user's level, the room's echo gain), kept across restarts.
  // send(text) → Promise<{ok, error}>: hands the words to Claude Code.
  constructor({ engine, settings, store, send, newConversation = async () => {}, log = () => {}, now = Date.now }) {
    super();
    this.engine = engine;
    this.settings = settings;
    this.store = store;
    this.sendText = send;
    this.openNewConversation = newConversation;
    this.log = log;
    this.now = now;

    this.on_ = false; // voice is on
    this.conv = false; // in conversation (the mic takes what is said)
    this.phase = "idle"; // idle | listening | transcribing
    this.speaking = false;
    this.enrolling = false;
    this.heard = ""; // what was sent, shown while the answer is awaited
    this.problem = "";
    this.flashText = "";
    this.level = 0;

    this.rec = null;
    this.wake = null;
    this.enrollBuf = null;
    this.resumeTimer = null;
    this.flashTimer = null;
    this.awaiting = null; // timer while Claude Code's answer is awaited
    this.convActiveAt = 0;
    this.textOnce = false; // the next answer is shown, not read ("글로만 보여 줘")

    this.gen = now(); // bumped by stopSpeaking to abandon a reading; the engine drops older ones
    this.replyText = ""; // what is (or was last) read aloud
    this.readingEndedAt = -Infinity;
    this.lastReply = "";
    this.detailHinted = false;
    this.playRefs = [];
    this.echoRatios = [];
    this.echoGain = store.get("echoGain") || null;
    this.userLevel = store.get("userLevel") || { level: 0, n: 0 };

    engine.on("mic", (m) => this.onFrame(A.pcmToFloat(m.pcm)));
    engine.on("micError", (m) => this.onMicError(m.error));
    engine.on("status", () => this.render());
  }

  get s() {
    return this.settings.get();
  }

  get fast() {
    return this.engine.whisper === "gpu";
  }

  // ---- on / off ----

  // start turns voice on: with the wake word it waits for "아글링크", otherwise
  // the conversation starts at once.
  async start() {
    if (this.on_) return;
    this.on_ = true;
    await this.engine.call("mic", { on: true });
    if (this.s.listenMode === "wake") {
      this.log(`waiting for ${quote(T.wakeNameLabel(this.s))}`);
      this.render();
    } else this.startConversation();
  }

  stop() {
    if (!this.on_) return;
    this.endConversation();
    this.on_ = false;
    this.wake = null;
    this.engine.call("mic", { on: false }).catch(() => {});
    this.render();
  }

  get isOn() {
    return this.on_;
  }

  startConversation() {
    if (!this.on_ || this.conv) return;
    this.conv = true;
    this.wake = null;
    this.convActiveAt = this.now();
    this.render();
    this.startRecording();
  }

  // endConversation goes back to waiting for the wake word; without one
  // ("manual") voice goes off altogether.
  endConversation(note = "") {
    const was = this.conv;
    this.conv = false;
    this.heard = "";
    this.problem = "";
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    clearTimeout(this.awaiting);
    this.awaiting = null;
    if (this.rec) this.stopRecording(false);
    this.stopSpeaking();
    if (note) this.flash(note);
    this.render();
    if (was && this.on_ && this.s.listenMode === "manual") this.emit("off");
  }

  // ---- what the status bar shows ----

  flash(text) {
    this.flashText = text;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashText = "";
      this.render();
    }, FLASH_MS);
    this.render();
  }

  state() {
    let phase = "off";
    let label = "음성 꺼짐";
    if (!this.on_ && this.speaking) [phase, label] = ["speaking", "답변을 읽는 중"]; // a typed question's answer
    if (this.on_) {
      if (this.problem) [phase, label] = ["problem", this.problem];
      else if (this.flashText) [phase, label] = ["note", this.flashText];
      else if (this.enrolling) [phase, label] = ["listening", "목소리 등록 중"];
      else if (this.phase === "listening") [phase, label] = ["listening", "듣는 중 — 말씀하세요"];
      else if (this.phase === "transcribing") [phase, label] = ["transcribing", "알아듣는 중"];
      else if (this.speaking) [phase, label] = ["speaking", "답변을 읽는 중"];
      else if (this.awaiting) [phase, label] = ["waiting", this.heard ? `${quote(this.heard, 20)} 답변 기다리는 중` : "답변 기다리는 중"];
      else if (this.conv) [phase, label] = ["conversation", "대화 중"];
      else [phase, label] = ["wake", `“${T.wakeNameLabel(this.s)}” 부르면 들어요`];
    }
    return { on: this.on_, conv: this.conv, phase, label, whisper: this.engine.whisper };
  }

  render() {
    this.emit("state", this.state());
  }

  // ---- the mic ----

  onMicError(error) {
    this.log(`mic failed: ${error}`);
    if (!this.on_) return;
    this.problem = "마이크를 다시 여는 중…";
    this.render();
    setTimeout(async () => {
      if (!this.on_) return;
      try {
        await this.engine.call("mic", { on: false });
        await this.engine.call("mic", { on: true });
        this.problem = "";
      } catch (e) {
        this.problem = `마이크를 열 수 없어요: ${e.message}`;
      }
      this.render();
    }, CONV_RETRY_MS);
  }

  onFrame(x) {
    if (!this.on_) return;
    const level = A.rms(x);
    this.level = Math.min(1, level * 12);
    const now = this.now();
    if (this.enrollBuf) {
      this.enrollBuf.push(x);
      return;
    }
    if (this.rec) {
      this.recFrame(this.rec, x, level, now);
      return;
    }
    if (this.wakeWanted()) this.wakeFrame(x, level, now);
    else this.wake = null;
  }

  wakeWanted() {
    return this.on_ && this.s.listenMode !== "manual" && !this.conv && this.phase === "idle" && !this.enrolling && !this.speaking;
  }

  // ---- the user's level and the voice check ----

  learnUserLevel(level) {
    if (!(level > 0)) return;
    const n = Math.min(this.userLevel.n + 1, 30); // a moving average over ~30 clips
    this.userLevel = { level: this.userLevel.level + (level - this.userLevel.level) / n, n };
    this.store.set("userLevel", this.userLevel);
  }

  forgetUserLevel() {
    this.userLevel = { level: 0, n: 0 };
    this.store.set("userLevel", this.userLevel);
  }

  isQuiet(level) {
    return level > 0 && this.userLevel.n >= 1 && level < this.userLevel.level * QUIET_RATIO;
  }

  speakerMinFor(mixed) {
    return mixed ? Math.max(0.05, this.s.speakerMin - SPEAKER_MIXED_DROP) : this.s.speakerMin;
  }

  get enrolled() {
    return !!this.store.get("speaker");
  }

  // speakerScore: how much a clip sounds like the enrolled user, -1 if no
  // voice is enrolled or the check failed.
  async speakerScore(wav) {
    const sp = this.store.get("speaker");
    if (!sp || !wav) return -1;
    let e;
    try {
      e = (await this.engine.call("embed", { wav: wav.toString("base64") })).embedding;
    } catch {
      return -1;
    }
    const score = A.cosine(e, sp.ref);
    if (score >= ADAPT_MIN && A.clipSeconds(wav) >= ADAPT_SECONDS && A.cosine(e, sp.base) >= ANCHOR_MIN) {
      const r = A.normalize(sp.ref);
      const n = A.normalize(e);
      this.store.set("speaker", { base: sp.base, ref: A.normalize(r.map((v, i) => (1 - ADAPT_WEIGHT) * v + ADAPT_WEIGHT * n[i])) });
    }
    return Math.round(score * 1000) / 1000;
  }

  isUserVoice(score, min) {
    return score < 0 || score >= min;
  }

  async transcribe(wav) {
    return String((await this.engine.call("transcribe", { wav: wav.toString("base64") })).text || "").trim();
  }

  // ---- the echo floor ----

  noteEchoRatio(r) {
    this.echoRatios.push(r);
    if (this.echoRatios.length > 300) this.echoRatios.shift();
    if (this.echoRatios.length >= 20 && this.echoRatios.length % 10 === 0) {
      const sorted = [...this.echoRatios].sort((a, b) => a - b);
      this.echoGain = sorted[Math.floor(sorted.length * 0.5)];
      this.store.set("echoGain", this.echoGain);
    }
  }

  refLevel(now) {
    let level = 0;
    for (const ref of this.playRefs) {
      const t = now - ref.startAt;
      if (ref.endAt && now > ref.endAt + REF_BEFORE_MS) continue;
      const from = Math.max(0, Math.floor((t - REF_BEFORE_MS) / A.REF_FRAME_MS));
      const to = Math.min(ref.env.length - 1, Math.floor((t + REF_AFTER_MS) / A.REF_FRAME_MS));
      for (let i = from; i <= to; i++) if (ref.env[i] > level) level = ref.env[i];
    }
    return level;
  }

  addPlayRef(wav) {
    const now = this.now();
    this.playRefs = this.playRefs.filter((r) => !(r.endAt && now > r.endAt + 2000));
    const env = A.wavEnvelope(wav);
    if (!env) return null;
    const ref = { startAt: now, endAt: now + env.length * A.REF_FRAME_MS, env };
    this.playRefs.push(ref);
    return ref;
  }

  // ---- recording ----
  //
  // A barge-in recording runs while a reply is read (when barge-in is on): it
  // cuts the audio into short segments and checks each — our own voice coming
  // back is dropped, anything else is the user talking over the reading, which
  // stops it. Once the reading ends the same recording carries on as a normal
  // one, with what the user already said kept as its prefix.

  startRecording(barge = false) {
    if (!barge) {
      this.stopSpeaking();
      if (this.rec) this.stopRecording(false); // a barge-in recorder the reading left behind
    }
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (!this.conv || this.enrolling) return;
    if (barge && (this.rec || !this.speaking)) return;
    if (!barge) this.heard = "";
    const now = this.now();
    this.rec = {
      chunks: [],
      first: -1, // index of the first loud chunk
      loud: 0,
      speechSum: 0, // RMS summed over the loud chunks: how loudly this was said
      lastSpeechAt: 0,
      firstSpeechAt: 0,
      noise: 0,
      noiseN: 0,
      startedAt: now,
      learnedUntil: now + NOISE_LEARN_MS,
      barge,
      prefix: "", // what the user said over the reading
      earlyFor: 0, // lastSpeechAt of the pause already tried as the end
      checks: Promise.resolve(), // segment checks in flight
      stopped: false,
    };
    if (!barge) this.phase = "listening";
    this.render();
  }

  resetSegment(rec) {
    rec.chunks = [];
    rec.first = -1;
    rec.loud = 0;
    rec.speechSum = 0;
  }

  recFrame(rec, x, level, now) {
    rec.chunks.push(x);
    if (now < rec.learnedUntil) {
      rec.noise = (rec.noise * rec.noiseN + level) / (rec.noiseN + 1);
      rec.noiseN++;
      return;
    }
    if (rec.barge && !this.speaking) {
      // The reading is over: from here on this is an ordinary recording. A
      // segment still open is mostly the reading itself, so it is checked
      // like any other rather than carried over.
      if (rec.first >= 0 && rec.lastSpeechAt - rec.firstSpeechAt >= BARGE_MIN_SPEECH_MS && rec.loud >= BARGE_MIN_LOUD_CHUNKS)
        this.checkBargeSegment(rec, this.takeClip(rec), rec.speechSum / rec.loud);
      this.resetSegment(rec);
      rec.barge = false;
      rec.startedAt = now;
      this.phase = "listening";
      this.render();
    }
    // While our own voice plays, only sound well above the echo it makes counts.
    const ref = this.refLevel(now);
    if (ref > 0.01) this.noteEchoRatio(level / ref);
    const echoFloor = this.echoGain !== null ? this.echoGain * ref * ECHO_MARGIN : 0;
    const threshold = Math.max(MIN_THRESHOLD, rec.noise * 3, echoFloor);
    if (level > threshold) {
      if (rec.first < 0) {
        rec.first = rec.chunks.length - 1;
        rec.firstSpeechAt = now;
      }
      rec.lastSpeechAt = now;
      rec.loud++;
      rec.speechSum += level;
    }
    if (rec.barge) {
      // The reading rarely pauses long enough to end a segment, so one is also
      // cut after a few seconds.
      const ended = now - rec.lastSpeechAt > BARGE_SEGMENT_MS || now - rec.firstSpeechAt > BARGE_MAX_SEGMENT_MS;
      if (rec.first >= 0 && ended) {
        if (rec.lastSpeechAt - rec.firstSpeechAt >= BARGE_MIN_SPEECH_MS && rec.loud >= BARGE_MIN_LOUD_CHUNKS)
          this.checkBargeSegment(rec, this.takeClip(rec), rec.speechSum / rec.loud);
        this.resetSegment(rec);
      } else if (rec.first < 0 && rec.chunks.length > BARGE_PREROLL_CHUNKS) {
        rec.chunks.splice(0, rec.chunks.length - BARGE_PREROLL_CHUNKS);
      }
      return;
    }
    if (rec.first >= 0 && this.fast && now - rec.lastSpeechAt > EARLY_STOP_MS && rec.earlyFor !== rec.lastSpeechAt) this.tryEarlyStop(rec);
    if (rec.first >= 0 && now - rec.lastSpeechAt > CONV_SILENCE_STOP_MS) this.stopRecording(true);
    else if (rec.first < 0 && rec.prefix && now - Math.max(rec.lastSpeechAt, rec.startedAt) > CONV_SILENCE_STOP_MS) this.stopRecording(true);
    else if (rec.first < 0 && now - rec.startedAt > CONV_NO_SPEECH_MS) {
      this.stopRecording(false);
      if (!this.endIfIdle()) this.resumeListening(0);
    } else if (rec.first < 0 && rec.chunks.length > BARGE_PREROLL_CHUNKS) {
      rec.chunks.splice(0, rec.chunks.length - BARGE_PREROLL_CHUNKS); // nothing said yet: keep only the pre-roll
    } else if (now - rec.startedAt > MAX_CLIP_MS) this.stopRecording(true);
  }

  // endIfIdle: with the wake word on, a conversation nobody talks in goes back
  // to waiting for "아글링크". Only the user's own words that were kept (and
  // answers) count as talk, so a noisy room whose clips are all dropped still
  // times out.
  endIfIdle() {
    const s = this.s;
    if (s.listenMode !== "wake" || s.wakeIdleMin <= 0 || this.awaiting) return false;
    if (this.now() - this.convActiveAt <= s.wakeIdleMin * 60000) return false;
    this.log("conversation idle → waiting for the wake word");
    this.endConversation();
    return true;
  }

  // takeClip encodes the audio from just before the first speech.
  takeClip(rec) {
    const from = Math.max(0, rec.first - Math.ceil(PREROLL_MS / CHUNK_MS));
    return A.encodeWav(A.concat(rec.chunks.slice(from)));
  }

  // tryEarlyStop recognises the clip at a short pause; a finished sentence is
  // sent at once instead of after the full silence wait.
  tryEarlyStop(rec) {
    const at = rec.lastSpeechAt;
    rec.earlyFor = at;
    const wav = this.takeClip(rec);
    void (async () => {
      await rec.checks;
      let text = "";
      try {
        text = await this.transcribe(wav);
      } catch {
        return;
      }
      if (this.rec !== rec || rec.lastSpeechAt !== at || !T.SENTENCE_END_RE.test(text) || T.GOES_ON_RE.test(text)) return;
      this.log(`early end ${quote(text)}`);
      this.stopRecording(true, text);
    })();
  }

  // checkBargeSegment decides whether a segment heard during the reading was
  // the user or our own voice, one at a time. A quiet segment needs a clearly
  // matching voice and less of a word match to be taken for the echo.
  checkBargeSegment(rec, wav, level) {
    rec.checks = rec.checks.then(async () => {
      if (this.rec !== rec && !rec.stopped) return;
      let text = "";
      let score = -1;
      try {
        [text, score] = await Promise.all([this.transcribe(wav), this.speakerScore(wav)]);
      } catch {
        return;
      }
      if (!text || (this.rec !== rec && !rec.stopped)) return;
      const quiet = this.isQuiet(level);
      if (!this.isUserVoice(score, this.speakerMinFor(true) + (quiet ? QUIET_EXTRA_BAR : 0))) {
        this.log(`other voice dropped (barge, ${score.toFixed(2)}, level ${level.toFixed(3)}${quiet ? " quiet" : ""}) ${quote(text)}`);
        return;
      }
      if (T.BARGE_HUSH_RE.test(text)) {
        this.log(`barge-in hush ${quote(text)}`);
        this.stopSpeaking();
        return;
      }
      if (T.stopMatch(text, this.s)) {
        this.log(`barge-in stop ${quote(text)}`);
        this.endConversation("음성 대화를 끝냈어요");
        return;
      }
      if (T.isEcho(text, this.replyText, quiet ? 0.4 : T.ECHO_OVERLAP)) {
        this.log(`echo dropped${quiet ? " (quiet)" : ""} ${quote(text)}`);
        return;
      }
      this.log(`barge-in ${quote(text)} (echo gain ${this.echoGain?.toFixed(3) ?? "unlearned"}, voice ${score.toFixed(2)})`);
      this.stopSpeaking();
      rec.prefix = rec.prefix ? `${rec.prefix} ${text}` : text;
      rec.lastSpeechAt = this.now();
    });
  }

  // heard is the clip's text when tryEarlyStop already has it.
  stopRecording(transcribe, heard = null) {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.stopped = transcribe; // a segment check still in flight may add to the prefix
    this.level = 0;
    if (!transcribe || (rec.first < 0 && !rec.prefix)) {
      this.phase = "idle";
      this.render();
      return;
    }
    const wav = rec.first >= 0 ? this.takeClip(rec) : null;
    void this.transcribeClip(wav, rec, heard);
  }

  // transcribeClip sends what was said: the barge-in prefix (once its checks
  // are done) followed by the clip, either of which may be missing.
  async transcribeClip(wav, rec = null, known = null) {
    this.phase = "transcribing";
    this.render();
    let relisten = false;
    let retry = false;
    try {
      if (rec) await rec.checks;
      const scoring = wav ? this.speakerScore(wav) : Promise.resolve(-1);
      let heard = known ?? (wav ? await this.transcribe(wav) : "");
      const score = await scoring;
      const level = rec && rec.loud > 0 ? rec.speechSum / rec.loud : 0;
      const quiet = this.isQuiet(level);
      const bar = this.speakerMinFor(A.clipSeconds(wav) < SPEAKER_SHORT_S) + (quiet ? QUIET_EXTRA_BAR : 0);
      if (heard && quiet && score < 0) {
        this.log(`quiet dropped (level ${level.toFixed(3)}) ${quote(heard)}`);
        this.flash("소리가 작아서 넘겼어요");
        heard = "";
      } else if (heard && !this.isUserVoice(score, bar)) {
        this.log(`other voice dropped (${score.toFixed(2)}, level ${level.toFixed(3)}${quiet ? " quiet" : ""}) ${quote(heard)}`);
        this.flash(quiet ? "소리가 작아서 넘겼어요" : "다른 목소리라 넘겼어요");
        heard = "";
      } else if (heard && score >= 0) {
        this.log(`voice ${score.toFixed(2)} level ${level.toFixed(3)} ${quote(heard, 20)}`);
        if (score >= this.s.speakerMin + QUIET_EXTRA_BAR) this.learnUserLevel(level);
      }
      // whisper writes a back-and-forth as "- 그쵸. - 네.": people talking in
      // the room or on TV, not a request.
      if (heard && (heard.match(T.DIALOGUE_RE) || []).length >= 2) {
        this.log(`dialogue dropped ${quote(heard)}`);
        heard = "";
      }
      // A clip that is just the reply read back through the speakers is never
      // sent. Speech starting as the reading ends is most likely its tail. A
      // clip clearly in the enrolled voice, or a voice command, is never taken
      // for the echo: the user often says back words the reply just used.
      const tail = rec && rec.firstSpeechAt - this.readingEndedAt < ECHO_TAIL_MS;
      const trusted = score >= 0 && score >= this.s.speakerMin + T.ECHO_TRUST_MARGIN;
      if (heard && this.replyText && !trusted && !T.parseCommand(heard) && !T.stopMatch(heard, this.s)) {
        const thr = tail ? 0.4 : T.ECHO_OVERLAP;
        const kept = T.sentencesOf(heard).filter((x) => !((tail || T.normalizeForEcho(x).length >= 6) && T.isEcho(x, this.replyText, thr)));
        const rest = kept.join("").trim();
        if (rest !== heard) this.log(`echo dropped${tail ? " (tail)" : ""} ${quote(heard)} kept ${quote(rest)}`);
        heard = rest;
      }
      const text = [rec?.prefix, heard].filter(Boolean).join(" ");
      if (!text || !this.conv) {
        relisten = true;
        return;
      }
      if (T.stopMatch(text, this.s)) {
        this.log("stop");
        this.endConversation("음성 대화를 끝냈어요");
        return;
      }
      this.convActiveAt = this.now();
      if (await this.runCommand(text)) {
        this.log(`command ${quote(text)}`);
        relisten = true;
        return;
      }
      await this.send(text);
    } catch (error) {
      this.log(`transcribe failed: ${error?.message || error}`);
      this.flash("음성 인식에 실패했어요");
      retry = true;
    } finally {
      this.phase = "idle";
      this.render();
      if (this.conv && relisten) {
        if (!this.endIfIdle()) this.resumeListening(0);
      } else if (this.conv && retry) this.resumeListening(CONV_RETRY_MS);
    }
  }

  // resumeListening opens the mic again once the reading is over.
  resumeListening(delay = 200) {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.conv || this.rec || this.enrolling || this.awaiting) return;
      if (this.speaking || this.phase !== "idle") {
        this.resumeListening(300);
        return;
      }
      this.startRecording();
    }, delay);
  }

  // ---- Claude Code ----

  async send(text) {
    this.log(`to Claude Code ${quote(text)}`);
    this.heard = text;
    this.textOnce = T.ONCE_TEXT_RE.test(text);
    clearTimeout(this.awaiting);
    this.awaiting = setTimeout(() => {
      this.awaiting = null;
      this.heard = "";
      this.log("the answer never came");
      this.render();
      this.resumeListening(0);
    }, ANSWER_WAIT_MS);
    this.render();
    let res;
    try {
      res = await this.sendText(text);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (res && res.ok) {
      this.flash("💻 Claude Code 로 보냈어요");
      return;
    }
    clearTimeout(this.awaiting);
    this.awaiting = null;
    this.heard = "";
    this.log(`send failed: ${res?.error}`);
    void this.speak((res && res.error) || "Claude Code 로 보내지 못했어요.", "full"); // the mic opens again after it
  }

  // onReply is Claude Code's finished turn (the Stop hook). Only the answer to
  // what was said here is read: the hook reports every turn, typed ones too.
  onReply(md) {
    const text = String(md || "").trim();
    if (!this.conv || !this.awaiting || !text) return false;
    clearTimeout(this.awaiting);
    this.awaiting = null;
    this.heard = "";
    this.convActiveAt = this.now();
    this.log("Claude Code answered");
    void this.speakReply(text);
    this.textOnce = false;
    this.render();
    this.resumeListening(); // text only: nothing is read, so the mic opens now
    return true;
  }

  // ---- wake word ----

  wakeFrame(x, level, now) {
    let w = this.wake;
    if (!w) {
      w = this.wake = { chunks: [], first: -1, firstAt: 0, lastAt: 0, loud: 0, noise: 0, noiseN: 0, learnedUntil: now + NOISE_LEARN_MS, busy: false };
    }
    w.chunks.push(x);
    if (now < w.learnedUntil) {
      w.noise = (w.noise * w.noiseN + level) / (w.noiseN + 1);
      w.noiseN++;
      return;
    }
    if (level > Math.max(MIN_THRESHOLD, w.noise * 3)) {
      if (w.first < 0) {
        w.first = w.chunks.length - 1;
        w.firstAt = now;
      }
      w.lastAt = now;
      w.loud++;
    } else if (w.first < 0) {
      w.noise = w.noise * 0.98 + level * 0.02; // follow a slowly changing room, not the talking
    }
    if (w.first < 0) {
      if (w.chunks.length > WAKE_PREROLL_CHUNKS) w.chunks.splice(0, w.chunks.length - WAKE_PREROLL_CHUNKS);
      return;
    }
    if (now - w.lastAt > WAKE_SEGMENT_END_MS || now - w.firstAt > WAKE_MAX_SEGMENT_MS) {
      const long = w.lastAt - w.firstAt >= WAKE_MIN_SPEECH_MS && w.loud >= WAKE_MIN_LOUD_CHUNKS;
      const from = Math.max(0, w.first - WAKE_PREROLL_CHUNKS);
      // A bit of silence after the word: Whisper often returns nothing for a
      // lone short word that runs to the very end of the clip.
      const wav = long && !w.busy ? A.encodeWav(A.concat([...w.chunks.slice(from), new Float32Array(Math.round(A.RATE * WAKE_PAD_S))])) : null;
      w.chunks = [];
      w.first = -1;
      w.loud = 0;
      if (wav) void this.checkWake(w, wav);
    }
  }

  // checkWake looks for the name in one piece; one at a time, so a noisy room
  // cannot queue up recognitions. The voice check goes first: it is cheaper.
  async checkWake(w, wav) {
    w.busy = true;
    try {
      const score = await this.speakerScore(wav);
      if (!this.isUserVoice(score, this.speakerMinFor(A.clipSeconds(wav) < SPEAKER_SHORT_S))) {
        this.log(`wake: other voice (${score.toFixed(2)})`);
        return;
      }
      const text = await this.transcribe(wav);
      if (!text || this.wake !== w) return;
      const end = T.wakeMatch(text, this.s);
      if (end < 0) {
        this.log(`wake: not the name ${quote(text, 20)}`);
        return;
      }
      const rest = text.slice(end).replace(T.WAKE_TAIL_RE, "").trim();
      this.log(`wake ${score >= 0 ? `${score.toFixed(2)} ` : ""}${quote(text)}`);
      await this.wakeUp(rest);
    } catch (err) {
      this.log(`wake check failed: ${err?.message || err}`);
    } finally {
      w.busy = false;
    }
  }

  // wakeUp starts the conversation; what was said after the name in the same
  // breath ("아글링크, 오늘 할 일 정리해 줘") is sent right away.
  async wakeUp(rest) {
    if (!this.on_ || this.conv || this.phase !== "idle") return;
    this.conv = true;
    this.wake = null;
    this.convActiveAt = this.now();
    this.render();
    await this.playChime();
    if (rest.length >= 2) {
      await this.transcribeClip(null, null, rest);
      return;
    }
    void this.speak("네, 말씀하세요.", "full"); // the mic opens as the reading goes, as after any reply
  }

  async playChime() {
    try {
      await this.play(A.chimeWav(), this.gen);
    } catch (err) {
      this.log(`chime failed: ${err?.message || err}`);
    }
  }

  // ---- reading aloud ----

  speechMode() {
    return this.s.summary ? "short" : "gist";
  }

  stopSpeaking() {
    const cut = this.now();
    for (const ref of this.playRefs) if (ref.endAt > cut) ref.endAt = cut;
    this.engine.call("stop", { gen: this.gen }).catch(() => {});
    this.gen++;
    if (this.speaking) {
      this.speaking = false;
      this.render();
    }
  }

  async play(wav, gen) {
    if (gen !== this.gen) return;
    const ref = this.addPlayRef(wav);
    try {
      await this.engine.call("play", { wav: wav.toString("base64"), gen });
    } finally {
      if (ref && ref.endAt > this.now()) ref.endAt = this.now();
    }
  }

  synthesize(sentence) {
    const s = this.s;
    return this.engine.call("tts", { text: sentence, voice: s.voice, speed: s.speed }).then((r) => Buffer.from(r.wav, "base64"));
  }

  // speak reads md's spoken summary (mode "short" / "gist") or all of it
  // ("full"), sentence by sentence, the next one made while one plays.
  async speak(md, mode = this.speechMode(), tail = "") {
    const text = [T.speechText(md, mode), tail].filter(Boolean).join(" ");
    if (!text) return;
    this.stopSpeaking();
    const gen = this.gen;
    const sentences = T.splitSentences(text);
    this.replyText = text;
    this.speaking = true; // covers the first synthesis, so the mic waits
    this.render();
    // A recording with nothing said yet is stopped, so it does not take in the whole reading.
    const rec = this.rec;
    if (rec && !rec.barge && rec.first < 0 && !rec.prefix) this.stopRecording(false);
    if (this.conv && !this.enrolling) {
      if (this.s.barge && !this.rec && this.phase === "idle") this.startRecording(true);
      else if (!this.rec) this.resumeListening(); // taking turns: the mic opens after the reading
    }
    try {
      let next = this.synthesize(sentences[0]);
      for (let i = 0; i < sentences.length && gen === this.gen; i++) {
        let wav = null;
        try {
          wav = await next;
        } catch (err) {
          this.log(`reading skipped a sentence: ${err?.message || err}`); // not the rest of the reply
        }
        next = i + 1 < sentences.length ? this.synthesize(sentences[i + 1]) : null;
        if (next) next.catch(() => {});
        if (wav) await this.play(wav, gen);
      }
    } catch (err) {
      this.log(`reading failed: ${err?.message || err}`);
    } finally {
      if (gen === this.gen) {
        this.speaking = false;
        this.readingEndedAt = this.now();
        this.render();
      }
    }
  }

  // readTyped reads the answer to a question typed into Claude Code, when the
  // readTyped setting asks for it. Voice may be off (the engine then only
  // reads); with voice on, not over something being heard or awaited.
  readTyped(md) {
    const text = String(md || "").trim();
    const hearing = this.rec && (this.rec.first >= 0 || this.rec.prefix); // an open mic with nothing said yet is no reason to wait
    if (!text || !this.s.readTyped || this.awaiting || hearing || this.phase === "transcribing" || this.enrolling) return false;
    this.log("typed question answered");
    void this.speakReply(text, true);
    return true;
  }

  // speakReply reads an answer's summary. textOnly is for answers to spoken
  // questions; a typed question's answer (typed) is read because readTyped asked.
  speakReply(md, typed = false) {
    this.lastReply = md;
    if (!typed && (this.s.textOnly || this.textOnce)) {
      this.log("answer shown as text only");
      this.flash("📄 답변은 글로만 보여 드려요");
      return;
    }
    let tail = "";
    if (this.s.summary && !this.detailHinted) {
      const cut = T.speechText(md, "full").length > T.speechText(md, this.speechMode()).length + T.CUT_MARGIN;
      if (cut) {
        this.detailHinted = true;
        tail = "자세히 들으시려면 자세히 읽어 줘, 라고 하세요.";
      }
    }
    return this.speak(md, this.speechMode(), tail);
  }

  speakAgain(mode = this.speechMode()) {
    if (!this.lastReply) return this.speak("아직 읽어 드린 답변이 없어요.", "full");
    return this.speak(this.lastReply, mode);
  }

  // say reads one of our own short sentences whole.
  say(text) {
    return this.speak(text, "full");
  }

  // preview reads a sample in the current voice and speed.
  preview() {
    return this.say(`안녕하세요. ${T.voiceLabel(this.s.voice)} 목소리예요. 이 빠르기로 읽어 드릴게요.`);
  }

  // ---- voice commands ----

  changeSpeed(delta) {
    const before = this.s.speed;
    const speed = delta === null ? DEFAULT_SPEED : Math.round(T.clamp(before + delta, SPEED_RANGE) * 100) / 100;
    if (speed === before && delta !== null) return this.say(delta < 0 ? "지금이 가장 느린 빠르기예요." : "지금이 가장 빠른 빠르기예요.");
    this.settings.set({ speed });
    this.log(`speed ${before} → ${speed}`);
    return this.say("이 빠르기로 읽을게요.");
  }

  // runCommand carries out text if it is one of the commands; false means it
  // goes to Claude Code.
  async runCommand(text) {
    const s = this.s;
    const c = T.parseCommand(text, s.voice);
    if (!c) return false;
    switch (c.kind) {
      case "wakeName": {
        if (!c.name) {
          void this.say("부를 이름은 두 글자에서 여덟 글자로 정해 주세요.");
          break;
        }
        if (!c.set && !s.wakeNames.includes(c.name) && s.wakeNames.length >= T.MAX_WAKE_NAMES) {
          void this.say(`부르는 이름은 ${T.MAX_WAKE_NAMES}개까지 정할 수 있어요. 설정에서 하나를 지운 뒤에 말씀해 주세요.`);
          break;
        }
        const names = T.cleanWakeNames(c.set ? [c.name] : [...s.wakeNames, c.name]);
        await this.settings.set({ wakeNames: names });
        this.log(`wake names → ${names.join(", ")}`);
        void this.say(`이제 ${c.name}, 라고 부르시면 깨어날게요.${s.wakeDefault ? " 아글링크라고 부르셔도 계속 돼요." : ""}`);
        break;
      }
      case "listen":
        await this.settings.set({ listenMode: c.mode });
        void this.say(c.mode === "always" ? "이제 음성을 켜면 바로 듣고 있을게요." : `이제 ${T.wakeNameLabel(this.s)}, 라고 부르실 때만 들을게요.`);
        break;
      case "textOnly":
        await this.settings.set({ textOnly: c.on });
        void this.say(c.on ? "이제 답변은 읽지 않고 글로만 보여 드릴게요. 다시 말로 해 줘, 라고 하시면 읽어 드려요." : "이제 다시 답변을 읽어 드릴게요.");
        break;
      case "read":
        void this.speakAgain(c.mode || this.speechMode());
        break;
      case "unenroll":
        this.store.set("speaker", null);
        this.forgetUserLevel();
        this.log("speaker enrollment cleared");
        void this.say("등록한 목소리를 지웠어요. 이제 들리는 말은 모두 받아요.");
        break;
      case "enroll":
        await this.enroll();
        break;
      case "barge":
        await this.settings.set({ barge: c.on });
        void this.say(c.on ? "끼어들기를 켰어요. 제가 읽는 중에도 말씀하시면 멈추고 들어요." : "주고받기로 바꿨어요. 제가 다 읽은 뒤에 말씀해 주세요.");
        break;
      case "hush":
        this.stopSpeaking();
        break;
      case "speed":
        void this.changeSpeed(c.delta);
        break;
      case "newConversation":
        try {
          await this.openNewConversation();
          void this.say("새 대화를 열었어요. 말씀하세요.");
        } catch (e) {
          this.log(`new conversation failed: ${e.message}`);
          void this.say("새 대화를 열지 못했어요.");
        }
        break;
      case "voice":
        if (!c.name) {
          void this.say("어떤 목소리로 바꿀지 못 알아들었어요. 남자 일 번부터 오 번, 여자 일 번부터 오 번 중에서 말씀해 주세요.");
          break;
        }
        await this.settings.set({ voice: c.name });
        this.log(`voice → ${c.name}`);
        void this.say(`${T.voiceLabel(c.name)} 목소리로 바꿨어요. 이 목소리 어떠세요?`);
        break;
      default:
        return false;
    }
    return true;
  }

  // ---- enrollment ----

  // enroll records ~15 s of the user talking as the voice to listen to;
  // clips that do not sound like it are not sent from then on.
  async enroll() {
    if (!this.on_ || this.enrolling) return false;
    this.enrolling = true;
    if (this.rec) this.stopRecording(false);
    this.render();
    let ok = false;
    try {
      await this.say("지금부터 십오 초 동안 평소 말투로 아무 이야기나 해 주세요. 띵 소리가 나면 시작하세요.");
      await this.playChime();
      this.enrollBuf = [];
      this.render();
      await new Promise((r) => setTimeout(r, ENROLL_MS));
      const samples = A.concat(this.enrollBuf);
      this.enrollBuf = null;
      if (samples.length < A.RATE * ENROLL_MIN_S) {
        void this.say("마이크 소리가 들어오지 않아 등록하지 못했어요.");
        return false;
      }
      const e = (await this.engine.call("embed", { wav: A.encodeWav(samples).toString("base64") })).embedding;
      const n = A.normalize(e);
      this.store.set("speaker", { base: n, ref: n });
      this.forgetUserLevel(); // a new voice (or a new mic spot) is learned afresh
      this.log(`speaker enrolled (${(samples.length / A.RATE).toFixed(1)} s)`);
      void this.say("목소리를 등록했어요. 이제 다른 사람 말은 보내지 않아요. 지우고 싶으면 목소리 등록 해제, 라고 말씀해 주세요.");
      ok = true;
    } catch (err) {
      this.log(`speaker enroll failed: ${err?.message || err}`);
      void this.say("목소리 등록에 실패했어요.");
    } finally {
      this.enrollBuf = null;
      this.enrolling = false;
      this.render();
      this.resumeListening();
    }
    return ok;
  }
}

module.exports = { Conversation, SPEED_RANGE, DEFAULT_SPEED };
