// Phase 8C step 5: shipping (commit, push, pull request) and merge
// verification for tickets implemented in their signed sibling worktree.
// Everything runs against disposable repositories and a local bare "origin";
// pull requests are recorded through the MCP route (no provider is called).
// Every repository lives under "React Apps/demo app".
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../scripts/lib/approval.cjs");
const M = require("../scripts/lib/merge.cjs");
const { STORE, SITE, KEY, git, makeFixture, draft, reviewJson, reviewed: legacyReviewed, guard, uuid } = require("./helpers.cjs");

const REPO_DIR = path.join("React Apps", "demo app");
const PLAN = `# Plan ${KEY}\n\nReadiness: READY\n\n## Files likely to change\n- \`src/app.js\`\n\n## Testing and validation\n- \`node -v\`\n`;
const CHECK = `node -e "process.exit(require('./src/app.js') === 2 ? 0 : 1)"`;
const PR = 7;

// Plan approved, implemented in the worktree, reviewed (PASS), and the review
// approved by the developer.
function approvedReview() {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  f.run(["save", f.data, SITE, KEY, draft(f, "plan", PLAN)]);
  f.planHash = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, KEY]).out)[1];
  assert.match(f.run(["approve", f.data, f.sid("plan"), KEY, "r1", f.planHash]).out, /GRANTED/);
  f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", f.planHash]);
  assert.match(f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", f.planHash]).out, /AUTHORIZED/);
  f.ticket = path.join(f.data, "plans", SITE, KEY);
  f.wt = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid("impl")}.json`), "utf8")).worktree.path;
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  assert.match(f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `Report ${KEY}\n`)]).out, /REPORT SAVED/);
  assert.match(f.run(["review-start", f.data, f.sid("review"), KEY]).out, /STARTED/);
  assert.match(f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]).out, /Exit code: 0/);
  const saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson("PASS"))]).out;
  f.reviewHash = /Review SHA-256: ([0-9a-f]{64})/.exec(saved)[1];
  assert.match(f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", f.reviewHash]).out, /REVIEW APPROVAL: GRANTED/);
  f.bindingFile = path.join(f.ticket, "worktree-b1.json");
  f.binding = JSON.parse(fs.readFileSync(f.bindingFile, "utf8"));
  f.approvalFile = path.join(f.ticket, "reviews", "review-approval-rv-1.json");

  f.main = () => ({
    head: git(f.repo, "rev-parse", "HEAD"),
    branch: git(f.repo, "branch", "--show-current"),
    status: git(f.repo, "status", "--porcelain", "--ignored"),
    index: git(f.repo, "ls-files", "-s"),
    app: fs.readFileSync(path.join(f.repo, "src", "app.js"), "utf8"),
  });
  f.before = f.main();
  f.ship = (...extra) => f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", f.reviewHash, ...extra]).out;
  f.commit = (msg = `${KEY}: export 2\n\nShips the approved change.\n`) => f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", msg)]);
  f.push = () => f.run(["ship-push", f.data, f.sid("ship")]);
  f.prepare = () => f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Export two\n\nChanges the export.\n")]);
  f.record = (url = `https://github.com/acme/widgets/pull/${PR}`) => f.run(["ship-record-pr", f.data, f.sid("ship"), url]);
  f.state = () => JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid("ship")}.json`), "utf8"));
  f.remoteBranch = () => {
    try { return git(f.bare, "rev-parse", `refs/heads/jira/${KEY}`); } catch { return null; }
  };
  return f;
}

const withBindingTampered = (f, fn) => {
  const good = fs.readFileSync(f.bindingFile, "utf8");
  fs.writeFileSync(f.bindingFile, good.replace(/"planRevision": 1/, '"planRevision": 5'));
  try { fn(); } finally { fs.writeFileSync(f.bindingFile, good); }
};

// --------------------------------------------------------------- happy path

test("worktree shipping: commit, push, and pull request from the worktree on jira/<KEY>; the main checkout is untouched", () => {
  const f = approvedReview();
  const start = f.ship();
  assert.match(start, /SHIP: AUTHORIZED for ABC-1 \(rv-1\)/);
  assert.ok(start.includes(`Shipped from: ticket worktree ${f.wt} (branch jira/${KEY}, base ${f.binding.baseHead}, binding worktree-b1)`));
  assert.match(start, /Ticket branch: jira\/ABC-1 \(the worktree's fixed branch, already checked out there; never switched\)/);
  const s = f.state();
  assert.equal(s.layout, "worktree");
  assert.deepEqual(s.workspace, { kind: "worktree", path: f.wt, branch: `jira/${KEY}`, baseHead: f.binding.baseHead, binding: 1, bindingHmac: f.binding.hmac });
  assert.equal(s.reviewApprovalSha256, L.sha256(f.approvalFile));

  const c = f.commit();
  assert.match(c.out, /COMMITTED: [0-9a-f]{40} on jira\/ABC-1/);
  const sha = git(f.wt, "rev-parse", "HEAD");
  assert.equal(git(f.wt, "rev-parse", "HEAD~1"), f.binding.baseHead, "the shipping commit sits on the approved base");
  assert.equal(git(f.wt, "diff", "--name-only", "HEAD~1", "HEAD"), "src/app.js");
  assert.equal(git(f.wt, "branch", "--show-current"), `jira/${KEY}`);
  const rec = JSON.parse(fs.readFileSync(path.join(f.ticket, "reviews", "ship-commit-rv-1.json"), "utf8"));
  assert.ok(L.signatureValid(rec, L.approvalKey(f.data, false)));
  assert.equal(rec.commit, sha);
  assert.equal(rec.parent, f.binding.baseHead);

  assert.match(f.push().out, /PUSHED: jira\/ABC-1/);
  assert.equal(f.remoteBranch(), sha);
  assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), f.binding.baseHead, "origin's main is untouched");
  const prep = f.prepare().out;
  assert.match(prep, /Head: jira\/ABC-1\nBase: main/);
  assert.match(f.record().out, /PULL REQUEST RECORDED/);
  assert.match(f.run(["ship-status", f.data, f.sid("ship")]).out, /stage pr-created[\s\S]*Gates: valid/);

  const ship = JSON.parse(fs.readFileSync(path.join(f.ticket, "reviews", "ship-rv-1.json"), "utf8"));
  assert.ok(L.signatureValid(ship, L.approvalKey(f.data, false)));
  assert.equal(ship.layout, "worktree");
  assert.deepEqual(ship.workspace, s.workspace);
  assert.equal(ship.reviewApprovalSha256, L.sha256(f.approvalFile));
  assert.equal(ship.commit, sha);
  assert.equal(ship.branch, `jira/${KEY}`);
  assert.equal(ship.planRevision, 1);

  assert.deepEqual(f.main(), f.before, "HEAD, branch, status, index, and files of the main checkout are unchanged");
});

test("--branch is refused for a worktree ticket, and shipping never creates or switches a branch", () => {
  const f = approvedReview();
  for (const name of [`jira/${KEY}`, `feature/${KEY}-x`]) {
    assert.match(f.ship("--branch", name), /SHIP: REFUSED\. --branch is not allowed for a ticket worktree: ABC-1 ships on its fixed branch jira\/ABC-1/);
  }
  assert.match(f.ship(), /AUTHORIZED/);
  git(f.wt, "switch", "-q", "-c", "other");
  const c = f.commit();
  assert.match(c.out, /ERROR: commit refused: .*branch other checked out, not jira\/ABC-1/);
  assert.equal(git(f.wt, "rev-parse", "HEAD"), f.binding.baseHead, "nothing was committed");
  git(f.wt, "switch", "-q", `jira/${KEY}`);
  assert.match(f.commit().out, /COMMITTED/);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
});

// --------------------------------------------- stale approvals and changes

test("changes after the review approval block shipping before any git change", () => {
  const f = approvedReview();
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 99;\n");
  assert.match(f.ship(), /SHIP: REFUSED\. .*the code changed after the review/);
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  assert.match(f.ship(), /AUTHORIZED/);

  fs.writeFileSync(path.join(f.wt, "extra.txt"), "x\n");
  assert.match(f.commit().out, /ERROR: commit refused: .*untracked files differ/);
  fs.rmSync(path.join(f.wt, "extra.txt"));

  // The developer's review approval itself changed (re-signed with another time).
  const good = fs.readFileSync(f.approvalFile, "utf8");
  const a = JSON.parse(good);
  a.approvedAt = "2001-01-01T00:00:00.000Z";
  delete a.hmac;
  a.hmac = L.sign(a, L.approvalKey(f.data, false));
  fs.writeFileSync(f.approvalFile, JSON.stringify(a, null, 2));
  assert.match(f.commit().out, /ERROR: commit refused: the developer's review approval changed since shipping was authorized/);
  fs.writeFileSync(f.approvalFile, good);
  assert.equal(git(f.wt, "rev-parse", "HEAD"), f.binding.baseHead);
  assert.match(f.commit().out, /COMMITTED/);
});

test("unexpected commits on the ticket branch stop shipping", () => {
  const f = approvedReview();
  // Before shipping starts: a commit nobody authorized.
  git(f.wt, "commit", "-q", "-am", "manual commit");
  assert.match(f.ship(), /SHIP: REFUSED\. .*the code changed after the review \(HEAD moved/);
  git(f.wt, "reset", "-q", "--soft", "HEAD~1");
  git(f.wt, "reset", "-q");
  assert.match(f.ship(), /AUTHORIZED/);
  assert.match(f.commit().out, /COMMITTED/);

  // After the shipping commit: another commit before the push.
  fs.writeFileSync(path.join(f.wt, "later.txt"), "later\n");
  git(f.wt, "add", "later.txt");
  git(f.wt, "commit", "-q", "-m", "later");
  assert.match(f.push().out, /ERROR: push refused: HEAD is no longer the commit that was made for this ticket/);
  assert.equal(f.remoteBranch(), null, "nothing reached origin");
});

test("a rewritten shipping commit (same message, different content) is refused before push", () => {
  const f = approvedReview();
  f.ship();
  f.commit();
  // Amend the commit with different content: HEAD changes, so it no longer matches.
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 3;\n");
  git(f.wt, "commit", "-q", "--amend", "-am", `${KEY}: export 2`);
  assert.match(f.push().out, /ERROR: push refused: HEAD is no longer the commit/);
  // Forge the session's commit to the amended one: content and record checks still catch it.
  const sFile = path.join(f.data, "sessions", `${f.sid("ship")}.json`);
  const s = JSON.parse(fs.readFileSync(sFile, "utf8"));
  fs.writeFileSync(sFile, JSON.stringify({ ...s, commit: git(f.wt, "rev-parse", "HEAD") }));
  assert.match(f.push().out, /ERROR: push refused: src\/app\.js in the shipping commit differs from the reviewed content/);
  assert.equal(f.remoteBranch(), null);
});

// ------------------------------------------------------- remote, failures

test("a changed origin is refused before push and before the pull request", () => {
  const f = approvedReview();
  f.ship();
  f.commit();
  // origin is part of the repository identity, so the approval chain itself
  // refuses first; the shipping remote check backs it up.
  const changed = /.*(origin changed since shipping was authorized|was planned for .*, not .*origin https:\/\/github\.com\/(evil|acme\/other))/;
  git(f.repo, "remote", "set-url", "origin", "https://github.com/evil/widgets.git");
  assert.match(f.push().out, new RegExp(`ERROR: push refused: ${changed.source}`));
  git(f.repo, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");

  // A push URL pointing elsewhere is not part of the identity: the remote check catches it.
  git(f.repo, "config", "remote.origin.pushurl", "https://github.com/evil/widgets.git");
  assert.match(f.push().out, /ERROR: push refused: origin's push URL \(remote\.origin\.pushurl\) does not point to the authorized repository/);
  git(f.repo, "config", "--unset", "remote.origin.pushurl");
  assert.equal(f.remoteBranch(), null);

  assert.match(f.push().out, /PUSHED/);
  f.prepare();
  git(f.repo, "remote", "set-url", "origin", "https://github.com/acme/other.git");
  assert.match(f.record().out, new RegExp(`ERROR: recording the pull request refused: ${changed.source}`));
  git(f.repo, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
  assert.match(f.record().out, /PULL REQUEST RECORDED/);
});

test("partial failures leave the session at its stage and can be retried", () => {
  const f = approvedReview();
  f.ship();
  f.commit();
  fs.renameSync(f.bare, `${f.bare}-offline`);
  const failed = f.push();
  assert.match(failed.out, /ERROR: git push failed/);
  assert.equal(f.state().stage, "committed");
  fs.renameSync(`${f.bare}-offline`, f.bare);
  assert.match(f.push().out, /PUSHED/);
  assert.equal(f.state().stage, "pushed");

  assert.match(f.record("https://github.com/acme/widgets/pull/1").out, /ERROR: no pull request text was prepared/);
  f.prepare();
  assert.match(f.record("https://github.com/evil/widgets/pull/1").out, /ERROR: .*does not belong/);
  assert.equal(f.state().stage, "pushed");
  assert.equal(fs.existsSync(path.join(f.ticket, "reviews", "ship-rv-1.json")), false, "no ship record before a pull request is recorded");
  assert.match(f.record().out, /RECORDED/);
  assert.deepEqual(f.main(), f.before);
});

// --------------------------------------------------------------- tampering

test("a tampered, replaced, or moved worktree binding fails closed at every step; never the main checkout", () => {
  const f = approvedReview();
  withBindingTampered(f, () => assert.match(f.ship(), /SHIP: REFUSED\. .*(invalid signature|binding changed)/));
  assert.match(f.ship(), /AUTHORIZED/);
  withBindingTampered(f, () => assert.match(f.commit().out, /ERROR: commit refused: .*(invalid signature|binding changed)/));
  assert.match(f.commit().out, /COMMITTED/);
  withBindingTampered(f, () => assert.match(f.push().out, /ERROR: push refused: .*(invalid signature|binding changed)/));

  // A validly signed replacement binding (as if the worktree were re-created).
  const b2 = { ...f.binding, binding: 2 };
  delete b2.hmac;
  b2.hmac = L.sign(b2, L.approvalKey(f.data, false));
  fs.writeFileSync(path.join(f.ticket, "worktree-b2.json"), JSON.stringify(b2));
  assert.match(f.push().out, /ERROR: push refused: .*binding changed \(expected worktree-b1\.json as recorded\)/);
  fs.rmSync(path.join(f.ticket, "worktree-b2.json"));

  fs.renameSync(f.wt, `${f.wt}-moved`);
  assert.match(f.push().out, /ERROR: push refused: .*does not exist/);
  fs.renameSync(`${f.wt}-moved`, f.wt);

  // A session that says "worktree" but lost its workspace never falls back.
  const sFile = path.join(f.data, "sessions", `${f.sid("ship")}.json`);
  const s = JSON.parse(fs.readFileSync(sFile, "utf8"));
  const { workspace, ...withoutWorkspace } = s;
  fs.writeFileSync(sFile, JSON.stringify(withoutWorkspace));
  assert.match(f.push().out, /ERROR: push refused: .*(not the one shipping was authorized for|does not record it)/);
  fs.writeFileSync(sFile, JSON.stringify({ ...s, workspace }));

  assert.equal(f.remoteBranch(), null, "nothing reached origin while anything was wrong");
  assert.match(f.push().out, /PUSHED/);
  assert.deepEqual(f.main(), f.before);
});

// -------------------------------------------------------------------- guard

test("guard: MCP pull request creation re-verifies the whole worktree chain first", () => {
  const f = approvedReview();
  f.ship();
  f.commit();
  f.push();
  const prep = f.prepare().out;
  const title = /^Title: (.*)$/m.exec(prep)[1];
  const body = /-----BEGIN PR BODY-----\n([\s\S]*?)\n-----END PR BODY-----/.exec(prep)[1];
  const good = { owner: "acme", repo: "widgets", head: `jira/${KEY}`, base: "main", title, body };
  const call = (input = good) => guard(f, { session_id: f.sid("ship"), permission_mode: "default", tool_name: "mcp__github__create_pull_request", tool_input: input, cwd: f.repo });
  assert.equal(call().permissionDecision, "ask");
  assert.equal(call({ ...good, head: "main" }).permissionDecision, "deny");
  withBindingTampered(f, () => {
    const r = call();
    assert.equal(r.permissionDecision, "deny");
    assert.match(r.permissionDecisionReason, /pull request creation refused: .*(invalid signature|binding changed)/);
  });
  git(f.repo, "remote", "set-url", "origin", "https://github.com/evil/widgets.git");
  assert.match(call().permissionDecisionReason, /pull request creation refused: .*(origin changed|origin https:\/\/github\.com\/evil)/);
  git(f.repo, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
  git(f.repo, "config", "remote.origin.pushurl", "https://github.com/evil/widgets.git");
  assert.match(call().permissionDecisionReason, /remote\.origin\.pushurl/);
  git(f.repo, "config", "--unset", "remote.origin.pushurl");
  assert.equal(call().permissionDecision, "ask");
  fs.writeFileSync(path.join(f.wt, "later.txt"), "x\n");
  git(f.wt, "add", "later.txt");
  git(f.wt, "commit", "-q", "-m", "later");
  assert.match(call().permissionDecisionReason, /HEAD is no longer the commit/);

  // The worktree is still protected while shipping, and raw git stays denied.
  const sh = (command) => guard(f, { session_id: f.sid("ship"), permission_mode: "default", tool_name: "Bash", tool_input: { command }, cwd: f.repo }).permissionDecision;
  assert.equal(sh(`git -C "${f.wt}" push origin HEAD`), "deny");
  assert.equal(sh(`git worktree remove "${f.wt}"`), "deny");
  assert.equal(sh(`node "${STORE.replace(/\\/g, "/")}" ship-start "${f.data.replace(/\\/g, "/")}" ${f.sid("ship")} ${KEY} rv-1 ${f.reviewHash}`), "deny");
});

// -------------------------------------------------------------------- merge

function shipped() {
  const f = approvedReview();
  f.ship();
  assert.match(f.commit().out, /COMMITTED/);
  assert.match(f.push().out, /PUSHED/);
  f.prepare();
  assert.match(f.record().out, /RECORDED/);
  f.sha = git(f.wt, "rev-parse", "HEAD");
  f.merge = (sid = uuid()) => ({ sid, out: f.run(["merge-start", f.data, sid, KEY, String(PR), f.sha, "--method", "squash"]).out });
  return f;
}

test("merge verification follows the worktree-bound ship record and its own authorization", () => {
  const f = shipped();
  const { sid, out } = f.merge();
  assert.match(out, /MERGE: AUTHORIZED/, out);
  const state = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${sid}.json`), "utf8"));
  assert.equal(state.mode, "merging");
  assert.equal(state.layout, "worktree");
  assert.deepEqual(state.workspace, f.state().workspace);
  assert.equal(state.headSha, f.sha);
  assert.deepEqual(M.gate(f.data, state).reasons.filter((r) => /approval chain/.test(r)), [], "the chain holds; only provider evidence is missing");

  withBindingTampered(f, () => {
    assert.match(f.merge().out, /MERGE: REFUSED\. .*(invalid signature|binding changed)/);
    assert.match(M.gate(f.data, state).reasons.join("\n"), /the approval chain no longer holds: .*(invalid signature|binding changed)/);
  });
  const good = fs.readFileSync(f.approvalFile, "utf8");
  const a = JSON.parse(good);
  a.approvedAt = "2001-01-01T00:00:00.000Z";
  delete a.hmac;
  a.hmac = L.sign(a, L.approvalKey(f.data, false));
  fs.writeFileSync(f.approvalFile, JSON.stringify(a, null, 2));
  assert.match(f.merge().out, /MERGE: REFUSED\. the developer's review approval changed since the ticket was shipped/);
  fs.writeFileSync(f.approvalFile, good);
  assert.match(f.merge().out, /MERGE: AUTHORIZED/);

  // The merge still needs its own command: shipping never authorizes it.
  assert.equal(guard(f, { session_id: f.sid("ship"), permission_mode: "default", tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: PR } }).permissionDecision, "deny");
  assert.deepEqual(f.main(), f.before);
});

// ----------------------------------------------------- after shipping

test("the authorized shipping commit is not treated as unreviewed work; any other commit is", () => {
  const f = shipped();
  // CI feedback: implement again in the same worktree, then review again.
  assert.match(f.run(["implement-start", f.data, f.sid("impl2"), KEY, "r1", f.planHash]).out, /IMPLEMENTATION: AUTHORIZED/);
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2; // fixed\n");
  assert.match(f.run(["report-save", f.data, f.sid("impl2"), draft(f, "report", `Report 2 ${KEY}\n`)]).out, /REPORT SAVED/);
  const ok = f.run(["review-start", f.data, f.sid("review2"), KEY]).out;
  assert.match(ok, /REVIEW: STARTED rv-2/);
  assert.match(ok, /Working tree matches the implementation report: yes/);

  // A commit nobody authorized, then a new report and review: integrity fails.
  git(f.wt, "commit", "-q", "-am", "unreviewed commit");
  f.run(["implement-start", f.data, f.sid("impl3"), KEY, "r1", f.planHash]);
  f.run(["report-save", f.data, f.sid("impl3"), draft(f, "report", `Report 3 ${KEY}\n`)]);
  const bad = f.run(["review-start", f.data, f.sid("review3"), KEY]).out;
  assert.match(bad, /Working tree matches the implementation report: NO \(.*is not an authorized shipping commit/);
});

// -------------------------------------------------------------------- legacy

test("legacy in-place shipping keeps working and is labelled; worktree sessions can't use it", () => {
  const f = legacyReviewed();
  assert.match(f.approve(), /GRANTED/);
  assert.match(f.ship(f.reviewHash, "--branch", `jira/${KEY}-legacy`), /SHIP: AUTHORIZED/, "--branch stays available in place");
  const s = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid("ship")}.json`), "utf8"));
  assert.equal(s.layout, "legacy-in-place");
  assert.equal(s.workspace.kind, "legacy-in-place");
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: change\n`)]).out, /COMMITTED: .* on jira\/ABC-1-legacy/);
  assert.equal(git(f.repo, "branch", "--show-current"), `jira/${KEY}-legacy`, "in place, the branch is created in the main checkout as before");
  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /PUSHED/);
  f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Title\n")]);
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), "https://github.com/acme/widgets/pull/3"]).out, /RECORDED/);
  const ship = JSON.parse(fs.readFileSync(path.join(f.data, "plans", SITE, KEY, "reviews", "ship-rv-1.json"), "utf8"));
  assert.equal(ship.layout, "legacy-in-place");

  // A worktree review always ships from the worktree (the layout comes from
  // the signed review, not from the request).
  const w = approvedReview();
  assert.match(w.ship(), /AUTHORIZED/);
  assert.equal(w.state().layout, "worktree");
});
