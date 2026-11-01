// Claude Code's Stop hook: after each finished turn Claude Code runs this
// script with the turn as JSON on stdin (last_assistant_message is the
// answer). It hands the turn to whichever voice is listening — this extension
// on its own (STANDALONE_PORT) or the aglink desktop app (DESKTOP_PORT) — and
// never fails or slows the turn.
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");

const STANDALONE_PORT = 48231;
const DESKTOP_PORT = 48230;
const HOOK_MARK = "aglink-voice-stop-hook";
const OLD_HOOK_MARK = "vscode-voice-hook"; // aglink-vscode's, desktop only

const HOOK_SCRIPT = `// ${HOOK_MARK}: hands Claude Code's finished turn to the aglink voice
// (the VS Code extension on ${STANDALONE_PORT}, the aglink desktop app on ${DESKTOP_PORT}),
// which reads it out when voice is on. Never fails the turn. entrypoint says
// which Claude Code ran it (claude-vscode for VS Code's).
let d = "";
let left = 2;
const done = () => process.exit(0);
setTimeout(done, 3000);
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try { const h = JSON.parse(d); h.entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || ""; d = JSON.stringify(h); } catch {}
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

// The same for PCs without Node.js (a company PC with only VS Code and Claude
// Code): Windows PowerShell is always there. Slower to start, so only then.
const HOOK_SCRIPT_PS = `# ${HOOK_MARK}: hands Claude Code's finished turn to the aglink voice
# (the VS Code extension on ${STANDALONE_PORT}, the aglink desktop app on ${DESKTOP_PORT}).
# Never fails the turn.
$ErrorActionPreference = 'SilentlyContinue'
$ms = New-Object IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($ms)
$body = [Text.Encoding]::UTF8.GetString($ms.ToArray()).Trim()
$ep = $env:CLAUDE_CODE_ENTRYPOINT -replace '[^A-Za-z0-9_-]', ''
if ($body.StartsWith('{')) {
  $rest = $body.Substring(1).TrimStart()
  $body = '{"entrypoint":"' + $ep + '"' + $(if ($rest.StartsWith('}')) { '' } else { ',' }) + $rest
}
$bytes = [Text.Encoding]::UTF8.GetBytes($body)
foreach ($u in 'http://127.0.0.1:${STANDALONE_PORT}/stop', 'http://127.0.0.1:${DESKTOP_PORT}/vscode/stop') {
  try { Invoke-WebRequest -Uri $u -Method Post -Body $bytes -ContentType 'application/json' -UseBasicParsing -TimeoutSec 2 | Out-Null } catch {}
}
exit 0
`;

function hasNode() {
  try {
    return spawnSync(process.platform === "win32" ? "where" : "which", ["node"], { windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

function hookDir(home = os.homedir()) {
  return process.env.AGLINK_VOICE_HOME || path.join(home, ".aglink-voice");
}

// ensureStopHook installs the hook script and adds it to Claude Code's user
// settings once; other settings and hooks are left as they are. aglink-vscode's
// older desktop-only hook is replaced, so a turn is not reported twice. Without
// Node.js on the PATH the PowerShell script is used, and ours run the other
// way (Node.js since installed or removed) is replaced.
function ensureStopHook(home = os.homedir(), node = hasNode()) {
  const dir = hookDir(home);
  const script = path.join(dir, `${HOOK_MARK}.${node ? "js" : "ps1"}`);
  const text = node ? HOOK_SCRIPT : HOOK_SCRIPT_PS;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(script) || fs.readFileSync(script, "utf8") !== text) fs.writeFileSync(script, text);
  const fwd = script.replace(/\\/g, "/");
  const command = node ? `node "${fwd}"` : `powershell -NoProfile -ExecutionPolicy Bypass -File "${fwd}"`;
  const file = path.join(home, ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const hooks = (settings.hooks = settings.hooks || {});
  const before = JSON.stringify(hooks.Stop || []);
  const isOther = (h) => JSON.stringify(h).includes(HOOK_MARK) && !(h.hooks || []).some((x) => x.command === command);
  const stop = (hooks.Stop || []).filter((h) => !JSON.stringify(h).includes(OLD_HOOK_MARK) && !isOther(h));
  if (!JSON.stringify(stop).includes(HOOK_MARK)) stop.push({ hooks: [{ type: "command", command, timeout: 5 }] });
  if (JSON.stringify(stop) === before) return false;
  hooks.Stop = stop;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

module.exports = { STANDALONE_PORT, DESKTOP_PORT, HOOK_MARK, HOOK_SCRIPT, HOOK_SCRIPT_PS, ensureStopHook, hookDir };
