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
