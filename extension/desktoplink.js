// Voice conversation with Claude Code in this window through the aglink
// desktop app, when it is running: its wake word, Whisper recognition,
// enrolled-voice check and Supertonic reading are used as they are, with the
// desktop's voice settings (desktop/vscodevoice.go in the aglink repo has the
// other side). Without the desktop app, standalone.js does the same on the
// bundled engine.
//
// - This window keeps GET /vscode/events open on the desktop app and turns the
//   voice on or off for itself with POST /vscode/attach (status bar button).
// - What the user says arrives as {type:"prompt", text}: it goes on the
//   clipboard, Claude Code's input box takes the focus, and POST /vscode/paste
//   has the desktop press Ctrl+V, Enter in this window. Claude Code has no way
//   to submit a prompt from outside, so keys are the only way in.
// - Claude Code's Stop hook (hook.js) posts each finished turn back to the
//   desktop, which reads the answer out.
"use strict";

const http = require("http");
const { DESKTOP_PORT: PORT, ensureStopHook } = require("./hook");

const MIN_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

// parseEvents pulls complete "data:" events out of a server-sent event stream
// buffer; it returns them and what is left over for the next chunk.
function parseEvents(buf) {
  const events = [];
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch (e) {
      // not ours
    }
  }
  return { events, rest: buf };
}

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "Content-Type": "application/json" }, timeout: 5000 },
      (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => {
          if (res.statusCode >= 300) reject(new Error(s.trim() || `HTTP ${res.statusCode}`));
          else resolve(s ? JSON.parse(s) : {});
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEAR_FRAME_MS = 300;

// stateLook is how the button shows what the desktop voice is doing. Sound
// coming in is a mic with 1-3 waves (media/aglink-icons.woff, frame cycles)
// on the red of a recording light, so it stands out from plain listening.
function stateLook(st, frame = 0) {
  if (st.hearing) return { icon: `$(aglink-hear-${(frame % 3) + 1})`, text: "듣는 중", bg: "statusBarItem.errorBackground" };
  switch (st.phase) {
    case "preparing": // the desktop's recognition is still loading
      return { icon: "$(loading~spin)", text: "준비 중", bg: "statusBarItem.warningBackground" };
    case "listening":
      return { icon: "$(mic-filled)", text: "말씀하세요", bg: "statusBarItem.warningBackground" };
    case "transcribing":
      return { icon: "$(loading~spin)", text: "알아듣는 중", bg: "statusBarItem.warningBackground" };
    case "waiting":
      return { icon: "$(watch)", text: "답 기다리는 중", bg: "statusBarItem.warningBackground" };
    case "speaking":
    case "done":
      return { icon: "$(unmute)", text: "읽는 중", bg: "statusBarItem.warningBackground" };
    case "problem":
      return { icon: "$(warning)", text: "문제가 있어요", bg: "statusBarItem.errorBackground" };
    default:
      return { icon: "$(mic-filled)", text: "음성 켜짐", bg: "statusBarItem.warningBackground" };
  }
}

// createVoice links this window to the desktop app. It draws on the shared
// status bar item only while active() (the desktop is the voice in use) and
// tells onLink when the desktop app comes and goes.
function createVoice(vscode, log, { item, active = () => true, onLink = () => {}, showSend = () => {} } = {}) {
  let req = null;
  let linked = false; // the event stream to the desktop app is open
  let on = false;
  let state = {}; // the desktop voice's last {phase, label, hearing}
  let stopped = false;
  let retry = null;
  let backoff = MIN_BACKOFF_MS;

  function identity() {
    const f = vscode.workspace.workspaceFolders;
    return {
      folder: f && f.length && f[0].uri.scheme === "file" ? f[0].uri.fsPath : "",
      title: vscode.workspace.name || "",
      pid: process.ppid, // the VS Code main process, which owns the window
    };
  }

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
    animate(!stopped && active() && linked && on && !!state.hearing);
    if (active()) showSend(linked && on ? state.phase : null);
    if (!active()) return;
    if (!linked) {
      item.text = "$(mic) 음성";
      item.tooltip = "aglink 데스크톱이 꺼져 있어요";
      item.backgroundColor = undefined;
    } else if (on) {
      const look = stateLook(state, frame);
      item.text = `${look.icon} ${look.text}`;
      item.tooltip = `${state.label ? state.label + "\n" : ""}aglink 데스크톱 음성으로 Claude Code 와 대화 중이에요. 설정은 데스크톱 앱을 따라요. 누르면 꺼요 (Ctrl+Alt+V). 메뉴는 옆의 ▾.`;
      item.backgroundColor = new vscode.ThemeColor(look.bg);
    } else {
      item.text = "$(mic) 음성";
      item.tooltip = "누르면 aglink 데스크톱 음성으로 대화를 켜요 (Ctrl+Alt+V)";
      item.backgroundColor = undefined;
    }
    item.show();
  }

  async function onPrompt(text) {
    const old = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(text);
    await vscode.commands.executeCommand("claude-vscode.focus");
    await sleep(250);
    let res;
    try {
      res = await post("/vscode/paste", identity());
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    log(`voice prompt ${res.ok ? "sent" : `not sent: ${res.error}`}`);
    if (!res.ok) {
      vscode.window.showWarningMessage(`aglink 음성: ${res.error}`);
      return; // the words stay on the clipboard
    }
    await sleep(800);
    await vscode.env.clipboard.writeText(old);
  }

  function connect() {
    if (stopped) return;
    const q = new URLSearchParams(Object.entries(identity()).map(([k, v]) => [k, String(v)])).toString();
    let buf = "";
    req = http.get({ host: "127.0.0.1", port: PORT, path: `/vscode/events?${q}` }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return;
      }
      linked = true;
      backoff = MIN_BACKOFF_MS;
      onLink(true);
      render();
      log("voice: linked to aglink desktop");
      // The desktop app restarted while voice was on: take it again.
      if (on) post("/vscode/attach", { on: true, ...identity() }).catch(() => {});
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        const r = parseEvents(buf + chunk.replace(/\r/g, ""));
        buf = r.rest;
        for (const ev of r.events) {
          if (ev.type === "prompt" && ev.text) onPrompt(ev.text).catch((e) => log(`voice prompt failed: ${e.message}`));
          else if (ev.type === "attached" && !ev.on) {
            on = false;
            state = {};
            render();
          } else if (ev.type === "state") {
            state = ev;
            render();
          }
        }
      });
    });
    req.on("close", () => {
      req = null;
      const was = linked;
      if (linked) log("voice: aglink desktop gone");
      linked = false;
      if (was) onLink(false);
      render();
      if (stopped) return;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
    req.on("error", () => {}); // close follows
  }

  async function toggle() {
    if (!linked) {
      vscode.window.showWarningMessage("aglink 데스크톱 앱이 켜져 있지 않아요. 앱을 켠 뒤 다시 눌러 주세요.");
      return;
    }
    const want = !on;
    if (want) {
      try {
        if (ensureStopHook()) log("voice: Claude Code Stop hook added to ~/.claude/settings.json");
      } catch (e) {
        vscode.window.showErrorMessage(`aglink 음성: Claude Code 설정에 답 읽기를 넣지 못했어요 — ${e.message}`);
        return;
      }
    }
    try {
      await post("/vscode/attach", { on: want, ...identity() });
      on = want;
      if (!on) state = {};
    } catch (e) {
      vscode.window.showWarningMessage(`aglink 음성: ${e.message}`);
    }
    render();
  }

  async function sendNow() {
    try {
      await post("/vscode/send", {});
    } catch (e) {
      log(`voice send failed: ${e.message}`);
    }
  }

  async function skipReading() {
    try {
      await post("/vscode/skip", {});
    } catch (e) {
      log(`voice skip failed: ${e.message}`);
    }
  }

  render();
  connect();
  return {
    toggle,
    sendNow,
    skipReading,
    render,
    get linked() {
      return linked;
    },
    get on() {
      return on;
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      animate(false);
      clearTimeout(retry);
      if (on && linked) post("/vscode/attach", { on: false, ...identity() }).catch(() => {});
      if (req) req.destroy();
    },
  };
}

module.exports = { createVoice, parseEvents, stateLook, HEAR_FRAME_MS };
