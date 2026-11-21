// The coding agents a spoken question can go to, and their VS Code commands:
// Claude Code (anthropic.claude-code) and Codex (openai.chatgpt). The
// aglinkVoice.target setting picks one; "auto" takes the one whose chat tab
// was in front last (or whose answer came last), else Claude Code.
"use strict";

const AGENTS = {
  claude: {
    id: "claude",
    name: "Claude Code",
    extension: "anthropic.claude-code",
    focus: "claude-vscode.focus", // "Claude Code: Focus input"
    newConversation: "claude-vscode.newConversation",
  },
  codex: {
    id: "codex",
    name: "Codex",
    extension: "openai.chatgpt",
    // "Open Codex Sidebar": shows the Codex view and focuses it (its chat
    // input takes the keys); there is no separate focus-input command.
    focus: "chatgpt.openSidebar",
    newConversation: "chatgpt.newChat", // opens the sidebar, then a new chat
  },
};

// pickAgent: the agent for the target setting; recent is the id last seen in
// use (for "auto").
function pickAgent(target, recent) {
  if (target === "codex") return AGENTS.codex;
  if (target === "auto" && AGENTS[recent]) return AGENTS[recent];
  return AGENTS.claude;
}

// agentOfTab tells which agent's chat an editor tab is, from its input's
// viewType: Claude Code's panel is the webview "claudeVSCodePanel", Codex's a
// custom editor "chatgpt.conversationEditor". Null for anything else.
function agentOfTab(tab) {
  const vt = String((tab && tab.input && tab.input.viewType) || "");
  if (/claudeVSCodePanel/i.test(vt)) return "claude";
  if (/chatgpt\./i.test(vt)) return "codex";
  return null;
}

module.exports = { AGENTS, pickAgent, agentOfTab };
