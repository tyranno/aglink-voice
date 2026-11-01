// Sound as numbers: the engine's mic pieces (16 kHz mono 16-bit PCM) turned
// into samples and levels, clips encoded as WAV for recognition, the loudness
// envelope of a reading (for the echo floor), the wake chime, and comparing
// two voice embeddings.
"use strict";

const RATE = 16000;
const REF_FRAME_MS = 20;

// pcmToFloat turns base64 16-bit little-endian PCM into samples in -1..1.
function pcmToFloat(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = new Float32Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function encodeWav(samples, rate = RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

// clipSeconds is how long a 16 kHz clip made by encodeWav is.
function clipSeconds(wav) {
  return wav ? (wav.length - 44) / (RATE * 2) : 0;
}

// wavEnvelope: the RMS of each REF_FRAME_MS of a 16-bit or float PCM WAV.
function wavEnvelope(bytes) {
  try {
    let fmt = null;
    for (let off = 12; off + 8 <= bytes.length; ) {
      const id = bytes.toString("ascii", off, off + 4);
      const size = bytes.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === "fmt ") fmt = { format: bytes.readUInt16LE(body), channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) };
      if (id === "data" && fmt) {
        const step = (fmt.bits / 8) * fmt.channels;
        const n = Math.floor(Math.min(size, bytes.length - body) / step);
        const per = Math.max(1, Math.round((fmt.rate * REF_FRAME_MS) / 1000));
        const env = new Float32Array(Math.ceil(n / per));
        const float = fmt.format === 3 && fmt.bits === 32;
        for (let f = 0; f < env.length; f++) {
          let sum = 0;
          const end = Math.min(n, (f + 1) * per);
          for (let i = f * per; i < end; i++) {
            const s = float ? bytes.readFloatLE(body + i * step) : bytes.readInt16LE(body + i * step) / 32768;
            sum += s * s;
          }
          env[f] = Math.sqrt(sum / Math.max(1, end - f * per));
        }
        return env;
      }
      off = body + size + (size & 1);
    }
  } catch {}
  return null;
}

// chimeWav: two short rising bell tones, made here so no sound file is shipped.
let chime = null;
function chimeWav() {
  if (chime) return chime;
  const rate = 24000;
  const notes = [
    [880, 0, 0.16],
    [1320, 0.11, 0.42],
  ]; // Hz, start s, length s
  const samples = new Float32Array(Math.ceil(rate * 0.56));
  for (const [f, start, len] of notes) {
    const from = Math.floor(start * rate);
    for (let i = 0; i < len * rate && from + i < samples.length; i++) {
      const t = i / rate;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 9);
      samples[from + i] += 0.32 * env * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t));
    }
  }
  chime = encodeWav(samples, rate);
  return chime;
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

module.exports = { RATE, REF_FRAME_MS, pcmToFloat, rms, concat, encodeWav, clipSeconds, wavEnvelope, chimeWav, normalize, cosine };
