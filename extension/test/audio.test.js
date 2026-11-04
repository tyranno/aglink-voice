"use strict";
const test = require("node:test");
const assert = require("node:assert");
const A = require("../core/audio");

function tone(amp, n = 16000) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(i / 5) * amp;
  return x;
}
const levelOf = (wav) => {
  const n = (wav.length - 44) >> 1;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = wav.readInt16LE(44 + i * 2) / 32768; s += v * v; }
  return Math.sqrt(s / n);
};

test("a quiet clip is turned up for recognition, a loud one is left alone", () => {
  const quiet = A.encodeWav(tone(0.02)); // a Bluetooth headset's level
  const up = A.loudForSpeech(quiet);
  assert.ok(levelOf(up) > levelOf(quiet) * 4, `${levelOf(quiet)} -> ${levelOf(up)}`);
  assert.strictEqual(up.length, quiet.length);
  const loud = A.encodeWav(tone(0.2));
  assert.strictEqual(A.loudForSpeech(loud), loud, "already loud enough");
});

test("the gain is capped so near-silence is not blown up into hiss", () => {
  const hiss = A.encodeWav(tone(0.0005));
  assert.ok(levelOf(A.loudForSpeech(hiss)) <= levelOf(hiss) * 20 + 1e-4);
  const peaky = new Float32Array(16000).fill(0.001);
  peaky[100] = 0.9; // one loud click: the gain stops before it clips
  const out = A.loudForSpeech(A.encodeWav(peaky));
  let peak = 0;
  for (let i = 0; i < 16000; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(44 + i * 2) / 32768));
  assert.ok(peak <= 0.96, String(peak));
});
