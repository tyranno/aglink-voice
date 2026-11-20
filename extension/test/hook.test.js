"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { ensureStopHook, HOOK_SCRIPT, HOOK_SCRIPT_PS, STANDALONE_PORT, ownsTurn, hookAllowed } = require("../hook");

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aglink-voice-"));
  fs.mkdirSync(path.join(home, ".claude"));
  return home;
}

test("ensureStopHook adds the hook once, keeps other settings and replaces aglink-vscode's", () => {
  const home = tempHome();
  const old = process.env.AGLINK_VOICE_HOME;
  delete process.env.AGLINK_VOICE_HOME;
  try {
    const file = path.join(home, ".claude", "settings.json");
    const other = { hooks: [{ type: "command", command: "echo hi" }] };
    const desktopOnly = { hooks: [{ type: "command", command: 'node "C:/Users/x/.aglink/vscode-voice-hook.js"', timeout: 5 }] };
    fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: [other, desktopOnly] } }));
    assert.strictEqual(ensureStopHook(home, true), true);
    assert.strictEqual(ensureStopHook(home, true), false);
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(s.model, "opus");
    assert.strictEqual(s.hooks.Stop.length, 2);
    assert.deepStrictEqual(s.hooks.Stop[0], other);
    assert.match(s.hooks.Stop[1].hooks[0].command, /^node ".*\/\.aglink-voice\/aglink-voice-stop-hook\.js"$/);
    assert.strictEqual(fs.readFileSync(path.join(home, ".aglink-voice", "aglink-voice-stop-hook.js"), "utf8"), HOOK_SCRIPT);
  } finally {
    if (old !== undefined) process.env.AGLINK_VOICE_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the hook script hands the turn to the extension and exits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aglink-voice-hook-"));
  const script = path.join(dir, "hook.js");
  fs.writeFileSync(script, HOOK_SCRIPT);
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c)).on("end", () => {
      got = { url: req.url, body: JSON.parse(b) };
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => srv.listen(STANDALONE_PORT, "127.0.0.1", r));
  try {
    const started = Date.now();
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [script], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "claude-vscode" } });
      p.on("exit", resolve);
      p.stdin.end(JSON.stringify({ last_assistant_message: "다 고쳤어요." }));
    });
    assert.strictEqual(code, 0);
    assert.ok(Date.now() - started < 2500, "does not wait for the timeout");
    assert.deepStrictEqual(got, { url: "/stop", body: { last_assistant_message: "다 고쳤어요.", entrypoint: "claude-vscode" } }); // which Claude Code ran it
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without Node.js the hook runs in PowerShell, and switches back when Node.js comes", () => {
  const home = tempHome();
  const old = process.env.AGLINK_VOICE_HOME;
  delete process.env.AGLINK_VOICE_HOME;
  try {
    const file = path.join(home, ".claude", "settings.json");
    assert.strictEqual(ensureStopHook(home, false), true);
    let s = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(s.hooks.Stop.length, 1);
    assert.match(s.hooks.Stop[0].hooks[0].command, /^powershell -NoProfile -ExecutionPolicy Bypass -File ".*\/aglink-voice-stop-hook\.ps1"$/);
    assert.strictEqual(ensureStopHook(home, false), false);
    assert.strictEqual(ensureStopHook(home, true), true);
    s = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(s.hooks.Stop.length, 1);
    assert.match(s.hooks.Stop[0].hooks[0].command, /^node /);
  } finally {
    if (old !== undefined) process.env.AGLINK_VOICE_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the PowerShell hook hands the turn to the extension too", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aglink-voice-hook-"));
  const script = path.join(dir, "hook.ps1");
  fs.writeFileSync(script, HOOK_SCRIPT_PS);
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (b += c)).on("end", () => {
      got = { url: req.url, body: JSON.parse(b) };
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => srv.listen(STANDALONE_PORT, "127.0.0.1", r));
  try {
    const code = await new Promise((resolve) => {
      const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "claude-vscode" } });
      p.on("exit", resolve);
      p.stdin.end(JSON.stringify({ last_assistant_message: "다 고쳤어요. \"따옴표\"\n줄바꿈" }));
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(got, { url: "/stop", body: { entrypoint: "claude-vscode", last_assistant_message: "다 고쳤어요. \"따옴표\"\n줄바꿈" } });
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ownsTurn reads only this window's folder", () => {
  assert.ok(ownsTurn("C:\\Users\\me\\proj", ["c:\\users\\me\\proj"]));
  assert.ok(ownsTurn("C:\\Users\\me\\proj\\sub", ["c:\\users\\me\\proj\\"]));
  assert.ok(!ownsTurn("C:\\Users\\me\\other", ["C:\\Users\\me\\proj"]));
  assert.ok(ownsTurn("/home/me/proj/web", ["/home/me/proj"]));
  assert.ok(!ownsTurn("/home/me/proj2", ["/home/me/proj"]));
  assert.ok(ownsTurn("", ["/home/me/proj"]));
  assert.ok(ownsTurn("/anywhere", []));
});

test("hookAllowed: our loopback hook passes, browser pages and strangers do not", () => {
  const json = { "content-type": "application/json", host: "127.0.0.1:48231" };
  const lo = (headers) => ({ remoteAddress: "127.0.0.1", headers });
  const net = (headers) => ({ remoteAddress: "192.168.0.9", headers });
  // our own Stop hook, with or without a token set
  assert.equal(hookAllowed(lo(json), ""), true);
  assert.equal(hookAllowed(lo(json), "s3cret"), true);
  assert.equal(hookAllowed(lo({ ...json, host: "localhost:48231" }), "s3cret"), true);
  // a web page: has Origin, or a simple text/plain POST, or a DNS-rebound Host
  assert.equal(hookAllowed(lo({ ...json, origin: "https://evil.example" }), ""), false);
  assert.equal(hookAllowed(lo({ ...json, "content-type": "text/plain" }), ""), false);
  assert.equal(hookAllowed(lo({ ...json, host: "evil.example:48231" }), "s3cret"), false);
  // a remote hook (Remote-SSH) needs the token
  const remote = { "content-type": "application/json", host: "192.168.0.2:48231" };
  assert.equal(hookAllowed(net(remote), "s3cret"), false);
  assert.equal(hookAllowed(net({ ...remote, authorization: "Bearer s3cret" }), "s3cret"), true);
  assert.equal(hookAllowed(net({ ...remote, authorization: "Bearer nope" }), "s3cret"), false);
  assert.equal(hookAllowed(net(remote), ""), false);
});
