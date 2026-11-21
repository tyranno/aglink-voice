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
  const bridgePort = (process.env.AGLINK_VOICE_PORT || "").trim();
  const bridgeToken = (process.env.AGLINK_BRIDGE_TOKEN || "").trim();
  // A stale or incomplete bridge must not send the answer to a fallback host.
  if ((bridgePort || bridgeToken) && (!/^\\d+$/.test(bridgePort) || Number(bridgePort) < 1 || Number(bridgePort) > 65535 || !bridgeToken)) done();
  const host = bridgePort ? "127.0.0.1" : ((process.env.SSH_CONNECTION || "").trim().split(/\\s+/)[0] || "127.0.0.1");
  const tok = bridgePort ? bridgeToken : (process.env.AGLINK_VOICE_TOKEN || "").trim();
  const hdr = { "Content-Type": "application/json" };
  if (tok) hdr["Authorization"] = "Bearer " + tok;
  const r = require("http").request(
    { host, port: bridgePort ? Number(bridgePort) : ${STANDALONE_PORT}, path: "/stop", method: "POST", headers: hdr, timeout: 1500 },
    (res) => {
      if (bridgePort && res.statusCode === 401) console.error("aglink voice: reload the SSH window and start Codex again in that window or in a new integrated terminal.");
      res.resume(); res.on("end", done);
    }
  );
  r.on("error", () => {
    if (bridgePort) console.error("aglink voice: the SSH bridge did not respond. Reopen Codex from the current SSH window or from a new integrated terminal.");
    done();
  });
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

// notifyLine is the config.toml line that runs the script. node is the
// program that runs it: "node" from PATH on this PC; on an SSH server the
// path the bridge found, since Codex there often has no node on its PATH
// (nvm sets it up only in interactive shells).
function notifyLine(script, node = "node") {
  return `notify = [${JSON.stringify(node)}, ${JSON.stringify(script.replace(/\\/g, "/"))}]`;
}

// withOurNotify returns the config with our notify line replaced by line, or
// null when it has none of ours (another program's notify is never touched).
const OUR_NOTIFY_RE = new RegExp(String.raw`^[ \t]*notify[ \t]*=.*` + NOTIFY_MARK + ".*$", "m");
function withOurNotify(toml, line) {
  const text = String(toml || "");
  if (!OUR_NOTIFY_RE.test(text)) return null;
  return text.replace(OUR_NOTIFY_RE, () => line);
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

function usesRemoteCodex(vscode) {
  if (vscode.env.remoteName !== "ssh-remote") return false;
  const codex = vscode.extensions?.getExtension("openai.chatgpt");
  return !(codex?.extensionUri?.scheme === "file" && codex.extensionKind === vscode.ExtensionKind.UI);
}

async function notifyFiles(vscode, home, env) {
  if (!usesRemoteCodex(vscode)) {
    const file = codexConfigPath(home, env);
    return {
      file,
      commandPath: path.join(hookDir(home), `${NOTIFY_MARK}.js`),
      read: async () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""),
      write: async (text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      },
      ensureScript: async () => ensureNotifyScript(home),
    };
  }
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri || vscode.workspace.workspaceFile;
  if (uri?.scheme !== "vscode-remote" || !uri.authority) throw new Error("SSH 창에서 원격 폴더를 먼저 열어 주세요.");
  const paths = await vscode.commands.executeCommand("aglink.bridge.codexNotifyPaths");
  if (!paths?.config || !paths.script || !paths.commandPath) throw new Error("원격 aglink 브리지 경로를 확인하지 못했습니다.");
  const config = uri.with({ path: paths.config, query: "", fragment: "" });
  const script = uri.with({ path: paths.script, query: "", fragment: "" });
  const read = async (target) => {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(target)).toString("utf8");
    } catch (e) {
      if (e.code === "FileNotFound") return "";
      throw e;
    }
  };
  const write = async (target, text) => {
    await vscode.workspace.fs.createDirectory(target.with({ path: path.posix.dirname(target.path) }));
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8"));
  };
  return {
    file: `SSH ${config.path}`,
    commandPath: paths.commandPath,
    node: typeof paths.node === "string" && paths.node.startsWith("/") ? paths.node : "node", // bridge 0.2.1+ finds it
    read: () => read(config),
    write: (text) => write(config, text),
    ensureScript: async () => {
      if ((await read(script)) !== NOTIFY_SCRIPT) await write(script, NOTIFY_SCRIPT);
    },
  };
}

async function codexNotifyConfigured(vscode) {
  try {
    const files = await notifyFiles(vscode, os.homedir(), process.env);
    return (await files.read()).includes(NOTIFY_MARK);
  } catch {
    return false;
  }
}

// installCodexNotify is the aglinkVoice.installCodexNotify command: it shows
// the line and adds it only when the user clicks "추가".
async function installCodexNotify(vscode, log, { home = os.homedir(), env = process.env, node = true } = {}) {
  if (!usesRemoteCodex(vscode) && !node) {
    vscode.window.showWarningMessage("aglink 음성: Codex 답 읽기는 Node.js 가 있어야 돼요. Node.js 를 설치한 뒤 다시 실행해 주세요.");
    return false;
  }
  let files;
  let toml;
  try {
    files = await notifyFiles(vscode, home, env);
    toml = await files.read();
  } catch (e) {
    vscode.window.showErrorMessage(`aglink 음성: Codex 설정을 읽지 못했어요. SSH를 사용 중이면 aglink 브리지를 업데이트하고 창을 다시 열어 주세요. (${e.message})`);
    return false;
  }
  const { file, read, write, ensureScript } = files;
  const line = notifyLine(files.commandPath, files.node);
  const COPY = "줄 복사";
  const UPDATE = "갱신";
  if (hasNotify(toml)) {
    const ours = toml.includes(NOTIFY_MARK);
    // Ours, but naming another node or script (a bare "node" not on the
    // server's PATH, a VS Code server since updated): offer to fix it.
    if (ours && !toml.includes(line) && withOurNotify(toml, line) !== null) {
      const pick = await vscode.window.showInformationMessage(
        `aglink 음성: ${file} 의 Codex 답 읽기 설정을 이 줄로 바꿀까요?\n\n${line}\n\n바꾼 뒤에는 Codex 를 다시 열어 주세요.`,
        { modal: true },
        UPDATE,
      );
      if (pick !== UPDATE) return false;
      try {
        await ensureScript();
        const next = withOurNotify(await read(), line); // read again: it may have changed meanwhile
        if (next === null) return false;
        await write(next);
      } catch (e) {
        vscode.window.showErrorMessage(`aglink 음성: ${file} 에 쓰지 못했어요 — ${e.message}`);
        return false;
      }
      log(`voice: Codex notify updated in ${file}`);
      vscode.window.showInformationMessage("aglink 음성: Codex 답 읽기 설정을 바꿨어요. Codex 를 다시 열면 적용돼요.");
      return true;
    }
    const pick = await vscode.window.showWarningMessage(
      ours
        ? `aglink 음성: ${file} 에 이미 Codex 답 읽기 설정이 있어요.`
        : `aglink 음성: ${file} 에 이미 다른 notify 설정이 있어서 바꾸지 않았어요. 직접 고쳐 주세요 (notify 는 하나만 둘 수 있어요):\n${line}`,
      { modal: !ours },
      ...(ours ? [] : [COPY]),
    );
    try {
      if (ours || pick === COPY) await ensureScript();
      if (pick === COPY) await vscode.env.clipboard.writeText(line);
    } catch (e) {
      vscode.window.showErrorMessage(`aglink 음성: 알림 스크립트를 준비하지 못했어요. (${e.message})`);
    }
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
    try {
      await ensureScript();
      await vscode.env.clipboard.writeText(line);
    } catch (e) {
      vscode.window.showErrorMessage(`aglink 음성: 알림 스크립트를 준비하지 못했어요. (${e.message})`);
    }
    return false;
  }
  if (pick !== ADD) return false;
  try {
    await ensureScript();
    const next = withNotify(await read(), line); // read again: it may have changed meanwhile
    if (next === null) {
      vscode.window.showWarningMessage(`aglink 음성: ${file} 에 그사이 notify 설정이 생겨서 바꾸지 않았어요.`);
      return false;
    }
    await write(next);
  } catch (e) {
    vscode.window.showErrorMessage(`aglink 음성: ${file} 에 쓰지 못했어요 — ${e.message}`);
    return false;
  }
  log(`voice: Codex notify added to ${file}`);
  vscode.window.showInformationMessage("aglink 음성: Codex 답 읽기를 설정했어요. Codex 를 다시 열면 적용돼요.");
  return true;
}

module.exports = { NOTIFY_MARK, NOTIFY_SCRIPT, codexConfigPath, ensureNotifyScript, notifyLine, hasNotify, withNotify, withOurNotify, installCodexNotify, codexNotifyConfigured };
