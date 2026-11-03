// Per-developer connection verification for /jira-dev-harness:connect.
//
// Pure decision logic over facts that Claude collected with read-only calls
// (ToolSearch, Atlassian and GitHub MCP reads) and facts that connect.cjs
// collected from the official `gh`. The plugin never reads, stores, or logs a
// credential: it sees account identities and tool names only. READY needs the
// developer's own typed confirmation of both account identities, which is
// recorded by the user-only injected `connect.cjs begin` command, never by
// Claude.

"use strict";

const STATUS = {
  VERIFIED: "VERIFIED",
  UNCONFIRMED: "UNCONFIRMED",
  NOT_CONNECTED: "NOT_CONNECTED",
  NEEDS_AUTH: "NEEDS_AUTH",
  INACCESSIBLE: "INACCESSIBLE",
  MISMATCH: "MISMATCH",
  BLOCKED: "BLOCKED",
};

// Where an MCP connection comes from, from its tool name
// (mcp__<server>__<tool>). Only a claude.ai connector is known to be
// account-level. A server added with `claude mcp add` is authorized through
// /mcp and stored by Claude Code on this machine. Anything else is unknown,
// and no isolation is claimed for it.
function classifySource(toolName) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(toolName || ""));
  if (!m) return "unknown";
  const server = m[1];
  if (/^claude_ai_/i.test(server)) return "claude-ai-connector";
  if (/^plugin_/i.test(server)) return "plugin-bundled";
  return "claude-code-mcp";
}

const ISOLATION = {
  "claude-ai-connector": "NOT guaranteed: a claude.ai connector belongs to the claude.ai account, so everyone signed in to the same Claude account shares it",
  "claude-code-mcp": "authorized through /mcp and stored by Claude Code on this machine, per operating-system user (not isolated if the OS user is shared)",
  "plugin-bundled": "unknown: a plugin-bundled server; this plugin does not bundle any",
  unknown: "unknown",
  "github-cli": "the official gh keeps its own sign-in on this machine, per operating-system user (not isolated if the OS user is shared)",
};

const norm = (s) => String(s || "").trim().toLowerCase();
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

function sourcesOf(tools) {
  return [...new Set(list(tools).map(classifySource))];
}

function warningsFor(sources) {
  const w = [];
  if (sources.includes("claude-ai-connector")) {
    w.push("This connection is a claude.ai connector. It is tied to the Claude account, not to this PC, so a shared Claude account shares it. This plugin cannot show whose credentials it holds. For a per-PC connection, add the server with `claude mcp add` and sign in through /mcp.");
  }
  if (sources.includes("unknown") || sources.includes("plugin-bundled")) {
    w.push("The source of this connection could not be identified, so no credential isolation is claimed.");
  }
  return w;
}

function matches(typed, identities) {
  const t = norm(typed);
  return !!t && list(identities).some((i) => norm(i) === t);
}

// ------------------------------------------------------------------- Jira

// facts.jira = { tools[], authState: "ok"|"needs-auth"|"error"|"unknown",
//                identities[], sites[], error }
function evaluateJira(facts, confirm, expectedSite) {
  const j = (facts && facts.jira) || {};
  const tools = list(j.tools);
  const sources = sourcesOf(tools);
  const r = { service: "Jira", status: null, route: "atlassian-mcp", identities: list(j.identities), sources, isolation: sources.map((s) => ISOLATION[s]), warnings: warningsFor(sources), blockers: [], next: [] };
  const setup = ["Run: claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp", "Then run /mcp, select atlassian, and sign in with your own Atlassian account in the browser.", "If your organization restricts the Rovo MCP server, ask an Atlassian admin to allow your account.", "Run /reload-plugins or restart Claude Code, then run /jira-dev-harness:connect again."];
  if (!tools.length) {
    r.status = STATUS.NOT_CONNECTED;
    r.blockers.push("No Atlassian MCP tools are available in this session.");
    r.next = setup;
  } else if (j.authState === "needs-auth") {
    r.status = STATUS.NEEDS_AUTH;
    r.blockers.push("The Atlassian server is connected but not signed in.");
    r.next = ["Run /mcp, select atlassian (or reconnect Atlassian in your claude.ai connector settings), and sign in with your own account.", "Then run /jira-dev-harness:connect again."];
  } else if (j.authState === "error" || j.error) {
    r.status = STATUS.BLOCKED;
    r.blockers.push(`Reading from Jira failed: ${j.error || "unknown error"}`);
    r.next = ["If this was an authorization error, sign in again through /mcp. Otherwise try again later."];
  } else if (!r.identities.length) {
    r.status = STATUS.BLOCKED;
    r.blockers.push("This connection did not report which Atlassian account it uses, so it cannot be verified.");
  } else if (expectedSite && !list(j.sites).map(norm).includes(norm(expectedSite))) {
    r.status = STATUS.INACCESSIBLE;
    r.blockers.push(`This Atlassian account cannot access ${expectedSite}, the site in this repository's committed mapping. Accessible sites: ${list(j.sites).join(", ") || "none"}.`);
    r.next = ["Connect with the Atlassian account that has access to that site."];
  } else if (!norm(confirm)) {
    r.status = STATUS.UNCONFIRMED;
    r.blockers.push("Account identity not confirmed by the developer.");
  } else if (!matches(confirm, r.identities)) {
    r.status = STATUS.MISMATCH;
    r.blockers.push(`The Jira account you typed (${confirm}) is not the connected account.`);
    r.next = ["Sign in with the account you intend to use, or type the account that is connected."];
  } else {
    r.status = STATUS.VERIFIED;
  }
  return r;
}

// ----------------------------------------------------------------- GitHub

// facts.github.mcp = { tools[], authState, identities[], error, repoAccess }
// gh = { status: "ok"|"missing"|"unauthenticated"|"error", identities[], reason, repoAccess }
function routeResult(name, state, identities, confirm, repoAccess) {
  const r = { route: name, state, identities: list(identities), problems: [] };
  if (state.status !== "ok") {
    r.problems.push(state.reason);
    return r;
  }
  if (repoAccess === false) r.problems.push("this account cannot read the repository named by origin");
  return r;
}

function evaluateGithub(facts, gh, confirm) {
  const m = (facts && facts.github && facts.github.mcp) || {};
  const tools = list(m.tools);
  const sources = sourcesOf(tools);
  const out = { service: "GitHub", status: null, routes: [], sources, isolation: [], warnings: warningsFor(sources), blockers: [], next: [] };
  const routes = [];

  if (tools.length) {
    let state;
    if (m.authState === "needs-auth") state = { status: "needs-auth", reason: "The GitHub MCP server is connected but not signed in." };
    else if (m.authState === "error" || m.error) state = { status: "error", reason: `Reading from GitHub failed: ${m.error || "unknown error"}` };
    else if (!list(m.identities).length) state = { status: "error", reason: "The GitHub MCP connection did not report which account it uses." };
    else state = { status: "ok" };
    routes.push({ ...routeResult("github-mcp", state, m.identities, confirm, m.repoAccess), authenticated: state.status === "ok" });
    out.isolation.push(...sources.map((s) => ISOLATION[s]));
  }
  if (gh && gh.status && gh.status !== "missing") {
    const state = gh.status === "ok" ? { status: "ok" } : { status: gh.status, reason: gh.reason || "gh is not usable" };
    routes.push({ ...routeResult("github-cli", state, gh.identities, confirm, gh.repoAccess), authenticated: gh.status === "ok" });
    if (gh.status === "ok") out.isolation.push(ISOLATION["github-cli"]);
  }
  out.routes = routes;

  const usable = routes.filter((r) => r.authenticated);
  if (!routes.length) {
    out.status = STATUS.NOT_CONNECTED;
    out.blockers.push("No GitHub MCP tools and no official GitHub CLI sign-in were found.");
    out.next = [
      "Option 1 (MCP): run `claude mcp add --transport http github https://api.githubcopilot.com/mcp/`, then /mcp and sign in. GitHub's remote server may not support browser sign-in (OAuth) from Claude Code. If /mcp reports an incompatible auth server, use option 2. Do not paste a personal access token.",
      "Option 2 (official GitHub CLI): install gh from https://cli.github.com, then run `gh auth login --web` and sign in with your own GitHub account in the browser.",
      "Then run /jira-dev-harness:connect again.",
    ];
  } else if (!usable.length) {
    const needs = routes.some((r) => r.state.status === "needs-auth" || r.state.status === "unauthenticated");
    out.status = needs ? STATUS.NEEDS_AUTH : STATUS.BLOCKED;
    for (const r of routes) out.blockers.push(`${r.route}: ${r.problems.join("; ")}`);
    out.next = ["For the MCP route, run /mcp and sign in. If it reports an incompatible auth server, use `gh auth login --web` instead.", "Then run /jira-dev-harness:connect again."];
  } else if (usable.some((r) => r.problems.length)) {
    out.status = STATUS.INACCESSIBLE;
    for (const r of usable) for (const p of r.problems) out.blockers.push(`${r.route}: ${p}`);
    out.next = ["Connect with the GitHub account that has access to this repository."];
  } else if (!norm(confirm)) {
    out.status = STATUS.UNCONFIRMED;
    out.blockers.push("Account identity not confirmed by the developer.");
  } else {
    const wrong = usable.filter((r) => !matches(confirm, r.identities));
    if (wrong.length) {
      out.status = STATUS.MISMATCH;
      for (const r of wrong) out.blockers.push(`${r.route} is signed in as ${r.identities.join(", ")}, not ${confirm}. Ship may use either route, so they must be the same account.`);
      out.next = ["Sign out of the route you don't intend to use (for example `gh auth logout`, or remove it in /mcp), or sign in with the intended account."];
    } else {
      out.status = STATUS.VERIFIED;
    }
  }
  out.identities = [...new Set(usable.flatMap((r) => r.identities))];
  return out;
}

// -------------------------------------------------------------- overall

function evaluate(facts, gh, confirm, expectedSite) {
  const c = confirm || {};
  const jira = evaluateJira(facts, c.jira, expectedSite);
  const github = evaluateGithub(facts, gh, c.github);
  const ready = jira.status === STATUS.VERIFIED && github.status === STATUS.VERIFIED;
  return { ready, jira, github };
}

function render(result) {
  const lines = [];
  for (const s of [result.jira, result.github]) {
    lines.push(`${s.service}: ${s.status}`);
    if (s.identities && s.identities.length) lines.push(`  connected as: ${s.identities.join(", ")}`);
    for (const r of s.routes || []) lines.push(`  route ${r.route}: ${r.state.status === "ok" ? `signed in as ${r.identities.join(", ")}` : r.problems.join("; ")}`);
    for (const i of [...new Set(s.isolation || [])]) lines.push(`  credentials: ${i}`);
    for (const w of s.warnings) lines.push(`  WARNING: ${w}`);
    for (const b of s.blockers) lines.push(`  BLOCKER: ${b}`);
    for (const n of s.next) lines.push(`  - ${n}`);
  }
  if (result.ready) {
    lines.push("", "CONNECTIONS: READY. Both accounts were read from live connections and confirmed by you.");
  } else {
    lines.push("", "CONNECTIONS: NOT READY.");
    const unconfirmed = [result.jira, result.github].some((s) => s.status === STATUS.UNCONFIRMED);
    if (unconfirmed) {
      lines.push("To confirm, check the accounts above are the ones you intend to use, then type:", "  /jira-dev-harness:connect --confirm <jira-account> <github-login>", "using the exact email, name, or login shown after \"connected as\".");
    }
  }
  return lines.join("\n");
}

// Arguments of the user's slash command: empty, or --confirm <jira> <github>.
function parseArgs(argv) {
  const a = argv.map(String);
  if (!a.length) return { confirm: null };
  if (a[0] !== "--confirm" || a.length !== 3 || !a[1].trim() || !a[2].trim()) {
    return { error: "usage: /jira-dev-harness:connect [--confirm <jira-account> <github-login>]" };
  }
  return { confirm: { jira: a[1].trim(), github: a[2].trim() } };
}

module.exports = { STATUS, classifySource, evaluate, evaluateJira, evaluateGithub, render, parseArgs, matches };
