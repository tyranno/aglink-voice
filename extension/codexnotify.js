// Codex's answers: Codex runs the `notify` program of ~/.codex/config.toml
// after each finished turn with the turn as JSON in its last argument
// ({type: "agent-turn-complete", "thread-id", "turn-id", cwd,
// "input-messages", "last-assistant-message"}). Our script posts it, marked
// entrypoint "codex", to the same listener as Claude Code's Stop hook. The
// config line is only added when the user clicks for it, and an existing
// notify is never replaced.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { STANDALONE_PORT, hookDir } = require("./hook");

const NOTIFY_MARK = "aglink-voice-codex-notify";

const NOTIFY_SCRIPT = `// ${NOTIFY_MARK}: hands Codex's finished turn (notify) to the aglink
// VS Code voice extension on ${STANDALONE_PORT}, which reads it out when voice is on.
// Codex passes the turn as JSON in the last argument. Never fails the turn.
const done = () => process.exit(0);
setTimeout(done, 3000);
let h = null;
try { h = JSON.parse(process.argv[process.argv.length - 1] || ""); } catch {}
if (!h || h.type !== "agent-turn-complete") done();
else {
  h.entrypoint = "codex";
  const host = (process.env.SSH_CONNECTION || "").trim().split(" ")[0] || "127.0.0.1";
  const tok = (process.env.AGLINK_VOICE_TOKEN || "").trim();
  const hdr = { "Content-Type": "application/json" };
  if (tok) hdr["Authorization"] = "Bearer " + tok;
  const r = require("http").request(
    { host, port: ${STANDALONE_PORT}, path: "/stop", method: "POST", headers: hdr, timeout: 1500 },
    (res) => { res.resume(); res.on("end", done); }
  );
  r.on("error", done);
  r.on("timeout", () => r.destroy());
  r.end(JSON.stringify(h));
}
`;

function codexConfigPath(home = os.homedir(), env = process.env) {
  return path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
}

// ensureNotifyScript writes the script (if missing or changed) and returns its path.
function ensureNotifyScript(home = os.homedir()) {
  const dir = hookDir(home);
  const script = path.join(dir, `${NOTIFY_MARK}.js`);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(script) || fs.readFileSync(script, "utf8") !== NOTIFY_SCRIPT) fs.writeFileSync(script, NOTIFY_SCRIPT);
  return script;
}

// notifyLine is the config.toml line that runs the script.
function notifyLine(script) {
  return `notify = ["node", ${JSON.stringify(script.replace(/\\/g, "/"))}]`;
}

// hasNotify: the config already has a notify (ours or another program's).
function hasNotify(toml) {
  return /^\s*notify\s*=/m.test(String(toml || ""));
}

// withNotify returns the config with the line added among the top-level keys
// (before the first [table], where a key would otherwise land inside it), or
// null when it has a notify already.
function withNotify(toml, line) {
  const text = String(toml || "");
  if (hasNotify(text)) return null;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const add = `# ${NOTIFY_MARK}: Codex's answers read aloud by the aglink voice${nl}${line}${nl}`;
  const m = /^[ \t]*\[/m.exec(text);
  if (!m) return text + (text && !text.endsWith("\n") ? nl : "") + (text ? nl : "") + add;
  return text.slice(0, m.index) + add + nl + text.slice(m.index);
}

// installCodexNotify is the aglinkVoice.installCodexNotify command: it shows
// the line and adds it only when the user clicks "추가".
async function installCodexNotify(vscode, log, { home = os.homedir(), env = process.env, node = true } = {}) {
  const file = codexConfigPath(home, env);
  if (!node) {
    vscode.window.showWarningMessage("aglink 음성: Codex 답 읽기는 Node.js 가 있어야 돼요. Node.js 를 설치한 뒤 다시 실행해 주세요.");
    return false;
  }
  const line = notifyLine(ensureNotifyScript(home));
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  let toml;
  try {
    toml = read();
  } catch (e) {
    vscode.window.showErrorMessage(`aglink 음성: ${file} 을 읽지 못했어요 — ${e.message}`);
    return false;
  }
  const COPY = "줄 복사";
  if (hasNotify(toml)) {
    const ours = toml.includes(NOTIFY_MARK);
    const pick = await vscode.window.showWarningMessage(
      ours
        ? `aglink 음성: ${file} 에 이미 Codex 답 읽기 설정이 있어요.`
        : `aglink 음성: ${file} 에 이미 다른 notify 설정이 있어서 바꾸지 않았어요. 직접 고쳐 주세요 (notify 는 하나만 둘 수 있어요):\n${line}`,
      { modal: !ours },
      ...(ours ? [] : [COPY]),
    );
    if (pick === COPY) await vscode.env.clipboard.writeText(line);
    return false;
  }
  const ADD = "추가";
  const pick = await vscode.window.showInformationMessage(
    `aglink 음성: Codex 의 답을 읽으려면 ${file} 에 이 줄이 있어야 해요. 추가할까요?\n\n${line}\n\n추가한 뒤에는 Codex(VS Code 창)를 다시 열어 주세요.`,
    { modal: true },
    ADD,
    COPY,
  );
  if (pick === COPY) {
    await vscode.env.clipboard.writeText(line);
    return false;
  }
  if (pick !== ADD) return false;
  try {
    const next = withNotify(read(), line); // read again: it may have changed meanwhile
    if (next === null) {
      vscode.window.showWarningMessage(`aglink 음성: ${file} 에 그사이 notify 설정이 생겨서 바꾸지 않았어요.`);
      return false;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
  } catch (e) {
    vscode.window.showErrorMessage(`aglink 음성: ${file} 에 쓰지 못했어요 — ${e.message}`);
    return false;
  }
  log(`voice: Codex notify added to ${file}`);
  vscode.window.showInformationMessage("aglink 음성: Codex 답 읽기를 설정했어요. Codex 를 다시 열면 적용돼요.");
  return true;
}

module.exports = { NOTIFY_MARK, NOTIFY_SCRIPT, codexConfigPath, ensureNotifyScript, notifyLine, hasNotify, withNotify, installCodexNotify };
