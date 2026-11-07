// aglink voice for Claude Code in VS Code: say a request, hear the answer.
//
// Two ways to the same conversation, one status bar button:
// - the aglink desktop app, when it is running (desktoplink.js) — its voice
//   and settings are used as they are;
// - otherwise the engine installed with this extension (standalone.js), with
//   the settings under aglinkVoice.* here.
// aglinkVoice.source picks one for good; "auto" prefers the desktop app.
//
// The mic button turns voice on and off; the gear beside it opens a menu of
// the everyday settings; settingsPanel.js is the full settings screen.
"use strict";

const vscode = require("vscode");
const { createVoice } = require("./desktoplink");
const { createStandalone } = require("./standalone");
const { openSettings } = require("./settingsPanel");
const { TTS_VOICES, voiceLabel } = require("./core/text");

const SPEEDS = [0.8, 0.9, 0.98, 1.1, 1.2, 1.35, 1.5];

let disposeAll = () => {};

function activate(context) {
  const out = vscode.window.createOutputChannel("aglink 음성");
  const log = (m) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  // The mic and the gear are one control in two halves: same name, adjacent
  // priorities, and the gear takes on whatever background the mic shows, so
  // the pair reads as a single block rather than two extensions side by side.
  const micItem = vscode.window.createStatusBarItem("aglinkVoice.mic", vscode.StatusBarAlignment.Right, 1000);
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
  const menuItem = vscode.window.createStatusBarItem("aglinkVoice.menu", vscode.StatusBarAlignment.Right, 999.9);
  menuItem.name = "aglink 음성";
  menuItem.text = "$(chevron-down)";
  menuItem.color = accent;
  menuItem.tooltip = "aglink 음성 메뉴 — 목소리, 빠르기, 마이크 등";
  menuItem.command = "aglinkVoice.menu";
  menuItem.show();

  let desktop = null;
  let standalone = null;
  const cfg = () => vscode.workspace.getConfiguration("aglinkVoice");
  const source = () => cfg().get("source") || "auto";
  // mode: which of the two the button is for right now. One that is on keeps it.
  const mode = () => {
    if (standalone && standalone.on) return "standalone";
    if (desktop && desktop.on && desktop.linked) return "desktop";
    const src = source();
    if (src === "desktop" || src === "standalone") return src;
    return desktop && desktop.linked ? "desktop" : "standalone";
  };
  const render = () => (mode() === "desktop" ? desktop : standalone)?.render();

  standalone = createStandalone(vscode, context, log, { item, active: () => mode() === "standalone", elsewhere: () => !!(desktop && desktop.on && desktop.linked) });
  desktop = createVoice(vscode, log, { item, active: () => mode() === "desktop", onLink: render });
  render();

  const toggle = () => (mode() === "desktop" ? desktop.toggle() : standalone.toggle());
  // The mic button: on/off, or stop a reading that is playing with voice off.
  const primary = () => (mode() === "standalone" && standalone.speaking && !standalone.on ? standalone.stopReading() : toggle());
  const standaloneOnly = (fn) => async () => {
    if (mode() === "desktop") {
      vscode.window.showInformationMessage("aglink 데스크톱 앱의 음성을 쓰는 중이에요. 목소리 등록과 설정은 데스크톱 앱에서 해 주세요.");
      return;
    }
    await fn();
  };
  const set = (key, value) => cfg().update(key, value, vscode.ConfigurationTarget.Global);

  const settingsHost = {
    status: () => ({ on: mode() === "desktop" ? desktop.on : standalone.on, enrolled: standalone.enrolled, desktop: mode() === "desktop" }),
    onChange: (fn) => standalone.onChange(fn),
    toggle,
    preview: standaloneOnly(() => standalone.preview()),
    enroll: standaloneOnly(() => standalone.enroll()),
    unenroll: () => standalone.unenroll(),
    pickMic: standaloneOnly(() => pickDevice("micDevice", "inputs", "듣는 마이크")),
    pickOutput: standaloneOnly(() => pickDevice("outputDevice", "outputs", "읽어 주는 소리가 나올 곳")),
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
      vscode.window.showErrorMessage(`aglink 음성: 장치 목록을 읽지 못했어요 — ${e.message}`);
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

  // menu: the status bar button. On/off first, then the settings changed most.
  async function menu() {
    const on = mode() === "desktop" ? desktop.on : standalone.on;
    const items = [{ label: on ? "$(mic-filled) 음성 대화 끄기" : "$(mic) 음성 대화 켜기", description: "Ctrl+Alt+V", run: toggle }];
    if (standalone.speaking) items.push({ label: "$(debug-stop) 읽기 멈추기", run: () => standalone.stopReading() });
    if (mode() === "desktop") {
      items.push({ label: "$(info) 데스크톱 앱의 음성을 쓰는 중", description: "설정은 데스크톱 앱에서 바꿔요", run: () => {} });
    } else {
      const s = cfg();
      const onOff = (v) => (v ? "켜짐" : "꺼짐");
      items.push(
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: `$(person) 목소리: ${voiceLabel(s.get("voice") || "M2")}`, run: pickVoice },
        { label: `$(dashboard) 빠르기: ${s.get("speed")}배`, run: pickSpeed },
        { label: `$(play) 지금 목소리로 들어 보기`, run: () => standalone.preview() },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: `$(record) 마이크: ${deviceLabel(s.get("micDevice"))}`, run: () => pickDevice("micDevice", "inputs", "듣는 마이크") },
        { label: `$(unmute) 소리 나올 곳: ${deviceLabel(s.get("outputDevice"))}`, run: () => pickDevice("outputDevice", "outputs", "읽어 주는 소리가 나올 곳") },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: `$(list-flat) 긴 답은 요점만 읽기: ${onOff(s.get("summary"))}`, run: () => set("summary", !s.get("summary")) },
        { label: `$(file-text) 말로 물어도 답은 글로만: ${onOff(s.get("textOnly"))}`, run: () => set("textOnly", !s.get("textOnly")) },
        { label: `$(keyboard) 타이핑한 질문 답도 읽기: ${onOff(s.get("readTyped"))}`, run: () => set("readTyped", !s.get("readTyped")) },
        { label: `$(debug-pause) 읽는 중에 말하면 멈추기: ${onOff(s.get("barge"))}`, run: () => set("barge", !s.get("barge")) },
      );
    }
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(gear) 설정 화면 열기", description: "모든 설정과 설명", run: () => openSettings(vscode, settingsHost) });
    const pick = await vscode.window.showQuickPick(items, { title: "aglink 음성" });
    if (pick && pick.run) await pick.run();
  }

  context.subscriptions.push(
    out,
    micItem,
    menuItem,
    vscode.commands.registerCommand("aglinkVoice.toggle", toggle),
    vscode.commands.registerCommand("aglinkVoice.primary", primary),
    vscode.commands.registerCommand("aglinkVoice.menu", menu),
    vscode.commands.registerCommand("aglinkVoice.openSettings", () => openSettings(vscode, settingsHost)),
    vscode.commands.registerCommand("aglinkVoice.stopReading", () => standalone.stopReading()),
    vscode.commands.registerCommand("aglinkVoice.enroll", settingsHost.enroll),
    vscode.commands.registerCommand("aglinkVoice.unenroll", settingsHost.unenroll),
    vscode.commands.registerCommand("aglinkVoice.preview", settingsHost.preview),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aglinkVoice")) render();
      if (e.affectsConfiguration("aglinkVoice.readTyped")) void standalone.syncReadTyped();
      if (e.affectsConfiguration("aglinkVoice.micDevice")) standalone.micDeviceChanged();
    }),
  );
  disposeAll = () => {
    desktop.dispose();
    standalone.dispose();
  };
}

function deactivate() {
  disposeAll();
}

module.exports = { activate, deactivate };
