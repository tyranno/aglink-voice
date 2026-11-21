"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sameQuestion, lastPrompt, transcriptQuestion, turnFromHook } = require("../core/turns");

const line = (o) => JSON.stringify(o);

test("lastPrompt finds the turn's prompt past tool results, meta entries and reminders", () => {
  const jsonl = [
    '{"cut line from the tail',
    line({ type: "user", message: { role: "user", content: "앞선 질문" } }),
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "<ide_opened_file>a.js</ide_opened_file>" }, { type: "text", text: "빌드 돌려 줘." }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1" }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    line({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: …" } }),
    line({ type: "user", message: { role: "user", content: "<system-reminder>x</system-reminder>" } }),
    line({ type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "끝났어요" }] } }),
    "",
  ].join("\n");
  const q = lastPrompt(jsonl);
  assert.ok(sameQuestion(q, "빌드 돌려 줘."));
  assert.ok(!sameQuestion(q, "앞선 질문"));
  assert.strictEqual(lastPrompt(line({ type: "assistant" })), null);
});

test("sameQuestion ignores whitespace and what the agent adds around the words", () => {
  assert.ok(sameQuestion("  테스트도\r\n돌려 줘. ", "테스트도 돌려 줘."));
  assert.ok(sameQuestion("<ide_selection>…</ide_selection> 커밋해 줘.", "커밋해 줘."));
  assert.ok(!sameQuestion("커밋해 줘.", "빌드 돌려 줘."));
  assert.ok(!sameQuestion("", "x"));
  assert.ok(!sameQuestion("네 아니요", "네"), "a very short text must match whole");
});

test("transcriptQuestion reads the file's end, and null when there is none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agv-turns-"));
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(f, line({ type: "user", message: { content: "질문이에요" } }) + "\n");
  assert.strictEqual(transcriptQuestion(f), "질문이에요");
  assert.strictEqual(transcriptQuestion(path.join(dir, "missing.jsonl")), null);
  assert.strictEqual(transcriptQuestion(""), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("turnFromHook maps Claude Code's Stop hook and Codex's notify to one shape", () => {
  const claude = turnFromHook({ entrypoint: "claude-vscode", cwd: "C:/w", last_assistant_message: "답", session_id: "s1", transcript_path: "x" }, () => "질문");
  assert.deepStrictEqual(claude, { agent: "claude", cwd: "C:/w", md: "답", question: "질문", sessionId: "s1", transcript: "x" });
  assert.strictEqual(turnFromHook({ last_assistant_message: "답" }, () => null).question, undefined, "unreadable transcript: unknown");
  assert.strictEqual(turnFromHook({ entrypoint: "cli", last_assistant_message: "답" }, () => null), null, "the CLI is not read here");
  const codex = turnFromHook({ entrypoint: "codex", type: "agent-turn-complete", "thread-id": "th", "turn-id": "tu", cwd: "C:/w", "input-messages": ["빌드 돌려 줘."], "last-assistant-message": "끝났어요" });
  assert.deepStrictEqual(codex, { agent: "codex", cwd: "C:/w", md: "끝났어요", question: "빌드 돌려 줘.", sessionId: "th" });
  assert.strictEqual(turnFromHook({ entrypoint: "codex", type: "approval-requested" }), null);
  assert.strictEqual(turnFromHook({ entrypoint: "codex", type: "agent-turn-complete", "last-assistant-message": "a" }).question, undefined);
  assert.strictEqual(turnFromHook(null), null);
});
