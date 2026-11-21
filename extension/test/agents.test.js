"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { AGENTS, pickAgent, agentOfTab } = require("../agents");
const { NOTIFY_MARK, NOTIFY_SCRIPT, notifyLine, hasNotify, withNotify, installCodexNotify, codexConfigPath } = require("../codexnotify");

test("the target setting picks the agent; auto follows the one last seen, else Claude Code", () => {
  assert.strictEqual(pickAgent(undefined).id, "claude");
  assert.strictEqual(pickAgent("claude", "codex").id, "claude");
  assert.strictEqual(pickAgent("codex").id, "codex");
  assert.strictEqual(pickAgent("auto", null).id, "claude");
  assert.strictEqual(pickAgent("auto", "codex").id, "codex");
  assert.strictEqual(AGENTS.claude.focus, "claude-vscode.focus");
  assert.strictEqual(AGENTS.codex.focus, "chatgpt.openSidebar");
  assert.strictEqual(AGENTS.codex.newConversation, "chatgpt.newChat");
});

test("agentOfTab knows Claude Code's and Codex's chat tabs", () => {
  assert.strictEqual(agentOfTab({ input: { viewType: "mainThreadWebview-claudeVSCodePanel" } }), "claude");
  assert.strictEqual(agentOfTab({ input: { viewType: "chatgpt.conversationEditor" } }), "codex");
  assert.strictEqual(agentOfTab({ input: { uri: {} } }), null);
  assert.strictEqual(agentOfTab(undefined), null);
});

test("the notify line goes among the top-level keys and never replaces an existing notify", () => {
  const line = notifyLine(["C:", "Users", "me", ".aglink-voice", "aglink-voice-codex-notify.js"].join(String.fromCharCode(92)));
  assert.strictEqual(line, 'notify = ["node", "C:/Users/me/.aglink-voice/aglink-voice-codex-notify.js"]');
  const toml = 'model = "gpt-5"\n\n[projects."C:/w"]\ntrust_level = "trusted"\n';
  const out = withNotify(toml, line);
  assert.ok(out.indexOf(line) < out.indexOf("[projects"), "before the first table");
  assert.ok(out.startsWith('model = "gpt-5"\n'));
  assert.ok(out.endsWith('trust_level = "trusted"\n'));
  assert.strictEqual(withNotify('notify = ["say"]\n', line), null);
  assert.ok(hasNotify('  notify = ["x"]'));
  assert.ok(!hasNotify("[tui]\nnotifications = true\n"));
  assert.ok(withNotify("", line).includes(line));
});

test("installCodexNotify writes only after the click, and leaves another notify alone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agv-codex-"));
  const env = { CODEX_HOME: path.join(home, ".codex") };
  const old = process.env.AGLINK_VOICE_HOME;
  process.env.AGLINK_VOICE_HOME = path.join(home, ".aglink-voice");
  let answer;
  const shown = [];
  let copied = null;
  const vscode = {
    window: {
      showInformationMessage: async (m, ...rest) => (shown.push(m), typeof rest[0] === "object" ? answer : undefined),
      showWarningMessage: async (m) => (shown.push(m), answer),
      showErrorMessage: async (m) => shown.push(m),
    },
    env: { clipboard: { writeText: async (t) => (copied = t) } },
  };
  try {
    const file = codexConfigPath(home, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt-5"\n');
    answer = undefined; // dismissed
    assert.strictEqual(await installCodexNotify(vscode, () => {}, { home, env }), false);
    assert.strictEqual(fs.readFileSync(file, "utf8"), 'model = "gpt-5"\n', "nothing written without the click");
    answer = "줄 복사";
    await installCodexNotify(vscode, () => {}, { home, env });
    assert.match(copied, /^notify = \["node", ".*aglink-voice-codex-notify\.js"\]$/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), 'model = "gpt-5"\n');
    answer = "추가";
    assert.strictEqual(await installCodexNotify(vscode, () => {}, { home, env }), true);
    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.includes(NOTIFY_MARK) && after.includes(copied));
    assert.strictEqual(fs.readFileSync(path.join(home, ".aglink-voice", `${NOTIFY_MARK}.js`), "utf8"), NOTIFY_SCRIPT);

    fs.writeFileSync(file, 'notify = ["my-notifier"]\n');
    assert.strictEqual(await installCodexNotify(vscode, () => {}, { home, env }), false);
    assert.strictEqual(fs.readFileSync(file, "utf8"), 'notify = ["my-notifier"]\n', "another notify is never replaced");
    assert.match(shown[shown.length - 1], /다른 notify/);
  } finally {
    if (old === undefined) delete process.env.AGLINK_VOICE_HOME;
    else process.env.AGLINK_VOICE_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the notify script ignores what is not a finished turn and exits at once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agv-notify-"));
  const f = path.join(dir, "n.js");
  fs.writeFileSync(f, NOTIFY_SCRIPT);
  for (const arg of ['{"type":"approval-requested"}', "not json"]) {
    const r = spawnSync(process.execPath, [f, arg], { timeout: 5000 });
    assert.strictEqual(r.status, 0);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
