// What a finished turn was asking. The Stop hook (Claude Code) and Codex's
// notify both report every turn of the folder, so the conversation needs the
// question each answer belongs to: Claude Code's comes from the turn's
// transcript (JSONL), Codex's from the notify payload's input-messages.
"use strict";

const fs = require("fs");

const TAIL_BYTES = 2 << 20;
// User entries that are not something the user said: slash-command echoes,
// hook output, reminders the agent adds.
const NOT_PROMPT_RE = /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook)/;

// normQuestion makes a sent text and its transcript copy comparable: the
// paste may turn newlines into \r\n and leave spaces around.
function normQuestion(s) {
  return String(s || "")
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// sameQuestion: the turn's prompt (asked) is the text we sent. The agent may
// add around it (an opened-file note, a selection), so containing it counts.
function sameQuestion(asked, sent) {
  const a = normQuestion(asked);
  const b = normQuestion(sent);
  if (!a || !b) return false;
  return a === b || (b.length >= 4 && a.includes(b));
}

// promptText is a transcript entry's prompt, or null when it is not one the
// user typed (a tool result, a meta or sidechain entry).
function promptText(e) {
  if (!e || e.type !== "user" || e.isMeta || e.isSidechain) return null;
  const c = e.message && e.message.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === "tool_result")) return null;
    text = c
      .filter((b) => b && b.type === "text" && typeof b.text === "string" && !NOT_PROMPT_RE.test(b.text))
      .map((b) => b.text)
      .join("\n");
  } else return null;
  if (!text.trim() || NOT_PROMPT_RE.test(text)) return null;
  return text;
}

// lastPrompt finds the last real user prompt in JSONL text, or null.
function lastPrompt(jsonl) {
  const lines = String(jsonl || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"user"')) continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue; // the first line of a tail read is cut
    }
    const t = promptText(e);
    if (t !== null) return t;
  }
  return null;
}

// transcriptQuestion reads the end of Claude Code's transcript for the turn's
// prompt; null when the file cannot be read or holds none.
function transcriptQuestion(file) {
  try {
    if (!file) return null;
    const size = fs.statSync(file).size;
    const n = Math.min(size, TAIL_BYTES);
    const b = Buffer.alloc(n);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, b, 0, n, size - n);
    } finally {
      fs.closeSync(fd);
    }
    return lastPrompt(b.toString("utf8"));
  } catch {
    return null;
  }
}

// turnFromHook maps a posted turn to {agent, cwd, md, question, sessionId,
// transcript}, or null when it is not one to read here. Claude Code's Stop
// hook says entrypoint claude-vscode (blank from older hooks); our Codex
// notify script says codex and passes Codex's payload (type
// agent-turn-complete, last-assistant-message, input-messages, thread-id,
// cwd). question is undefined when it cannot be told.
function turnFromHook(h, readQuestion = transcriptQuestion) {
  if (!h || typeof h !== "object") return null;
  if (h.entrypoint === "codex") {
    if (h.type && h.type !== "agent-turn-complete") return null;
    const inputs = Array.isArray(h["input-messages"]) ? h["input-messages"].filter((m) => typeof m === "string") : null;
    return {
      agent: "codex",
      cwd: h.cwd,
      md: h["last-assistant-message"],
      question: inputs && inputs.length ? inputs.join("\n") : undefined,
      sessionId: h["thread-id"] || undefined,
    };
  }
  if (h.entrypoint && h.entrypoint !== "claude-vscode") return null; // the CLI, aglink's
  const q = readQuestion(h.transcript_path);
  return {
    agent: "claude",
    cwd: h.cwd,
    md: h.last_assistant_message,
    question: q === null ? undefined : q,
    sessionId: h.session_id || undefined,
    transcript: h.transcript_path,
  };
}

module.exports = { normQuestion, sameQuestion, promptText, lastPrompt, transcriptQuestion, turnFromHook };
