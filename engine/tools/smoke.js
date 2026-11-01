// Smoke test for aglink-voice-engine: node smoke.js <engine.exe> <root> <16 kHz wav>
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const [exe, root, wavPath] = process.argv.slice(2);
const p = spawn(exe, [root], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", next = 1;
const waits = new Map();
let micFrames = 0, onReady;
const ready = new Promise((r) => (onReady = r));
p.stdout.setEncoding("utf8").on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.ev === "mic") micFrames++;
    else if (m.ev === "status" && m.whisper !== "starting") onReady(m.whisper);
    else if (m.ev) console.log("event", JSON.stringify(m));
    else if (waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  }
});
const call = (op, args = {}) => new Promise((r) => { const id = next++; waits.set(id, r); p.stdin.write(JSON.stringify({ id, op, ...args }) + "\n"); });
(async () => {
  let t = Date.now();
  console.log("whisper:", await ready, `${Date.now() - t} ms`);
  const wav = fs.readFileSync(wavPath).toString("base64");
  t = Date.now(); const tr = await call("transcribe", { wav }); console.log("transcribe:", tr.ok, tr.text || tr.error, `${Date.now() - t} ms`);
  t = Date.now(); const em = await call("embed", { wav }); console.log("embed:", em.ok, em.embedding ? em.embedding.length : em.error, `${Date.now() - t} ms`);
  for (const v of ["M2", "F1"]) {
    t = Date.now(); const s = await call("tts", { text: "안녕하세요. 음성 엔진 시험입니다.", voice: v, speed: 1.0 });
    console.log(`tts ${v}:`, s.ok, s.wav ? s.wav.length : s.error, `${Date.now() - t} ms`);
    if (s.ok && process.env.PLAY) { t = Date.now(); const pl = await call("play", { wav: s.wav }); console.log("play:", JSON.stringify(pl), `${Date.now() - t} ms`); }
  }
  await call("mic", { on: true }); await new Promise((r) => setTimeout(r, 1000)); await call("mic", { on: false });
  console.log("mic frames in 1 s:", micFrames);
  console.log("status:", JSON.stringify(await call("status")));
  p.stdin.end();
})();
