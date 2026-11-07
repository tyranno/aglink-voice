"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseEvents } = require("../desktoplink");

test("parseEvents keeps a half-received event for the next chunk", () => {
  const a = parseEvents(': hi\n\ndata: {"type":"prompt","text":"안녕"}\n\ndata: {"ty');
  assert.deepStrictEqual(a.events, [{ type: "prompt", text: "안녕" }]);
  const b = parseEvents(a.rest + 'pe":"attached","on":false}\n\n');
  assert.deepStrictEqual(b.events, [{ type: "attached", on: false }]);
  assert.strictEqual(b.rest, "");
});

test("stateLook: incoming speech stands out from plain listening", () => {
  const { stateLook } = require("../desktoplink");
  const hearing = stateLook({ phase: "listening", hearing: true });
  const listening = stateLook({ phase: "listening" });
  assert.equal(hearing.bg, "statusBarItem.errorBackground");
  assert.equal(listening.bg, "statusBarItem.warningBackground");
  assert.notEqual(hearing.icon, listening.icon);
  assert.match(stateLook({ phase: "transcribing" }).icon, /~spin/);
  assert.equal(stateLook({}).text, "음성 켜짐");
});
