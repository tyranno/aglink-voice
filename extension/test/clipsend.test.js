"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { clipboardSender } = require("../core/clipsend");

const tick = () => new Promise((r) => setImmediate(r));

// rig is a clipboard, a focus and a paste that note what happened; waits are
// immediate unless held (gate) so a test can act in the middle of a send.
function rig(start = "원래 복사한 것") {
  const r = { text: start, delivered: [], log: [], gate: null };
  r.clipboard = {
    readText: async () => r.text,
    writeText: async (t) => {
      r.text = t;
      r.log.push(t);
    },
  };
  r.send = clipboardSender({
    clipboard: r.clipboard,
    focus: async () => {},
    deliver: async () => {
      r.delivered.push(r.text); // what Ctrl+V would paste
      return { ok: true };
    },
    wait: (ms) => (ms === 800 && r.gate ? r.gate : Promise.resolve()),
  });
  return r;
}

test("clipsend: the clipboard comes back after a send", async () => {
  const r = rig();
  assert.deepEqual(await r.send("안녕"), { ok: true });
  assert.deepEqual(r.delivered, ["안녕"]);
  assert.equal(r.text, "원래 복사한 것");
});

test("clipsend: what the user copies during a send is not overwritten", async () => {
  const r = rig();
  let open;
  r.gate = new Promise((x) => (open = x));
  const p = r.send("말한 문장");
  while (!r.delivered.length) await tick();
  r.text = "방금 복사한 것"; // the user copies while the paste settles
  open();
  assert.deepEqual(await p, { ok: true });
  assert.equal(r.text, "방금 복사한 것");
});

test("clipsend: two sends back to back go one after the other and both arrive", async () => {
  const r = rig();
  let open;
  r.gate = new Promise((x) => (open = x));
  const a = r.send("첫째");
  const b = r.send("둘째");
  while (!r.delivered.length) await tick();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(r.delivered, ["첫째"], "the second waits for the first's restore");
  assert.equal(r.text, "첫째");
  r.gate = null;
  open();
  assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(r.delivered, ["첫째", "둘째"]);
  assert.equal(r.text, "원래 복사한 것", "ends with the user's own clipboard");
  assert.deepEqual(r.log, ["첫째", "원래 복사한 것", "둘째", "원래 복사한 것"]);
});

test("clipsend: a failed paste keeps the words on the clipboard and the next send still runs", async () => {
  const r = rig();
  let fail = true;
  const send = clipboardSender({
    clipboard: r.clipboard,
    focus: async () => {},
    deliver: async () => (fail ? { ok: false, error: "VS Code 창이 바뀌어 붙여넣지 않았어요" } : { ok: true }),
    wait: async () => {},
  });
  assert.deepEqual(await send("하나"), { ok: false, error: "VS Code 창이 바뀌어 붙여넣지 않았어요" });
  assert.equal(r.text, "하나");
  fail = false;
  assert.deepEqual(await send("둘"), { ok: true });
});

test("clipsend: a focus that throws is reported, not thrown", async () => {
  const r = rig();
  const send = clipboardSender({
    clipboard: r.clipboard,
    focus: async () => {
      throw new Error("no Claude Code");
    },
    deliver: async () => ({ ok: true }),
    wait: async () => {},
  });
  assert.deepEqual(await send("하나"), { ok: false, error: "no Claude Code" });
});
