// Merge tests: the separately authorized merge workflow, with mocked
// providers. No real GitHub account, token, or network is involved.
// "MCP" evidence is fed through the real PostToolUse hook (evidence.cjs);
// the gh route is exercised in-process with a mock adapter, because a mock
// executable cannot (and must not) pass the official-gh checks.
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const G = require("../scripts/lib/merge-gate.cjs");
const M = require("../scripts/lib/merge.cjs");
const P = require("../scripts/lib/provider.cjs");
const { ROOT, STORE, SITE, KEY, uuid, git, draft, reviewed, guard } = require("./helpers.cjs");

const EVIDENCE = path.join(ROOT, "scripts", "evidence.cjs");
const PR = 3;

// A repository that went through approve-review, ship, commit, push, and a
// recorded pull request. Built once and shared; every test uses its own
// merge session.
let shared = null;
function shipped() {
  if (shared) return shared;
  const f = reviewed();
  assert.match(f.approve(), /GRANTED/);
  assert.match(f.ship(), /AUTHORIZED/);
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: export 2\n`)]).out, /COMMITTED/);
  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /PUSHED/);
  assert.match(f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Export two\n")]).out, /PREPARED/);
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), `https://github.com/acme/widgets/pull/${PR}`]).out, /RECORDED/);
  f.sha = git(f.repo, "rev-parse", "HEAD");
  shared = f;
  return f;
}

const mergeStart = (f, sid, ...args) => f.run(["merge-start", f.data, sid, KEY, ...args]).out;
const startOk = (f, sid = uuid(), method = "squash") => {
  const out = mergeStart(f, sid, String(PR), f.sha, "--method", method);
  assert.match(out, /MERGE: AUTHORIZED/, out);
  return { sid, state: JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${sid}.json`), "utf8")) };
};

// Mock GitHub REST responses for a pull request that may be merged.
function good(sha, o = {}) {
  const repo = "acme/widgets";
  return {
    pr: { number: PR, state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean", commits: 1,
      html_url: `https://github.com/${repo}/pull/${PR}`, user: { login: "dev" },
      head: { sha, ref: "jira/ABC-1", repo: { full_name: repo } }, base: { ref: "main", repo: { full_name: repo } }, ...o.pr },
    files: o.files || [{ filename: "src/app.js", status: "modified" }],
    reviews: o.reviews || [{ user: { login: "rev" }, state: "APPROVED", commit_id: sha }],
    checks: o.checks || { total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success", head_sha: sha }] },
    protection: "protection" in o ? o.protection : { required_status_checks: { contexts: ["ci"] }, required_pull_request_reviews: { required_approving_review_count: 1 }, enforce_admins: { enabled: true } },
    repo: o.repo || { full_name: repo, permissions: { push: true } },
  };
}

const TOOLS = {
  pr: "mcp__github__get_pull_request", files: "mcp__github__get_pull_request_files", reviews: "mcp__github__get_pull_request_reviews",
  checks: "mcp__github__list_check_runs", protection: "mcp__github__get_branch_protection", repo: "mcp__github__get_repository",
};

function records(ev, skip = [], at = new Date().toISOString()) {
  return Object.entries(ev).filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined)
    .map(([k, data]) => ({ tool: TOOLS[k], input: {}, at, data }));
}

const stateFor = (f, extra = {}) => ({
  mode: "merging", stage: "started", pr: PR, headSha: f.sha, branch: "jira/ABC-1", base: "main", method: "squash",
  remote: { host: "github.com", owner: "acme", name: "widgets" }, approvedFiles: [{ path: "src/app.js" }],
  startedAt: new Date(Date.now() - 60000).toISOString(), ...extra,
});

// Sends a response through the real PostToolUse hook. tool_response is a bare
// array of MCP content blocks, as captured from a live Claude Code 2.1.316 session.
function feed(f, sid, tool, data, input = {}) {
  spawnSync("node", [EVIDENCE], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid, tool_name: tool, tool_input: input, tool_response: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] }), // the shape Claude Code sends, verified live
    env: f.env, encoding: "utf8",
  });
}
const feedAll = (f, sid, ev, skip = []) => { for (const [k, d] of Object.entries(ev)) if (!skip.includes(k) && d) feed(f, sid, TOOLS[k], d); };

// ------------------------------------------------------------ the gate

test("gate: a pull request that meets every requirement passes", () => {
  const f = shipped();
  const r = G.evaluate(stateFor(f), records(good(f.sha)));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.facts.requiredContexts, ["ci"]);
  assert.equal(r.facts.approvals, 1);
});

const BLOCKS = [
  ["a different head SHA (new commits pushed)", (sha) => good(sha, { pr: { head: { sha: "1".repeat(40), ref: "jira/ABC-1", repo: { full_name: "acme/widgets" } } } }), /head is .*not the authorized/],
  ["a failing required check", (sha) => good(sha, { checks: { total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "failure", head_sha: sha }] } }), /concluded failure|no successful result/],
  ["a pending required check", (sha) => good(sha, { checks: { total_count: 1, check_runs: [{ name: "ci", status: "in_progress", conclusion: null, head_sha: sha }] } }), /is in_progress/],
  ["a required check that never ran", (sha) => good(sha, { checks: { total_count: 0, check_runs: [] } }), /required check "ci" has no successful result/],
  ["a check run for another commit", (sha) => good(sha, { checks: { total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success", head_sha: "2".repeat(40) }] } }), /is for commit/],
  ["truncated check runs", (sha) => good(sha, { checks: { total_count: 150, check_runs: [{ name: "ci", status: "completed", conclusion: "success", head_sha: sha }] } }), /truncated/],
  ["no branch protection evidence", (sha) => good(sha, { protection: null }), /branch protection cannot be verified/],
  ["protection with no required checks", (sha) => good(sha, { protection: { required_pull_request_reviews: { required_approving_review_count: 1 } } }), /no required status checks/],
  ["too few approving reviews", (sha) => good(sha, { reviews: [] }), /0 approving review/],
  ["an approval of an older commit", (sha) => good(sha, { reviews: [{ user: { login: "rev" }, state: "APPROVED", commit_id: "3".repeat(40) }] }), /0 approving review/],
  ["outstanding requested changes", (sha) => good(sha, { reviews: [{ user: { login: "rev" }, state: "APPROVED", commit_id: sha }, { user: { login: "rev" }, state: "CHANGES_REQUESTED", commit_id: sha }] }), /requested changes/],
  ["the author's own approval", (sha) => good(sha, { reviews: [{ user: { login: "dev" }, state: "APPROVED", commit_id: sha }] }), /0 approving review/],
  ["an unrelated file in the pull request", (sha) => good(sha, { files: [{ filename: "src/app.js" }, { filename: "src/other.js" }] }), /unrelated: src\/other\.js/],
  ["a missing approved file", (sha) => good(sha, { files: [] }), /missing: src\/app\.js/],
  ["a draft", (sha) => good(sha, { pr: { draft: true } }), /draft/],
  ["a blocked mergeable state", (sha) => good(sha, { pr: { mergeable_state: "blocked" } }), /must be "clean"/],
  ["a behind-base branch", (sha) => good(sha, { pr: { mergeable_state: "behind" } }), /must be "clean"/],
  ["a merge conflict", (sha) => good(sha, { pr: { mergeable: false, mergeable_state: "dirty" } }), /must be "clean"/],
  ["an already merged pull request", (sha) => good(sha, { pr: { state: "closed", merged: true } }), /already merged/],
  ["a closed pull request", (sha) => good(sha, { pr: { state: "closed" } }), /closed/],
  ["another pull request number", (sha) => good(sha, { pr: { number: 9, html_url: "https://github.com/acme/widgets/pull/9" } }), /#9, not #3/],
  ["another base branch", (sha) => good(sha, { pr: { base: { ref: "develop", repo: { full_name: "acme/widgets" } } } }), /base branch is develop/],
  ["another head branch", (sha) => good(sha, { pr: { head: { sha, ref: "other", repo: { full_name: "acme/widgets" } } } }), /head branch is other/],
  ["a fork as the head repository", (sha) => good(sha, { pr: { head: { sha, ref: "jira/ABC-1", repo: { full_name: "evil/widgets" } } } }), /forks are not merged/],
  ["another repository", (sha) => good(sha, { pr: { base: { ref: "main", repo: { full_name: "evil/widgets" } }, html_url: `https://github.com/evil/widgets/pull/${PR}` } }), /base repository is evil/],
  ["extra commits", (sha) => good(sha, { pr: { commits: 2 } }), /2 commits/],
  ["no permission to merge", (sha) => good(sha, { repo: { full_name: "acme/widgets", permissions: { pull: true, push: false } } }), /does not have permission/],
];
for (const [name, build, expected] of BLOCKS) {
  test(`gate blocks: ${name}`, () => {
    const f = shipped();
    const r = G.evaluate(stateFor(f), records(build(f.sha)));
    assert.equal(r.ok, false);
    assert.match(r.reasons.join("\n"), expected);
  });
}

test("gate blocks: each missing piece of evidence (insufficient evidence fails closed)", () => {
  const f = shipped();
  for (const kind of ["pr", "files", "reviews", "checks", "repo"]) {
    const r = G.evaluate(stateFor(f), records(good(f.sha), [kind]));
    assert.equal(r.ok, false, kind);
    assert.match(r.reasons.join("\n"), /insufficient evidence/, kind);
  }
  assert.equal(G.evaluate(stateFor(f), []).ok, false);
});

test("gate blocks: stale evidence, evidence from before authorization, and other pull requests", () => {
  const f = shipped();
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const state = stateFor(f, { startedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  assert.match(G.evaluate(state, records(good(f.sha), [], old)).reasons.join("\n"), /older than 10 minutes/);
  assert.match(G.evaluate(stateFor(f), records(good(f.sha), [], old)).reasons.join("\n"), /before this merge was authorized/);
  const other = records(good(f.sha)).map((r) => ({ ...r, input: { owner: "acme", repo: "widgets", pullNumber: 99 } }));
  assert.equal(G.evaluate(stateFor(f), other).ok, false, "evidence about #99 is not evidence about #3");
  const foreign = records(good(f.sha)).map((r) => ({ ...r, input: { owner: "evil", repo: "widgets" } }));
  assert.equal(G.evaluate(stateFor(f), foreign).ok, false, "evidence about another owner is ignored");
});

test("gate: both the live payload shape and the MCP-protocol shape are unwrapped", () => {
  const pr = { number: 3, head: { sha: "a".repeat(40) }, base: { ref: "main" } };
  const text = JSON.stringify(pr);
  assert.equal(G.jsonOf([{ type: "text", text }]).number, 3);
  assert.equal(G.jsonOf({ content: [{ type: "text", text }] }).number, 3);
  assert.equal(G.jsonOf(text).number, 3);
  assert.equal(G.classify("mcp__github__get_pull_request", G.jsonOf([{ type: "text", text }])), "pr");
  assert.equal(G.jsonOf([{ type: "text", text: "Not Found" }]), null);
  assert.equal(G.classify("rules", G.jsonOf([{ type: "required_status_checks", parameters: {} }])), "rules", "a rules list is not mistaken for content blocks");
});

test("gate: an unparseable or non-GitHub-shaped response is not evidence", () => {
  const f = shipped();
  const recs = records(good(f.sha)).map((r) => (r.tool === TOOLS.pr ? { ...r, data: { summary: "looks good, mergeable", number: PR } } : r));
  assert.match(G.evaluate(stateFor(f), recs).reasons.join("\n"), /insufficient evidence: no provider response for the pull request/);
  assert.equal(G.jsonOf({ content: [{ type: "text", text: "Not Found" }] }), null);
});

test("gate: rulesets can supply required checks and reviews", () => {
  const f = shipped();
  const ev = good(f.sha, { protection: null });
  const rules = { tool: "mcp__github__get_branch_rules", input: {}, at: new Date().toISOString(), data: [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } },
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
  ] };
  const r = G.evaluate(stateFor(f), [...records(ev), rules]);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.facts.requiredReviews, 1);
});

// -------------------------------------------------- authorization (start)

test("merge-start: refused without a ship record, with a wrong or short SHA, or without a method", () => {
  const unshipped = reviewed();
  unshipped.approve();
  assert.match(unshipped.run(["merge-start", unshipped.data, uuid(), KEY, "3", "a".repeat(40), "--method", "squash"]).out, /MERGE: REFUSED.*no valid ship record/);

  const f = shipped();
  assert.match(mergeStart(f, uuid(), "3", f.sha), /MERGE: REFUSED.*method explicitly/);
  assert.match(mergeStart(f, uuid(), "3", f.sha, "--method", "fast"), /MERGE: REFUSED.*merge method/);
  assert.match(mergeStart(f, uuid(), "3", f.sha, "--admin"), /MERGE: REFUSED/);
  assert.match(mergeStart(f, uuid(), "3", f.sha.slice(0, 12), "--method", "squash"), /MERGE: REFUSED.*40-character/);
  assert.match(mergeStart(f, uuid(), "3", "b".repeat(40), "--method", "squash"), /MERGE: REFUSED.*shipped commit is/);
  assert.match(mergeStart(f, uuid(), "x", f.sha, "--method", "squash"), /MERGE: REFUSED.*invalid pull request number/);
  assert.match(mergeStart(f, uuid(), "3", f.sha, "--method", "squash"), /MERGE: AUTHORIZED/);
});

test("merge-start: a tampered ship record or review approval is refused", () => {
  const f = shipped();
  const reviews = path.join(f.data, "plans", SITE, KEY, "reviews");
  const shipFile = path.join(reviews, "ship-rv-1.json");
  const approvalFile = path.join(reviews, "review-approval-rv-1.json");
  const saveShip = fs.readFileSync(shipFile, "utf8");
  const saveApproval = fs.readFileSync(approvalFile, "utf8");
  try {
    const rec = JSON.parse(saveShip);
    rec.commit = "c".repeat(40);
    fs.writeFileSync(shipFile, JSON.stringify(rec));
    assert.match(mergeStart(f, uuid(), "3", "c".repeat(40), "--method", "squash"), /MERGE: REFUSED.*no valid ship record/);
    fs.writeFileSync(shipFile, saveShip);

    fs.writeFileSync(approvalFile, saveApproval.replace(/"approvedAt": "[^"]+"/, '"approvedAt": "2000-01-01T00:00:00.000Z"'));
    assert.match(mergeStart(f, uuid(), "3", f.sha, "--method", "squash"), /MERGE: REFUSED.*signature/);
  } finally {
    fs.writeFileSync(shipFile, saveShip);
    fs.writeFileSync(approvalFile, saveApproval);
  }
});

// ---------------------------------------------- the MCP route (real hook)

test("evidence hook: records GitHub MCP reads only in a merge session, never writes", () => {
  const f = shipped();
  const { sid } = startOk(f);
  const other = uuid();
  const ev = good(f.sha);
  feed(f, other, TOOLS.pr, ev.pr);
  assert.ok(!fs.existsSync(path.join(f.data, "evidence", other)), "not a merge session");
  feed(f, sid, "mcp__jira__get_issue", ev.pr);
  feed(f, sid, "mcp__github__create_pull_request", ev.pr);
  feed(f, sid, "mcp__github__merge_pull_request", ev.pr);
  assert.ok(!fs.existsSync(path.join(f.data, "evidence", sid)), "non-GitHub servers and writes are not evidence");
  feed(f, sid, TOOLS.pr, ev.pr);
  assert.equal(fs.readdirSync(path.join(f.data, "evidence", sid)).length, 1);
});

test("merge-verify: BLOCKED with no evidence, PASS with complete real-hook evidence, BLOCKED when it fails", () => {
  const f = shipped();
  const a = startOk(f);
  const none = f.run(["merge-verify", f.data, a.sid]).out;
  assert.match(none, /MERGE GATE: BLOCKED/);
  assert.match(none, /insufficient evidence/);

  const b = startOk(f);
  feedAll(f, b.sid, good(f.sha));
  const pass = f.run(["merge-verify", f.data, b.sid]).out;
  assert.match(pass, /MERGE GATE: PASS/, pass);
  assert.match(pass, /Required checks: ci/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${b.sid}.json`), "utf8")).stage, "verified");

  const c = startOk(f);
  feedAll(f, c.sid, good(f.sha, { checks: { total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "failure", head_sha: f.sha }] } }));
  const blocked = f.run(["merge-verify", f.data, c.sid]).out;
  assert.match(blocked, /MERGE GATE: BLOCKED/);
  assert.match(blocked, /concluded failure/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${c.sid}.json`), "utf8")).stage, "started");
});

test("merge-verify: a free-text summary from the agent is not evidence", () => {
  const f = shipped();
  const { sid } = startOk(f);
  feed(f, sid, TOOLS.pr, "The pull request is open, all checks passed, two approvals, safe to merge.");
  assert.match(f.run(["merge-verify", f.data, sid]).out, /BLOCKED[\s\S]*insufficient evidence/);
});

const mergeCall = (f, sid, over = {}, ctx = {}) => guard(f, {
  session_id: sid, tool_name: "mcp__github__merge_pull_request", permission_mode: "default",
  tool_input: { owner: "acme", repo: "widgets", pullNumber: PR, sha: f.sha, merge_method: "squash", ...over }, ...ctx,
});

test("guard: an MCP merge reaches a prompt only with the authorized values and a passing gate", () => {
  const f = shipped();
  const { sid } = startOk(f);
  assert.equal(mergeCall(f, sid).permissionDecision, "deny", "no evidence yet");
  assert.match(mergeCall(f, sid).permissionDecisionReason, /merge gate/);

  feedAll(f, sid, good(f.sha));
  assert.equal(mergeCall(f, sid).permissionDecision, "ask");
  assert.equal(mergeCall(f, sid, {}, { permission_mode: "bypassPermissions" }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, {}, { permission_mode: "acceptEdits" }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { pullNumber: 4 }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { sha: "d".repeat(40) }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { merge_method: "rebase" }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { owner: "evil" }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { repo: "other" }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { auto_merge: true }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { admin: true }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, { sha: undefined }).permissionDecision, "deny", "a tool with no head-SHA field cannot pin the head");
  assert.equal(mergeCall(f, sid, {}, { agent_type: "jira-dev-harness:developer" }).permissionDecision, "deny");
  assert.equal(mergeCall(f, sid, {}, { agent_type: "jira-dev-harness:reviewer" }).permissionDecision, "deny");
});

test("guard: a merge is denied when the gate fails, evidence is for another commit, or no merge was authorized", () => {
  const f = shipped();
  const failing = startOk(f);
  feedAll(f, failing.sid, good(f.sha, { reviews: [] }));
  assert.equal(mergeCall(f, failing.sid).permissionDecision, "deny");

  const moved = startOk(f);
  feedAll(f, moved.sid, good("e".repeat(40)));
  assert.equal(mergeCall(f, moved.sid).permissionDecision, "deny");

  assert.equal(mergeCall(f, f.sid("ship")).permissionDecision, "deny", "a shipping session may not merge");
  assert.equal(mergeCall(f, f.sid("review")).permissionDecision, "deny", "neither may a reviewing session");
  for (const tool of ["mcp__github__enable_pull_request_auto_merge", "mcp__github__merge_branch", "mcp__other__merge_pull_request"]) {
    const ok = startOk(f);
    feedAll(f, ok.sid, good(f.sha));
    assert.equal(guard(f, { session_id: ok.sid, tool_name: tool, permission_mode: "default", tool_input: { owner: "acme", repo: "widgets", pullNumber: PR, sha: f.sha, merge_method: "squash" } }).permissionDecision, "deny", tool);
  }
});

test("guard: merge-run asks; raw gh/git merges, merge-start, and evidence tampering are denied", () => {
  const f = shipped();
  const { sid } = startOk(f);
  const run = `node "${STORE}" merge-run "${f.data}" ${sid}`;
  const base = { session_id: sid, tool_name: "Bash", permission_mode: "default" };
  assert.equal(guard(f, { ...base, tool_input: { command: run } }).permissionDecision, "ask");
  assert.equal(guard(f, { ...base, permission_mode: "auto", tool_input: { command: run } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, session_id: f.sid("ship"), tool_input: { command: `node "${STORE}" merge-run "${f.data}" ${f.sid("ship")}` } }).permissionDecision, "deny", "no merge authorization");
  assert.equal(guard(f, { ...base, tool_input: { command: `${run} && gh pr merge 3 --admin` } }).permissionDecision, "deny");
  for (const command of ["gh pr merge 3 --admin --squash", "gh pr merge 3 --auto", "gh api -X PUT repos/acme/widgets/pulls/3/merge", "git merge jira/ABC-1", "git push origin HEAD:main",
    `node "${STORE}" merge-start "${f.data}" ${sid} ${KEY} 3 ${f.sha} --method squash`]) {
    assert.equal(guard(f, { ...base, tool_input: { command } }).permissionDecision, "deny", command);
  }
  const evidence = path.join(f.data, "evidence", sid, "00001.json");
  assert.equal(guard(f, { ...base, tool_name: "Write", tool_input: { file_path: evidence, content: "{}" } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_input: { command: `echo {} > "${evidence}"` } }).permissionDecision, "deny");
  for (const sub of ["merge-verify", "merge-record", "merge-collect"]) {
    assert.notEqual(guard(f, { ...base, tool_input: { command: `node "${STORE}" ${sub} "${f.data}" ${sid}` } }).permissionDecision, "deny", sub);
  }
});

test("merge-record: only a recorded provider response that says merged counts", () => {
  const f = shipped();
  const a = startOk(f);
  assert.match(f.run(["merge-record", f.data, a.sid]).out, /ERROR.*no pull request response/);
  feedAll(f, a.sid, good(f.sha));
  assert.match(f.run(["merge-record", f.data, a.sid]).out, /ERROR.*did not confirm/, "an open pull request is not a merge");

  const b = startOk(f);
  const merged = good(f.sha, { pr: { state: "closed", merged: true, merge_commit_sha: "f".repeat(40) } }).pr;
  feed(f, b.sid, TOOLS.pr, merged);
  assert.match(f.run(["merge-record", f.data, b.sid]).out, /MERGED \(confirmed by a recorded provider response\).*#3/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${b.sid}.json`), "utf8")).stage, "merged");

  const c = startOk(f);
  feed(f, c.sid, TOOLS.pr, { ...merged, merge_commit_sha: null });
  assert.match(f.run(["merge-record", f.data, c.sid]).out, /ERROR.*merge commit/);
  const d = startOk(f);
  feed(f, d.sid, TOOLS.pr, { ...merged, head: { ...merged.head, sha: "9".repeat(40) } });
  assert.match(f.run(["merge-record", f.data, d.sid]).out, /ERROR.*head is not the authorized/);
});

// ----------------------------------------- the gh route (in-process mock)

function mockDeps(ev, { official = true, merged = true, calls = [] } = {}) {
  return {
    calls,
    officialGh: () => (official ? { ok: true, exe: "gh", version: "gh version 9.9.9" } : { ok: false, reason: "not the official gh" }),
    adapter: {
      mergeEvidence: () => {
        calls.push("evidence");
        const at = new Date().toISOString();
        const out = Object.entries(ev).filter(([, v]) => v).map(([k, data]) => ({ tool: { pr: "gh api pulls", files: "gh api pulls/files", reviews: "gh api pulls/reviews", checks: "gh api check-runs", protection: "gh api branch protection", repo: "gh api repository" }[k], input: { endpoint: k }, at, data }));
        return calls.filter((c) => c === "merge").length && merged
          ? out.map((r) => (r.tool === "gh api pulls" ? { ...r, data: { ...r.data, state: "closed", merged: true, merge_commit_sha: "a".repeat(40) } } : r))
          : out;
      },
      mergePullRequest: (info, remote, args) => { calls.push("merge"); calls.args = args; },
    },
  };
}

test("gh route: merges with the head SHA and method pinned, and confirms from the provider", () => {
  const f = shipped();
  const { sid, state } = startOk(f, uuid(), "rebase");
  const deps = mockDeps(good(f.sha));
  const next = M.runGh(f.data, { ...state, sessionId: sid }, deps);
  assert.equal(next.stage, "merged");
  assert.equal(next.mergeCommit, "a".repeat(40));
  assert.deepEqual(deps.calls.args, { number: PR, sha: f.sha, method: "rebase" });
});

test("gh route: nothing is merged when the gate fails, gh is not official, or the provider doesn't confirm", () => {
  const f = shipped();
  const { sid, state } = startOk(f);
  const s = { ...state, sessionId: sid };

  const failing = mockDeps(good(f.sha, { reviews: [] }));
  assert.throws(() => M.runGh(f.data, s, failing), /merge blocked.*approving review/);
  assert.ok(!failing.calls.includes("merge"));

  const moved = mockDeps(good("1".repeat(40)));
  assert.throws(() => M.runGh(f.data, s, moved), /merge blocked/);
  assert.ok(!moved.calls.includes("merge"));

  const noProtection = mockDeps(good(f.sha, { protection: null }));
  assert.throws(() => M.runGh(f.data, s, noProtection), /branch protection cannot be verified/);
  assert.ok(!noProtection.calls.includes("merge"));

  const fake = mockDeps(good(f.sha), { official: false });
  assert.throws(() => M.runGh(f.data, s, fake), /not the official gh/);
  assert.deepEqual(fake.calls, []);

  const unconfirmed = mockDeps(good(f.sha), { merged: false });
  assert.throws(() => M.runGh(f.data, s, unconfirmed), /did not confirm/);
  assert.ok(unconfirmed.calls.includes("merge"), "the merge was attempted, but is reported as unconfirmed");

  assert.throws(() => M.runGh(f.data, { ...s, mode: "shipping" }, mockDeps(good(f.sha))), /no merge authorization/);
});

test("gh route: the approval chain is re-checked at merge time", () => {
  const f = shipped();
  const { sid, state } = startOk(f);
  const approvalFile = path.join(f.data, "plans", SITE, KEY, "reviews", "review-approval-rv-1.json");
  const saved = fs.readFileSync(approvalFile, "utf8");
  try {
    fs.rmSync(approvalFile);
    const deps = mockDeps(good(f.sha));
    assert.throws(() => M.runGh(f.data, { ...state, sessionId: sid }, deps), /approval chain no longer holds/);
    assert.ok(!deps.calls.includes("merge"));
  } finally {
    fs.writeFileSync(approvalFile, saved);
  }
});

test("provider: merge call checks and the gh merge arguments", () => {
  const f = shipped();
  const s = stateFor(f);
  const ok = { owner: "acme", repo: "widgets", pullNumber: PR, sha: f.sha, merge_method: "squash" };
  assert.equal(P.mcpMergeProblem(s, ok), null);
  assert.match(P.mcpMergeProblem(s, { ...ok, sha: undefined }), /head-SHA/);
  assert.match(P.mcpMergeProblem(s, { ...ok, merge_method: undefined }), /merge-method/);
  assert.match(P.mcpMergeProblem(s, { ...ok, delete_branch: true }), /not allowed/);
  assert.match(P.mcpMergeProblem(null, ok), /no merge authorization/);
  assert.match(P.mcpMergeProblem({ ...s, mode: "shipping" }, ok), /no merge authorization/);
  assert.equal(P.classifyMcpTool("mcp__github__merge_pull_request"), "mergePullRequest");
  assert.equal(P.classifyMcpTool("mcp__github__enable_pull_request_auto_merge"), "otherMerge");
  assert.equal(P.classifyMcpTool("mcp__other__merge_pull_request"), "otherMerge");
  assert.throws(() => P.GhAdapter.mergePullRequest({ exe: "gh" }, { host: "github.com", owner: "a", name: "b" }, { number: 1, sha: "x", method: "admin" }), /invalid merge method/);
});

test("the plugin ships no unpinned or bypassing merge path", () => {
  const files = ["scripts/lib/merge.cjs", "scripts/lib/provider.cjs", "scripts/plan-store.cjs", "skills/merge/SKILL.md"];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|-|>|#)/.test(l)).join("\n");
    assert.ok(!/["'`]--admin["'`]|["'`]--auto["'`]|--delete-branch|bypass_pull_request/.test(text.replace(/auto_merge|"bypass"/g, "")) || rel.endsWith("SKILL.md"), rel);
  }
  const gh = fs.readFileSync(path.join(ROOT, "scripts/lib/provider.cjs"), "utf8");
  assert.match(gh, /"--match-head-commit"/);
});

// ------------------------------------- production-path bypass attempts

test("guard: a forged store, environment prefixes, and wrappers can't reach ship or merge steps", () => {
  const f = shipped();
  const { sid } = startOk(f);
  const base = { session_id: sid, tool_name: "Bash", permission_mode: "default" };
  const forged = path.join(f.base, "forged-store");
  const real = (sub) => `node "${STORE}" ${sub} "${f.data}" ${sid}`;
  assert.equal(guard(f, { ...base, tool_input: { command: real("merge-run") } }).permissionDecision, "ask", "control: the real store asks");
  for (const sub of ["merge-run", "ship-push", "ship-pr", "merge-verify", "merge-record", "merge-collect"]) {
    assert.equal(guard(f, { ...base, tool_input: { command: `node "${STORE}" ${sub} "${forged}" ${sid}` } }).permissionDecision, "deny", `${sub} with a forged store`);
  }
  for (const command of [
    `CLAUDE_PLUGIN_DATA=${forged} ${real("merge-run")}`,
    `env CLAUDE_PLUGIN_DATA=${forged} ${real("merge-run")}`,
    `PATH=/evil ${real("merge-run")}`,
    `JDH_PROVIDER=mock ${real("merge-run")}`,
    `cd "${f.repo}" && ${real("merge-run")}`,
    `${real("merge-run")} --admin`,
    `bash -c '${real("merge-run")}'`,
    `node -e "require('${STORE.split(path.sep).join("/")}')"`,
  ]) {
    const d = guard(f, { ...base, tool_input: { command } }).permissionDecision;
    assert.notEqual(d, "ask", command);
    assert.notEqual(d, "(none)", command);
  }
});

test("guard: evidence from one MCP server can't authorize a merge through another", () => {
  const f = shipped();
  const { sid } = startOk(f);
  const ev = good(f.sha);
  for (const [k, d] of Object.entries(ev)) if (d) feed(f, sid, TOOLS[k].replace("mcp__github__", "mcp__fakegithub__"), d);
  assert.equal(mergeCall(f, sid).permissionDecision, "deny", "evidence came from another server");
  assert.match(mergeCall(f, sid).permissionDecisionReason, /insufficient evidence/);
  feedAll(f, sid, ev);
  assert.equal(mergeCall(f, sid).permissionDecision, "ask", "the same server's evidence is accepted");
});

test("no synthetic route: evidence and records are only writable by the hook and scripts", () => {
  const f = shipped();
  const { sid } = startOk(f);
  const base = { session_id: sid, permission_mode: "default" };
  const targets = [
    path.join(f.data, "evidence", sid, "00001.json"),
    path.join(f.data, "sessions", `${sid}.json`),
    path.join(f.data, "plans", SITE, KEY, "reviews", "ship-rv-1.json"),
    path.join(f.data, "plans", SITE, KEY, "reviews", "review-approval-rv-1.json"),
    path.join(f.data, "keys", "approval.key"),
  ];
  for (const t of targets) {
    for (const tool of ["Write", "Edit"]) {
      assert.equal(guard(f, { ...base, tool_name: tool, tool_input: { file_path: t, content: "{}" } }).permissionDecision, "deny", `${tool} ${path.basename(t)}`);
    }
    assert.equal(guard(f, { ...base, tool_name: "Bash", tool_input: { command: `cp /tmp/x "${t}"` } }).permissionDecision, "deny", `cp ${path.basename(t)}`);
  }
  assert.equal(guard(f, { ...base, tool_name: "Read", tool_input: { file_path: targets[4] } }).permissionDecision, "deny", "the signing key can't be read");
  // The merge entry points accept no provider, mock, or adapter selection from the command line or environment.
  const source = ["scripts/plan-store.cjs", "scripts/guard.cjs", "scripts/evidence.cjs"].map((r) => fs.readFileSync(path.join(ROOT, r), "utf8")).join("\n");
  assert.ok(!/deps\s*[:=]|mockAdapter|JDH_|process\.env\.(MOCK|PROVIDER|ADAPTER|GH_)/i.test(source));
  const envReads = [...(source + fs.readFileSync(path.join(ROOT, "scripts/lib/merge.cjs"), "utf8")).matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)], ["CLAUDE_PLUGIN_DATA"]);
});
