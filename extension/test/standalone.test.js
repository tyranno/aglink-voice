"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { targetText, rememberRequest } = require("../standalone");

test("targetText: the tooltip names where questions go, and where auto goes now", () => {
  assert.strictEqual(targetText("claude", "Codex"), "Claude Code");
  assert.strictEqual(targetText(undefined, "Codex"), "Claude Code");
  assert.strictEqual(targetText("codex", "Claude Code"), "Codex");
  assert.strictEqual(targetText("auto", "Codex"), "자동 (지금은 Codex)");
});

test("rememberRequest keeps the newest last, each text once, and only so many", () => {
  let h = rememberRequest(null, "빌드해 줘", 3, 1);
  h = rememberRequest(h, "테스트 돌려 줘", 3, 2);
  h = rememberRequest(h, "빌드해 줘", 3, 3);
  assert.deepStrictEqual(h, [
    { text: "테스트 돌려 줘", at: 2 },
    { text: "빌드해 줘", at: 3 },
  ]);
  for (const [i, s] of ["가", "나", "다"].entries()) h = rememberRequest(h, s, 3, 10 + i);
  assert.deepStrictEqual(h.map((x) => x.text), ["가", "나", "다"]);
  assert.deepStrictEqual(rememberRequest([{ text: "" }, null, { text: "a", at: 1 }], "  ", 3, 5), [{ text: "a", at: 1 }]);
});
