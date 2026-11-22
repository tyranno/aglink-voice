"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { stateLook } = require("../core/look");

test("stateLook: incoming speech stands out from plain listening", () => {
  const hearing = stateLook({ phase: "listening", hearing: true });
  const listening = stateLook({ phase: "listening" });
  assert.equal(hearing.bg, "statusBarItem.errorBackground");
  assert.equal(listening.bg, "statusBarItem.warningBackground");
  assert.notEqual(hearing.icon, listening.icon);
  assert.deepEqual([0, 1, 2, 3].map((f) => stateLook({ hearing: true }, f).icon), ["$(aglink-hear-1)", "$(aglink-hear-2)", "$(aglink-hear-3)", "$(aglink-hear-1)"]);
  assert.match(stateLook({ phase: "transcribing" }).icon, /~spin/);
  assert.equal(stateLook({}).text, "음성 켜짐");
});
