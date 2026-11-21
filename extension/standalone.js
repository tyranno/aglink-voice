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
//   questions' answers are to be read (readTyped). Codex's notify script
//   (codexnotify.js) posts its turns there too, when aglinkVoice.target sends
//   to Codex (agents.js).
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
const { clipboardSender } = require("./core/clipsend");
const { turnFromHook } = require("./core/turns");
const { AGENTS, pickAgent, agentOfTab } = require("./agents");
const { NOTIFY_MARK, codexConfigPath } = require("./codexnotify");
const { TTS_VOICES, voiceLabel, cleanWakeNames } = require("./core/text");
const { STANDALONE_PORT, ensureStopHook, ownsTurn, hookAllowed } = require("./hook");
const { stateLook, HEAR_FRAME_MS } = require("./desktoplink");

const SECTION = "aglinkVoice";
const SETTING_KEYS = ["voice", "speed", "speakerMin", "listenMode", "wakeIdleMin", "summary", "wakeNames", "wakeDefault", "stopWords", "stopDefault", "textOnly", "readTyped", "barge", "bargeFast", "echoCancel", "micDevice", "outputDevice"];
const READER_IDLE_MS = 10 * 60000;

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
  let epoch = 0; // counts teardowns: a start that outlives one is dropped
  let last = { on: false, phase: "off", label: "음성 꺼짐" };
  const listeners = new Set(); // the settings panel, told when voice goes on or off

  const voiceOn = () => !!(conv && conv.isOn);

  function identity() {
    return { pid: process.ppid, title: vscode.workspace.name || "" }; // the VS Code main process owns the window
  }

  // send hands the words to Claude Code (see core/clipsend.js); a failure
  // (the engine found another window in front, say) comes back as {ok:false,
  // error} for the conversation to show.
  // The agent spoken questions go to (aglinkVoice.target, see agents.js);
  // for "auto", recentAgent is the one whose chat tab was in front last or
  // whose answer came last.
  let recentAgent = null;
  const agent = () => pickAgent(cfg().get("target"), recentAgent);
  const seeTab = () => {
    const a = agentOfTab(vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab);
    if (a) recentAgent = a;
  };
  const tabWatch = vscode.window.tabGroups ? [vscode.window.tabGroups.onDidChangeTabs(seeTab), vscode.window.tabGroups.onDidChangeTabGroups(seeTab)] : [];
  seeTab();
  // Codex's answers need our notify line in ~/.codex/config.toml, which is
  // only added on the user's click: the first send to Codex without it says so.
  let codexHinted = false;
  function hintCodexNotify() {
    if (codexHinted) return;
    codexHinted = true;
    let toml = "";
    try {
      toml = fs.readFileSync(codexConfigPath(), "utf8");
    } catch {}
    if (toml.includes(NOTIFY_MARK)) return;
    log("voice: Codex notify is not set up — Codex's answers will not be read");
    void vscode.window.showInformationMessage("aglink 음성: Codex 의 답을 읽으려면 Codex 설정(config.toml)에 알림 줄이 필요해요.", "설정 보기").then((pick) => {
      if (pick) void vscode.commands.executeCommand("aglinkVoice.installCodexNotify");
    });
  }
  // agentCommand runs one of the agent's commands, or says it is not installed.
  async function agentCommand(a, cmd) {
    const missing = new Error(`${a.name} 확장을 찾지 못했어요. 설치되어 있는지 확인해 주세요.`);
    if (vscode.extensions && !vscode.extensions.getExtension(a.extension)) throw missing;
    try {
      await vscode.commands.executeCommand(a[cmd]);
    } catch {
      throw missing;
    }
  }

  const send = clipboardSender({
    clipboard: vscode.env.clipboard,
    focus: () => {
      const a = agent();
      if (a.id === "codex") hintCodexNotify();
      return agentCommand(a, "focus");
    },
    deliver: () => (engine ? engine.call("paste", identity()) : { ok: false, error: "음성 엔진이 꺼져 있어요" }),
  });

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
    // aglink's); only VS Code's answers are read (see core/turns.js).
    const turn = turnFromHook(h);
    if (!turn) return;
    // Only this window's folder: another window's answer is read there (or by
    // the desktop app), not here as well.
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => (f.uri.scheme === "file" ? f.uri.fsPath : f.uri.path));
    if (!ownsTurn(turn.cwd, folders)) return;
    const md = turn.md;
    if (!md) return;
    recentAgent = turn.agent;
    const receivedAt = Date.now();
    const lag = answerLag(turn.transcript, receivedAt);
    log(`voice: ${AGENTS[turn.agent].name} answer arrived${lag != null ? ` ${lag} ms after it was written` : ""}${turn.question === undefined ? " (its question unknown)" : ""}`);
    if (conv) conv.answerAt = receivedAt;
    if (conv && conv.onReply(md, turn)) return; // the answer to what was said
    if (!settings.get().readTyped || elsewhere()) return;
    void reader().then((c) => {
      if (c && c.readTyped(md)) idleLater();
    });
  }

  function listen() {
    // Loopback by default. When AGLINK_VOICE_TOKEN is set, bind the network
    // interfaces too (token-gated) so a Stop hook running on a remote server can
    // reach this PC's voice and have the reply read here. No token means no
    // network exposure.
    const tok = (process.env.AGLINK_VOICE_TOKEN || "").trim();
    const bindHost = tok ? "0.0.0.0" : "127.0.0.1";
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        // Our own Stop hook on loopback passes without a token; browser pages
        // and network peers without the token are refused (see hookAllowed).
        const ra = (req.socket && req.socket.remoteAddress) || "";
        if (!hookAllowed({ remoteAddress: ra, headers: req.headers }, tok)) {
          res.writeHead(401).end('{"error":"aglink-voice: not allowed"}');
          return;
        }
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
      srv.listen(STANDALONE_PORT, bindHost, () => resolve(srv));
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

  // startupOpts are the engine options read only when it starts.
  function startupOpts() {
    return { whisperServer: (cfg().get("whisperServer") || "").trim(), micCleanup: cfg().get("micCleanup") || "off" };
  }

  async function startCore(whisper) {
    const { exe, root } = enginePaths(cfg());
    if (!fs.existsSync(exe)) throw new Error(`음성 엔진이 설치되어 있지 않아요 (${exe}). aglink 음성 설치 파일을 먼저 실행해 주세요.`);
    const e = new Engine(exe, root, log, { whisper, ...startupOpts() });
    e.on("exit", (code) => {
      if (engine !== e) return;
      const wasOn = voiceOn();
      log(`voice: engine exited (${code})`);
      teardown();
      if (wasOn) vscode.window.showWarningMessage("aglink 음성: 음성 엔진이 멈춰서 음성을 껐어요. 다시 켜 주세요.");
    });
    const my = epoch;
    await e.start();
    if (my !== epoch) {
      // voice went off (or the window closed) while the engine was starting
      e.stop();
      throw new Error("음성 엔진을 켜는 동안 음성이 꺼졌어요");
    }
    engine = e;
    conv = new Conversation({
      engine: e,
      settings,
      store,
      send,
      newConversation: () => agentCommand(agent(), "newConversation"),
      agent: () => {
        const a = agent();
        return { id: a.id, name: a.name };
      },
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
    epoch++;
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
    // An engine kept for reading was started with the settings of its day;
    // whisperServer and micCleanup only take effect at startup, so restart it
    // if they changed meanwhile — otherwise off/on would silently keep the old.
    const want = startupOpts();
    if (engine && (engine.whisperServer !== want.whisperServer || engine.micCleanup !== want.micCleanup)) {
      log("voice: engine settings changed — restarting the engine");
      teardown();
    }
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
    stopWaiting() {
      if (conv) conv.stopWaiting();
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
      epoch++;
      clearTimeout(readerTimer);
      animate(false);
      for (const d of tabWatch) d.dispose();
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
