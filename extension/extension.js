// aglink voice for Claude Code in VS Code: say a request, hear the answer.
//
// Fully standalone: always the engine installed with this extension
// (standalone.js), with the settings under aglinkVoice.* here. It has NO
// connection to the aglink desktop app — recognition, reading and the Stop
// hook all stay within this extension.
//
// The mic button turns voice on and off; the gear beside it opens a menu of
// the everyday settings; settingsPanel.js is the full settings screen. The
// menu's pickers are palette commands too.
"use strict";

const vscode = require("vscode");
const { createStandalone } = require("./standalone");
const { openSettings } = require("./settingsPanel");
const { TTS_VOICES, VOICE_COMMANDS, voiceLabel } = require("./core/text");
const { installCodexNotify } = require("./codexnotify");
const { hasNode } = require("./hook");
const { ensureVocabFile } = require("./core/vocab");

const SPEEDS = [0.8, 0.9, 0.98, 1.1, 1.2, 1.35, 1.5];
const LISTEN_MODES = [
  { value: "wake", label: "호출어로 시작", description: "\"아글링크\" 라고 부를 때 대화가 시작돼요" },
  { value: "always", label: "켜면 바로 대화", description: "부르지 않아도 바로 들어요" },
  { value: "manual", label: "켤 때만 듣기", description: "\"그만\" 하면 음성이 꺼져요" },
];
const WALKTHROUGH = "aglink.aglink-voice#aglinkVoice.start";

let disposeAll = () => {};

function activate(context) {
  const out = vscode.window.createOutputChannel("aglink 음성");
  const log = (m) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  // The mic and the gear are one control in two halves: same name, adjacent
  // priorities, and the gear takes on whatever background the mic shows, so
  // the pair reads as a single block rather than two extensions side by side.
  // Left side, far left: the right side is the one VS Code clips when the bar
  // is crowded or the window narrow, and this must always stay visible.
  const micItem = vscode.window.createStatusBarItem("aglinkVoice.mic", vscode.StatusBarAlignment.Left, 100000);
  micItem.name = "aglink 음성";
  micItem.command = "aglinkVoice.primary";
  // A shared accent colour and a ▾ for the menu half make the pair read as one
  // split button; with a background set, VS Code uses its own foreground.
  const accent = new vscode.ThemeColor("charts.blue");
  micItem.color = accent;
  const item = new Proxy(micItem, {
    get: (t, k) => (typeof t[k] === "function" ? t[k].bind(t) : t[k]),
    set: (t, k, v) => {
      t[k] = v;
      if (k === "backgroundColor") menuItem.backgroundColor = v;
      return true;
    },
  });
  const menuItem = vscode.window.createStatusBarItem("aglinkVoice.menu", vscode.StatusBarAlignment.Left, 99999.9);
  menuItem.name = "aglink 음성";
  menuItem.text = "$(chevron-down)";
  menuItem.color = accent;
  menuItem.tooltip = "aglink 음성 메뉴 — 목소리, 빠르기, 마이크, 말 명령 등";
  menuItem.command = "aglinkVoice.menu";
  menuItem.show();
  // Shown only while listening: the room may never go quiet enough for the
  // end of the words to be noticed, so they can be sent by hand.
  const sendItem = vscode.window.createStatusBarItem("aglinkVoice.send", vscode.StatusBarAlignment.Left, 99999.8);
  sendItem.name = "aglink 음성 보내기";
  sendItem.text = "$(send) 보내기";
  sendItem.color = accent;
  sendItem.tooltip = "듣기를 멈추고 지금까지 들은 말을 바로 보내요 (Ctrl+Alt+Enter)";
  sendItem.command = "aglinkVoice.sendNow";
  // Shown only while a reply is read: a long one can be cut short to go on.
  const skipItem = vscode.window.createStatusBarItem("aglinkVoice.skip", vscode.StatusBarAlignment.Left, 99999.8);
  skipItem.name = "aglink 음성 그만 읽기";
  skipItem.text = "$(debug-step-over) 그만 읽기";
  skipItem.color = accent;
  skipItem.tooltip = "답변 읽기를 여기서 멈추고 바로 다음 말을 들어요 (Esc 또는 Ctrl+Alt+Enter)";
  skipItem.command = "aglinkVoice.skipReading";
  // Shown only while an answer is awaited: one that never comes (no Stop hook,
  // an interrupted turn) would hold the mic shut, so the wait can be dropped
  // without switching voice off and on.
  const waitItem = vscode.window.createStatusBarItem("aglinkVoice.unwait", vscode.StatusBarAlignment.Left, 99999.8);
  waitItem.name = "aglink 음성 대기 그만";
  waitItem.text = "$(debug-stop) 대기 그만";
  waitItem.color = accent;
  waitItem.tooltip = "답을 그만 기다리고 바로 다음 말을 들어요. 음성은 켜 둔 채예요 (Ctrl+Alt+Enter)";
  waitItem.command = "aglinkVoice.stopWaiting";
  let shownPhase = null; // the voice's phase as last drawn, for Ctrl+Alt+Enter
  const showSend = (phase) => {
    shownPhase = phase;
    if (phase === "listening") sendItem.show();
    else sendItem.hide();
    if (phase === "speaking") skipItem.show();
    else skipItem.hide();
    if (phase === "waiting") waitItem.show();
    else waitItem.hide();
  };

  const cfg = () => vscode.workspace.getConfiguration("aglinkVoice");
  const standalone = createStandalone(vscode, context, log, { item, showSend, showLog: () => out.show(true) });
  const render = () => standalone.render();
  render();

  // note shows a short line on the status bar, for a key that had nothing to do.
  const note = (text) => vscode.window.setStatusBarMessage(`aglink 음성: ${text}`, 3000);

  const sendNow = () => standalone.sendNow();
  const skipReading = () => standalone.skipReading();
  const stopWaiting = () => standalone.stopWaiting();
  // Ctrl+Alt+Enter moves the conversation on: a reading is cut short, a wait
  // is dropped, a listening is sent. Otherwise it says why nothing happened.
  const next = () => {
    if (shownPhase === "speaking" || standalone.speaking) return skipReading();
    if (shownPhase === "waiting") return stopWaiting();
    if (shownPhase === "listening") return sendNow();
    if (!standalone.on) return note("음성이 꺼져 있어요 — Ctrl+Alt+V 로 켜요");
    if (shownPhase === "transcribing") return note("알아듣는 중이에요. 잠시만 기다려 주세요");
    if (shownPhase === "wake") return note("지금은 넘길 것이 없어요 — 먼저 호출어로 불러 주세요");
    return note("지금은 넘길 것이 없어요");
  };
  const toggle = () => standalone.toggle();
  // The mic button: on/off, or stop a reading that is playing with voice off.
  const primary = () => (standalone.speaking && !standalone.on ? standalone.stopReading() : toggle());
  const set = (key, value) => cfg().update(key, value, vscode.ConfigurationTarget.Global);

  const pickMic = () => pickDevice("micDevice", "inputs", "듣는 마이크");
  const pickOutput = () => pickDevice("outputDevice", "outputs", "읽어 주는 소리가 나올 곳");
  const settingsHost = {
    status: () => ({ on: standalone.on, enrolled: standalone.enrolled }),
    onChange: (fn) => standalone.onChange(fn),
    toggle,
    preview: () => standalone.preview(),
    enroll: () => standalone.enroll(),
    unenroll: () => standalone.unenroll(),
    pickMic,
    pickOutput,
  };

  async function pickVoice() {
    const now = cfg().get("voice");
    const pick = await vscode.window.showQuickPick(
      TTS_VOICES.map((v) => ({ label: `${v === now ? "$(check) " : ""}${voiceLabel(v)}`, value: v })),
      { title: "읽어 주는 목소리", placeHolder: "고르면 그 목소리로 한 번 읽어 줘요" },
    );
    if (!pick) return;
    await set("voice", pick.value);
    await standalone.preview();
  }

  async function pickSpeed() {
    const now = cfg().get("speed");
    const pick = await vscode.window.showQuickPick(
      SPEEDS.map((v) => ({ label: `${v === now ? "$(check) " : ""}${v}배`, description: v === 0.98 ? "보통" : v < 0.98 ? "천천히" : "빨리", value: v })),
      { title: "읽는 빠르기", placeHolder: "1 이 보통이에요. 더 세밀하게는 설정 화면에서 바꿔요" },
    );
    if (!pick) return;
    await set("speed", pick.value);
    await standalone.preview();
  }

  // pickDevice chooses the mic (key "micDevice", the engine's inputs) or where
  // the reading plays (key "outputDevice", its outputs). Blank is Windows'
  // default, which follows whatever Windows has chosen — a headset included.
  async function pickDevice(key, kind, title) {
    let list;
    try {
      list = (await standalone.devices())[kind];
    } catch (e) {
      const pick = await vscode.window.showErrorMessage(`aglink 음성: 장치 목록을 읽지 못했어요 — ${e.message}`, "출력 창 보기");
      if (pick) out.show(true);
      return;
    }
    const now = cfg().get(key) || "";
    const mark = (v) => (v === now ? "$(check) " : "");
    const items = [{ label: `${mark("")}윈도우 기본 장치`, description: "윈도우 소리 설정에서 고른 장치를 따라가요", value: "" }];
    for (const name of list) if (name) items.push({ label: `${mark(name)}${name}`, value: name });
    if (now && !list.includes(now)) items.push({ label: `$(check) ${now}`, description: "지금 연결되어 있지 않아요 (윈도우 기본 장치로 들어요)", value: now });
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: kind === "inputs" ? "블루투스 이어폰은 켠 뒤 몇 초 지나야 소리가 들어와요" : "고르면 그 장치로 한 번 읽어 줘요",
    });
    if (!pick) return;
    await set(key, pick.value);
    if (kind === "outputs") await standalone.preview();
  }

  const deviceLabel = (v) => v || "윈도우 기본";
  const TARGETS = [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "auto", label: "자동", description: "마지막으로 쓴 쪽 (모르면 Claude Code)" },
  ];
  const targetLabel = (v) => (TARGETS.find((t) => t.value === v) || TARGETS[0]).label;
  const listenLabel = (v) => (LISTEN_MODES.find((m) => m.value === v) || LISTEN_MODES[0]).label;

  // pickTarget chooses where spoken questions go.
  async function pickTarget() {
    const now = cfg().get("target") || "claude";
    const pick = await vscode.window.showQuickPick(
      TARGETS.map((t) => ({ ...t, label: `${t.value === now ? "$(check) " : ""}${t.label}` })),
      { title: "말한 질문을 보낼 곳", placeHolder: "Codex 의 답을 읽으려면 'Codex 답 읽기 설정' 도 한 번 해 주세요" },
    );
    if (pick) await set("target", pick.value);
  }

  // pickListenMode chooses when listening starts once voice is on.
  async function pickListenMode() {
    const now = cfg().get("listenMode") || "wake";
    const pick = await vscode.window.showQuickPick(
      LISTEN_MODES.map((m) => ({ ...m, label: `${m.value === now ? "$(check) " : ""}${m.label}` })),
      { title: "언제부터 들을지" },
    );
    if (pick) await set("listenMode", pick.value);
  }

  // toggleSetting flips an on/off setting and says what it is now.
  async function toggleSetting(key, what) {
    const v = !cfg().get(key);
    await set(key, v);
    note(`${what}: ${v ? "켜짐" : "꺼짐"}`);
  }
  const toggleTextOnly = () => toggleSetting("textOnly", "읽기 끄기 (음성 입력만)");
  const toggleBarge = () => toggleSetting("barge", "읽는 중에 말하면 멈추기");

  // voiceCommands lists what can be said (core/text.js VOICE_COMMANDS), by group.
  async function voiceCommands() {
    const items = [];
    let group = "";
    for (const c of VOICE_COMMANDS) {
      if (c.group !== group) {
        group = c.group;
        items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
      }
      items.push({ label: `$(comment) ${c.says[0]}`, description: c.does, detail: c.says.length > 1 ? `이렇게도: ${c.says.slice(1).join(" · ")}` : undefined });
    }
    await vscode.window.showQuickPick(items, {
      title: "말 명령 — 대화 중에 이렇게 말하면 돼요",
      placeHolder: "명령은 문장 전체가 그 말일 때만 알아들어요. 그 밖의 말은 질문으로 보내요",
      matchOnDescription: true,
      matchOnDetail: true,
    });
  }

  // copyLastAnswer puts the last answer this window got on the clipboard.
  async function copyLastAnswer() {
    const md = standalone.lastAnswer;
    if (!md) {
      note("아직 복사할 답이 없어요");
      return;
    }
    await vscode.env.clipboard.writeText(md);
    note("마지막 답을 복사했어요");
  }

  // readSelection reads the editor's selection, or what is on screen.
  async function readSelection() {
    if (!(await standalone.readSelection())) note("읽을 글이 없어요 — 편집기에서 읽을 부분을 골라 주세요");
  }

  // toggleDictation starts or ends 받아 적기 (what is said goes to the cursor).
  async function toggleDictation() {
    const on = !standalone.dictating;
    if (await standalone.setDictation(on)) note(on ? "받아 적기 시작 — \"받아 적기 끝\" 하면 마쳐요" : "받아 적기를 마쳤어요");
  }

  // pickAnswer reads one of the last few answers again.
  async function pickAnswer() {
    const list = standalone.recentAnswers();
    if (!list.length) {
      note("아직 받은 답이 없어요");
      return;
    }
    const firstLine = (md) => String(md).replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
    const pick = await vscode.window.showQuickPick(
      list.map((md, i) => ({ label: `${i === 0 ? "$(star-full) " : ""}${firstLine(md).slice(0, 80) || "(글 없음)"}`, description: i === 0 ? "마지막 답" : `${i + 1}번째 전`, md })),
      { title: "최근 답 다시 듣기", placeHolder: "고르면 그 답을 다시 읽어 줘요" },
    );
    if (pick) await standalone.readAnswer(pick.md);
  }

  // pickHistory resends one of the recent spoken requests.
  async function pickHistory() {
    const list = standalone.history();
    if (!list.length) {
      void vscode.window.showInformationMessage("aglink 음성: 아직 말로 보낸 요청이 없어요.");
      return;
    }
    const when = (at) => (at ? new Date(at).toLocaleString() : "");
    const pick = await vscode.window.showQuickPick(
      list.map((h) => ({ label: h.text, description: when(h.at), text: h.text })),
      { title: "최근에 말한 요청 다시 보내기", placeHolder: "고르면 그대로 한 번 더 보내고 답을 읽어 줘요", matchOnDescription: true },
    );
    if (pick) await standalone.resend(pick.text);
  }

  // menu: the status bar button. On/off first, then the settings changed most.
  async function menu() {
    const on = standalone.on;
    const items = [{ label: on ? "$(mic-filled) 음성 대화 끄기" : "$(mic) 음성 대화 켜기", description: "Ctrl+Alt+V", run: toggle }];
    if (standalone.speaking) items.push({ label: "$(debug-stop) 읽기 멈추기", description: "Esc", run: () => standalone.stopReading() });
    if (shownPhase === "waiting") items.push({ label: "$(debug-stop) 답 그만 기다리기", description: "음성은 켜 둔 채 바로 다음 말을 들어요", run: stopWaiting });
    const s = cfg();
    const onOff = (v) => (v ? "켜짐" : "꺼짐");
    items.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(comment-discussion) 말 명령 도움말", description: "대화 중에 쓸 수 있는 말", run: voiceCommands },
      { label: "$(history) 최근 요청 다시 보내기", run: pickHistory },
      { label: "$(copy) 마지막 답 복사", run: copyLastAnswer },
      { label: "$(unmute) 최근 답 다시 듣기", run: pickAnswer },
      { label: "$(book) 고른 글 읽어 주기", description: "편집기에서 고른 부분, 없으면 화면에 보이는 글", run: readSelection },
      { label: standalone.dictating ? "$(edit) 받아 적기 끝내기" : "$(edit) 받아 적기 시작", description: "말한 것을 커서 자리에 적어요", run: toggleDictation },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: `$(hubot) 보낼 곳: ${targetLabel(s.get("target"))}`, run: pickTarget },
      { label: `$(ear) 듣기 방식: ${listenLabel(s.get("listenMode"))}`, run: pickListenMode },
      { label: "$(bell) Codex 답 읽기 설정", description: "Codex 의 답을 소리로 듣기 (config.toml 의 notify)", run: () => vscode.commands.executeCommand("aglinkVoice.installCodexNotify") },
      { label: `$(person) 목소리: ${voiceLabel(s.get("voice") || "M2")}`, run: pickVoice },
      { label: `$(dashboard) 빠르기: ${s.get("speed")}배`, run: pickSpeed },
      { label: `$(play) 지금 목소리로 들어 보기`, run: () => standalone.preview() },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: `$(record) 마이크: ${deviceLabel(s.get("micDevice"))}`, run: pickMic },
      { label: `$(unmute) 소리 나올 곳: ${deviceLabel(s.get("outputDevice"))}`, run: pickOutput },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: `$(list-flat) 긴 답은 요점만 읽기: ${onOff(s.get("summary"))}`, run: () => set("summary", !s.get("summary")) },
      { label: `$(file-text) 읽기 끄기 (음성 입력만): ${onOff(s.get("textOnly"))}`, run: () => set("textOnly", !s.get("textOnly")) },
      { label: `$(keyboard) 타이핑한 질문 답도 읽기: ${onOff(s.get("readTyped"))}`, run: () => set("readTyped", !s.get("readTyped")) },
      { label: `$(debug-pause) 읽는 중에 말하면 멈추기: ${onOff(s.get("barge"))}`, run: () => set("barge", !s.get("barge")) },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(book) 단어장 열기", description: "잘 알아듣게 할 단어 · 고쳐 쓸 말 · 스니펫", run: openVocab },
      { label: "$(milestone) 처음 사용 안내", description: "설치부터 첫 대화까지", run: openWalkthrough },
      { label: "$(gear) 설정 화면 열기", description: "모든 설정과 설명", run: () => openSettings(vscode, settingsHost) },
    );
    const pick = await vscode.window.showQuickPick(items, { title: "aglink 음성" });
    if (pick && pick.run) await pick.run();
  }

  const openWalkthrough = () => vscode.commands.executeCommand("workbench.action.openWalkthrough", WALKTHROUGH, false);

  // openVocab opens the personal vocabulary (~/.aglink/voice-words.json, the
  // desktop app's too) in an editor, creating an empty one first.
  async function openVocab() {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ensureVocabFile()));
      await vscode.window.showTextDocument(doc);
    } catch (e) {
      vscode.window.showErrorMessage(`aglink 음성: 단어장을 열지 못했어요 (${e.message})`);
    }
  }

  context.subscriptions.push(
    out,
    micItem,
    menuItem,
    sendItem,
    waitItem,
    skipItem,
    vscode.commands.registerCommand("aglinkVoice.toggle", toggle),
    vscode.commands.registerCommand("aglinkVoice.sendNow", sendNow),
    vscode.commands.registerCommand("aglinkVoice.skipReading", skipReading),
    vscode.commands.registerCommand("aglinkVoice.stopWaiting", stopWaiting),
    vscode.commands.registerCommand("aglinkVoice.next", next),
    // The mic button's own command; hidden from the palette (toggle is the public one).
    vscode.commands.registerCommand("aglinkVoice.primary", primary),
    vscode.commands.registerCommand("aglinkVoice.menu", menu),
    vscode.commands.registerCommand("aglinkVoice.openSettings", () => openSettings(vscode, settingsHost)),
    vscode.commands.registerCommand("aglinkVoice.stopReading", () => standalone.stopReading()),
    vscode.commands.registerCommand("aglinkVoice.enroll", settingsHost.enroll),
    vscode.commands.registerCommand("aglinkVoice.unenroll", settingsHost.unenroll),
    vscode.commands.registerCommand("aglinkVoice.preview", settingsHost.preview),
    vscode.commands.registerCommand("aglinkVoice.openVocab", openVocab),
    vscode.commands.registerCommand("aglinkVoice.installCodexNotify", () => installCodexNotify(vscode, log, { node: hasNode() })),
    vscode.commands.registerCommand("aglinkVoice.pickTarget", pickTarget),
    vscode.commands.registerCommand("aglinkVoice.pickVoice", pickVoice),
    vscode.commands.registerCommand("aglinkVoice.pickSpeed", pickSpeed),
    vscode.commands.registerCommand("aglinkVoice.pickMic", pickMic),
    vscode.commands.registerCommand("aglinkVoice.pickOutput", pickOutput),
    vscode.commands.registerCommand("aglinkVoice.pickListenMode", pickListenMode),
    vscode.commands.registerCommand("aglinkVoice.toggleTextOnly", toggleTextOnly),
    vscode.commands.registerCommand("aglinkVoice.toggleBarge", toggleBarge),
    vscode.commands.registerCommand("aglinkVoice.voiceCommands", voiceCommands),
    vscode.commands.registerCommand("aglinkVoice.copyLastAnswer", copyLastAnswer),
    vscode.commands.registerCommand("aglinkVoice.resendRecent", pickHistory),
    vscode.commands.registerCommand("aglinkVoice.openWalkthrough", openWalkthrough),
    vscode.commands.registerCommand("aglinkVoice.readSelection", readSelection),
    vscode.commands.registerCommand("aglinkVoice.toggleDictation", toggleDictation),
    vscode.commands.registerCommand("aglinkVoice.recentAnswers", pickAnswer),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aglinkVoice")) render();
      if (e.affectsConfiguration("aglinkVoice.readTyped")) void standalone.syncReadTyped();
      if (e.affectsConfiguration("aglinkVoice.micDevice") || e.affectsConfiguration("aglinkVoice.echoCancel")) standalone.micDeviceChanged();
      if (e.affectsConfiguration("aglinkVoice.listenMode")) standalone.listenModeChanged();
    }),
  );
  disposeAll = () => {
    standalone.dispose();
  };
}

function deactivate() {
  disposeAll();
}

module.exports = { activate, deactivate };
