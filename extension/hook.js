// Claude Code's Stop hook: after each finished turn Claude Code runs this
// script with the turn as JSON on stdin (last_assistant_message is the
// answer). It hands the turn to whichever voice is listening — this extension
// on its own (STANDALONE_PORT) or the aglink desktop app (DESKTOP_PORT) — and
// never fails or slows the turn.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const STANDALONE_PORT = 48231;
const DESKTOP_PORT = 48230;
const HOOK_MARK = "aglink-voice-stop-hook";
const OLD_HOOK_MARK = "vscode-voice-hook"; // aglink-vscode's, desktop only

const HOOK_SCRIPT = `// ${HOOK_MARK}: hands Claude Code's finished turn to the aglink voice
// (the VS Code extension on ${STANDALONE_PORT}, the aglink desktop app on ${DESKTOP_PORT}),
// which reads it out when voice is on. Never fails the turn.
let d = "";
let left = 2;
const done = () => process.exit(0);
setTimeout(done, 3000);
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  for (const port of [${STANDALONE_PORT}, ${DESKTOP_PORT}]) {
    const r = require("http").request(
      { host: "127.0.0.1", port, path: port === ${DESKTOP_PORT} ? "/vscode/stop" : "/stop", method: "POST", headers: { "Content-Type": "application/json" }, timeout: 1500 },
      (res) => { res.resume(); res.on("end", () => --left || done()); }
    );
    r.on("error", () => --left || done());
    r.on("timeout", () => r.destroy());
    r.end(d);
  }
});
`;

function hookDir(home = os.homedir()) {
  return process.env.AGLINK_VOICE_HOME || path.join(home, ".aglink-voice");
}

// ensureStopHook installs the hook script and adds it to Claude Code's user
// settings once; other settings and hooks are left as they are. aglink-vscode's
// older desktop-only hook is replaced, so a turn is not reported twice.
function ensureStopHook(home = os.homedir()) {
  const dir = hookDir(home);
  const script = path.join(dir, `${HOOK_MARK}.js`);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(script) || fs.readFileSync(script, "utf8") !== HOOK_SCRIPT) fs.writeFileSync(script, HOOK_SCRIPT);
  const file = path.join(home, ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const hooks = (settings.hooks = settings.hooks || {});
  const before = JSON.stringify(hooks.Stop || []);
  const stop = (hooks.Stop || []).filter((h) => !JSON.stringify(h).includes(OLD_HOOK_MARK));
  if (!JSON.stringify(stop).includes(HOOK_MARK)) stop.push({ hooks: [{ type: "command", command: `node "${script.replace(/\\/g, "/")}"`, timeout: 5 }] });
  if (JSON.stringify(stop) === before) return false;
  hooks.Stop = stop;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

module.exports = { STANDALONE_PORT, DESKTOP_PORT, HOOK_MARK, HOOK_SCRIPT, ensureStopHook, hookDir };
