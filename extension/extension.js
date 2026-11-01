// aglink voice for Claude Code in VS Code: say a request, hear the answer.
//
// Two ways to the same conversation, one status bar button:
// - the aglink desktop app, when it is running (desktoplink.js) — its voice
//   and settings are used as they are;
// - otherwise the engine installed with this extension (standalone.js), with
//   the settings under aglinkVoice.* here.
// aglinkVoice.source picks one for good; "auto" prefers the desktop app.
"use strict";

const vscode = require("vscode");
const { createVoice } = require("./desktoplink");
const { createStandalone } = require("./standalone");

let disposeAll = () => {};

function activate(context) {
  const out = vscode.window.createOutputChannel("aglink 음성");
  const log = (m) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  item.command = "aglinkVoice.toggle";

  let desktop = null;
  let standalone = null;
  const source = () => vscode.workspace.getConfiguration("aglinkVoice").get("source") || "auto";
  // mode: which of the two the button is for right now. One that is on keeps it.
  const mode = () => {
    if (standalone && standalone.on) return "standalone";
    if (desktop && desktop.on && desktop.linked) return "desktop";
    const src = source();
    if (src === "desktop" || src === "standalone") return src;
    return desktop && desktop.linked ? "desktop" : "standalone";
  };
  const render = () => (mode() === "desktop" ? desktop : standalone)?.render();

  standalone = createStandalone(vscode, context, log, { item, active: () => mode() === "standalone" });
  desktop = createVoice(vscode, log, { item, active: () => mode() === "desktop", onLink: render });
  render();

  const standaloneOnly = (fn) => async () => {
    if (mode() === "desktop") {
      vscode.window.showInformationMessage("aglink 데스크톱 앱의 음성을 쓰는 중이에요. 목소리 등록과 설정은 데스크톱 앱에서 해 주세요.");
      return;
    }
    await fn();
  };

  context.subscriptions.push(
    out,
    item,
    vscode.commands.registerCommand("aglinkVoice.toggle", () => (mode() === "desktop" ? desktop.toggle() : standalone.toggle())),
    vscode.commands.registerCommand("aglinkVoice.enroll", standaloneOnly(() => standalone.enroll())),
    vscode.commands.registerCommand("aglinkVoice.preview", standaloneOnly(() => standalone.preview())),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aglinkVoice")) render();
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
