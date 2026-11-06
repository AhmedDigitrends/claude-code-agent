// Phase 8C step 6: safe, user-only worktree removal; merge verification
// after an authorized removal; immutable ship records; and re-planning with
// an existing worktree. Disposable repositories under "React Apps/jadwa app",
// a local bare origin, and mocked provider responses only.
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const L = require("../scripts/lib/approval.cjs");
const M = require("../scripts/lib/merge.cjs");
const W = require("../scripts/lib/worktree.cjs");
const { STORE, SITE, KEY, git, draft, guard, uuid } = require("./helpers.cjs");
const { PLAN, PR, json, worktreeTicket, goodEvidence, feedAll } = require("./worktree-flow.cjs");

const remove = (f, ...args) => f.run(["worktree-remove", f.data, f.sid("remover"), KEY, ...args]).out;
const endBoth = (f) => ["--end-session", f.sid("impl"), "--end-session", f.sid("review")];

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

// Ignore rules shared by the main checkout and every worktree (not committed).
function exclude(f, lines) {
  const common = git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  fs.mkdirSync(path.join(common, "info"), { recursive: true });
  fs.writeFileSync(path.join(common, "info", "exclude"), `${lines.join("\n")}\n`);
}

const still = (f) => {
  assert.ok(fs.existsSync(f.wt), "the worktree is still there");
  assert.ok(W.listWorktrees(f.repo).some((w) => W.samePath(w.path, f.wt)), "git still lists it");
  assert.equal(fs.existsSync(path.join(f.ticket, "worktree-b1-removed.json")), false, "no removal record");
};

// ------------------------------------------------------- confirmed removal

test("a shipped, clean worktree is removed with git's unforced removal; branch, binding, and records are kept", () => {
  const f = worktreeTicket("shipped");
  const recordsBefore = tree(f.ticket);

  // The implementation and review sessions still act on the ticket.
  const refused = remove(f);
  assert.match(refused, /WORKTREE REMOVAL: REFUSED\. nothing was removed:[\s\S]*active session\(s\) still act on ABC-1/);
  assert.ok(refused.includes(f.sid("impl")) && refused.includes(f.sid("review")));
  assert.doesNotMatch(refused, new RegExp(f.sid("ship")), "a shipping session with a recorded pull request is not active");
  still(f);

  const out = remove(f, ...endBoth(f));
  assert.match(out, /WORKTREE REMOVAL: REMOVED example\.atlassian\.net\/ABC-1/);
  assert.ok(out.includes(`Removed worktree: ${f.wt}`));
  assert.match(out, new RegExp(`Branch kept: jira/ABC-1 at ${f.sha}`));
  assert.match(out, new RegExp(`On origin: jira/ABC-1 at ${f.sha}`));
  assert.equal(fs.existsSync(f.wt), false);
  assert.equal(W.listWorktrees(f.repo).some((w) => W.samePath(w.path, f.wt)), false);
  assert.equal(git(f.repo, "rev-parse", `refs/heads/jira/${KEY}`), f.sha, "the ticket branch is kept");
  assert.equal(f.session("impl").mode, "planning");
  assert.equal(f.session("review").mode, "planning");

  const rec = json(path.join(f.ticket, "worktree-b1-removed.json"));
  assert.ok(L.signatureValid(rec, L.approvalKey(f.data, false)));
  assert.equal(rec.kind, "worktree-removal");
  assert.equal(rec.bindingHmac, f.binding.hmac);
  assert.equal(rec.head, f.sha);
  assert.equal(rec.pushed.commit, f.sha);
  assert.equal(rec.branchKept, true);
  assert.deepEqual(rec.endedSessions.map((s) => s.sessionId).sort(), [f.sid("impl"), f.sid("review")].sort());

  // Every earlier record is byte-identical; only the removal record was added.
  const after = tree(f.ticket);
  for (const [file, hash] of Object.entries(recordsBefore)) assert.equal(after[file], hash, file);
  assert.deepEqual(Object.keys(after).filter((k) => !(k in recordsBefore)), ["worktree-b1-removed.json"]);
  assert.deepEqual(W.registeredPaths(f.data), []);
  assert.match(f.run(["worktree-status", f.data, KEY]).out, /WORKTREE: REMOVED[\s\S]*branch jira\/ABC-1 kept/);
  assert.deepEqual(f.main(), f.before, "the main checkout is unchanged");

  // The old implementation session gets no writes, and nothing re-creates the worktree silently.
  const dev = guard(f, { session_id: f.sid("impl"), agent_type: "jira-dev-harness:developer", tool_name: "Write", tool_input: { file_path: path.join(f.wt, "src", "x.js") }, permission_mode: "default" });
  assert.equal(dev.permissionDecision, "deny");
  assert.match(f.run(["implement-start", f.data, f.sid("again"), KEY, "r1", f.planHash]).out, /IMPLEMENTATION: REFUSED\. branch jira\/ABC-1 already exists/);
  assert.match(remove(f), /REFUSED\. nothing was removed:[\s\S]*no active worktree binding/);
});

// ---------------------------------------------------------------- refusals

test("refused for tracked and untracked changes, unknown or missing sessions, and bad arguments", () => {
  const f = worktreeTicket("shipped");
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 3;\n");
  assert.match(remove(f, ...endBoth(f)), /REFUSED[\s\S]*1 uncommitted change\(s\) \(tracked or untracked\)[\s\S]*src\/app\.js/);
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  fs.writeFileSync(path.join(f.wt, "notes.txt"), "mine\n");
  assert.match(remove(f, ...endBoth(f)), /REFUSED[\s\S]*uncommitted change[\s\S]*notes\.txt/);
  fs.rmSync(path.join(f.wt, "notes.txt"));
  assert.match(remove(f, "--end-session", uuid()), /REFUSED[\s\S]*--end-session names no active session/);
  assert.match(remove(f, "--force"), /REFUSED\. unexpected arguments/);
  assert.match(remove(f, "--confirm-ignored", "-1"), /REFUSED\. unexpected arguments/);
  assert.equal(f.session("impl").mode, "implementing", "a refused removal ends no session");
  still(f);
});

test("refused for unpushed commits", () => {
  const f = worktreeTicket("committed");
  const out = remove(f, ...endBoth(f), "--end-session", f.sid("ship"));
  assert.match(out, /REFUSED[\s\S]*1 commit\(s\) that are not on origin; push them first/);
  still(f);
});

test("refused for sensitive ignored files, regardless of any confirmation", () => {
  const f = worktreeTicket("shipped");
  exclude(f, [".env", "keys/", "node_modules/"]);
  fs.writeFileSync(path.join(f.wt, ".env"), "SECRET=1\n");
  fs.mkdirSync(path.join(f.wt, "keys"));
  fs.writeFileSync(path.join(f.wt, "keys", "id_rsa"), "key\n");
  for (const extra of [[], ["--confirm-ignored", "2"]]) {
    const out = remove(f, ...endBoth(f), ...extra);
    assert.match(out, /REFUSED[\s\S]*sensitive ignored files[\s\S]*\.env[\s\S]*keys\/id_rsa[\s\S]*the plugin never deletes them/);
  }
  assert.equal(fs.readFileSync(path.join(f.wt, ".env"), "utf8"), "SECRET=1\n");
  still(f);
});

test("ordinary ignored files: listed, confirmed by exact count, and re-checked; a changed set is refused", () => {
  const f = worktreeTicket("shipped");
  exclude(f, ["node_modules/", "build/"]);
  fs.mkdirSync(path.join(f.wt, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(f.wt, "node_modules", "dep", "index.js"), "x\n");
  fs.mkdirSync(path.join(f.wt, "build"));
  fs.writeFileSync(path.join(f.wt, "build", "out file.txt"), "y\n");

  const listed = remove(f, ...endBoth(f));
  assert.match(listed, /REFUSED\. the worktree holds 2 ignored file\(s\)[\s\S]*build\/out file\.txt[\s\S]*node_modules\/dep\/index\.js[\s\S]*--confirm-ignored 2/);
  assert.match(remove(f, ...endBoth(f), "--confirm-ignored", "3"), /REFUSED\. the confirmed count \(3\) does not match/);

  // The set changes between the listing and the confirmed run.
  fs.writeFileSync(path.join(f.wt, "build", "later.txt"), "z\n");
  const changed = remove(f, ...endBoth(f), "--confirm-ignored", "2");
  assert.match(changed, /REFUSED\. the confirmed count \(2\) does not match the ignored files listed, or they changed since they were listed[\s\S]*current list \(3 file\(s\)\)[\s\S]*later\.txt/);
  still(f);
  // Same count, different files: still refused (the exact set is bound).
  fs.rmSync(path.join(f.wt, "build", "later.txt"));
  fs.writeFileSync(path.join(f.wt, "build", "other.txt"), "z\n");
  assert.match(remove(f, ...endBoth(f), "--confirm-ignored", "3"), /REFUSED[\s\S]*changed since they were listed/);
  fs.rmSync(path.join(f.wt, "build", "other.txt"));
  fs.writeFileSync(path.join(f.wt, "build", "later.txt"), "z\n");
  assert.match(remove(f, ...endBoth(f), "--confirm-ignored", "3"), /REFUSED[\s\S]*changed since they were listed/, "the listing was replaced by the last refusal");
  assert.match(remove(f, ...endBoth(f)), /holds 3 ignored file/);
  const out = remove(f, ...endBoth(f), "--confirm-ignored", "3");
  assert.match(out, /WORKTREE REMOVAL: REMOVED[\s\S]*Ignored files removed: 3/);
  assert.equal(fs.existsSync(f.wt), false);
  assert.equal(json(path.join(f.ticket, "worktree-b1-removed.json")).ignoredRemoved.count, 3);
});

test("refused for a tampered binding, a moved worktree, an active shipping session, and a held lock", () => {
  const f = worktreeTicket("pushed");
  assert.match(remove(f, ...endBoth(f)), /REFUSED[\s\S]*active session[\s\S]*shipping, pushed/);
  const good = fs.readFileSync(f.bindingFile, "utf8");
  fs.writeFileSync(f.bindingFile, good.replace(/"planRevision": 1/, '"planRevision": 2'));
  assert.match(remove(f, ...endBoth(f)), /REFUSED[\s\S]*failed verification: .*invalid signature/);
  fs.writeFileSync(f.bindingFile, good);
  fs.renameSync(f.wt, `${f.wt}-moved`);
  assert.match(remove(f, ...endBoth(f)), /REFUSED[\s\S]*does not exist/);
  fs.renameSync(`${f.wt}-moved`, f.wt);
  const lock = path.join(f.data, "worktrees", "locks", `${SITE}__${KEY}.lock`);
  fs.writeFileSync(lock, "{}");
  assert.match(remove(f, ...endBoth(f)), /REFUSED\. another worktree operation for ABC-1 is in progress/);
  fs.rmSync(lock);
  still(f);
});

test("two concurrent removals: one removes, the other is refused", async () => {
  const f = worktreeTicket("shipped");
  const child = (name) => new Promise((resolve) => {
    const c = spawn(process.execPath, [STORE, "worktree-remove", f.data, f.sid(name), KEY, ...endBoth(f)], { cwd: f.repo, env: f.env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve(out));
  });
  const outs = await Promise.all([child("r1"), child("r2")]);
  assert.equal(outs.filter((o) => /WORKTREE REMOVAL: REMOVED/.test(o)).length, 1, outs.join("\n---\n"));
  assert.match(outs.find((o) => !/REMOVED/.test(o)), /WORKTREE REMOVAL: REFUSED\. .*(in progress|no active worktree binding|does not exist|active session)/s);
  assert.equal(fs.readdirSync(f.ticket).filter((n) => /-removed\.json$/.test(n)).length, 1);
});

test("Claude cannot run the removal itself", () => {
  const f = worktreeTicket("shipped");
  const cmd = `node "${STORE.replace(/\\/g, "/")}" worktree-remove "${f.data.replace(/\\/g, "/")}" ${uuid()} ${KEY} --confirm-ignored 0`;
  for (const sid of [uuid(), f.sid("ship")]) {
    assert.equal(guard(f, { session_id: sid, tool_name: "Bash", tool_input: { command: cmd }, permission_mode: "default", cwd: f.repo }).permissionDecision, "deny");
  }
  const skill = fs.readFileSync(path.join(__dirname, "..", "skills", "worktree-remove", "SKILL.md"), "utf8");
  assert.match(skill, /^disable-model-invocation: true$/m);
});

// ------------------------------------------------ merge after the removal

function removedAfterShipping() {
  const f = worktreeTicket("shipped");
  assert.match(remove(f, ...endBoth(f)), /REMOVED/);
  f.removalFile = path.join(f.ticket, "worktree-b1-removed.json");
  f.merge = (pr = PR, sid = uuid()) => ({ sid, out: f.run(["merge-start", f.data, sid, KEY, String(pr), f.sha, "--method", "squash"]).out });
  return f;
}

const resign = (f, file, change) => {
  const r = json(file);
  change(r);
  delete r.hmac;
  r.hmac = L.sign(r, L.approvalKey(f.data, false));
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
};

test("merge verification after an authorized removal: removal record, ship evidence, commit, PR, and its own authorization", () => {
  const f = removedAfterShipping();
  const { sid, out } = f.merge();
  assert.match(out, /MERGE: AUTHORIZED/, out);
  feedAll(f, sid, goodEvidence(f.sha));
  assert.match(f.run(["merge-verify", f.data, sid]).out, /MERGE GATE: PASS/);
  const mergeCall = guard(f, { session_id: sid, tool_name: "mcp__github__merge_pull_request", permission_mode: "default", tool_input: { owner: "acme", repo: "widgets", pullNumber: PR, sha: f.sha, merge_method: "squash" } });
  assert.equal(mergeCall.permissionDecision, "ask", "the merge still needs the developer's prompt");

  // After a removal the pull request must match exactly.
  assert.match(f.merge(PR + 1).out, /MERGE: REFUSED\. the ship record's pull request .* is not #8; after a worktree removal the pull request must match exactly/);

  const good = fs.readFileSync(f.removalFile, "utf8");
  fs.writeFileSync(f.removalFile, good.replace(/"branchKept": true/, '"branchKept": false'));
  assert.match(f.merge().out, /MERGE: REFUSED\. .*removal record or binding does not verify/);
  fs.writeFileSync(f.removalFile, good);
  resign(f, f.removalFile, (r) => { r.head = "a".repeat(40); });
  assert.match(f.merge().out, /MERGE: REFUSED\. the worktree was removed at a{40}, not at the shipped commit/);
  fs.writeFileSync(f.removalFile, good);
  resign(f, f.removalFile, (r) => { r.pushed.commit = null; });
  assert.match(f.merge().out, /MERGE: REFUSED\. the removal record does not show the shipped commit on origin/);
  fs.writeFileSync(f.removalFile, good);

  // A removal record never replaces the review approval.
  const approval = fs.readFileSync(f.approvalFile, "utf8");
  fs.rmSync(f.approvalFile);
  assert.match(f.merge().out, /MERGE: REFUSED\. .*has not been approved/);
  fs.writeFileSync(f.approvalFile, approval);
  // The gate of an authorized session re-checks the chain.
  fs.writeFileSync(f.removalFile, good.replace(/"branchKept": true/, '"branchKept": false'));
  assert.match(f.run(["merge-verify", f.data, sid]).out, /BLOCKED[\s\S]*approval chain no longer holds: .*removal record or binding does not verify/);
  fs.writeFileSync(f.removalFile, good);
  assert.match(f.merge().out, /MERGE: AUTHORIZED/);
});

// -------------------------------------------------- immutable ship records

test("ship records are immutable: a pull request correction is a signed, chained revision", () => {
  const f = worktreeTicket("shipped");
  const r1 = path.join(f.ticket, "reviews", "ship-rv-1.json");
  const r1Bytes = fs.readFileSync(r1, "utf8");
  const out = f.run(["ship-record-pr", f.data, f.sid("ship"), "https://github.com/acme/widgets/pull/8"]).out;
  assert.match(out, /PULL REQUEST RECORDED: https:\/\/github\.com\/acme\/widgets\/pull\/8 \(ship record revision 2; earlier revisions are kept unchanged\)/);
  assert.equal(fs.readFileSync(r1, "utf8"), r1Bytes, "revision 1 is byte-identical");
  const r2file = path.join(f.ticket, "reviews", "ship-rv-1-r2.json");
  const r2 = json(r2file);
  assert.equal(r2.revision, 2);
  assert.equal(r2.previousSha256, L.sha256(r1));
  assert.equal(r2.pr.correctionOf, `https://github.com/acme/widgets/pull/${PR}`);
  const t = L.findTicketDir(f.data, KEY);
  assert.equal(M.latestShipRecord(f.data, t).pr.url, "https://github.com/acme/widgets/pull/8");
  assert.match(f.run(["merge-start", f.data, uuid(), KEY, "8", f.sha, "--method", "squash"]).out, /MERGE: AUTHORIZED/);

  // A revision that changes an immutable field cannot be written.
  const state = f.session("ship");
  assert.throws(() => M.writeShipRecord(f.data, { ...state, commit: "b".repeat(40) }), /already exists with a different commit; it is never replaced/);
  // A tampered revision makes the whole chain invalid: fail closed.
  const good = fs.readFileSync(r2file, "utf8");
  fs.writeFileSync(r2file, good.replace("/pull/8", "/pull/9"));
  assert.equal(M.latestShipRecord(f.data, t), null);
  assert.match(f.run(["merge-start", f.data, uuid(), KEY, "8", f.sha, "--method", "squash"]).out, /MERGE: REFUSED\. nothing was shipped for this ticket \(no valid ship record\)/);
  fs.writeFileSync(r2file, good);
  // A revision that skips a link (wrong previous hash) is refused too.
  resign(f, r2file, (r) => { r.previousSha256 = "0".repeat(64); });
  assert.equal(M.latestShipRecord(f.data, t), null);
  fs.writeFileSync(r2file, good);
  assert.ok(M.latestShipRecord(f.data, t));

  // Claude can't write ship records or their revisions.
  for (const file of [r1, r2file, path.join(f.ticket, "reviews", "ship-rv-1-r3.json")]) {
    assert.equal(guard(f, { session_id: f.sid("ship"), tool_name: "Write", tool_input: { file_path: file }, permission_mode: "default" }).permissionDecision, "deny");
  }
});

// -------------------------------------------------------------- re-planning

test("re-planning with an existing worktree: the plan must account for its work; reuse only on the same base", () => {
  const f = worktreeTicket("implemented");
  const noSection = PLAN.replace(/## Existing worktree changes\nNone\n\n/, "");
  const refused = f.run(["save", f.data, SITE, KEY, draft(f, "plan", noSection)]);
  assert.equal(refused.status, 1);
  assert.match(refused.out, /ERROR: the ticket worktree .* already holds work \(1 uncommitted change\(s\), 0 commit\(s\) since its base\), and the plan has no "## Existing worktree changes" section/);
  assert.equal(fs.existsSync(path.join(f.ticket, "plan-r2.md")), false);

  const st = f.run(["worktree-status", f.data, KEY]).out;
  assert.match(st, /WORKTREE: VERIFIED[\s\S]*Uncommitted changes in the worktree: 1\n   M src\/app\.js/);

  const replan = PLAN.replace("## Existing worktree changes\nNone", "## Existing worktree changes\n- src/app.js: keep - already exports 2");
  const saved = f.run(["save", f.data, SITE, KEY, draft(f, "plan", replan)]).out;
  assert.match(saved, /SAVED: ABC-1 revision r2/);
  assert.ok(saved.includes(`Ticket worktree: ${f.wt}`));
  assert.doesNotMatch(saved, /Warning/);
  const h2 = /SHA-256: ([0-9a-f]{64})/.exec(saved)[1];
  assert.match(f.run(["approve", f.data, f.sid("plan2"), KEY, "r2", h2]).out, /GRANTED/);
  const again = f.run(["implement-start", f.data, f.sid("impl2"), KEY, "r2", h2]).out;
  assert.match(again, /IMPLEMENTATION: AUTHORIZED/);
  assert.match(again, /from earlier attempts \(must be preserved\): \n   M src\/app\.js/);
  assert.equal(fs.readFileSync(path.join(f.wt, "src", "app.js"), "utf8"), "module.exports = 2;\n", "the earlier work is kept");

  // The main checkout moved on: the re-plan warns, and implementation refuses reuse.
  fs.writeFileSync(path.join(f.repo, "README.md"), "r\n");
  git(f.repo, "add", "README.md");
  git(f.repo, "commit", "-q", "-m", "main moved");
  const moved = f.run(["save", f.data, SITE, KEY, draft(f, "plan", replan)]).out;
  assert.match(moved, /Warning: this revision's base is .* but the worktree is based on .*will refuse to reuse it.*never discarded automatically/s);
  const h3 = /SHA-256: ([0-9a-f]{64})/.exec(moved)[1];
  assert.match(f.run(["approve", f.data, f.sid("plan3"), KEY, "r3", h3]).out, /GRANTED/);
  assert.match(f.run(["implement-start", f.data, f.sid("impl3"), KEY, "r3", h3]).out, /REFUSED\. the existing worktree for ABC-1 is based on .* Nothing was changed/);
  assert.equal(fs.readFileSync(path.join(f.wt, "src", "app.js"), "utf8"), "module.exports = 2;\n");
});

test("the Analyzer, Planner, and ticket workflow instructions cover existing worktree changes", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  assert.match(read("agents/planner.md"), /## Existing worktree changes[\s\S]*keep \| revise \| revert/);
  assert.match(read("agents/planner.md"), /Earlier work is never discarded silently/);
  assert.match(read("agents/analyzer.md"), /Existing worktree changes\.\*\* Only when they were given: read each\s+changed file in the worktree/);
  assert.match(read("skills/ticket/SKILL.md"), /## Step 5b: Existing ticket worktree \(re-planning\)/);
  assert.match(read("agents/developer.md"), /revert only\s+what it explicitly says to revert/);
});
