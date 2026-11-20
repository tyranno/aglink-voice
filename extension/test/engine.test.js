"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { Engine } = require("../core/engine");

// Node runs test/fake-engine.js in place of the engine exe: Engine spawns
// `exe root ...`, so the script goes where the root does.
const FAKE = path.join(__dirname, "fake-engine.js");
function fake(mode, opts = {}) {
  process.env.AGLINK_FAKE_ENGINE = mode; // spawn hands the fake our environment
  return new Engine(process.execPath, FAKE, () => {}, { whisper: false, ...opts });
}
const exited = (p) => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise((r) => p.once("exit", r)));

test("engine: an exe that is not there rejects the start, and nothing is left waiting", async () => {
  const e = new Engine(path.join(__dirname, "no-such-engine.exe"), "", () => {}, { whisper: false });
  let exits = 0;
  e.on("exit", () => exits++);
  await assert.rejects(e.start(), (err) => err.code === "ENOENT");
  assert.equal(e.running, false);
  assert.equal(e.starting, null);
  await assert.rejects(e.call("status"), /not running/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exits, 1, "error and exit are cleaned up once");
});

test("engine: no ready in time rejects the start and kills the process", async () => {
  const e = fake("silent", { startTimeoutMs: 300 });
  const a = e.start();
  const b = e.start(); // a start in flight is shared
  assert.strictEqual(a, b);
  const p = e.proc;
  await assert.rejects(a, /제때 켜지지/);
  assert.equal(e.running, false);
  await exited(p);
  assert.ok(p.killed || p.signalCode !== null || p.exitCode !== null);
});

test("engine: a missing reply times out, a stop refuses the rest, and a new start works", async () => {
  const e = fake("ok", { callTimeoutMs: 200 });
  const [a, b] = [e.start(), e.start()];
  assert.strictEqual(a, b);
  await a;
  assert.equal((await e.call("status")).ok, true);
  await assert.rejects(e.call("hang"), /응답하지 않아요 \(hang\)/);
  // a request still out when the engine goes is refused, its timer cleared
  const pending = e.call("hang");
  const p = e.proc;
  e.stop();
  await assert.rejects(pending, /engine stopped/);
  await exited(p);
  assert.equal(e.waits.size, 0);
  // the same Engine starts again
  await e.start();
  assert.equal(e.running, true);
  assert.equal((await e.call("devices")).op, "devices");
  const q = e.proc;
  e.stop();
  await exited(q);
});

test("engine: a long op may take longer than the default limit", async () => {
  const e = fake("ok", { callTimeoutMs: 100, callTimeouts: { hang: 0 } });
  await e.start();
  let settled = false;
  e.call("hang").then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(settled, false, "no limit for this op");
  const p = e.proc;
  e.stop();
  await exited(p);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, true);
});
