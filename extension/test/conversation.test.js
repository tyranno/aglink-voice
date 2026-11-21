"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");
const { Conversation, bargeOnset } = require("../core/conversation");
const A = require("../core/audio");
const V = require("../core/vocab");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

// FakeEngine answers like the engine: transcribe gives what is "said" (the
// same for every look at the clip), embed the set voice, tts a short clip;
// play takes a moment.
class FakeEngine extends EventEmitter {
  constructor() {
    super();
    this.whisper = "gpu";
    this.calls = [];
    this.text = "";
    this.embedding = null;
  }
  async call(op, args = {}) {
    this.calls.push({ op, ...args });
    switch (op) {
      case "transcribe":
        return { ok: true, text: this.text };
      case "embed":
        return { ok: true, embedding: this.embedding };
      case "tts":
        return { ok: true, wav: A.encodeWav(new Float32Array(1600).fill(0.05)).toString("base64") };
      case "play":
        await sleep(5);
        return { ok: true };
      default:
        return { ok: true };
    }
  }
  ops(op) {
    return this.calls.filter((c) => c.op === op);
  }
}

function frame(amp) {
  const b = Buffer.alloc(1600);
  for (let i = 0; i < 800; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * amp * 32767), i * 2);
  return b.toString("base64");
}

function setup({ settings: over = {}, store: init = {}, vocab } = {}) {
  let clock = 1_000_000;
  const engine = new FakeEngine();
  const values = { voice: "M2", speed: 0.98, speakerMin: 0.4, listenMode: "wake", wakeIdleMin: 3, summary: true, wakeNames: [], wakeDefault: true, textOnly: false, barge: false, ...over };
  const kept = { ...init };
  const sent = [];
  const conv = new Conversation({
    engine,
    settings: { get: () => ({ ...values }), set: async (p) => Object.assign(values, p) },
    store: { get: (k) => kept[k] ?? null, set: (k, v) => (kept[k] = v) },
    send: async (text) => {
      sent.push(text);
      return { ok: true };
    },
    now: () => clock,
    ...(vocab ? { vocab } : {}),
  });
  // feed sends ms of mic audio, 50 ms at a time, letting the checks it starts
  // run. vad is the Silero speech probability the engine would attach to each
  // piece (0 by default, as if the model found no speech).
  async function feed(amp, ms, vad = 0) {
    for (let t = 0; t < ms; t += 50) {
      clock += 50;
      engine.emit("mic", { pcm: frame(amp), vad });
      await tick();
    }
  }
  async function until(cond, what, ms = 2000) {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  }
  return { conv, engine, values, kept, sent, feed, until };
}

test("the wake word starts a conversation, the request is sent, the answer read and 그만 ends it", async () => {
  const { conv, engine, sent, feed, until } = setup();
  await conv.start();
  assert.strictEqual(conv.state().phase, "wake");

  engine.text = "아글링크야, 오늘 할 일 정리해 줘.";
  await feed(0.001, 500); // the room
  await feed(0.2, 800); // "아글링크야, …"
  await feed(0.001, 700);
  await until(() => sent.length === 1, "the request");
  assert.deepStrictEqual(sent, ["오늘 할 일 정리해 줘."]);
  assert.ok(conv.conv);
  assert.strictEqual(engine.ops("play").length, 1, "the chime");
  assert.ok(conv.awaiting, "waits for the answer");

  // Claude Code's answer: read as a short summary, then the mic opens again.
  assert.ok(conv.onReply("네.\n\n할 일을 정리했어요.\n\n- 보고서 쓰기\n- 회의 준비\n\n```js\ncode()\n```"));
  await until(() => !conv.speaking && conv.phase === "listening", "the mic after the reading");
  const read = engine.ops("tts").map((c) => c.text).join(" ");
  assert.match(read, /할 일을 정리했어요/);
  assert.match(read, /보고서 쓰기/);
  assert.doesNotMatch(read, /code/);
  assert.ok(engine.ops("tts").every((c) => c.voice === "M2" && c.speed === 0.98));

  engine.text = "그만";
  await feed(0.001, 500);
  await feed(0.2, 600);
  await feed(0.001, 2400);
  await until(() => !conv.conv, "the end of the conversation");
  assert.strictEqual(conv.state().phase === "wake" || conv.state().phase === "note", true);
  assert.strictEqual(sent.length, 1, "그만 is not sent");
  conv.stop();
});

test("with text only nothing is read: the request still goes, the answer and our own lines show as text", async () => {
  const { conv, engine, sent, feed, until } = setup({ settings: { textOnly: true } });
  await conv.start();
  engine.text = "아글링크야, 오늘 할 일 정리해 줘.";
  await feed(0.001, 500);
  await feed(0.2, 800);
  await feed(0.001, 700);
  await until(() => sent.length === 1, "the request");
  assert.ok(conv.onReply("할 일을 정리했어요."));
  await until(() => conv.phase === "listening", "the mic after the answer");
  assert.match(conv.flashText, /글로만/);
  await conv.say("다시 들을게요. 말씀하세요.");
  assert.strictEqual(conv.flashText, "다시 들을게요. 말씀하세요.");
  assert.strictEqual(engine.ops("tts").length, 0, "nothing synthesized");
  await conv.preview();
  assert.strictEqual(engine.ops("tts").length > 0, true, "a preview asked for is still read");
  conv.stop();
});

test("another voice is not sent once a voice is enrolled", async () => {
  const me = A.normalize([1, 0, 0, 0]);
  const { conv, engine, sent, feed, until } = setup({ settings: { listenMode: "always" }, store: { speaker: { base: me, ref: me } } });
  await conv.start();
  assert.ok(conv.conv);
  engine.embedding = [0, 1, 0, 0]; // someone else
  engine.text = "저녁 뭐 먹을까";
  await feed(0.001, 500);
  await feed(0.2, 1500);
  await feed(0.001, 2400);
  await until(() => engine.ops("transcribe").length >= 1 && conv.phase === "listening", "the next listening");
  await sleep(100);
  assert.deepStrictEqual(sent, []);
  assert.match(conv.flashText, /다른 목소리/);

  engine.embedding = [0.9, 0.1, 0, 0]; // the user
  engine.text = "테스트 돌려 줘";
  await feed(0.001, 500);
  await feed(0.2, 1500);
  await feed(0.001, 2400);
  await until(() => sent.length === 1, "the user's request");
  assert.deepStrictEqual(sent, ["테스트 돌려 줘"]);
  conv.stop();
});

test("a voice command changes the setting instead of going to Claude Code", async () => {
  const { conv, engine, values, sent, feed, until } = setup({ settings: { listenMode: "always" } });
  await conv.start();
  engine.text = "여자 삼 번 목소리로 바꿔 줘";
  await feed(0.001, 500);
  await feed(0.2, 1000);
  await feed(0.001, 2400);
  await until(() => engine.ops("tts").length > 0, "the spoken confirmation");
  assert.strictEqual(values.voice, "F3");
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(engine.ops("tts")[0].voice, "F3");
  assert.match(engine.ops("tts")[0].text, /여자 삼 번 목소리로 바꿨어요/);
  conv.stop();
});

test("a stop for an older reading never cuts the newer one", async () => {
  const { conv, engine } = setup({ settings: { listenMode: "always" } });
  await conv.start();
  const g = conv.gen;
  conv.stopSpeaking();
  const stop = engine.ops("stop").pop();
  assert.strictEqual(stop.gen, g);
  await conv.say("안녕하세요.");
  const play = engine.ops("play").pop();
  assert.ok(play.gen > stop.gen);
  conv.stop();
});

test("a typed question's answer is read only with readTyped, voice off, even with text only", async () => {
  const off = setup({ settings: { readTyped: false } });
  assert.strictEqual(off.conv.readTyped("답이에요."), false);
  assert.strictEqual(off.engine.ops("tts").length, 0);

  const { conv, engine, values, until } = setup({ settings: { readTyped: true, textOnly: true } });
  assert.strictEqual(conv.isOn, false, "voice stays off: no mic");
  assert.ok(conv.readTyped("타이핑한 질문의 답이에요."));
  assert.strictEqual(conv.state().phase, "speaking");
  await until(() => !conv.speaking, "the reading");
  assert.match(engine.ops("tts").map((c) => c.text).join(" "), /타이핑한 질문의 답이에요/);
  assert.strictEqual(engine.ops("mic").length, 0);
  assert.strictEqual(conv.state().phase, "off");

  values.readTyped = false;
  assert.strictEqual(conv.readTyped("또 다른 답."), false);
});

test("with voice on, a typed answer is not read over an answer being awaited", async () => {
  const { conv, engine, until } = setup({ settings: { listenMode: "always", readTyped: true } });
  await conv.start();
  conv.awaiting = setTimeout(() => {}, 1000);
  assert.strictEqual(conv.readTyped("다른 창의 답."), false);
  clearTimeout(conv.awaiting);
  conv.awaiting = null;
  assert.ok(conv.readTyped("이제 읽어요."), "an open mic with nothing said does not hold it");
  await until(() => engine.ops("tts").length > 0, "the reading");
  conv.stop();
});

test("the picked mic opens on start, a new pick reopens it, and blank means Windows' default", async () => {
  const { conv, engine, values } = setup({ settings: { micDevice: "머리에 거는 수화기(S3)" } });
  await conv.start();
  assert.deepStrictEqual(engine.ops("mic").map((c) => [c.on, c.device]), [[true, "머리에 거는 수화기(S3)"]]);

  values.micDevice = "";
  await conv.micDeviceChanged();
  assert.deepStrictEqual(engine.ops("mic").pop(), { op: "mic", on: true, device: "", aec: true });

  conv.stop();
  const before = engine.ops("mic").length;
  values.micDevice = "다른 마이크";
  await conv.micDeviceChanged(); // off: nothing opens now, the next start uses it
  assert.strictEqual(engine.ops("mic").length, before);
});

test("echo cancellation is asked of the engine unless it is switched off", async () => {
  const { conv, engine, values } = setup({});
  await conv.start();
  assert.strictEqual(engine.ops("mic").pop().aec, true);
  values.echoCancel = false;
  await conv.micDeviceChanged();
  assert.strictEqual(engine.ops("mic").pop().aec, false);
});

test("the reading plays on the picked output, and a missing device is logged", async () => {
  const logs = [];
  const { conv, engine } = setup({ settings: { outputDevice: "스피커(2- Realtek(R) Audio)" } });
  conv.log = (m) => logs.push(m);
  await conv.preview();
  const plays = engine.ops("play");
  assert.ok(plays.length >= 1, "the preview played");
  for (const p of plays) assert.strictEqual(p.device, "스피커(2- Realtek(R) Audio)");

  engine.emit("deviceMissing", { kind: "mic", name: "머리에 거는 수화기(S3)" });
  assert.ok(logs.some((m) => /not connected/.test(m) && /S3/.test(m)), logs.join("\n"));
});

test("인식 멈춰 holds everything until 다시 인식해; 마이크 꺼 switches voice off", async () => {
  const { conv, engine, sent, feed, until } = setup({ settings: { listenMode: "always" } });
  const listening = () => until(() => !conv.speaking && conv.phase === "listening", "listening");
  const say = async (text) => {
    await listening();
    engine.text = text;
    await feed(0.001, 700); // the room: the recorder learns the noise first
    await feed(0.2, 800);
    await feed(0.001, 2500);
  };
  await conv.start();
  assert.ok(conv.conv, "always: listening at once");

  await say("인식 멈춰");
  await until(() => conv.paused, "paused");
  await until(() => !conv.speaking, "the confirmation read");
  assert.match(conv.state().label, /인식 멈춤/);

  await say("오늘 할 일 정리해 줘");
  await sleep(50);
  assert.deepStrictEqual(sent, [], "nothing is sent while paused");

  await say("마이크 꺼 줘 그런데"); // not exactly the command: still ignored
  await sleep(50);
  assert.ok(conv.isOn && conv.paused);

  await say("다시 인식해");
  await until(() => !conv.paused, "resumed");

  await say("오늘 할 일 정리해 줘");
  await until(() => sent.length === 1, "sent after resume");
  assert.deepStrictEqual(sent, ["오늘 할 일 정리해 줘"]);

  let off = false;
  conv.on("off", () => (off = true));
  conv.onReply("정리했어요.");
  await until(() => !conv.speaking && conv.phase === "listening", "listening again");
  await say("마이크 꺼");
  await until(() => off, "the off event");
});

test("a quiet speaker's soft speech still counts once their level is known, and recognition gets the clip turned up", async () => {
  const { conv, engine } = setup({ settings: { listenMode: "always" }, store: { userLevel: { level: 0.025, n: 10 } } });
  assert.ok(conv.speechFloor() < 0.012, `floor ${conv.speechFloor()}`);
  assert.ok(conv.speechFloor() >= 0.005);
  const fresh = setup().conv;
  assert.strictEqual(fresh.speechFloor(), 0.012, "unknown level: the fixed floor");

  const quiet = A.encodeWav(new Float32Array(8000).fill(0).map((_, i) => Math.sin(i / 5) * 0.02));
  await conv.transcribe(quiet);
  const sent = Buffer.from(engine.ops("transcribe").pop().wav, "base64");
  let s = 0;
  for (let i = 0; i < 8000; i++) { const v = sent.readInt16LE(44 + i * 2) / 32768; s += v * v; }
  assert.ok(Math.sqrt(s / 8000) > 0.05, "turned up for Whisper");
});

test("a long first sentence is split lead-first at a comma, every piece at full quality", async () => {
  const { conv, engine } = setup();
  conv.onReply("회의 자료를 정리했고요, 팀원들에게 메일로 보냈습니다. 확인해 주세요.");
  await conv.speak("회의 자료를 정리했고요, 팀원들에게 메일로 보냈습니다. 확인해 주세요.", "full");
  const tts = engine.ops("tts").filter((c) => !/아글링크|목소리예요/.test(c.text));
  assert.ok(tts.length >= 3, JSON.stringify(tts.map((c) => c.text)));
  const first = tts.findIndex((c) => c.text === "회의 자료를 정리했고요,");
  assert.ok(first >= 0, "the lead was read on its own");
  for (const c of tts) assert.strictEqual(c.steps, undefined, "no piece uses fewer steps");
});

test("the button says speech is coming in from the first loud sound until the clip is taken", async () => {
  const { conv, engine, sent, feed, until } = setup({ settings: { listenMode: "always" } });
  const seen = [];
  conv.on("state", (st) => seen.push(st));
  await conv.start();
  await until(() => conv.phase === "listening", "the mic");
  await feed(0.001, 500); // the room
  assert.strictEqual(conv.state().hearing, false);

  engine.text = "오늘 할 일 정리해 줘.";
  await feed(0.2, 300);
  assert.strictEqual(conv.state().hearing, true);
  assert.strictEqual(conv.state().label, "말소리 듣는 중");
  await feed(0.2, 500);
  await feed(0.001, 2400);
  await until(() => sent.length === 1, "the request");
  assert.strictEqual(conv.state().hearing, false);
  assert.ok(seen.some((st) => st.hearing), "the change is sent to the button");
  conv.stop();
});

test("a soft voice under the energy gate is still caught by VAD and sent", async () => {
  const { conv, engine, sent, feed, until } = setup({ settings: { listenMode: "always" } });
  engine.text = "조용히 말했어요.";
  await conv.start();
  await until(() => conv.phase === "listening", "the mic");
  await feed(0.001, 500, 0); // the quiet room: below the energy threshold, no speech
  assert.strictEqual(conv.state().hearing, false, "nothing heard yet");
  await feed(0.001, 900, 0.9); // just as quiet, but VAD says it is speech
  assert.strictEqual(conv.state().hearing, true, "VAD marks the soft voice as speech");
  await feed(0.001, 2400, 0); // VAD falls silent: the end-of-speech wait ends the clip
  await until(() => sent.length === 1, "the request");
  assert.deepStrictEqual(sent, ["조용히 말했어요."]);
  conv.stop();
});

test("recFrame uses VAD while listening but ignores it during a barge recording", () => {
  const { conv } = setup({ settings: { listenMode: "always", barge: true } });
  const now = conv.now();
  const mk = (barge) => ({
    chunks: [], first: -1, loud: 0, speechSum: 0, lastSpeechAt: 0, firstSpeechAt: 0,
    noise: 0, noiseN: 0, startedAt: now - 2000, learnedUntil: now - 1000, barge,
    prefix: "", earlyFor: 0, checks: Promise.resolve(), stopped: false,
  });
  const quiet = new Float32Array(800); // below the energy gate
  const lvl = 0.0007;

  const listening = mk(false);
  conv.speaking = false;
  conv.recFrame(listening, quiet, lvl, now, 0.9);
  assert.strictEqual(listening.first, 0, "while listening, a soft but voiced piece counts as speech");

  const barge = mk(true);
  conv.speaking = true; // the reply is being read; the quiet signal is its echo
  conv.recFrame(barge, quiet, lvl, now, 0.9);
  assert.strictEqual(barge.first, -1, "during a barge recording VAD is ignored, so the echo is not speech");
});

test("the user talking over the TV is found in a window of the clip, and only their part is sent", async () => {
  const me = A.normalize([1, 0, 0, 0]);
  const { conv, engine, sent, feed, until } = setup({ settings: { listenMode: "always", speakerMin: 0.5 }, store: { speaker: { base: me, ref: me } } });
  // The voice in a clip is the share of it that is loud (the user, close)
  // against soft (the TV); the words are the TV's plus the user's, or only
  // the user's for a short clip of them.
  const loudShare = (b64) => {
    const w = Buffer.from(b64, "base64");
    const n = (w.length - 44) / 2;
    let loud = 0;
    for (let i = 0; i < n; i += 800) {
      let peak = 0;
      for (let j = i; j < Math.min(n, i + 800); j++) peak = Math.max(peak, Math.abs(w.readInt16LE(44 + j * 2)) / 32767);
      if (peak > 0.3) loud++;
    }
    return loud / Math.ceil(n / 800);
  };
  const call = engine.call.bind(engine);
  engine.call = async (op, args = {}) => {
    if (op === "embed") {
      engine.calls.push({ op });
      const f = loudShare(args.wav);
      return { ok: true, embedding: [f, 1 - f, 0, 0] };
    }
    if (op === "transcribe") {
      engine.calls.push({ op });
      return { ok: true, text: loudShare(args.wav) > 0.6 ? "지금 설치해." : "미래의 먹거리도 신경 써야 돼요. 지금 설치해." };
    }
    return call(op, args);
  };
  await conv.start();
  await until(() => conv.phase === "listening", "the mic");
  await feed(0.001, 500);
  await feed(0.1, 8000); // the TV
  await feed(0.6, 3000); // the user
  await feed(0.001, 2400);
  await until(() => sent.length === 1, "the user's request");
  assert.deepStrictEqual(sent, ["지금 설치해."]);
  conv.stop();
});

test("a long clip that only just passes as a whole but is mostly someone else is not sent", async () => {
  const me = A.normalize([1, 0, 0, 0]);
  const { conv, engine, sent, feed, until } = setup({ settings: { listenMode: "always", speakerMin: 0.5 }, store: { speaker: { base: me, ref: me } } });
  // Two people taking turns, both close: the user loud (0.6), the other a
  // little softer (0.35). The voice is the user's share of the loud chunks.
  const shares = (b64) => {
    const w = Buffer.from(b64, "base64");
    const n = (w.length - 44) / 2;
    let u = 0;
    let o = 0;
    for (let i = 0; i < n; i += 800) {
      let peak = 0;
      for (let j = i; j < Math.min(n, i + 800); j++) peak = Math.max(peak, Math.abs(w.readInt16LE(44 + j * 2)) / 32767);
      if (peak > 0.5) u++;
      else if (peak > 0.2) o++;
    }
    return [u, o];
  };
  const call = engine.call.bind(engine);
  engine.call = async (op, args = {}) => {
    if (op === "embed") {
      engine.calls.push({ op });
      const [u, o] = shares(args.wav);
      return { ok: true, embedding: [u, o, 0, 0] };
    }
    if (op === "transcribe") {
      engine.calls.push({ op });
      return { ok: true, text: "엄마는 바퀴 하게 만들래. 내가 만들 거야." };
    }
    return call(op, args);
  };
  await conv.start();
  await until(() => conv.phase === "listening", "the mic");
  await feed(0.001, 500);
  await feed(0.35, 8000); // someone else
  await feed(0.6, 5000); // the user, 0.53 as a whole: just over the bar
  await feed(0.001, 2400);
  await until(() => engine.ops("embed").length >= 8, "the window check");
  await feed(0.001, 500);
  assert.deepStrictEqual(sent, []);
  conv.stop();
});

test("a long clip that only just passes as a whole, half the user, sends only their part", async () => {
  const me = A.normalize([1, 0, 0, 0]);
  const { conv, engine, sent, feed, until } = setup({ settings: { listenMode: "always", speakerMin: 0.5 }, store: { speaker: { base: me, ref: me } } });
  // Two people taking turns, both close: the user loud (0.6), the other a
  // little softer (0.35). The voice is the user's share of the loud chunks.
  const shares = (b64) => {
    const w = Buffer.from(b64, "base64");
    const n = (w.length - 44) / 2;
    let u = 0;
    let o = 0;
    for (let i = 0; i < n; i += 800) {
      let peak = 0;
      for (let j = i; j < Math.min(n, i + 800); j++) peak = Math.max(peak, Math.abs(w.readInt16LE(44 + j * 2)) / 32767);
      if (peak > 0.5) u++;
      else if (peak > 0.2) o++;
    }
    return [u, o];
  };
  const call = engine.call.bind(engine);
  engine.call = async (op, args = {}) => {
    if (op === "embed") {
      engine.calls.push({ op });
      const [u, o] = shares(args.wav);
      return { ok: true, embedding: [u, o, 0, 0] };
    }
    if (op === "transcribe") {
      engine.calls.push({ op });
      const [u, o] = shares(args.wav);
      return { ok: true, text: o > u ? "엄마는 바퀴 하게 만들래. 지금 설치해." : "지금 설치해." };
    }
    return call(op, args);
  };
  await conv.start();
  await until(() => conv.phase === "listening", "the mic");
  await feed(0.001, 500);
  await feed(0.35, 6500); // someone else
  await feed(0.6, 5500); // the user, 0.65 as a whole: just over the bar
  await feed(0.001, 2400);
  await until(() => sent.length === 1, "the user's request");
  assert.deepStrictEqual(sent, ["지금 설치해."]);
  conv.stop();
});

test("only one early try runs at a time, and one that hears no words drops the noise", async () => {
  const { conv, engine, feed, until } = setup({ settings: { listenMode: "always" } });
  let release;
  let running = 0;
  let most = 0;
  const call = engine.call.bind(engine);
  engine.call = async (op, args = {}) => {
    if (op !== "transcribe") return call(op, args);
    engine.calls.push({ op });
    most = Math.max(most, ++running);
    await new Promise((r) => (release = r));
    running--;
    return { ok: true, text: "" };
  };
  await conv.start();
  await until(() => conv.phase === "listening", "the mic");
  await feed(0.001, 500);
  for (let i = 0; i < 4; i++) {
    await feed(0.2, 400);
    await feed(0.001, 1000); // a pause long enough for an early try
  }
  assert.strictEqual(most, 1, "tries do not pile up");
  release(); // an older pause: speech came after it, so nothing is dropped
  await sleep(10);
  assert.ok(conv.rec.first >= 0);
  await feed(0.001, 100); // the latest pause is tried now
  release();
  await until(() => conv.rec && conv.rec.first < 0, "the noise dropped");
  conv.stop();
});

test("대기 그만 drops an answer that never comes: voice stays on, the mic opens, a late answer is ignored", async () => {
  const { conv, engine, sent, feed, until } = setup();
  await conv.start();
  engine.text = "아글링크야, 빌드 돌려 줘.";
  await feed(0.001, 500);
  await feed(0.2, 800);
  await feed(0.001, 700);
  await until(() => sent.length === 1, "the request");
  assert.ok(conv.awaiting, "waits for the answer");

  assert.strictEqual(conv.stopWaiting(), true);
  assert.strictEqual(conv.awaiting, null);
  assert.ok(conv.on_ && conv.conv, "voice and the conversation stay on");
  await until(() => conv.phase === "listening", "the mic for the next words");

  const reads = engine.ops("tts").length;
  assert.strictEqual(conv.onReply("늦게 온 답이에요."), false, "a late answer is not read");
  assert.strictEqual(engine.ops("tts").length, reads);
  assert.strictEqual(conv.stopWaiting(), false, "nothing to drop twice");
  conv.stop();
});

// asking: a conversation on, the mic not recording, ready to send() directly.
async function asking(over = {}) {
  const t = setup({ settings: { listenMode: "always", ...over } });
  await t.conv.start();
  if (t.conv.rec) t.conv.stopRecording(false);
  return t;
}

test("two quick sends: the first question's answer is dropped, only the second's is read", async () => {
  const { conv, engine, sent, until } = await asking();
  await conv.send("빌드 돌려 줘.");
  await conv.send("테스트도 돌려 줘.");
  assert.deepStrictEqual(sent, ["빌드 돌려 줘.", "테스트도 돌려 줘."]);
  assert.strictEqual(conv.onReply("빌드가 끝났어요.", { question: "빌드 돌려 줘." }), true, "handled: an earlier question's");
  assert.ok(conv.awaiting, "still waiting for the second answer");
  assert.strictEqual(engine.ops("tts").length, 0, "the first answer is not read");
  assert.strictEqual(conv.onReply("손으로 친 질문의 답", { question: "이건 타이핑했어요" }), false, "a typed question is not ours");
  assert.ok(conv.awaiting);
  assert.strictEqual(conv.onReply("테스트가 모두 통과했어요.", { question: "<ide_opened_file>a.js</ide_opened_file>\n테스트도  돌려 줘.\r\n" }), true);
  assert.strictEqual(conv.awaiting, null);
  await until(() => engine.ops("tts").length > 0, "the reading");
  assert.match(engine.ops("tts").map((c) => c.text).join(" "), /테스트가 모두 통과/);
  conv.stop();
});

test("a new question by the wake word mid-wait: the late old answer is dropped, the new one read", async () => {
  const { conv, engine, sent, feed, until } = setup();
  await conv.start();
  engine.text = "아글링크야, 빌드 돌려 줘.";
  await feed(0.001, 500);
  await feed(0.2, 800);
  await feed(0.001, 700);
  await until(() => sent.length === 1, "the first request");
  engine.text = "아글링크야, 커밋해 줘.";
  await feed(0.001, 500);
  await feed(0.2, 800);
  await feed(0.001, 700);
  await until(() => sent.length === 2, "the second request");
  assert.deepStrictEqual(sent, ["빌드 돌려 줘.", "커밋해 줘."]);
  const reads = engine.ops("tts").length;
  assert.strictEqual(conv.onReply("빌드 끝났어요.", { question: "빌드 돌려 줘." }), true);
  assert.ok(conv.awaiting, "the new question is still awaited");
  assert.strictEqual(engine.ops("tts").length, reads);
  assert.strictEqual(conv.onReply("커밋했어요.", { question: "커밋해 줘." }), true);
  await until(() => engine.ops("tts").some((c) => /커밋했어요/.test(c.text)), "the new answer read");
  conv.stop();
});

test("without a transcript the answer is taken as before, but not from another session than the last answer's", async () => {
  const { conv, engine, until } = await asking();
  await conv.send("첫 질문이에요.");
  assert.strictEqual(conv.onReply("첫 답이에요.", { sessionId: "s1" }), true);
  await until(() => !conv.speaking, "the first reading");
  if (conv.rec) conv.stopRecording(false);
  await conv.send("두 번째 질문이에요.");
  assert.strictEqual(conv.onReply("다른 탭의 답", { sessionId: "s2" }), false);
  assert.ok(conv.awaiting, "still waiting");
  assert.strictEqual(conv.onReply("두 번째 답이에요.", { sessionId: "s1" }), true);
  assert.strictEqual(conv.awaiting, null);
  await until(() => engine.ops("tts").some((c) => /두 번째 답/.test(c.text)), "the second answer read");
  conv.stop();
});

test("an answer from the other agent than the one asked is not taken", async () => {
  const { conv } = await asking();
  await conv.send("질문이에요.");
  assert.strictEqual(conv.onReply("다른 에이전트의 답", { agent: "codex" }), false);
  assert.ok(conv.awaiting);
  assert.strictEqual(conv.onReply("답이에요.", { agent: "claude" }), true);
  conv.stop();
});

test("bargeOnset fires once after 250 ms of unbroken voiced sound above the floor", () => {
  const hit = { vad: 0.9, level: 0.2, floor: 0.05 };
  const st = {};
  const got = [hit, hit, hit, hit, hit, hit].map((f) => bargeOnset(st, f));
  assert.deepStrictEqual(got, [false, false, false, false, true, false], "the 5th 50 ms piece, then never again");

  const broken = {};
  const seq = [hit, hit, hit, { vad: 0.2, level: 0.2, floor: 0.05 }, hit, hit, hit, hit];
  assert.deepStrictEqual(seq.map((f) => bargeOnset(broken, f)), [false, false, false, false, false, false, false, false], "a gap starts the count again");

  const loudNoVoice = {};
  for (let i = 0; i < 20; i++) assert.strictEqual(bargeOnset(loudNoVoice, { vad: 0.3, level: 0.5, floor: 0.05 }), false);
  const voicedEcho = {};
  for (let i = 0; i < 20; i++) assert.strictEqual(bargeOnset(voicedEcho, { vad: 0.95, level: 0.06, floor: 0.05 }), false, "not above the floor by the margin");
});

test("fast barge-in stops the reading at the onset and the clip goes on as an ordinary recording", () => {
  for (const bargeFast of [true, false]) {
    const { conv, engine } = setup({ settings: { listenMode: "always", barge: true, bargeFast } });
    conv.on_ = true;
    conv.conv = true;
    conv.echoGain = 0.1;
    conv.speaking = true;
    const now = conv.now();
    const rec = {
      chunks: [], first: -1, loud: 0, speechSum: 0, lastSpeechAt: 0, firstSpeechAt: 0,
      noise: 0.001, noiseN: 5, startedAt: now - 2000, learnedUntil: now - 1000, barge: true,
      prefix: "", earlyFor: 0, checks: Promise.resolve(), stopped: false,
    };
    conv.rec = rec;
    const x = new Float32Array(800).fill(0.2);
    for (let i = 0; i < 5; i++) conv.recFrame(rec, x, 0.2, now + i * 50, 0.9);
    if (!bargeFast) {
      assert.strictEqual(conv.speaking, true, "off: the reading goes on");
      continue;
    }
    assert.strictEqual(conv.speaking, false, "the reading stopped");
    assert.ok(engine.ops("stop").length >= 1);
    conv.recFrame(rec, x, 0.2, now + 300, 0.9);
    assert.strictEqual(rec.barge, false, "now an ordinary recording");
    assert.ok(rec.first >= 0, "the first words are kept");
    assert.strictEqual(conv.phase, "listening");
  }
});

test("the vocabulary: its words prompt recognition, replacements fix what was heard, a snippet goes out as its text", async () => {
  const v = V.compile(
    V.tidy({
      words: ["Headscale", "두원"],
      replace: [{ from: "에이지링크", to: "aglink" }],
      snippets: [{ trigger: "서명 넣어", text: "감사합니다.\n- 두원 드림\n- 연구소" }],
    }),
  );
  const { conv, engine, sent, feed, until } = setup({ vocab: { current: () => v } });
  await conv.start();

  engine.text = "아글링크야, 에이지 링크 버전 알려 줘.";
  await feed(0.001, 500);
  await feed(0.2, 800);
  await feed(0.001, 700);
  await until(() => sent.length === 1, "the request");
  assert.deepStrictEqual(sent, ["aglink 버전 알려 줘."]);
  assert.strictEqual(engine.ops("transcribe")[0].prompt, "아글링크", "the wake clip keeps the wake prompt");

  assert.ok(conv.onReply("1.2 버전이에요."));
  await until(() => !conv.speaking && conv.phase === "listening", "the mic after the reading");
  engine.text = "서명 넣어.";
  await feed(0.001, 500);
  await feed(0.2, 800);
  await feed(0.001, 2400);
  await until(() => sent.length === 2, "the snippet");
  assert.strictEqual(sent[1], "감사합니다.\n- 두원 드림\n- 연구소", "lines and the list kept, not taken for dialogue");
  assert.ok(engine.ops("transcribe").slice(1).every((c) => c.prompt === "Headscale, 두원."), "other clips get the words");
  conv.stop();
});
