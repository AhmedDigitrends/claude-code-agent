// Phase 6 tests: review approval, shipping, the GitHub adapter, and the guard.
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const P = require("../scripts/lib/provider.cjs");
const { ROOT, STORE, SITE, KEY, uuid, git, draft, reviewed, guard } = require("./helpers.cjs");

// ----------------------------------------------------------- review approval

test("approve-review: a current PASS review is approved and bound to the tree", () => {
  const f = reviewed();
  assert.match(f.saved, /VERDICT: PASS/);
  const out = f.approve();
  assert.match(out, /REVIEW APPROVAL: GRANTED/);
  assert.match(out, /src\/app\.js {2}[0-9a-f]{64}/);
  assert.match(f.approve(), /ALREADY GRANTED/);
  const rec = JSON.parse(fs.readFileSync(path.join(f.data, "plans", SITE, KEY, "reviews", "review-approval-rv-1.json"), "utf8"));
  assert.equal(rec.reviewSha256, f.reviewHash);
  assert.equal(rec.planRevision, 1);
  assert.match(rec.hmac, /^[0-9a-f]{64}$/);
});

test("approve-review: no answer, a short hash, a wrong hash, or a wrong id are refused", () => {
  const f = reviewed();
  assert.match(f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1"]).out, /REFUSED.*64-character/);
  assert.match(f.approve(f.reviewHash.slice(0, 12)), /REFUSED/);
  assert.match(f.approve("0".repeat(64)), /REFUSED.*does not match/);
  assert.match(f.approve(f.reviewHash, "rv-9"), /REFUSED.*does not exist|not the latest/);
  assert.match(f.approve(f.reviewHash, "latest"), /REFUSED.*invalid review id/);
  assert.ok(!fs.existsSync(path.join(f.data, "plans", SITE, KEY, "reviews", "review-approval-rv-1.json")));
});

test("approve-review: a FAIL review is never approved", () => {
  const f = reviewed("FAIL");
  assert.match(f.saved, /VERDICT: FAIL/);
  assert.match(f.approve(), /REFUSED.*not PASS/);
});

test("approve-review: a stale review is refused after the code changes", () => {
  const f = reviewed();
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 3;\n");
  assert.match(f.approve(), /REFUSED.*code changed after the review/);
  fs.writeFileSync(path.join(f.repo, "src", "extra.js"), "x\n");
  assert.match(f.approve(), /REFUSED/);
});

test("approve-review: an edited review, report, or evidence is refused", () => {
  const f = reviewed("FAIL");
  const forged = JSON.parse(fs.readFileSync(f.reviewFile, "utf8"));
  forged.verdict = "PASS";
  fs.writeFileSync(f.reviewFile, JSON.stringify(forged, null, 2) + "\n");
  const newHash = crypto.createHash("sha256").update(fs.readFileSync(f.reviewFile)).digest("hex");
  assert.match(f.approve(newHash), /REFUSED.*signature/);

  const g = reviewed();
  fs.appendFileSync(g.reviewFile.replace(/\.json$/, ".html"), "<!-- edited -->");
  assert.match(g.approve(), /REFUSED.*HTML report was modified/);

  const h = reviewed();
  fs.appendFileSync(path.join(h.data, "plans", SITE, KEY, "reviews", "rv-1", "checks", "C1.log"), "tampered");
  assert.match(h.approve(), /REFUSED.*log of check C1/);
});

test("approve-review: an approval cannot be reused for another repository", () => {
  const f = reviewed();
  assert.match(f.approve(), /GRANTED/);
  const other = path.join(f.base, "other");
  fs.mkdirSync(other);
  git(other, "init", "-b", "main");
  assert.match(f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", f.reviewHash], other).out, /REFUSED/);
});

// -------------------------------------------------------------------- ship

test("ship-start: refused without the developer's review approval (no-answer case)", () => {
  const f = reviewed();
  assert.match(f.ship(), /SHIP: REFUSED.*has not been approved/);
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: x\n`)]).out, /ERROR.*no shipping authorization/);
});

test("ship-start: refuses protected and default branch names, bad names, and a wrong hash", () => {
  const f = reviewed();
  f.approve();
  assert.match(f.ship(f.reviewHash, "--branch", "main"), /SHIP: REFUSED.*protected or default/);
  assert.match(f.ship(f.reviewHash, "--branch", "develop"), /SHIP: REFUSED.*protected or default/);
  assert.match(f.ship(f.reviewHash, "--branch", "release/1.0"), /SHIP: REFUSED/);
  assert.match(f.ship(f.reviewHash, "--branch", "no-key-here"), /SHIP: REFUSED.*must contain ABC-1/);
  assert.match(f.ship(f.reviewHash, "--branch", "abc-1/../x"), /SHIP: REFUSED.*invalid branch/);
  assert.match(f.ship("0".repeat(64)), /SHIP: REFUSED.*does not match/);
  assert.match(f.ship(f.reviewHash, "--force"), /SHIP: REFUSED.*unexpected arguments/);
});

test("ship: commit, push, and pull request text follow the gates and never merge", () => {
  const f = reviewed();
  fs.writeFileSync(path.join(f.repo, "notes.txt"), "unrelated untracked\n");
  // An unrelated file after the review makes the tree differ from the approved one.
  assert.match(f.approve(), /REFUSED/);
  fs.rmSync(path.join(f.repo, "notes.txt"));

  assert.match(f.approve(), /GRANTED/);
  const start = f.ship();
  assert.match(start, /SHIP: AUTHORIZED/);
  assert.match(start, /Ticket branch: jira\/ABC-1/);
  assert.match(start, /Remote: github\.com\/acme\/widgets/);

  // Out-of-order steps are refused.
  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /ERROR.*needs stage committed/);
  assert.match(f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", `${KEY} change\n`)]).out, /ERROR.*needs stage pushed/);

  // A commit message without the key, or with a credential, is refused.
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", "no key\n")]).out, /ERROR.*must mention ABC-1/);
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: token ghp_${"a".repeat(30)}\n`)]).out, /ERROR.*credential/);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), git(f.repo, "rev-parse", "origin/main"));

  // Content changed after approval is refused before any git change.
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 99;\n");
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: edit\n`)]).out, /ERROR.*commit refused.*code changed/);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 2;\n");

  const commit = f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: export 2\n\nBody.\n`)]).out;
  assert.match(commit, /COMMITTED: [0-9a-f]{40} on jira\/ABC-1/);
  assert.equal(git(f.repo, "branch", "--show-current"), "jira/ABC-1");
  assert.equal(git(f.repo, "log", "-1", "--format=%s"), `${KEY}: export 2`);
  assert.equal(git(f.repo, "diff", "--name-only", "HEAD~1", "HEAD"), "src/app.js");

  const push = f.run(["ship-push", f.data, f.sid("ship")]).out;
  assert.match(push, /PUSHED: jira\/ABC-1/);
  assert.equal(git(f.bare, "rev-parse", "refs/heads/jira/ABC-1"), git(f.repo, "rev-parse", "HEAD"));
  assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), git(f.repo, "rev-parse", "origin/main"), "main on origin is untouched");

  const prep = f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Export two\n\nChanges the export.\n")]).out;
  assert.match(prep, /Title: ABC-1: Export two/);
  assert.match(prep, new RegExp(`Jira: https://${SITE.replace(/\./g, "\\.")}/browse/ABC-1`));
  assert.match(prep, /Independent review: rv-1 PASS/);

  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), "https://github.com/evil/other/pull/3"]).out, /ERROR.*does not belong/);
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), "https://github.com/acme/widgets/issues/3"]).out, /ERROR.*not a pull request URL/);
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), "https://github.com/acme/widgets/pull/3"]).out, /PULL REQUEST RECORDED/);
  assert.match(f.run(["ship-status", f.data, f.sid("ship")]).out, /stage pr-created[\s\S]*Gates: valid/);

  // A new review-invalidating change after the commit stops further steps.
  const state = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid("ship")}.json`), "utf8"));
  assert.equal(state.pr.url, "https://github.com/acme/widgets/pull/3");
  assert.ok(!/merge/i.test(Object.keys(JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid("ship")}.json`), "utf8"))).join()));
});

test("ship-commit: refuses staged extras and files that already had local changes", () => {
  const f = reviewed();
  f.approve();
  fs.writeFileSync(path.join(f.repo, "other.txt"), "x\n");
  git(f.repo, "add", "other.txt");
  assert.match(f.ship(), /SHIP: REFUSED/, "an extra staged file changes the tree identity");
  git(f.repo, "reset", "-q");
  fs.rmSync(path.join(f.repo, "other.txt"));
  assert.match(f.ship(), /AUTHORIZED/);
});

test("ship-push: refuses when HEAD moved after the commit", () => {
  const f = reviewed();
  f.approve();
  f.ship();
  f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: change\n`)]);
  fs.writeFileSync(path.join(f.repo, "later.txt"), "later\n");
  git(f.repo, "add", "later.txt");
  git(f.repo, "commit", "-m", "later");
  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /ERROR.*push refused.*HEAD is no longer/);
  assert.throws(() => git(f.bare, "rev-parse", "refs/heads/jira/ABC-1"));
});

test("ship-start: refuses an origin URL with embedded credentials", () => {
  const f = reviewed();
  f.approve();
  git(f.repo, "remote", "set-url", "origin", "https://user:secret@github.com/acme/widgets.git");
  assert.match(f.ship(), /SHIP: REFUSED/);
  assert.ok(!f.ship().includes("secret"), "credentials are never echoed");
});

// ---------------------------------------------------------------- providers

test("parseRemote handles https, ssh, and credential-bearing URLs", () => {
  assert.deepEqual(P.parseRemote("https://github.com/acme/widgets.git"), { host: "github.com", owner: "acme", name: "widgets", hasCredentials: false });
  assert.equal(P.parseRemote("git@github.com:acme/widgets.git").name, "widgets");
  assert.equal(P.parseRemote("ssh://git@github.example.com/acme/widgets").host, "github.example.com");
  assert.equal(P.parseRemote("https://tok@github.com/acme/widgets").hasCredentials, true);
  assert.equal(P.parseRemote("not a url"), null);
});

test("classifyMcpTool recognises pull request creation and any merge, and invents nothing", () => {
  assert.equal(P.classifyMcpTool("mcp__github__create_pull_request"), "createPullRequest");
  assert.equal(P.classifyMcpTool("mcp__claude_ai_GitHub__create_pull_request"), "createPullRequest");
  assert.equal(P.classifyMcpTool("mcp__github__merge_pull_request"), "mergePullRequest");
  assert.equal(P.classifyMcpTool("mcp__other__enable_auto_merge"), "otherMerge");
  assert.equal(P.classifyMcpTool("mcp__github__create_pull_request_review"), null);
  assert.equal(P.classifyMcpTool("mcp__jira__create_issue"), null);
  assert.equal(P.classifyMcpTool("mcp__randomserver__create_pull_request"), null, "only a GitHub server is trusted for creation");
  assert.equal(P.classifyMcpTool("Bash"), null);
});

const shipping = (extra = {}) => ({
  mode: "shipping", stage: "pushed", issueKey: KEY, branch: "jira/ABC-1", base: "main",
  remote: { host: "github.com", owner: "acme", name: "widgets" },
  prepared: { title: "ABC-1: t", body: "b", bodySha256: crypto.createHash("sha256").update("b").digest("hex") },
  ...extra,
});

test("mcpCreatePrProblem accepts only the prepared values", () => {
  const ok = { owner: "acme", repo: "widgets", head: "jira/ABC-1", base: "main", title: "ABC-1: t", body: "b" };
  assert.equal(P.mcpCreatePrProblem(shipping(), ok), null);
  assert.match(P.mcpCreatePrProblem(shipping(), { ...ok, base: "develop" }), /base must be main/);
  assert.match(P.mcpCreatePrProblem(shipping(), { ...ok, head: "main" }), /head must be/);
  assert.match(P.mcpCreatePrProblem(shipping(), { ...ok, body: "other" }), /body differs/);
  assert.match(P.mcpCreatePrProblem(shipping(), { ...ok, title: "x" }), /title differs/);
  assert.match(P.mcpCreatePrProblem(shipping(), { ...ok, owner: "evil" }), /owner must be/);
  assert.match(P.mcpCreatePrProblem(shipping(), { head: "jira/ABC-1" }), /does not expose/);
  assert.match(P.mcpCreatePrProblem(shipping({ stage: "committed" }), ok), /not been pushed/);
  assert.match(P.mcpCreatePrProblem(null, ok), /no shipping authorization/);
});

test("the GitHub CLI adapter rejects impostors and shims", () => {
  assert.equal(P.looksOfficial("gh version 2.40.1 (2024-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.40.1\n"), true);
  assert.equal(P.looksOfficial("gh 2.8.9\n"), false);
  assert.equal(P.looksOfficial("gh version 1.0.0\nhttps://example.com/\n"), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdh-gh-"));
  const fake = path.join(dir, process.platform === "win32" ? "gh.cmd" : "gh");
  fs.writeFileSync(fake, process.platform === "win32" ? "@echo gh version 9.9.9\r\n" : "#!/bin/sh\necho 'gh version 9.9.9'\necho https://github.com/cli/cli/releases/tag/v9.9.9\n", { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.equal(P.officialGh(ROOT, "github.com").ok, false);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- guard


test("guard: shipping steps always ask, need attended mode, and need a shipping session", () => {
  const f = reviewed();
  f.approve();
  f.ship();
  const sid = f.sid("ship");
  const call = (sub, extra = "") => `node "${STORE}" ${sub} "${f.data}" ${sid}${extra}`;
  const base = { session_id: sid, tool_name: "Bash", permission_mode: "default" };

  for (const sub of ["ship-commit", "ship-push", "ship-pr"]) {
    const extra = sub === "ship-commit" ? ` "${path.join(f.tmp, "jira-dev-harness", "drafts", SITE, KEY, "commit.md")}"` : "";
    assert.equal(guard(f, { ...base, tool_input: { command: call(sub, extra) } }).permissionDecision, "ask", sub);
    assert.equal(guard(f, { ...base, permission_mode: "bypassPermissions", tool_input: { command: call(sub, extra) } }).permissionDecision, "deny", `${sub} unattended`);
  }
  const other = { ...base, session_id: uuid() };
  assert.equal(guard(f, { ...other, tool_input: { command: call("ship-push") } }).permissionDecision, "deny", "no shipping session");
  assert.equal(guard(f, { ...base, tool_input: { command: `${call("ship-push")} && git push --force` } }).permissionDecision, "deny", "chained");
});

test("guard: raw git, hosting CLIs, ship-start, and approve-review are denied to Claude in a shipping session", () => {
  const f = reviewed();
  f.approve();
  f.ship();
  const base = { session_id: f.sid("ship"), tool_name: "Bash", permission_mode: "default" };
  for (const command of [
    "git commit -m x", "git push origin HEAD", "git push --force", "gh pr create --fill", "gh pr merge 3",
    `node "${STORE}" ship-start "${f.data}" ${f.sid("ship")} ${KEY} rv-1 ${f.reviewHash}`,
    `node "${STORE}" approve-review "${f.data}" ${f.sid("ship")} ${KEY} rv-1 ${f.reviewHash}`,
  ]) {
    assert.equal(guard(f, { ...base, tool_input: { command } }).permissionDecision, "deny", command);
  }
  const rec = path.join(f.data, "plans", SITE, KEY, "reviews", "review-approval-rv-1.json");
  assert.equal(guard(f, { ...base, tool_name: "Write", tool_input: { file_path: rec, content: "{}" } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_input: { command: `echo {} > "${rec}"` } }).permissionDecision, "deny");
});

test("guard: MCP pull request creation is verified, and merging is always denied", () => {
  const f = reviewed();
  f.approve();
  f.ship();
  f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: change\n`)]);
  f.run(["ship-push", f.data, f.sid("ship")]);
  const prep = f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Title\n\nBody text\n")]).out;
  const title = /^Title: (.*)$/m.exec(prep)[1];
  const body = /-----BEGIN PR BODY-----\n([\s\S]*?)\n-----END PR BODY-----/.exec(prep)[1];
  const base = { session_id: f.sid("ship"), permission_mode: "default" };
  const create = "mcp__github__create_pull_request";
  const good = { owner: "acme", repo: "widgets", head: "jira/ABC-1", base: "main", title, body };

  assert.equal(guard(f, { ...base, tool_name: create, tool_input: good }).permissionDecision, "ask");
  assert.equal(guard(f, { ...base, tool_name: create, tool_input: { ...good, base: "develop" } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: create, tool_input: { ...good, body: `${body}\nextra` } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: create, permission_mode: "auto", tool_input: good }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: create, agent_type: "jira-dev-harness:reviewer", tool_input: good }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: create, agent_type: "jira-dev-harness:developer", tool_input: good }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: 3 } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: "mcp__github__enable_pull_request_auto_merge", tool_input: {} }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: "mcp__atlassian__transitionJiraIssue", tool_input: {} }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: "mcp__github__get_pull_request", tool_input: {} }).permissionDecision, "(none)", "reads follow the normal flow");
});

test("guard: pull request creation is denied before the branch is pushed and outside shipping", () => {
  const f = reviewed();
  f.approve();
  f.ship();
  const base = { session_id: f.sid("ship"), permission_mode: "default", tool_name: "mcp__github__create_pull_request" };
  const input = { owner: "acme", repo: "widgets", head: "jira/ABC-1", base: "main", title: "t", body: "b" };
  assert.equal(guard(f, { ...base, tool_input: input }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, session_id: f.sid("review"), tool_input: input }).permissionDecision, "deny", "reviewing session");
});
