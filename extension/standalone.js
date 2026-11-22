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
const { createVocab } = require("./core/vocab");
const { turnFromHook } = require("./core/turns");
const { AGENTS, pickAgent, agentOfTab } = require("./agents");
const { codexNotifyConfigured } = require("./codexnotify");
const { TTS_VOICES, voiceLabel, cleanWakeNames, wakeNameLabel, fileNameScore } = require("./core/text");
const { STANDALONE_PORT, ensureStopHook, ownsTurn, hookAllowed } = require("./hook");
const { stateLook, HEAR_FRAME_MS } = require("./core/look");

const SECTION = "aglinkVoice";
const SETTING_KEYS = ["voice", "speed", "volume", "speakerMin", "listenMode", "wakeIdleMin", "summary", "wakeNames", "wakeDefault", "stopWords", "stopDefault", "textOnly", "readTyped", "barge", "bargeFast", "echoCancel", "micDevice", "outputDevice"];
const READER_IDLE_MS = 10 * 60000;
const HISTORY_KEEP = 20; // recent spoken requests kept for "최근 요청 다시 보내기"
const MIC_HINT_MS = 60000; // the mic-failure message is shown at most this often
const ANSWERS_KEEP = 5; // recent answers for "최근 답 다시 듣기"
const MAX_READ_CHARS = 4000; // "이거 읽어 줘" reads at most this much
const MAX_ATTACH_CHARS = 6000; // "이 파일 보고 …" sends at most this much of the selection
const MAX_PROBLEMS = 30; // "에러 보고 …" sends at most this many problems
const FILE_SEARCH_EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,__pycache__}/**";
const RELEASES_URL = "https://github.com/tyranno/aglink-voice/releases"; // the setup files

// targetText is where spoken questions go, as the button's tooltip says it:
// for "auto", also the one it goes to now.
function targetText(target, now) {
  if (target === "codex") return "Codex";
  if (target === "auto") return `자동 (지금은 ${now})`;
  return "Claude Code";
}

// rememberRequest puts text at the end of the recent requests, once.
function rememberRequest(list, text, keep = HISTORY_KEEP, at = Date.now()) {
  const t = String(text || "").trim();
  const out = (Array.isArray(list) ? list : []).filter((x) => x && x.text && x.text !== t);
  if (t) out.push({ text: t, at });
  return out.slice(-keep);
}

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
  if (!(s.volume > 0)) s.volume = 1;
  return s;
}

// showSend(phase) shows the buttons for the phase; showLog() opens the output
// channel (for the buttons on error messages).
function createStandalone(vscode, context, log, { item, showSend = () => {}, showLog = () => {} } = {}) {
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
  let lastAnswer = ""; // the last answer this window got, for "마지막 답 복사"
  const answers = []; // the last few answers this window got, newest last
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
  // The button's tooltip says where "auto" sends now, so a change is drawn.
  const seeTabAndDraw = () => {
    const before = recentAgent;
    seeTab();
    if (recentAgent !== before) render();
  };
  const tabWatch = vscode.window.tabGroups ? [vscode.window.tabGroups.onDidChangeTabs(seeTabAndDraw), vscode.window.tabGroups.onDidChangeTabGroups(seeTabAndDraw)] : [];
  seeTab();
  // Codex's answers need our notify line in ~/.codex/config.toml, which is
  // only added on the user's click: the first send to Codex without it says so.
  let codexHinted = false;
  async function hintCodexNotify() {
    if (codexHinted) return;
    codexHinted = true;
    if (await codexNotifyConfigured(vscode)) return;
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
    log,
    focus: (ctx) => {
      // A question said to one agent by name ("코덱스한테 …") goes there, and
      // "auto" follows it for the next ones.
      const a = ctx && AGENTS[ctx.agent] ? AGENTS[ctx.agent] : agent();
      if (ctx && AGENTS[ctx.agent]) recentAgent = a.id;
      if (a.id === "codex") hintCodexNotify();
      return agentCommand(a, "focus");
    },
    deliver: () => (engine ? engine.call("paste", identity()) : { ok: false, error: "음성 엔진이 꺼져 있어요" }),
  });

  // ---- the editor, for the spoken editor commands (core/conversation.js ide) ----

  // editor: the text editor in use. With Claude Code's panel in front there is
  // no active one, so the last one that was, if still on screen, or any shown.
  let lastEditor = vscode.window.activeTextEditor || null;
  const editorWatch = vscode.window.onDidChangeActiveTextEditor
    ? vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) lastEditor = e;
      })
    : null;
  function editor() {
    const shown = vscode.window.visibleTextEditors || [];
    return vscode.window.activeTextEditor || shown.find((e) => e === lastEditor) || shown[0] || null;
  }
  const baseName = (uri) => path.basename(uri.fsPath || uri.path || "");
  const selectedText = (e) =>
    e.selections
      .filter((s) => !s.isEmpty)
      .map((s) => e.document.getText(s))
      .join("\n");

  const ide = {
    // what "이거 읽어 줘" reads: the selection, else what is on screen
    async readable() {
      const e = editor();
      if (!e) return "";
      const text = selectedText(e) || (e.visibleRanges || []).map((r) => e.document.getText(r)).join("\n");
      return text.slice(0, MAX_READ_CHARS);
    },
    // 받아 적기: the words at the cursor, a space before them when they would
    // run into a word
    async insert(text) {
      const e = editor();
      if (!e) return false;
      const pos = e.selection.active;
      const before = pos.character > 0 ? e.document.lineAt(pos.line).text[pos.character - 1] : "";
      const piece = (before && !/\s/.test(before) ? " " : "") + text;
      return e.edit((b) => b.replace(e.selection, piece));
    },
    // "이 파일 보고 …": the file and the selection; "에러 보고 …": the problems
    async attach(kind) {
      if (kind === "errors") return problemsText();
      const e = editor();
      if (!e) return "";
      const rel = vscode.workspace.asRelativePath(e.document.uri);
      const sel = selectedText(e);
      if (!sel) return `(참고: 열린 파일 ${rel}, 커서는 ${e.selection.active.line + 1}번째 줄)`;
      const from = e.selection.start.line + 1;
      const to = e.selection.end.line + 1;
      return `(참고: ${rel} ${from === to ? `${from}번째 줄` : `${from}~${to}번째 줄`}에서 고른 부분)\n\`\`\`\n${sel.slice(0, MAX_ATTACH_CHARS)}\n\`\`\``;
    },
    async openFile(name) {
      const files = await vscode.workspace.findFiles("**/*", FILE_SEARCH_EXCLUDE, 5000);
      let best = 0;
      let found = [];
      for (const uri of files) {
        const sc = fileNameScore(name, baseName(uri));
        if (sc > best) [best, found] = [sc, [uri]];
        else if (sc && sc === best) found.push(uri);
      }
      if (!found.length) return `"${name}" 파일을 찾지 못했어요`;
      const open = async (uri) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
      if (found.length === 1) {
        await open(found[0]);
        return `📂 ${baseName(found[0])} 열었어요`;
      }
      // Not awaited: the conversation goes on while the list is up.
      void vscode.window
        .showQuickPick(
          found.slice(0, 50).map((uri) => ({ label: baseName(uri), description: vscode.workspace.asRelativePath(uri), uri })),
          { title: `"${name}" 파일이 여러 개예요`, placeHolder: "열 파일을 고르세요" },
        )
        .then((pick) => pick && open(pick.uri))
        .catch((e) => log(`voice: open file failed: ${e.message}`));
      return `📂 "${name}" 파일이 ${found.length}개라 목록을 띄웠어요`;
    },
    async action(name) {
      if (name === "saveAll") {
        await vscode.workspace.saveAll(false);
        return "💾 모두 저장했어요";
      }
      if (name === "terminal") {
        await vscode.commands.executeCommand("workbench.action.terminal.focus");
        return "터미널을 열었어요";
      }
      if (name === "save") {
        const e = editor();
        if (!e) return "저장할 파일이 없어요";
        if (!e.document.isDirty) return `${baseName(e.document.uri)} 은 이미 저장되어 있어요`;
        return (await e.document.save()) ? `💾 ${baseName(e.document.uri)} 저장했어요` : "저장하지 못했어요";
      }
      return "";
    },
  };

  // problemsText is the Problems list as lines for a request: errors and
  // warnings, those of the file in use first.
  function problemsText() {
    const sev = vscode.DiagnosticSeverity || { Error: 0, Warning: 1 };
    const e = editor();
    const current = e ? e.document.uri.toString() : "";
    const all = (vscode.languages.getDiagnostics() || []).filter(([, list]) => list.some((d) => d.severity <= sev.Warning));
    all.sort(([a], [b]) => (b.toString() === current) - (a.toString() === current));
    const lines = [];
    for (const [uri, list] of all) {
      for (const d of list) {
        if (d.severity > sev.Warning) continue;
        if (lines.length >= MAX_PROBLEMS) break;
        lines.push(`- ${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}: [${d.severity === sev.Error ? "오류" : "경고"}] ${String(d.message).split("\n")[0]}`);
      }
    }
    return lines.length ? `(참고: VS Code 문제 목록)\n${lines.join("\n")}` : "";
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

  // Context keys for keybindings: aglinkVoice.speaking (Esc stops the
  // reading) and aglinkVoice.on; set only when they change.
  const contextKeys = {};
  function setContext(key, value) {
    if (contextKeys[key] === value) return;
    contextKeys[key] = value;
    Promise.resolve(vscode.commands.executeCommand("setContext", `aglinkVoice.${key}`, value)).catch(() => {});
  }

  function render() {
    const st = last;
    animate(st.on && !!st.hearing);
    showSend(st.on ? st.phase : null);
    setContext("speaking", st.phase === "speaking");
    setContext("on", !!st.on);
    const to = `보낼 곳: ${targetText(cfg().get("target"), agent().name)}`;
    if (starting && !st.on) {
      item.text = "$(loading~spin) 음성 켜는 중";
      item.tooltip = "음성 엔진을 켜는 중이에요";
      item.backgroundColor = undefined;
    } else if (!st.on && st.phase === "speaking") {
      item.text = `$(unmute) ${st.label || "답변을 읽는 중"}`;
      item.tooltip = "타이핑한 질문의 답을 읽는 중이에요. 누르거나 Esc 를 누르면 멈춰요.";
      item.backgroundColor = undefined;
    } else if (!st.on) {
      item.text = "$(mic) 음성";
      item.tooltip = `aglink 음성 — 누르면 켜요 (Ctrl+Alt+V). 메뉴는 옆의 ▾.\n${to}`;
      item.backgroundColor = undefined;
    } else if (st.hearing) {
      const look = stateLook(st, frame);
      item.text = `${look.icon} ${look.text}`;
      item.tooltip = `말소리가 들어오고 있어요. 누르면 꺼요 (Ctrl+Alt+V).\n${to}`;
      item.backgroundColor = new vscode.ThemeColor(look.bg);
    } else {
      item.text = `${ICONS[st.phase] || "$(mic)"} ${st.label}`;
      const s = settings.get();
      const esc = st.phase === "speaking" ? " 읽는 중에는 Esc 로 멈춰요." : "";
      item.tooltip = `음성 켜짐 — ${voiceLabel(s.voice)} 목소리, ${s.speed}배, 받아쓰기 ${st.whisper === "gpu" ? "그래픽카드" : st.whisper === "cpu" ? "CPU" : "준비 중"}. 누르면 꺼요 (Ctrl+Alt+V). 메뉴는 옆의 ▾.${esc}\n${to}`;
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
    lastAnswer = md;
    answers.push(md);
    if (answers.length > ANSWERS_KEEP) answers.shift();
    if (recentAgent !== turn.agent) {
      recentAgent = turn.agent;
      render();
    }
    const receivedAt = Date.now();
    const lag = answerLag(turn.transcript, receivedAt);
    log(`voice: ${AGENTS[turn.agent].name} answer arrived${lag != null ? ` ${lag} ms after it was written` : ""}${turn.question === undefined ? " (its question unknown)" : ""}`);
    if (conv) conv.answerAt = receivedAt;
    if (conv && conv.onReply(md, turn)) return; // the answer to what was said
    if (!settings.get().readTyped) return;
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
    if (ensureStopHook()) {
      log("voice: Claude Code Stop hook added to ~/.claude/settings.json");
      void vscode.window.showInformationMessage("aglink 음성: Claude Code 의 답을 읽을 수 있도록 Claude Code 설정(~/.claude/settings.json)에 답 알림(Stop hook)을 넣었어요. 다른 설정은 그대로예요.");
    }
    try {
      server = await listen();
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      const err = new Error("다른 VS Code 창에서 음성을 쓰고 있어요. 그 창에서 음성을 끈 뒤 다시 켜 주세요.");
      err.kind = "portInUse";
      throw err;
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
    if (!fs.existsSync(exe)) {
      const err = new Error(`음성 엔진이 설치되어 있지 않아요 (${exe}). aglink 음성 설치 파일을 먼저 실행해 주세요.`);
      err.kind = "engineMissing";
      throw err;
    }
    const e = new Engine(exe, root, log, { whisper, ...startupOpts() });
    e.on("exit", (code) => {
      if (engine !== e) return;
      const wasOn = voiceOn();
      log(`voice: engine exited (${code})`);
      teardown();
      if (wasOn)
        void vscode.window.showWarningMessage("aglink 음성: 음성 엔진이 멈춰서 음성을 껐어요.", "다시 켜기", "출력 창 보기").then((pick) => {
          if (pick === "다시 켜기") void toggle();
          else if (pick) showLog();
        });
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
      // A send to Codex whose answers cannot come back (no notify line of
      // ours) is marked so the conversation does not wait for one.
      send: async (text, ctx) => {
        const res = await send(text, ctx);
        if (res && res.ok) store.set("history", rememberRequest(store.get("history"), text));
        if (res && res.ok && ctx && ctx.agent === "codex" && !(await codexNotifyConfigured(vscode)))
          return { ...res, noAnswer: "답은 읽지 못해요 (명령: aglink 음성: Codex 답 읽기 설정)" };
        return res;
      },
      newConversation: () => agentCommand(agent(), "newConversation"),
      agent: (id) => {
        const a = id && AGENTS[id] ? AGENTS[id] : agent();
        return { id: a.id, name: a.name };
      },
      copy: (text) => vscode.env.clipboard.writeText(text),
      ide,
      log: (m) => log(`voice: ${m}`),
      vocab: createVocab({ log: (m) => log(`voice: ${m}`) }), // ~/.aglink/voice-words.json, shared with the desktop app
    });
    conv.on("state", (st) => {
      last = st;
      render();
      if (!st.on && st.phase !== "speaking" && engine === e) idleLater(); // a reading with voice off has ended
    });
    conv.on("off", () => void stop());
    conv.on("help", () => void vscode.commands.executeCommand("aglinkVoice.voiceCommands"));
    conv.on("micFailed", (message) => micFailed(message));
  }

  // micFailed offers Windows' microphone privacy settings (an app not allowed
  // the mic is the usual cause) and the mic choice; not more than once a minute.
  let micHintAt = -Infinity;
  function micFailed(message) {
    if (Date.now() - micHintAt < MIC_HINT_MS) return;
    micHintAt = Date.now();
    void vscode.window
      .showWarningMessage(`aglink 음성: 마이크를 열 수 없어요 (${message}). 윈도우의 마이크 권한이나 고른 마이크를 확인해 주세요.`, "마이크 권한 설정 열기", "마이크 고르기")
      .then((pick) => {
        if (pick === "마이크 권한 설정 열기") void vscode.env.openExternal(vscode.Uri.parse("ms-settings:privacy-microphone"));
        else if (pick === "마이크 고르기") void vscode.commands.executeCommand("aglinkVoice.pickMic");
      });
  }

  // startError shows why voice could not be turned on, with what helps.
  function startError(e) {
    if (e.micFailed) {
      micHintAt = -Infinity;
      micFailed(e.message);
      return;
    }
    const buttons = e.kind === "engineMissing" ? ["설치 파일 받는 곳 열기", "엔진 위치 설정", "출력 창 보기"] : e.kind === "portInUse" ? ["다시 시도", "출력 창 보기"] : ["출력 창 보기"];
    void vscode.window.showErrorMessage(`aglink 음성: ${e.message}`, ...buttons).then((pick) => {
      if (pick === "설치 파일 받는 곳 열기") void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
      else if (pick === "엔진 위치 설정") void vscode.commands.executeCommand("workbench.action.openSettings", "aglinkVoice.enginePath");
      else if (pick === "다시 시도") void toggle();
      else if (pick === "출력 창 보기") showLog();
    });
  }

  // wakeHint: the first time voice goes on in wake mode, how to start talking.
  function wakeHint() {
    if (settings.get().listenMode !== "wake" || store.get("wakeHinted")) return;
    store.set("wakeHinted", true);
    const name = wakeNameLabel(settings.get());
    void vscode.window.showInformationMessage(`aglink 음성: '${name}'라고 부르면 대화가 시작돼요. 끝낼 때는 '그만'이라고 하세요.`, "항상 듣기로 바꾸기", "말 명령 보기").then(async (pick) => {
      if (pick === "항상 듣기로 바꾸기") await settings.set({ listenMode: "always" }); // the configuration change starts the conversation
      else if (pick === "말 명령 보기") void vscode.commands.executeCommand("aglinkVoice.voiceCommands");
    });
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
      if (voiceOn()) wakeHint();
    } catch (e) {
      log(`voice: start failed: ${e.message}`);
      starting = null;
      await stop();
      startError(e);
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
    // listenModeChanged starts the conversation when "always" is picked while
    // voice waits for the wake word.
    listenModeChanged() {
      if (conv && conv.isOn && !conv.conv && settings.get().listenMode === "always") conv.startConversation();
    },
    // The last answer this window got (to a spoken or a typed question), as written.
    get lastAnswer() {
      return lastAnswer;
    },
    ide, // the editor hooks the conversation uses (for checks)
    // recentAnswers: the last few answers this window got, newest first.
    recentAnswers() {
      return [...answers].reverse();
    },
    // readAnswer reads one of them again (a summary, as answers are read); voice need not be on.
    async readAnswer(md) {
      const c = voiceOn() ? conv : await reader();
      if (!c) return;
      await c.speak(md, c.speechMode());
      idleLater();
    },
    // readSelection reads the editor's selection (or what is on screen).
    async readSelection() {
      const text = String(await ide.readable()).trim();
      if (!text) return false;
      const c = voiceOn() ? conv : await reader();
      if (!c) return false;
      await c.speak(text, "full");
      idleLater();
      return true;
    },
    get dictating() {
      return !!(conv && conv.dictating);
    },
    // setDictation starts or ends 받아 적기, turning voice on for it if need be.
    async setDictation(on) {
      if (on && !(await ensureOn())) return false;
      return !!(conv && conv.setDictation(on));
    },
    // history: the recent spoken requests, newest first.
    history() {
      const list = store.get("history");
      return (Array.isArray(list) ? list : []).filter((x) => x && x.text).reverse();
    },
    // resend sends text again as if just said, turning voice on for it if need
    // be; it says so when it cannot (the user is talking, say).
    async resend(text) {
      if (!(await ensureOn())) return false;
      const ok = await conv.resend(text);
      if (!ok) void vscode.window.showWarningMessage("aglink 음성: 지금은 보낼 수 없어요. 듣거나 알아듣는 중이면 끝난 뒤에 다시 해 주세요.");
      return ok;
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
        void vscode.window.showErrorMessage("aglink 음성: 음성 엔진을 켜지 못했어요. 출력 창의 'aglink 음성' 기록을 확인해 주세요.", "출력 창 보기").then((pick) => {
          if (pick) showLog();
        });
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
      if (editorWatch) editorWatch.dispose();
      const c = conv;
      conv = null;
      if (c) c.stop();
      if (engine) engine.stop();
      engine = null;
      closeServer();
    },
  };
}

module.exports = { createStandalone, enginePaths, readSettings, targetText, rememberRequest, SETTING_KEYS };
