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

test("prependSilence adds a silent lead and keeps the original samples and rate", () => {
  const clip = A.encodeWav(tone(0.3, 8000), 24000); // 8000 samples at 24 kHz
  const out = A.prependSilence(clip, 500); // 500 ms = 12000 samples at 24 kHz
  assert.strictEqual(out.readUInt32LE(24), 24000, "rate preserved");
  const n = (out.length - 44) >> 1;
  assert.strictEqual(n, 12000 + 8000, "12000 silent + 8000 original samples");
  for (let i = 0; i < 12000; i++) assert.strictEqual(out.readInt16LE(44 + i * 2), 0, "lead is silent");
  let voiced = 0;
  for (let i = 12000; i < n; i++) if (out.readInt16LE(44 + i * 2) !== 0) voiced++;
  assert.ok(voiced > 4000, "the original tone survives after the lead");
  assert.strictEqual(A.prependSilence(clip, 0), clip, "zero ms returns the clip unchanged");
});

test("scaleWav makes a 16-bit WAV louder or softer, clipped at full scale, and leaves others alone", () => {
  const A2 = require("../core/audio");
  const wav = A2.encodeWav(new Float32Array([0.5, -0.5, 0.9]));
  const at = (w, i) => w.readInt16LE(44 + i * 2);
  const half = A2.scaleWav(wav, 0.5);
  assert.ok(Math.abs(at(half, 0) - at(wav, 0) / 2) <= 1);
  const loud = A2.scaleWav(wav, 2);
  assert.strictEqual(at(loud, 2), 32767, "clipped");
  assert.strictEqual(at(loud, 1), -32768);
  assert.strictEqual(A2.scaleWav(wav, 1), wav);
  const odd = Buffer.from("not a wav file at all, just some bytes here......");
  assert.strictEqual(A2.scaleWav(odd, 2), odd);
  assert.strictEqual(at(wav, 0), Math.round(0.5 * 0x7fff), "the original is untouched");
});
