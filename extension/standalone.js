// Voice conversation with Claude Code on the bundled engine, for VS Code
// without the aglink desktop app. core/conversation.js listens and reads;
// this file gives it what lives in VS Code:
//
// - the settings (aglinkVoice.* in VS Code's settings) and a store for what it
//   learns (the enrolled voice, the user's level, the room's echo gain);
// - send(): the words go on the clipboard, Claude Code's input box takes the
//   focus, and the engine presses Ctrl+V, Enter in this window — Claude Code
//   has no way to submit a prompt from outside, so keys are the only way in;
// - the answer: Claude Code's Stop hook (hook.js) posts each finished turn to
//   127.0.0.1:STANDALONE_PORT, served here while voice is on.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Engine } = require("./core/engine");
const { Conversation } = require("./core/conversation");
const { TTS_VOICES, voiceLabel } = require("./core/text");
const { STANDALONE_PORT, ensureStopHook } = require("./hook");

const SECTION = "aglinkVoice";
const SETTING_KEYS = ["voice", "speed", "speakerMin", "listenMode", "wakeIdleMin", "summary", "wakeNames", "wakeDefault", "textOnly", "barge"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// enginePaths: where the setup put the engine (%LOCALAPPDATA%\aglink-voice),
// unless the settings say otherwise. The root holds models\ and whisper\.
function enginePaths(cfg, env = process.env) {
  const base = path.join(env.LOCALAPPDATA || "", "aglink-voice");
  const exe = cfg.get("enginePath") || path.join(base, "engine", "aglink-voice-engine.exe");
  const root = cfg.get("engineRoot") || path.dirname(path.dirname(exe));
  return { exe, root };
}

function readSettings(cfg) {
  const s = {};
  for (const k of SETTING_KEYS) s[k] = cfg.get(k);
  if (!TTS_VOICES.includes(s.voice)) s.voice = "M2";
  if (!Array.isArray(s.wakeNames)) s.wakeNames = [];
  if (!s.wakeDefault && !s.wakeNames.length) s.wakeDefault = true; // always some name to wake on
  return s;
}

function createStandalone(vscode, context, log, { item, active = () => true } = {}) {
  const cfg = () => vscode.workspace.getConfiguration(SECTION);
  const settings = {
    get: () => readSettings(cfg()),
    set: async (patch) => {
      for (const [k, v] of Object.entries(patch)) if (SETTING_KEYS.includes(k)) await cfg().update(k, v, vscode.ConfigurationTarget.Global);
    },
  };
  const store = {
    get: (k) => context.globalState.get(`voice.${k}`) ?? null,
    set: (k, v) => void context.globalState.update(`voice.${k}`, v),
  };

  let engine = null;
  let conv = null;
  let server = null;
  let starting = null;
  let last = { on: false, phase: "off", label: "음성 꺼짐" };

  function identity() {
    return { pid: process.ppid, title: vscode.workspace.name || "" }; // the VS Code main process owns the window
  }

  async function send(text) {
    const old = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(text);
    try {
      await vscode.commands.executeCommand("claude-vscode.focus");
    } catch (e) {
      return { ok: false, error: "Claude Code 확장을 찾지 못했어요. 설치되어 있는지 확인해 주세요." };
    }
    await sleep(250);
    let res;
    try {
      res = await engine.call("paste", identity());
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res.ok) return res; // the words stay on the clipboard
    await sleep(800);
    await vscode.env.clipboard.writeText(old);
    return { ok: true };
  }

  const ICONS = { off: "$(mic)", wake: "$(mic)", conversation: "$(mic-filled)", listening: "$(mic-filled)", transcribing: "$(loading~spin)", speaking: "$(unmute)", waiting: "$(watch)", note: "$(mic-filled)", problem: "$(warning)" };

  function render() {
    if (!active()) return;
    const st = last;
    if (starting && !st.on) {
      item.text = "$(loading~spin) 음성 켜는 중";
      item.tooltip = "음성 엔진을 켜는 중이에요";
      item.backgroundColor = undefined;
    } else if (!st.on) {
      item.text = "$(mic) 음성";
      item.tooltip = "음성 대화 켜기 (Ctrl+Alt+V)";
      item.backgroundColor = undefined;
    } else {
      item.text = `${ICONS[st.phase] || "$(mic)"} ${st.label}`;
      const s = settings.get();
      item.tooltip = `음성 켜짐 — ${voiceLabel(s.voice)} 목소리, ${s.speed}배, 받아쓰기 ${st.whisper === "gpu" ? "그래픽카드" : st.whisper === "cpu" ? "CPU" : "준비 중"}. 누르면 꺼요.`;
      item.backgroundColor = st.phase === "problem" ? new vscode.ThemeColor("statusBarItem.errorBackground") : new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    item.show();
  }

  // listen serves the Stop hook's POST /stop while voice is on in this window.
  function listen() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/stop") {
          res.writeHead(404).end();
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c) => {
          if (body.length < 4 << 20) body += c;
        });
        req.on("end", () => {
          res.writeHead(204).end();
          let h = {};
          try {
            h = JSON.parse(body);
          } catch {}
          if (conv && h.last_assistant_message) conv.onReply(h.last_assistant_message);
        });
      });
      srv.once("error", reject);
      srv.listen(STANDALONE_PORT, "127.0.0.1", () => resolve(srv));
    });
  }

  async function start() {
    const { exe, root } = enginePaths(cfg());
    if (!fs.existsSync(exe)) throw new Error(`음성 엔진이 설치되어 있지 않아요 (${exe}). aglink 음성 설치 파일을 먼저 실행해 주세요.`);
    if (ensureStopHook()) log("voice: Claude Code Stop hook added to ~/.claude/settings.json");
    engine = new Engine(exe, root, log);
    engine.on("exit", (code) => {
      if (!conv) return;
      log(`voice: engine exited (${code})`);
      const c = conv;
      conv = null;
      c.stop();
      closeServer();
      last = { on: false, phase: "off", label: "음성 꺼짐" };
      render();
      vscode.window.showWarningMessage("aglink 음성: 음성 엔진이 멈춰서 음성을 껐어요. 다시 켜 주세요.");
    });
    await engine.start();
    try {
      server = await listen();
    } catch (e) {
      engine.stop();
      engine = null;
      throw new Error(e.code === "EADDRINUSE" ? "다른 VS Code 창에서 음성을 쓰고 있어요." : e.message);
    }
    conv = new Conversation({
      engine,
      settings,
      store,
      send,
      newConversation: () => vscode.commands.executeCommand("claude-vscode.newConversation"),
      log: (m) => log(`voice: ${m}`),
    });
    conv.on("state", (st) => {
      last = st;
      render();
    });
    conv.on("off", () => void stop());
    await conv.start();
  }

  function closeServer() {
    if (server) server.close();
    server = null;
  }

  async function stop() {
    const c = conv;
    conv = null;
    if (c) c.stop();
    closeServer();
    if (engine) engine.stop();
    engine = null;
    last = { on: false, phase: "off", label: "음성 꺼짐" };
    render();
  }

  async function toggle() {
    if (starting) return;
    if (conv) {
      await stop();
      return;
    }
    starting = start();
    render();
    try {
      await starting;
    } catch (e) {
      log(`voice: start failed: ${e.message}`);
      await stop();
      vscode.window.showErrorMessage(`aglink 음성: ${e.message}`);
    } finally {
      starting = null;
      render();
    }
  }

  async function ensureOn() {
    if (!conv) await toggle();
    return !!conv;
  }

  return {
    toggle,
    render,
    get on() {
      return !!conv;
    },
    // enroll records the user's voice (turning voice on for it if need be).
    async enroll() {
      if (!(await ensureOn())) return;
      await conv.enroll();
    },
    get enrolled() {
      return !!store.get("speaker");
    },
    async preview() {
      if (!(await ensureOn())) return;
      await conv.preview();
    },
    dispose() {
      void stop();
    },
  };
}

module.exports = { createStandalone, enginePaths, readSettings, SETTING_KEYS };
