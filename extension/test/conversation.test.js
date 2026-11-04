"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");
const { Conversation } = require("../core/conversation");
const A = require("../core/audio");

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

function setup({ settings: over = {}, store: init = {} } = {}) {
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
  });
  // feed sends ms of mic audio, 50 ms at a time, letting the checks it starts run.
  async function feed(amp, ms) {
    for (let t = 0; t < ms; t += 50) {
      clock += 50;
      engine.emit("mic", { pcm: frame(amp) });
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
  assert.match(engine.ops("tts")[0].text, /여자 3번 목소리로 바꿨어요/);
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
  assert.deepStrictEqual(engine.ops("mic").pop(), { op: "mic", on: true, device: "" });

  conv.stop();
  const before = engine.ops("mic").length;
  values.micDevice = "다른 마이크";
  await conv.micDeviceChanged(); // off: nothing opens now, the next start uses it
  assert.strictEqual(engine.ops("mic").length, before);
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

test("a long first sentence is read lead-first, every piece at full quality", async () => {
  const { conv, engine } = setup();
  conv.onReply("오늘 오후 세 시 회의 자료를 정리해서 팀원들에게 메일로 보냈습니다. 확인해 주세요.");
  await conv.speak("오늘 오후 세 시 회의 자료를 정리해서 팀원들에게 메일로 보냈습니다. 확인해 주세요.", "full");
  const tts = engine.ops("tts").filter((c) => !/아글링크|목소리예요/.test(c.text));
  assert.ok(tts.length >= 3, JSON.stringify(tts.map((c) => c.text)));
  const first = tts.findIndex((c) => c.text === "오늘 오후 세 시 회의 자료를");
  assert.ok(first >= 0, "the lead was read on its own");
  for (const c of tts) assert.strictEqual(c.steps, undefined, "no piece uses fewer steps");
});
