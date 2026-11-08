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
//   127.0.0.1:STANDALONE_PORT, served here while voice is on or typed
//   questions' answers are to be read (readTyped).
//
// The engine runs in two ways: with voice on (mic and Whisper), or for
// reading only (a typed question's answer, a preview) — no mic, no Whisper,
// and it goes away after READER_IDLE_MS of nothing to read.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Engine } = require("./core/engine");
const { Conversation } = require("./core/conversation");
const { TTS_VOICES, voiceLabel, cleanWakeNames } = require("./core/text");
const { STANDALONE_PORT, ensureStopHook } = require("./hook");
const { stateLook, HEAR_FRAME_MS } = require("./desktoplink");

const SECTION = "aglinkVoice";
const SETTING_KEYS = ["voice", "speed", "speakerMin", "listenMode", "wakeIdleMin", "summary", "wakeNames", "wakeDefault", "stopWords", "stopDefault", "textOnly", "readTyped", "barge", "micDevice", "outputDevice"];
const READER_IDLE_MS = 10 * 60000;
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
  s.stopWords = cleanWakeNames(s.stopWords, 1);
  if (!s.stopDefault && !s.stopWords.length) s.stopDefault = true; // always some word to end on
  return s;
}

// elsewhere(): the desktop app's voice is on — it reads its own answers, so
// typed questions' answers are left alone too.
function createStandalone(vscode, context, log, { item, active = () => true, elsewhere = () => false, showSend = () => {} } = {}) {
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
  let conv = null; // made with the engine; started (mic on) only while voice is on
  let core = null; // the engine starting
  let server = null;
  let starting = null;
  let readerTimer = null;
  let last = { on: false, phase: "off", label: "음성 꺼짐" };
  const listeners = new Set(); // the settings panel, told when voice goes on or off

  const voiceOn = () => !!(conv && conv.isOn);

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

  const ICONS = { off: "$(mic)", wake: "$(mic)", conversation: "$(mic-filled)", listening: "$(mic-filled)", preparing: "$(loading~spin)", transcribing: "$(loading~spin)", speaking: "$(unmute)", waiting: "$(watch)", note: "$(mic-filled)", problem: "$(warning)" };

  // While speech is coming in the button shows the same mic with 1-3 waves
  // on red as the desktop voice does, so the two modes look alike.
  let frame = 0;
  let wave = null;
  function animate(want) {
    if (want && !wave) {
      frame = 0;
      wave = setInterval(() => {
        frame++;
        render();
      }, HEAR_FRAME_MS);
    } else if (!want && wave) {
      clearInterval(wave);
      wave = null;
    }
  }

  function render() {
    const st = last;
    animate(active() && st.on && !!st.hearing);
    if (active()) showSend(st.on ? st.phase : null);
    if (!active()) return;
    if (starting && !st.on) {
      item.text = "$(loading~spin) 음성 켜는 중";
      item.tooltip = "음성 엔진을 켜는 중이에요";
      item.backgroundColor = undefined;
    } else if (!st.on && st.phase === "speaking") {
      item.text = "$(unmute) 답변 읽는 중";
      item.tooltip = "타이핑한 질문의 답을 읽는 중이에요. 누르면 멈춰요.";
      item.backgroundColor = undefined;
    } else if (!st.on) {
      item.text = "$(mic) 음성";
      item.tooltip = "aglink 음성 — 누르면 켜요 (Ctrl+Alt+V). 메뉴는 옆의 ▾.";
      item.backgroundColor = undefined;
    } else if (st.hearing) {
      const look = stateLook(st, frame);
      item.text = `${look.icon} ${look.text}`;
      item.tooltip = "말소리가 들어오고 있어요. 누르면 꺼요 (Ctrl+Alt+V).";
      item.backgroundColor = new vscode.ThemeColor(look.bg);
    } else {
      item.text = `${ICONS[st.phase] || "$(mic)"} ${st.label}`;
      const s = settings.get();
      item.tooltip = `음성 켜짐 — ${voiceLabel(s.voice)} 목소리, ${s.speed}배, 받아쓰기 ${st.whisper === "gpu" ? "그래픽카드" : st.whisper === "cpu" ? "CPU" : "준비 중"}. 누르면 꺼요 (Ctrl+Alt+V). 메뉴는 옆의 ▾.`;
      item.backgroundColor = st.phase === "problem" ? new vscode.ThemeColor("statusBarItem.errorBackground") : new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    item.show();
  }

  function changed() {
    render();
    for (const fn of listeners) fn();
  }

  // ---- the answers: Claude Code's Stop hook posts each finished turn ----

  // answerLag is how long after Claude Code wrote its last answer to the
  // transcript the hook reached us, or null when that cannot be told. Only for
  // the log: it shows how much of the wait before the reading is the hook's.
  function answerLag(transcript, receivedAt) {
    try {
      if (!transcript) return null;
      const size = fs.statSync(transcript).size;
      const n = Math.min(size, 256 * 1024);
      const b = Buffer.alloc(n);
      const fd = fs.openSync(transcript, "r");
      try {
        fs.readSync(fd, b, 0, n, size - n);
      } finally {
        fs.closeSync(fd);
      }
      const lines = b.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"assistant"')) continue;
        try {
          const e = JSON.parse(lines[i]);
          if (e.type === "assistant" && e.timestamp) return receivedAt - Date.parse(e.timestamp);
        } catch {}
      }
    } catch {}
    return null;
  }

  function onTurn(h) {
    // Claude Code runs the hook for every session on this PC (the CLI,
    // aglink's); only VS Code's answers are read.
    if (h.entrypoint && h.entrypoint !== "claude-vscode") return;
    const md = h.last_assistant_message;
    if (!md) return;
    const receivedAt = Date.now();
    const lag = answerLag(h.transcript_path, receivedAt);
    log(`voice: answer arrived${lag != null ? ` ${lag} ms after Claude Code wrote it` : ""}`);
    if (conv) conv.answerAt = receivedAt;
    if (conv && conv.onReply(md)) return; // the answer to what was said
    if (!settings.get().readTyped || elsewhere()) return;
    void reader().then((c) => {
      if (c && c.readTyped(md)) idleLater();
    });
  }

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
          onTurn(h);
        });
      });
      srv.once("error", reject);
      srv.listen(STANDALONE_PORT, "127.0.0.1", () => resolve(srv));
    });
  }

  async function ensureServer() {
    if (server) return;
    if (ensureStopHook()) log("voice: Claude Code Stop hook added to ~/.claude/settings.json");
    try {
      server = await listen();
    } catch (e) {
      throw new Error(e.code === "EADDRINUSE" ? "다른 VS Code 창에서 음성을 쓰고 있어요." : e.message);
    }
  }

  function closeServer() {
    if (server) server.close();
    server = null;
  }

  // ---- the engine ----

  // ensureCore starts the engine (and the conversation it serves) if it is not
  // running; whisper adds recognition to one started for reading only.
  async function ensureCore(whisper) {
    if (!engine) {
      if (!core) core = startCore(whisper);
      try {
        await core;
      } finally {
        core = null;
      }
    }
    if (whisper && engine) await engine.ensureWhisper();
  }

  async function startCore(whisper) {
    const { exe, root } = enginePaths(cfg());
    if (!fs.existsSync(exe)) throw new Error(`음성 엔진이 설치되어 있지 않아요 (${exe}). aglink 음성 설치 파일을 먼저 실행해 주세요.`);
    const e = new Engine(exe, root, log, { whisper });
    e.on("exit", (code) => {
      if (engine !== e) return;
      const wasOn = voiceOn();
      log(`voice: engine exited (${code})`);
      teardown();
      if (wasOn) vscode.window.showWarningMessage("aglink 음성: 음성 엔진이 멈춰서 음성을 껐어요. 다시 켜 주세요.");
    });
    await e.start();
    engine = e;
    conv = new Conversation({
      engine: e,
      settings,
      store,
      send,
      newConversation: () => vscode.commands.executeCommand("claude-vscode.newConversation"),
      log: (m) => log(`voice: ${m}`),
    });
    conv.on("state", (st) => {
      last = st;
      render();
      if (!st.on && st.phase !== "speaking" && engine === e) idleLater(); // a reading with voice off has ended
    });
    conv.on("off", () => void stop());
  }

  // teardown stops everything: the conversation, the engine, and the hook
  // server unless typed questions' answers are still to be read.
  function teardown() {
    clearTimeout(readerTimer);
    readerTimer = null;
    const c = conv;
    const e = engine;
    conv = null;
    engine = null; // first, so the last state from c.stop() does not start an idle timer
    if (c) c.stop();
    if (e) e.stop();
    if (!settings.get().readTyped) closeServer();
    last = { on: false, phase: "off", label: "음성 꺼짐" };
    changed();
  }

  // reader gives the conversation for reading only, starting the engine
  // without the mic or Whisper if voice is off.
  async function reader() {
    try {
      await ensureCore(false);
      return conv;
    } catch (e) {
      log(`voice: reading failed: ${e.message}`);
      return null;
    }
  }

  // idleLater stops an engine kept only for reading once it has had nothing to
  // read for a while.
  function idleLater() {
    clearTimeout(readerTimer);
    readerTimer = null;
    if (voiceOn() || starting) return;
    readerTimer = setTimeout(() => {
      if (!voiceOn() && !starting && !(conv && conv.speaking)) teardown();
    }, READER_IDLE_MS);
  }

  // ---- on / off ----

  async function start() {
    clearTimeout(readerTimer);
    readerTimer = null;
    await ensureServer();
    await ensureCore(true);
    await conv.start();
  }

  async function stop() {
    if (conv) conv.stop();
    if (settings.get().readTyped && engine) {
      idleLater(); // kept a while for typed questions' answers
      changed();
    } else teardown();
  }

  async function toggle() {
    if (starting) return;
    if (voiceOn()) {
      await stop();
      return;
    }
    starting = start();
    render();
    try {
      await starting;
    } catch (e) {
      log(`voice: start failed: ${e.message}`);
      starting = null;
      await stop();
      vscode.window.showErrorMessage(`aglink 음성: ${e.message}`);
    } finally {
      starting = null;
      changed();
    }
  }

  async function ensureOn() {
    if (!voiceOn()) await toggle();
    return voiceOn();
  }

  // readTyped turned on: the hook server listens from now on (the engine
  // starts with the first answer); turned off with voice off: all goes.
  async function syncReadTyped() {
    if (settings.get().readTyped) {
      try {
        await ensureServer();
      } catch (e) {
        log(`voice: typed answers will not be read here: ${e.message}`);
      }
    } else if (!voiceOn() && !starting) teardown();
  }
  void syncReadTyped();

  return {
    toggle,
    render,
    syncReadTyped,
    get on() {
      return voiceOn();
    },
    get speaking() {
      return !!(conv && conv.speaking);
    },
    stopReading() {
      if (conv) conv.stopSpeaking();
    },
    sendNow() {
      if (conv) conv.sendNow();
    },
    skipReading() {
      if (conv) conv.skipReading();
    },
    // enroll records the user's voice (turning voice on for it if need be).
    async enroll() {
      if (!(await ensureOn())) return;
      await conv.enroll();
    },
    unenroll() {
      store.set("speaker", null);
      if (conv) conv.forgetUserLevel();
      else store.set("userLevel", null);
      log("voice: speaker enrollment cleared");
      changed();
    },
    get enrolled() {
      return !!store.get("speaker");
    },
    // preview reads a sample in the current voice and speed; voice need not be on.
    async preview() {
      const c = voiceOn() ? conv : await reader();
      if (!c) {
        vscode.window.showErrorMessage("aglink 음성: 음성 엔진을 켜지 못했어요. 출력 창의 'aglink 음성' 기록을 확인해 주세요.");
        return;
      }
      await c.preview();
      idleLater();
    },
    // devices lists the PC's recording and output devices by the names the
    // engine opens them by; voice need not be on.
    async devices() {
      const c = voiceOn() ? conv : await reader();
      if (!c || !engine) throw new Error("음성 엔진을 켜지 못했어요");
      const r = await engine.call("devices");
      idleLater();
      return { inputs: r.inputs || [], outputs: r.outputs || [] };
    },
    // micDeviceChanged applies a newly picked mic while voice is on.
    micDeviceChanged() {
      if (conv) void conv.micDeviceChanged();
    },
    onChange(fn) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    dispose() {
      clearTimeout(readerTimer);
      animate(false);
      const c = conv;
      conv = null;
      if (c) c.stop();
      if (engine) engine.stop();
      engine = null;
      closeServer();
    },
  };
}

module.exports = { createStandalone, enginePaths, readSettings, SETTING_KEYS };
