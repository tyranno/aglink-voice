// clipboardSender hands spoken words to Claude Code the only way there is:
// they go on the clipboard, Claude Code's input box takes the focus, and
// something (the engine, or the desktop app) presses Ctrl+V, Enter. The
// clipboard is then given back — but only if it still holds our words: what
// the user copied meanwhile is left alone. Sends run one at a time, so a
// second one waits for the first's restore and never takes its words for the
// user's clipboard. Used by standalone.js and desktoplink.js.
"use strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// clipboard: {readText, writeText}; focus() puts the focus in Claude Code's
// input box (throws if it cannot); deliver() presses the keys and resolves
// {ok, error}. A failed send leaves the words on the clipboard to paste by hand.
function clipboardSender({ clipboard, focus, deliver, log = () => {}, focusWaitMs = 250, restoreWaitMs = 800, wait = sleep }) {
  let chain = Promise.resolve();

  // ctx is handed to focus() as is (the agent this send goes to).
  async function once(text, ctx) {
    const old = await clipboard.readText();
    await clipboard.writeText(text);
    try {
      await focus(ctx);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    await wait(focusWaitMs);
    let res;
    try {
      if ((await clipboard.readText()) !== text) {
        return { ok: false, error: "전송 전에 클립보드가 바뀌어 보내지 않았어요. 다시 말씀해 주세요." };
      }
      res = await deliver();
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || "보내지 못했어요" };
    await wait(restoreWaitMs); // the paste reads the clipboard a moment after the keys
    try {
      if ((await clipboard.readText()) === text) await clipboard.writeText(old);
    } catch (e) {
      // Claude Code or Codex already got the prompt. Reporting a failed send
      // here would discard its reply or encourage the user to send it twice.
      log(`clipboard restore failed: ${e.message}`);
    }
    return { ok: true };
  }

  return function send(text, ctx) {
    const run = chain.then(() => once(text, ctx));
    chain = run.catch(() => {});
    return run;
  };
}

module.exports = { clipboardSender };
