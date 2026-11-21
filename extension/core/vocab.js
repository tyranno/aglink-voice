// The personal vocabulary: ~/.aglink/voice-words.json (or $AGLINK_HOME), the
// same file the aglink desktop app reads and edits (desktop/vocab.go, same
// rules):
//
//   {"words":    ["Headscale", "두원"],                         hints for Whisper's initial prompt
//    "replace":  [{"from": "에이지링크", "to": "aglink"}],        fixed after recognition
//    "snippets": [{"trigger": "내 메일 주소", "text": "..."}]}   a spoken phrase that expands to text
//
// No file is the old behaviour: no prompt, nothing replaced. The file is read
// again whenever it changes (mtime/size on each use).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const VOCAB_FILE = "voice-words.json";
// The prompt stays short: the Korean model's server keeps only its last 64
// tokens, so a long list would only push the first words out.
const MAX_PROMPT_CHARS = 120;

function vocabPath(env = process.env) {
  const home = String(env.AGLINK_HOME || "").trim() || path.join(os.homedir(), ".aglink");
  return path.join(home, VOCAB_FILE);
}

// squash is the form phrases are compared in: lower case, no spaces.
const squash = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const EDGE_RE = /^[\s\p{P}~]+|[\s\p{P}~]+$/gu; // what may surround a trigger
const ASCII_WORD_RE = /[A-Za-z0-9]/;
const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// tidy trims entries and drops empty ones and repeats (the first one wins).
function tidy(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  const list = (x) => (Array.isArray(x) ? x : []);
  const seen = new Set();
  const once = (k) => k.length > 1 && !seen.has(k) && seen.add(k);
  const words = list(v.words).map((w) => String(w ?? "").trim()).filter((w) => once("w" + squash(w)));
  const replace = list(v.replace)
    .map((r) => ({ from: String(r?.from ?? "").trim(), to: String(r?.to ?? "").trim() }))
    .filter((r) => once("r" + squash(r.from)));
  const snippets = list(v.snippets)
    .map((s) => ({ trigger: String(s?.trigger ?? "").replace(EDGE_RE, ""), text: String(s?.text ?? "").replace(/\r\n/g, "\n").trim() }))
    .filter((s) => s.text && once("s" + squash(s.trigger)));
  return { words, replace, snippets };
}

// phraseSet finds any of [from, to] pairs' phrases in text and puts each one's
// replacement in its place, in one pass so a replacement is never matched
// again. Case and spaces are ignored ("에이지 링크" is "에이지링크"); the
// longest phrase wins where several start at the same place. A phrase that
// begins or ends with a Latin letter or digit must not run into one there, so
// "ai" is not found in "said" — Korean has no such edge, particles stick to
// the word ("에이지링크를").
function phraseSet(pairs) {
  const items = pairs.filter(([from]) => squash(from)).sort((a, b) => [...squash(b[0])].length - [...squash(a[0])].length);
  if (!items.length) return (s) => s;
  const loose = (p) => [...p.replace(/\s+/g, "")].map(escape).join("\\s*");
  const re = new RegExp(items.map(([from]) => `(${loose(from)})`).join("|"), "giu");
  return (s) =>
    s.replace(re, (m, ...groups) => {
      const at = groups[items.length];
      const k = groups.findIndex((g, i) => i < items.length && g !== undefined);
      const from = items[k][0].trim();
      const before = s.slice(0, at).slice(-1);
      const after = s.slice(at + m.length, at + m.length + 1);
      if ((ASCII_WORD_RE.test(from[0]) && ASCII_WORD_RE.test(before)) || (ASCII_WORD_RE.test(from.slice(-1)) && ASCII_WORD_RE.test(after))) return m;
      return items[k][1];
    });
}

// compile turns tidied lists into the three things the conversation uses.
function compile(v) {
  const replace = phraseSet(v.replace.map((r) => [r.from, r.to]));
  const snippets = phraseSet(v.snippets.map((s) => [s.trigger, s.text]));
  const words = [];
  let budget = MAX_PROMPT_CHARS;
  for (const w of v.words) {
    const n = [...w].length + 2; // ", "
    if (n <= budget) words.push(w), (budget -= n);
  }
  return {
    ...v,
    // prompt: the words as Whisper's initial prompt, "" when there are none.
    prompt: words.length ? `${words.join(", ")}.` : "",
    promptWords: words,
    // fix applies the replacements to a transcript.
    fix: (s) => (s ? replace(s) : s),
    // expand puts the snippets in, on what is about to be sent — their text may
    // span lines or hold "- " lists the checks on what was heard must not see.
    // A text that is only a trigger becomes just the snippet text.
    expand(s) {
      if (!s) return s;
      const core = squash(s.replace(EDGE_RE, ""));
      const whole = v.snippets.find((x) => squash(x.trigger) === core);
      return whole ? whole.text : snippets(s);
    },
  };
}

// isPromptEcho: text that is just the prompt's words read back, what Whisper
// tends to make of silence once it has a prompt. One or two of them in a
// request are not an echo.
function isPromptEcho(text, words) {
  const phrases = String(text || "").split(/[.!?,-]/).map((p) => p.trim()).filter(Boolean);
  return phrases.length >= 3 && phrases.every((p) => words.includes(p));
}

// createVocab reads the file when it changed since the last call; a missing
// or broken file gives an empty vocabulary (log says why it is broken).
function createVocab({ file = vocabPath(), log = () => {} } = {}) {
  const empty = compile(tidy({}));
  let key = "";
  let cur = empty;
  function current() {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      key = "";
      return (cur = empty);
    }
    const k = `${st.mtimeMs}:${st.size}`;
    if (k === key) return cur;
    key = k;
    try {
      cur = compile(tidy(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""))));
    } catch (e) {
      log(`${VOCAB_FILE}: ${e.message}`);
      cur = empty;
    }
    return cur;
  }
  return { file, current };
}

// noVocab is the vocabulary when there is none to read (tests, or no file).
const noVocab = { file: "", current: (() => { const v = compile(tidy({})); return () => v; })() };

// ensureVocabFile creates an empty vocabulary file if there is none, so it can
// be opened for editing.
function ensureVocabFile(file = vocabPath()) {
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ words: [], replace: [], snippets: [] }, null, 2)}\n`);
  return file;
}

module.exports = { VOCAB_FILE, MAX_PROMPT_CHARS, vocabPath, tidy, compile, isPromptEcho, createVocab, noVocab, ensureVocabFile };
