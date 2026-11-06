// Phase 8C: the full offline chain, step by step, with the guard checked at
// each stage: ticket -> plan -> approval -> sibling worktree -> Developer
// implementation -> independent review -> developer review approval ->
// commit -> push -> pull request -> worktree removal -> merge verification
// -> merge (mocked provider) -> merged stage. Disposable repositories under
// "React Apps/jadwa app", a local bare origin, and mocked GitHub responses fed
// through the real evidence hook. No Jira, GitHub, or network is involved.
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../scripts/lib/approval.cjs");
const PR_ = require("../scripts/lib/progress.cjs");
const { STORE, SITE, KEY, git, makeFixture, draft, reviewJson, guard } = require("./helpers.cjs");
const { REPO_DIR, PLAN, CHECK, PR, TOOLS, json, goodEvidence, feed, feedAll } = require("./worktree-flow.cjs");

const slash = (p) => p.replace(/\\/g, "/");

test("offline end-to-end: ticket to merge, through the signed sibling worktree", () => {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  const store = slash(STORE);
  const g = (name, input) => guard(f, { session_id: f.sid(name), permission_mode: "default", cwd: f.repo, ...input });
  const decision = (name, input) => g(name, input).permissionDecision;
  const mainState = () => ({
    head: git(f.repo, "rev-parse", "HEAD"), branch: git(f.repo, "branch", "--show-current"),
    status: git(f.repo, "status", "--porcelain", "--ignored"), index: git(f.repo, "ls-files", "-s"),
    app: fs.readFileSync(path.join(f.repo, "src", "app.js"), "utf8"),
  });
  const before = mainState();
  const ticket = path.join(f.data, "plans", SITE, KEY);

  // ---- 1. Ticket: reference, mapping, planning session (read-only).
  assert.match(f.run(["ticket-ref", `https://${SITE}/browse/${KEY}`]).out, /^TICKET-REF: site=example\.atlassian\.net key=ABC-1 project=ABC$/m);
  assert.match(f.run(["mapping-status", SITE, KEY]).out, /^MAPPING-STATUS: VERIFIED - the committed mapping covers this site and project$/m);
  assert.match(f.run(["session-start", f.data, f.sid("ticket")]).out, /JDH-WORKFLOW-SESSION:/);
  assert.equal(decision("ticket", { tool_name: "Write", tool_input: { file_path: path.join(f.repo, "src", "app.js") } }), "deny", "planning never writes the repository");
  assert.equal(decision("ticket", { tool_name: "Bash", tool_input: { command: `node "${store}" worktree-status "${slash(f.data)}" ${SITE}/${KEY}` } }), "(none)");
  assert.match(f.run(["worktree-status", f.data, `${SITE}/${KEY}`]).out, /WORKTREE: NONE[\s\S]*Plan: none saved/);

  // ---- 2. Plan saved with its base commit; 3. developer approval.
  const planDraft = f.run(["draft-path", SITE, KEY, "plan"]).out.trim();
  assert.equal(decision("ticket", { tool_name: "Write", tool_input: { file_path: planDraft } }), "(none)", "the plan draft is the one writable file");
  fs.writeFileSync(planDraft, PLAN);
  const saved = f.run(["save", f.data, SITE, KEY, planDraft]).out;
  const planHash = /SHA-256: ([0-9a-f]{64})/.exec(saved)[1];
  assert.match(saved, new RegExp(`Base commit: ${before.head}`));
  assert.equal(decision("ticket", { tool_name: "Bash", tool_input: { command: `node "${store}" approve "${slash(f.data)}" ${f.sid("ticket")} ${KEY} r1 ${planHash}` } }), "deny", "Claude can't approve");
  assert.match(f.run(["approve", f.data, f.sid("approve"), KEY, "r1", planHash]).out, /APPROVAL: GRANTED[\s\S]*Base commit:/);
  assert.equal(json(path.join(ticket, "approval-r1.json")).baseHead, before.head);

  // ---- 4. Worktree: created, access handed to the developer, then authorized.
  const first = f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", planHash]).out;
  assert.match(first, /WORKTREE CREATED[\s\S]*ACCESS NEEDED/);
  const wt = /^Worktree: (.+)$/m.exec(first)[1];
  assert.equal(path.basename(wt), `jadwa app-${KEY}`);
  assert.equal(path.dirname(wt), slash(fs.realpathSync.native(path.dirname(f.repo))));
  assert.ok(first.includes(`/add-dir "${wt}"`));
  assert.match(f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", planHash]).out, /IMPLEMENTATION: AUTHORIZED/);

  // ---- 5. Developer implementation, confined to the worktree.
  const dev = (input) => decision("impl", { agent_type: "jira-dev-harness:developer", ...input });
  assert.equal(dev({ tool_name: "Edit", tool_input: { file_path: path.join(wt, "src", "app.js") } }), "ask");
  assert.equal(dev({ tool_name: "Edit", tool_input: { file_path: path.join(f.repo, "src", "app.js") } }), "deny");
  assert.equal(dev({ tool_name: "Bash", tool_input: { command: `cd "${wt}" && node -v` } }), "ask");
  assert.equal(dev({ tool_name: "Bash", tool_input: { command: "node -v" } }), "deny");
  assert.equal(dev({ tool_name: "Bash", tool_input: { command: `cd "${wt}" && git commit -am x` } }), "deny");
  fs.writeFileSync(path.join(wt, "src", "app.js"), "module.exports = 2;\n");
  assert.match(f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `## Implementation report: ${KEY} r1\nStatus: COMPLETED\n`)]).out, /REPORT SAVED/);

  // ---- 6. Independent review of the worktree; recorded check; enforced verdict.
  const rs = f.run(["review-start", f.data, f.sid("review"), KEY]).out;
  assert.ok(rs.includes(`Reviewed workspace: ticket worktree ${wt}`));
  assert.equal(decision("review", { agent_type: "jira-dev-harness:reviewer", tool_name: "Write", tool_input: { file_path: path.join(wt, "src", "app.js") } }), "deny");
  assert.match(f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]).out, /Ran in: .*\(ticket worktree\)\nExit code: 0/);
  const rv = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson("PASS"))]).out;
  assert.match(rv, /VERDICT: PASS/);
  const reviewHash = /Review SHA-256: ([0-9a-f]{64})/.exec(rv)[1];

  // ---- 7. Developer review approval (a separate gate from the Reviewer's PASS).
  assert.match(f.run(["ship-start", f.data, f.sid("early"), KEY, "rv-1", reviewHash]).out, /SHIP: REFUSED\. .*has not been approved/);
  assert.match(f.run(["approve-review", f.data, f.sid("approveReview"), KEY, "rv-1", reviewHash]).out, /REVIEW APPROVAL: GRANTED/);

  // ---- 8-10. Commit, push, pull request: each step asks, from the worktree.
  assert.match(f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", reviewHash]).out, /SHIP: AUTHORIZED[\s\S]*Shipped from: ticket worktree/);
  const shipCmd = (sub) => `node "${store}" ${sub} "${slash(f.data)}" ${f.sid("ship")}`;
  assert.equal(decision("ship", { tool_name: "Bash", tool_input: { command: shipCmd("ship-push") } }), "ask");
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: export 2\n`)]).out, /COMMITTED: [0-9a-f]{40} on jira\/ABC-1/);
  const sha = git(wt, "rev-parse", "HEAD");
  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /PUSHED/);
  assert.equal(git(f.bare, "rev-parse", `refs/heads/jira/${KEY}`), sha);
  const prep = f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Export two\n\nChanges the export.\n")]).out;
  const title = /^Title: (.*)$/m.exec(prep)[1];
  const body = /-----BEGIN PR BODY-----\n([\s\S]*?)\n-----END PR BODY-----/.exec(prep)[1];
  const create = { tool_name: "mcp__github__create_pull_request", tool_input: { owner: "acme", repo: "widgets", head: `jira/${KEY}`, base: "main", title, body } };
  assert.equal(decision("ship", create), "ask", "the mocked MCP pull request call reaches the developer's prompt");
  assert.equal(decision("ship", { tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: PR } }), "deny", "shipping never merges");
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), `https://github.com/acme/widgets/pull/${PR}`]).out, /PULL REQUEST RECORDED/);
  assert.equal(PR_.deriveStage(f.data, L.findTicketDir(f.data, KEY)).stage, "pr-created");

  // ---- 11. Authorized worktree removal (explicit, user-only).
  const removal = f.run(["worktree-remove", f.data, f.sid("remove"), KEY, "--end-session", f.sid("impl"), "--end-session", f.sid("review")]).out;
  assert.match(removal, /WORKTREE REMOVAL: REMOVED/);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(git(f.repo, "rev-parse", `refs/heads/jira/${KEY}`), sha, "the branch is kept");

  // ---- 12. Merge verification after removal, with its own authorization.
  const ms = f.run(["merge-start", f.data, f.sid("merge"), KEY, String(PR), sha, "--method", "squash"]).out;
  assert.match(ms, /MERGE: AUTHORIZED/, ms);
  const mergeCall = { tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "acme", repo: "widgets", pullNumber: PR, sha, merge_method: "squash" } };
  assert.equal(decision("merge", mergeCall), "deny", "no provider evidence yet");
  feedAll(f, f.sid("merge"), goodEvidence(sha));
  assert.match(f.run(["merge-verify", f.data, f.sid("merge")]).out, /MERGE GATE: PASS/);
  assert.equal(decision("merge", mergeCall), "ask", "the merge reaches the developer's prompt only now");
  assert.equal(decision("merge", { ...mergeCall, tool_input: { ...mergeCall.tool_input, sha: "d".repeat(40) } }), "deny");

  // ---- 13. The (mocked) provider confirms the merge; the stage is merged.
  feed(f, f.sid("merge"), TOOLS.pr, { ...goodEvidence(sha).pr, state: "closed", merged: true, merge_commit_sha: "e".repeat(40) });
  assert.match(f.run(["merge-record", f.data, f.sid("merge")]).out, new RegExp(`^MERGED \\(confirmed by a recorded provider response\\): pull request #${PR}, merge commit e{40}, via github-mcp$`, "m"));
  assert.equal(PR_.deriveStage(f.data, L.findTicketDir(f.data, KEY)).stage, "merged");

  // Throughout: the main checkout never changed, and every record verifies.
  assert.deepEqual(mainState(), before);
  const key = L.approvalKey(f.data, false);
  for (const file of ["approval-r1.json", "worktree-b1.json", "worktree-b1-removed.json", "reviews/review-rv-1.json", "reviews/review-approval-rv-1.json", "reviews/ship-commit-rv-1.json", "reviews/ship-rv-1.json", "reviews/merge-rv-1.json"]) {
    assert.ok(L.signatureValid(json(path.join(ticket, file)), key), `${file} is signed and intact`);
  }
});
