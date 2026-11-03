// Connection onboarding: status rules, confirmation recording, the guard, and
// the CLI. No Jira, GitHub, token, or network is involved: connection facts
// are supplied directly and `gh` is absent from PATH.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const C = require("../scripts/lib/connections.cjs");
const { ROOT, makeFixture, guard, uuid } = require("./helpers.cjs");

const CONNECT = path.join(ROOT, "scripts", "connect.cjs");
const JIRA_TOOLS = ["mcp__atlassian__getJiraIssue", "mcp__atlassian__atlassianUserInfo"];
const GH_TOOLS = ["mcp__github__get_me"];
const jiraOk = (extra = {}) => ({ tools: JIRA_TOOLS, authState: "ok", identities: ["dev@example.com", "Dev One"], sites: ["example.atlassian.net"], ...extra });
const ghMcpOk = (extra = {}) => ({ tools: GH_TOOLS, authState: "ok", identities: ["dev1"], ...extra });
const ghCliOk = (extra = {}) => ({ status: "ok", identities: ["dev1"], ...extra });
const confirm = { jira: "dev@example.com", github: "dev1" };

test("source classification and isolation claims", () => {
  assert.equal(C.classifySource("mcp__claude_ai_Atlassian_MCP__getJiraIssue"), "claude-ai-connector");
  assert.equal(C.classifySource("mcp__atlassian__getJiraIssue"), "claude-code-mcp");
  assert.equal(C.classifySource("mcp__plugin_x_github__get_me"), "plugin-bundled");
  assert.equal(C.classifySource("getJiraIssue"), "unknown");
  const r = C.evaluate({ jira: jiraOk({ tools: ["mcp__claude_ai_Atlassian_MCP__getJiraIssue"] }), github: { mcp: ghMcpOk() } }, null, confirm);
  assert.match(r.jira.warnings.join(" "), /claude\.ai connector/);
  assert.match(r.jira.isolation.join(" "), /NOT guaranteed/);
  assert.match(C.render(r), /WARNING: This connection is a claude\.ai connector/);
});

test("READY needs both accounts read live and confirmed by the developer", () => {
  const facts = { jira: jiraOk(), github: { mcp: ghMcpOk() } };
  const unconfirmed = C.evaluate(facts, null, null);
  assert.equal(unconfirmed.ready, false);
  assert.equal(unconfirmed.jira.status, "UNCONFIRMED");
  assert.equal(unconfirmed.github.status, "UNCONFIRMED");
  assert.match(C.render(unconfirmed), /connect --confirm <jira-account> <github-login>/);
  const ok = C.evaluate(facts, null, confirm);
  assert.equal(ok.ready, true);
  assert.match(C.render(ok), /CONNECTIONS: READY/);
  assert.equal(C.evaluate(facts, null, { jira: "DEV@example.com", github: "DEV1" }).ready, true, "case-insensitive");
  assert.equal(C.evaluate(facts, null, { jira: "Dev One", github: "dev1" }).ready, true, "display name also matches");
  const wrong = C.evaluate(facts, null, { jira: "other@example.com", github: "dev1" });
  assert.equal(wrong.jira.status, "MISMATCH");
  assert.equal(wrong.ready, false);
  assert.equal(C.evaluate(facts, null, { jira: "dev@example.com", github: "someone" }).github.status, "MISMATCH");
  assert.equal(C.evaluate(facts, null, { jira: "dev@example.com", github: "" }).ready, false);
});

test("missing, unauthenticated, errored, and inaccessible connections are blockers", () => {
  const none = C.evaluate({}, null, confirm);
  assert.equal(none.jira.status, "NOT_CONNECTED");
  assert.equal(none.github.status, "NOT_CONNECTED");
  assert.match(none.jira.next.join(" "), /claude mcp add --transport http atlassian/);
  assert.match(none.github.next.join(" "), /gh auth login --web/);
  assert.doesNotMatch(JSON.stringify(none), /docker/i, "no Docker suggestion");
  assert.match(none.github.next.join(" "), /Do not paste a personal access token/);
  assert.equal(C.evaluate({ jira: jiraOk({ authState: "needs-auth" }) }, null, confirm).jira.status, "NEEDS_AUTH");
  assert.equal(C.evaluate({ jira: jiraOk({ authState: "error", error: "HTTP 500" }) }, null, confirm).jira.status, "BLOCKED");
  assert.equal(C.evaluate({ jira: jiraOk({ identities: [] }) }, null, confirm).jira.status, "BLOCKED", "an unidentifiable account is not verified");
  const wrongSite = C.evaluateJira({ jira: jiraOk() }, "dev@example.com", "other.atlassian.net");
  assert.equal(wrongSite.status, "INACCESSIBLE");
  assert.equal(C.evaluateJira({ jira: jiraOk() }, "dev@example.com", "example.atlassian.net").status, "VERIFIED");
  assert.equal(C.evaluate({ github: { mcp: ghMcpOk({ authState: "needs-auth" }) } }, null, confirm).github.status, "NEEDS_AUTH");
  assert.equal(C.evaluate({ github: { mcp: ghMcpOk({ repoAccess: false }) } }, null, confirm).github.status, "INACCESSIBLE");
  assert.equal(C.evaluate({}, { status: "unauthenticated", reason: "gh is not authenticated" }, confirm).github.status, "NEEDS_AUTH");
  assert.equal(C.evaluate({}, { status: "error", reason: "gh is a script or shim" }, confirm).github.status, "BLOCKED");
});

test("the GitHub CLI fallback, and mixed identities across routes", () => {
  const viaCli = C.evaluate({ jira: jiraOk() }, ghCliOk(), confirm);
  assert.equal(viaCli.ready, true);
  assert.match(viaCli.github.isolation.join(" "), /official gh keeps its own sign-in/);
  assert.equal(C.evaluate({ jira: jiraOk(), github: { mcp: ghMcpOk() } }, ghCliOk(), confirm).ready, true);
  const mixed = C.evaluate({ jira: jiraOk(), github: { mcp: ghMcpOk() } }, ghCliOk({ identities: ["other-account"] }), confirm);
  assert.equal(mixed.github.status, "MISMATCH");
  assert.equal(mixed.ready, false);
  assert.match(mixed.github.blockers.join(" "), /github-cli is signed in as other-account/);
});

test("slash-command arguments", () => {
  assert.deepEqual(C.parseArgs([]), { confirm: null });
  assert.deepEqual(C.parseArgs(["--confirm", "a@b.c", "dev1"]), { confirm: { jira: "a@b.c", github: "dev1" } });
  for (const bad of [["--confirm"], ["--confirm", "a"], ["confirm", "a", "b"], ["--confirm", "a", "b", "c"], ["--confirm", " ", "b"]]) {
    assert.ok(C.parseArgs(bad).error, bad.join(" "));
  }
});

// ------------------------------------------------------------------- CLI

function cli(f, args, extraEnv = {}) {
  const r = spawnSync("node", [CONNECT, ...args], { cwd: f.repo, env: { ...f.env, ...extraEnv }, encoding: "utf8" });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

// A PATH with node but no gh, so the CLI sees "gh missing" without a network.
const noGhEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdh-nogh-"));
  const nodeDir = path.dirname(process.execPath);
  const gitDir = path.dirname(spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0]);
  return { PATH: [nodeDir, gitDir, dir].join(path.delimiter) };
};

test("CLI: confirmation is recorded per session, then READY only when it matches live facts", () => {
  const f = makeFixture();
  const sid = uuid();
  const factsFile = () => {
    const p = cli(f, ["facts-path"]).out.trim();
    assert.ok(path.isAbsolute(p) && !p.startsWith(f.repo));
    fs.writeFileSync(p, JSON.stringify({ jira: jiraOk(), github: { mcp: ghMcpOk() } }));
    return p;
  };
  assert.match(cli(f, ["begin", f.data, sid]).out, /no confirmation given yet/);
  let r = cli(f, ["evaluate", f.data, sid, factsFile()], noGhEnv());
  assert.match(r.out, /Jira: UNCONFIRMED/);
  assert.match(r.out, /CONNECTIONS: NOT READY/);
  assert.match(cli(f, ["begin", f.data, sid, "--confirm", "dev@example.com", "dev1"]).out, /confirmation recorded/);
  r = cli(f, ["evaluate", f.data, sid, factsFile()], noGhEnv());
  assert.match(r.out, /CONNECTIONS: READY/);
  assert.equal(cli(f, ["evaluate", f.data, uuid(), factsFile()], noGhEnv()).out.includes("READY. Both"), false, "another session's confirmation is not used");
  assert.match(cli(f, ["begin", f.data, sid, "--confirm", "only-one"]).out, /ERROR: usage/);
  assert.match(cli(f, ["begin", f.data, "not-a-uuid"]).out, /invalid session id/);
  assert.match(cli(f, ["begin", "relative/dir", sid]).out, /not an absolute path/);
  const mismatch = (() => {
    cli(f, ["begin", f.data, sid, "--confirm", "someone@else.com", "dev1"]);
    return cli(f, ["evaluate", f.data, sid, factsFile()], noGhEnv()).out;
  })();
  assert.match(mismatch, /Jira: MISMATCH/);
  assert.doesNotMatch(mismatch, /CONNECTIONS: READY/);
});

test("CLI: the mapped Jira site must be reachable by the connected account", () => {
  const f = makeFixture();
  const sid = uuid();
  cli(f, ["begin", f.data, sid, "--confirm", "dev@example.com", "dev1"]);
  const p = cli(f, ["facts-path"]).out.trim();
  fs.writeFileSync(p, JSON.stringify({ jira: jiraOk({ sites: ["another.atlassian.net"] }), github: { mcp: ghMcpOk() } }));
  const out = cli(f, ["evaluate", f.data, sid, p], noGhEnv()).out;
  assert.match(out, /Jira: INACCESSIBLE/);
  assert.match(out, /example\.atlassian\.net/);
});

// ----------------------------------------------------------------- guard

test("guard: Claude cannot record a confirmation, but can run the read-only report", () => {
  const f = makeFixture();
  const sid = uuid();
  const base = { session_id: sid, permission_mode: "default", tool_name: "Bash" };
  const script = path.join(ROOT, "scripts", "connect.cjs").replace(/\\/g, "/");
  const cmd = (rest) => `node "${script}" ${rest}`;
  assert.equal(guard(f, { ...base, tool_input: { command: cmd(`begin "${f.data}" ${sid} --confirm a@b.c dev1`) } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_input: { command: cmd(`evaluate "${f.data}" ${sid} "${f.tmp}/facts-1.json"`) } }).permissionDecision, "(none)");
  assert.equal(guard(f, { ...base, tool_input: { command: cmd(`evaluate "${f.data}" ${sid} "${f.tmp}/facts-1.json" && cat x`) } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_input: { command: cmd(`evaluate "${path.join(f.base, "forged")}" ${sid} x.json`) } }).permissionDecision, "deny", "only this plugin's data directory");
  assert.equal(guard(f, { ...base, tool_name: "Write", tool_input: { file_path: path.join(f.data, "connect", `${sid}.json`), content: "{}" } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_input: { command: cmd("facts-path") } }).permissionDecision, "(none)");
});

// The exact failure observed with `claude -p "/jira-dev-harness:connect"`:
//   Shell command permission check failed for command in /jira-dev-harness:connect:
//   node ".../scripts/connect.cjs" begin "<data dir>" "<session id>"  -> "This command requires approval"
// Claude Code checks every `!` command a skill injects against that skill's
// allowed-tools. (Injected commands do not go through PreToolUse hooks; the
// guard never sees them.) So each injected command must be covered.
const frontmatterTools = (text) => {
  const line = /^allowed-tools:\s*(.+)$/m.exec(text);
  return line ? [...line[1].matchAll(/(Bash|PowerShell)\((.*?)\)(?=\s|$)/g)].map((m) => ({ tool: m[1], pattern: m[2].split("${CLAUDE_PLUGIN_ROOT}").join("d:/dev ahmed/agent/plugin-code-automate") })) : [];
};
const covered = (tools, tool, command) => tools.some((t) => t.tool === tool && new RegExp(`^${t.pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(command));

test("regression: every command a skill injects is covered by that skill's allowed-tools", () => {
  const root = "d:\\dev ahmed\\agent\\plugin-code-automate";
  const data = "C:/Users/Abc/.claude/plugins/data/jira-dev-harness-inline";
  const sid = "46c95d7a-5d29-4d8a-97b3-271f88bf321e";
  const subst = (s, args) => s.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root.replace(/\\/g, "/")).replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, data).replace(/\$\{CLAUDE_SESSION_ID\}/g, sid).replace(/\$ARGUMENTS/g, args).trim();
  let injected = 0;
  for (const dir of fs.readdirSync(path.join(ROOT, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const text = fs.readFileSync(path.join(ROOT, "skills", dir.name, "SKILL.md"), "utf8");
    const tools = frontmatterTools(text);
    for (const m of text.matchAll(/^!`(.+)`$/gm)) {
      for (const args of ["", "ABC-1 r1 deadbeef"]) {
        injected++;
        const command = subst(m[1], args);
        // Injected commands run through bash (Git Bash on Windows).
        assert.ok(covered(tools, "Bash", command), `${dir.name}: this injected command would require approval: ${command}`);
      }
    }
  }
  assert.ok(injected >= 12, "found the injected commands of every skill");
  // The command from the observed failure, verbatim in shape.
  const observed = `node "d:/dev ahmed/agent/plugin-code-automate/scripts/connect.cjs" begin "${data}" "${sid}"`;
  const connect = frontmatterTools(fs.readFileSync(path.join(ROOT, "skills", "connect", "SKILL.md"), "utf8"));
  assert.ok(covered(connect, "Bash", observed));
  assert.ok(covered(connect, "PowerShell", observed));
  assert.ok(!covered(connect, "Bash", `node "d:/x/other.cjs" begin "${data}" "${sid}"`), "no broad Node exemption");
  assert.ok(!covered(connect, "Bash", `node "d:/dev ahmed/agent/plugin-code-automate/scripts/plan-store.cjs" approve "${data}" "${sid}"`), "no plan-store exemption");
});

test("guard: real hook payload format (mixed slashes, the live data directory) for the report, and the injected begin is still not Claude's to run", () => {
  const f = makeFixture();
  const data = "C:/Users/Abc/.claude/plugins/data/jira-dev-harness-inline";
  f.env.CLAUDE_PLUGIN_DATA = data;
  const sid = "46c95d7a-5d29-4d8a-97b3-271f88bf321e";
  const script = "d:\\dev ahmed\\agent\\plugin-code-automate/scripts/connect.cjs";
  const payload = (command, tool_name = "Bash") => ({ session_id: sid, hook_event_name: "PreToolUse", permission_mode: "default", cwd: f.repo, tool_name, tool_input: { command } });
  const facts = "C:\\Users\\Abc\\AppData\\Local\\Temp\\jira-dev-harness\\connect\\facts-e195ba281581.json";
  assert.equal(guard(f, payload(`node "${script}" evaluate "${data}" "${sid}" "${facts}"`)).permissionDecision, "(none)");
  assert.equal(guard(f, payload(`node "${script}" evaluate "${data.replace(/\//g, "\\")}" "${sid}" "${facts}"`)).permissionDecision, "(none)", "backslash spelling of the same directory");
  assert.equal(guard(f, payload(`node "${script}" evaluate "C:/Users/Abc/.claude/plugins/data/other" "${sid}" "${facts}"`)).permissionDecision, "deny");
  assert.equal(guard(f, payload(`node "${script}" begin "${data}" "${sid}"`)).permissionDecision, "deny");
  assert.equal(guard(f, payload(`cd . && node "${script}" evaluate "${data}" "${sid}" "${facts}"`)).permissionDecision, "deny");
  assert.equal(guard(f, payload(`node "${script}" evaluate "${data}" "${sid}" "${facts}" > x`)).permissionDecision, "deny");
  assert.equal(guard(f, payload(`node "${script}" facts-path`)).permissionDecision, "(none)");
  assert.equal(guard(f, payload(`node "${script}" facts-path`, "PowerShell")).permissionDecision, "(none)");
});

test("skills: connect is user-only and never asks for credentials; preflights are present", () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
  const connect = read("skills", "connect", "SKILL.md");
  assert.match(connect, /disable-model-invocation: true/);
  assert.match(connect, /Never handle credentials/);
  assert.match(read("skills", "ticket", "SKILL.md"), /Connection preflight/);
  assert.match(read("skills", "ship", "SKILL.md"), /Step 0: Connection preflight/);
});
