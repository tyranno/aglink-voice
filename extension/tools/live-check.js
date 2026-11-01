// Runs the conversation on the real engine with recordings in place of the
// mic, so recognition, the voice check and the command path are tried end to
// end without anyone talking (and with playback muted):
//
//   node tools/live-check.js <engine.exe> <root> <enroll.wav> <user.wav> [<other.wav>]
//
// The user's recording is enrolled first (as "목소리 등록" would), then fed as
// mic audio: what it says should be sent. The other recording should not.
"use strict";

const fs = require("fs");
const { Engine } = require("../core/engine");
const { Conversation } = require("../core/conversation");
const A = require("../core/audio");

const [exe, root, enrollWav, userWav, otherWav] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// read16k returns a 16-bit PCM WAV's first channel at 16 kHz.
function read16k(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  let rate = 16000;
  let ch = 1;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") {
      ch = b.readUInt16LE(off + 10);
      rate = b.readUInt32LE(off + 12);
    }
    if (id === "data") {
      const n = Math.floor(Math.min(size, b.length - off - 8) / (2 * ch));
      const src = new Float32Array(n);
      for (let i = 0; i < n; i++) src[i] = b.readInt16LE(off + 8 + i * 2 * ch) / 32768;
      if (rate === 16000) return src;
      const out = new Float32Array(Math.floor((n * 16000) / rate));
      for (let i = 0; i < out.length; i++) out[i] = src[Math.min(n - 1, Math.floor((i * rate) / 16000))];
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`no audio in ${file}`);
}

(async () => {
  const engine = new Engine(exe, root, () => {});
  await engine.start();
  for (let i = 0; i < 100 && engine.whisper === "starting"; i++) await sleep(100);
  console.log("whisper:", engine.whisper);
  // Mic and speakers stay off: the recordings are the mic.
  const real = engine.call.bind(engine);
  engine.call = (op, args) => (op === "mic" || op === "play" ? Promise.resolve({ ok: true }) : real(op, args));

  const kept = {};
  const values = { voice: "M2", speed: 0.98, speakerMin: 0.4, listenMode: "always", wakeIdleMin: 3, summary: true, wakeNames: [], wakeDefault: true, textOnly: false, barge: false };
  const sent = [];
  let clock = Date.now();
  const conv = new Conversation({
    engine,
    settings: { get: () => ({ ...values }), set: async (p) => Object.assign(values, p) },
    store: { get: (k) => kept[k] ?? null, set: (k, v) => (kept[k] = v) },
    send: async (text) => {
      sent.push(text);
      return { ok: true };
    },
    log: (m) => console.log("  ·", m),
    now: () => clock,
  });

  const e = (await engine.call("embed", { wav: fs.readFileSync(enrollWav).toString("base64") })).embedding;
  kept.speaker = { base: A.normalize(e), ref: A.normalize(e) };

  async function say(file) {
    const s = read16k(file);
    const silence = new Float32Array(800);
    const pieces = [];
    for (let i = 0; i < 12; i++) pieces.push(silence);
    for (let i = 0; i + 800 <= s.length; i += 800) pieces.push(s.subarray(i, i + 800));
    for (let i = 0; i < 60; i++) pieces.push(silence);
    for (const p of pieces) {
      clock += 50;
      conv.onFrame(p);
      await sleep(2); // let recognition run between pieces
    }
    for (let i = 0; i < 300 && (conv.phase === "transcribing" || conv.rec?.first >= 0); i++) await sleep(20);
    await sleep(500);
  }

  await conv.start();
  console.log(`user: ${userWav}`);
  let t = Date.now();
  await say(userWav);
  console.log(`  sent: ${JSON.stringify(sent)} (${Date.now() - t} ms)`);
  const userSent = sent.length;
  if (otherWav) {
    console.log(`other: ${otherWav}`);
    conv.awaiting && clearTimeout(conv.awaiting);
    conv.awaiting = null;
    conv.resumeListening(0);
    await sleep(300);
    await say(otherWav);
    console.log(`  sent: ${JSON.stringify(sent.slice(userSent))}`);
  }
  console.log(`tts: ${(await engine.call("tts", { text: "답변을 읽어 드릴게요.", voice: "F3", speed: 1 })).wav.length} bytes of base64`);
  conv.stop();
  engine.stop();
  console.log(userSent > 0 && (!otherWav || sent.length === userSent) ? "PASS" : "FAIL");
  setTimeout(() => process.exit(0), 500);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
