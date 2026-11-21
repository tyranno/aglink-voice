"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
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

test("Codex notify uses the window bridge, while local and direct SSH still work", () => {
  function send(env) {
    const sent = [];
    const exit = new Error("script exited");
    try {
      vm.runInNewContext(NOTIFY_SCRIPT, {
        process: { argv: [JSON.stringify({ type: "agent-turn-complete" })], env, exit: () => { throw exit; } },
        setTimeout: () => {},
        require: () => ({ request: (options) => { sent.push(options); return { on() {}, end() {} }; } }),
      });
    } catch (e) {
      if (e !== exit) throw e;
    }
    return sent;
  }
  const ssh = { SSH_CONNECTION: "192.0.2.10 10000 192.0.2.20 22", AGLINK_VOICE_TOKEN: "direct-token" };
  const [bridge] = send({ ...ssh, AGLINK_VOICE_PORT: "41234", AGLINK_BRIDGE_TOKEN: "window-token" });
  assert.strictEqual(bridge.host, "127.0.0.1");
  assert.strictEqual(bridge.port, 41234);
  assert.strictEqual(bridge.path, "/stop");
  assert.strictEqual(bridge.headers.Authorization, "Bearer window-token");
  assert.strictEqual(send(ssh)[0].host, "192.0.2.10");
  assert.strictEqual(send({})[0].port, 48231);
  assert.strictEqual(send({ ...ssh, AGLINK_VOICE_PORT: "41234" }).length, 0);
  assert.strictEqual(send({ ...ssh, AGLINK_VOICE_PORT: "70000", AGLINK_BRIDGE_TOKEN: "window-token" }).length, 0);
});

test("Codex notify setup writes to the current remote server only after confirmation", async () => {
  const files = new Map();
  const writes = [];
  const paths = {
    config: "/home/example/.codex/config.toml",
    script: "/home/example/.aglink-voice/aglink-voice-codex-notify.js",
    commandPath: "/home/example/.aglink-voice/aglink-voice-codex-notify.js",
  };
  function uri(parts = {}) {
    return { scheme: "vscode-remote", authority: "ssh-remote+test-host", path: "/work", ...parts, with(next) { return uri({ ...this, ...next }); } };
  }
  let pick;
  const vscode = {
    env: { remoteName: "ssh-remote" },
    commands: { executeCommand: async (name) => {
      assert.strictEqual(name, "aglink.bridge.codexNotifyPaths");
      return paths;
    } },
    window: {
      showInformationMessage: async () => pick,
      showWarningMessage: async () => undefined,
      showErrorMessage: (message) => assert.fail(message),
    },
    workspace: {
      workspaceFolders: [{ uri: uri() }],
      fs: {
        readFile: async (u) => {
          if (!files.has(u.path)) throw Object.assign(new Error("missing"), { code: "FileNotFound" });
          return Buffer.from(files.get(u.path));
        },
        createDirectory: async () => {},
        writeFile: async (u, bytes) => {
          assert.strictEqual(u.authority, "ssh-remote+test-host");
          files.set(u.path, bytes.toString("utf8"));
          writes.push(u.path);
        },
      },
    },
  };
  files.set(paths.config, 'model = "gpt-5"\n');
  assert.strictEqual(await installCodexNotify(vscode, () => {}, { node: false }), false);
  assert.deepStrictEqual(writes, []);
  pick = "추가";
  assert.strictEqual(await installCodexNotify(vscode, () => {}, { node: false }), true);
  assert.deepStrictEqual(writes, [paths.script, paths.config]);
  assert.ok(files.get(paths.config).includes(notifyLine(paths.commandPath)));
  assert.strictEqual(files.get(paths.script), NOTIFY_SCRIPT);
  files.set(paths.script, "old script");
  await installCodexNotify(vscode, () => {}, { node: false });
  assert.deepStrictEqual(writes, [paths.script, paths.config, paths.script]);
});

test("remote Codex notify names the node the bridge found, and an old line of ours is updated only on 갱신", async () => {
  const files = new Map();
  const writes = [];
  const paths = {
    config: "/home/example/.codex/config.toml",
    script: "/home/example/.aglink-voice/aglink-voice-codex-notify.js",
    commandPath: "/home/example/.aglink-voice/aglink-voice-codex-notify.js",
    node: "/home/example/.nvm/versions/node/v26.13.1/bin/node",
  };
  function uri(parts = {}) {
    return { scheme: "vscode-remote", authority: "ssh-remote+test-host", path: "/work", ...parts, with(next) { return uri({ ...this, ...next }); } };
  }
  let pick;
  const asked = [];
  const vscode = {
    env: { remoteName: "ssh-remote" },
    commands: { executeCommand: async () => paths },
    window: {
      showInformationMessage: async (msg, opts, ...items) => {
        if (items.length) asked.push(items[0]);
        return items.length ? pick : undefined;
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: (message) => assert.fail(message),
    },
    workspace: {
      workspaceFolders: [{ uri: uri() }],
      fs: {
        readFile: async (u) => {
          if (!files.has(u.path)) throw Object.assign(new Error("missing"), { code: "FileNotFound" });
          return Buffer.from(files.get(u.path));
        },
        createDirectory: async () => {},
        writeFile: async (u, bytes) => {
          files.set(u.path, bytes.toString("utf8"));
          writes.push(u.path);
        },
      },
    },
  };
  const want = notifyLine(paths.commandPath, paths.node);
  assert.ok(want.startsWith(`notify = ["${paths.node}", `));

  // A config from 0.5.29's first build: ours, on a bare "node".
  const old = `model = "gpt-5"\n# ${NOTIFY_MARK}: x\n${notifyLine(paths.commandPath)}\n\n[tui]\nx = 1\n`;
  files.set(paths.config, old);
  pick = undefined;
  assert.strictEqual(await installCodexNotify(vscode, () => {}, { node: false }), false);
  assert.deepStrictEqual(asked, ["갱신"]);
  assert.deepStrictEqual(writes, [], "dismissed: nothing written");
  pick = "갱신";
  assert.strictEqual(await installCodexNotify(vscode, () => {}, { node: false }), true);
  assert.strictEqual(files.get(paths.config), old.replace(notifyLine(paths.commandPath), want));
  assert.strictEqual(files.get(paths.script), NOTIFY_SCRIPT);

  // Another program's notify is still never replaced.
  writes.length = 0;
  files.set(paths.config, 'notify = ["other-tool"]\n');
  assert.strictEqual(await installCodexNotify(vscode, () => {}, { node: false }), false);
  assert.ok(!writes.includes(paths.config));
});
