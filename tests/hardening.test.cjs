// Pre-release hardening (Phase 8C): regression tests for the issues found in
// the audit of --end-session, ignored-file removal, post-removal merge
// checks, re-planning, ship-record chains, and legacy fallbacks. Disposable
// repositories under "React Apps/jadwa app" and a local bare origin only.
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../scripts/lib/approval.cjs");
const M = require("../scripts/lib/merge.cjs");
const { SITE, KEY, git, draft, guard, uuid, legacyImplement } = require("./helpers.cjs");
const { PLAN, PR, CHECK, json, worktreeTicket } = require("./worktree-flow.cjs");

const remove = (f, sid, ...args) => f.run(["worktree-remove", f.data, sid || f.sid("remover"), KEY, ...args]).out;
const endBoth = (f) => ["--end-session", f.sid("impl"), "--end-session", f.sid("review")];
const resign = (f, file, change) => {
  const r = json(file);
  change(r);
  delete r.hmac;
  r.hmac = L.sign(r, L.approvalKey(f.data, false));
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
};
const exclude = (f, lines) => {
  const common = git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  fs.mkdirSync(path.join(common, "info"), { recursive: true });
  fs.writeFileSync(path.join(common, "info", "exclude"), `${lines.join("\n")}\n`);
};

// ------------------------------------------------ links and junctions (blocker)

test("an ignored junction that points outside the worktree blocks removal; nothing outside is ever deleted", () => {
  const f = worktreeTicket("shipped");
  exclude(f, ["linked/", "node_modules"]);
  const outside = path.join(f.base, "shared store");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "precious.txt"), "keep\n");
  fs.symlinkSync(outside, path.join(f.wt, "linked"), "junction");
  fs.symlinkSync(outside, path.join(f.wt, "node_modules"), "junction");
  // git itself lists the target's files as ignored files of the worktree.
  assert.match(git(f.wt, "status", "--porcelain", "--ignored", "--untracked-files=all"), /!! linked\/precious\.txt/);

  for (const extra of [[], ["--confirm-ignored", "2"]]) {
    const out = remove(f, null, ...endBoth(f), ...extra);
    assert.match(out, /WORKTREE REMOVAL: REFUSED[\s\S]*symbolic links or junctions that git's removal could follow[\s\S]*linked[\s\S]*node_modules/);
  }
  assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf8"), "keep\n", "the target is untouched");
  assert.ok(fs.existsSync(f.wt));

  // Removing the links (not their targets) makes the removal possible again.
  fs.unlinkSync(path.join(f.wt, "linked"));
  fs.unlinkSync(path.join(f.wt, "node_modules"));
  assert.match(remove(f, null, ...endBoth(f)), /WORKTREE REMOVAL: REMOVED/);
  assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf8"), "keep\n");
});

test("a junction deeper in an ignored directory is found too", () => {
  const f = worktreeTicket("shipped");
  exclude(f, ["vendor/"]);
  const outside = path.join(f.base, "elsewhere");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "data.txt"), "keep\n");
  fs.mkdirSync(path.join(f.wt, "vendor", "pkg"), { recursive: true });
  fs.symlinkSync(outside, path.join(f.wt, "vendor", "pkg", "link"), "junction");
  assert.match(remove(f, null, ...endBoth(f), "--confirm-ignored", "1"), /REFUSED[\s\S]*junctions[\s\S]*vendor\/pkg\/link/);
  assert.ok(fs.existsSync(path.join(outside, "data.txt")));
});

// ----------------------------------------------- ignored-file content changes

test("a changed ignored file (same names, different size or time) invalidates the confirmation", () => {
  const f = worktreeTicket("shipped");
  exclude(f, ["build/"]);
  fs.mkdirSync(path.join(f.wt, "build"));
  const out = path.join(f.wt, "build", "out.txt");
  fs.writeFileSync(out, "v1\n");
  assert.match(remove(f, null, ...endBoth(f)), /holds 1 ignored file/);
  fs.writeFileSync(out, "version two, longer\n");
  assert.match(remove(f, null, ...endBoth(f), "--confirm-ignored", "1"), /REFUSED[\s\S]*changed since they were listed/);
  // Same size, newer modification time.
  fs.writeFileSync(out, "version two, LONGER\n");
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(out, later, later);
  assert.match(remove(f, null, ...endBoth(f), "--confirm-ignored", "1"), /REFUSED[\s\S]*changed since they were listed/);
  assert.match(remove(f, null, ...endBoth(f), "--confirm-ignored", "1"), /WORKTREE REMOVAL: REMOVED/, "confirmed against the latest listing");
});

// ------------------------------------------------------------- --end-session

test("--end-session never ends a shipping session with a pending pull request, and keeps every ended session's history", () => {
  const f = worktreeTicket("pushed");
  const out = remove(f, null, ...endBoth(f), "--end-session", f.sid("ship"));
  assert.match(out, /REFUSED[\s\S]*--end-session cannot end a shipping session before its pull request is recorded/);
  assert.equal(f.session("ship").mode, "shipping");
  assert.equal(f.session("impl").mode, "implementing", "a refused removal ends nothing");

  // Finish shipping, then remove: the ended sessions' previous states are kept byte for byte.
  f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Export two\n")]);
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), `https://github.com/acme/widgets/pull/${PR}`]).out, /RECORDED/);
  const implBefore = fs.readFileSync(path.join(f.data, "sessions", `${f.sid("impl")}.json`));
  assert.match(remove(f, null, ...endBoth(f)), /REMOVED/);
  const ended = f.session("impl");
  assert.equal(ended.mode, "planning");
  assert.ok(ended.previousState && fs.readFileSync(ended.previousState).equals(implBefore), "the previous state is kept unchanged");
  const rec = json(path.join(f.ticket, "worktree-b1-removed.json"));
  assert.ok(rec.endedSessions.every((s) => s.previousState));
  // Ending a session never grants anything: it is planning mode, and the
  // history file is in the protected store.
  assert.equal(guard(f, { session_id: f.sid("impl"), agent_type: "jira-dev-harness:developer", tool_name: "Write", tool_input: { file_path: path.join(f.repo, "x.js") }, permission_mode: "default" }).permissionDecision, "deny");
  assert.equal(guard(f, { session_id: uuid(), tool_name: "Write", tool_input: { file_path: ended.previousState }, permission_mode: "default" }).permissionDecision, "deny");
});

test("the removing session itself is inert for the ticket after removal (it is not counted as active, but can't act)", () => {
  const f = worktreeTicket("shipped");
  // Run the removal from the implementing session itself.
  assert.match(remove(f, f.sid("impl"), "--end-session", f.sid("review")), /REMOVED/);
  const dev = guard(f, { session_id: f.sid("impl"), agent_type: "jira-dev-harness:developer", tool_name: "Edit", tool_input: { file_path: path.join(f.wt, "src", "app.js") }, permission_mode: "default" });
  assert.equal(dev.permissionDecision, "deny");
  const report = f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `Report ${KEY}\n`)]);
  assert.equal(report.status, 1, "no report from a removed worktree");
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), `https://github.com/acme/widgets/pull/${PR + 1}`]).out, /ERROR: recording the pull request refused: .*binding.*missing/);
});

// ------------------------------------------------- post-removal merge identity

test("merge never trusts a missing worktree; after removal it needs the same repository and origin", () => {
  const f = worktreeTicket("shipped");
  const merge = () => f.run(["merge-start", f.data, uuid(), KEY, String(PR), f.sha, "--method", "squash"]).out;
  // Missing without a removal record: refused.
  fs.renameSync(f.wt, `${f.wt}-gone`);
  assert.match(merge(), /MERGE: REFUSED\. .*does not exist/);
  fs.renameSync(`${f.wt}-gone`, f.wt);

  assert.match(remove(f, null, ...endBoth(f)), /REMOVED/);
  assert.match(merge(), /MERGE: AUTHORIZED/);
  const removal = path.join(f.ticket, "worktree-b1-removed.json");
  const good = fs.readFileSync(removal, "utf8");
  resign(f, removal, (r) => { r.primary = { ...r.primary, rootCommits: "0".repeat(40) }; });
  assert.match(merge(), /MERGE: REFUSED\. the removal record is for another repository than the ship record/);
  fs.writeFileSync(removal, good);
  // Origin pointing elsewhere (same URL format, other repository) is refused.
  git(f.repo, "remote", "set-url", "origin", "https://github.com/acme/other.git");
  assert.match(merge(), /MERGE: REFUSED\. .*(r1 was planned for .*origin https:\/\/github\.com\/acme\/other|but the ticket was shipped to github\.com\/acme\/widgets)/);
  git(f.repo, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
  assert.match(merge(), /MERGE: AUTHORIZED/);
});

// ------------------------------------------------------------- re-planning

test("a re-plan must decide keep, revise, or revert for every path the earlier work touched", () => {
  const f = worktreeTicket("implemented");
  fs.mkdirSync(path.join(f.wt, "docs"));
  fs.writeFileSync(path.join(f.wt, "docs", "new file é.md"), "notes\n");
  const st = f.run(["worktree-status", f.data, KEY]).out;
  assert.match(st, /Paths touched by earlier work \(a re-plan must decide keep, revise, or revert for each\): 2\n  docs\/new file é\.md\n  src\/app\.js/);
  const plan = (section) => PLAN.replace("## Existing worktree changes\nNone", `## Existing worktree changes\n${section}`);
  const save = (section) => f.run(["save", f.data, SITE, KEY, draft(f, "plan", plan(section))]);

  let r = save("- `src/app.js`: keep - exports 2");
  assert.equal(r.status, 1);
  assert.match(r.out, /does not decide keep, revise, or revert for these changed paths in the ticket worktree: docs\/new file é\.md/);
  r = save("- `src/app.js`: keep\n- `docs/new file é.md`: looked at it");
  assert.match(r.out, /does not decide .*docs\/new file é\.md/, "a line without a decision does not count");
  r = save("None");
  assert.match(r.out, /does not decide .*docs\/new file é\.md, src\/app\.js/, "\"None\" does not account for real work");
  assert.equal(fs.existsSync(path.join(f.ticket, "plan-r2.md")), false);
  r = save("- `src/app.js`: keep - exports 2\n- `docs/new file é.md`: revert - not part of the ticket");
  assert.match(r.out, /SAVED: ABC-1 revision r2/);
});

test("paths changed by commits since the base must be decided too", () => {
  const f = worktreeTicket("committed");
  const r = f.run(["save", f.data, SITE, KEY, draft(f, "plan", PLAN)]);
  assert.equal(r.status, 1);
  assert.match(r.out, /does not decide keep, revise, or revert for these changed paths in the ticket worktree: src\/app\.js\./, "the committed change must be decided even though the section exists");
  const ok = f.run(["save", f.data, SITE, KEY, draft(f, "plan", PLAN.replace("## Existing worktree changes\nNone", "## Existing worktree changes\n- src/app.js: kept (shipped in the first commit)"))]);
  assert.match(ok.out, /SAVED/);
});

// ------------------------------------------------- ship and merge records

test("a ship record chain with a gap, or a revision without its predecessor, verifies nothing", () => {
  const f = worktreeTicket("shipped");
  const t = L.findTicketDir(f.data, KEY);
  const dir = path.join(f.ticket, "reviews");
  assert.ok(M.latestShipRecord(f.data, t));
  // A validly signed revision 3 placed without revision 2.
  const r1 = json(path.join(dir, "ship-rv-1.json"));
  const r3 = { ...r1, revision: 3, previousSha256: L.sha256(path.join(dir, "ship-rv-1.json")), pr: { url: "https://github.com/acme/widgets/pull/99" } };
  delete r3.hmac;
  r3.hmac = L.sign(r3, L.approvalKey(f.data, false));
  fs.writeFileSync(path.join(dir, "ship-rv-1-r3.json"), JSON.stringify(r3));
  assert.equal(M.latestShipRecord(f.data, t), null);
  assert.match(f.run(["merge-start", f.data, uuid(), KEY, String(PR), f.sha, "--method", "squash"]).out, /no valid ship record/);
  assert.throws(() => M.writeShipRecord(f.data, f.session("ship")), /does not verify; nothing was recorded/);
  fs.rmSync(path.join(dir, "ship-rv-1-r3.json"));
  assert.ok(M.latestShipRecord(f.data, t));
});

test("a merge record is written once: a different valid one is never replaced, a forged file is kept aside", () => {
  const f = worktreeTicket("shipped");
  const state = { ...f.session("ship"), headSha: f.sha, pr: PR, mergeCommit: "f".repeat(40), mergedVia: "test", mergedAt: new Date().toISOString() };
  const first = M.writeMergeRecord(f.data, state);
  assert.equal(M.writeMergeRecord(f.data, state).hmac, first.hmac, "the same merge again keeps the existing record");
  assert.throws(() => M.writeMergeRecord(f.data, { ...state, mergeCommit: "a".repeat(40) }), /a different merge record for rv-1 already exists; it is never replaced/);
  const file = path.join(f.ticket, "reviews", "merge-rv-1.json");
  fs.writeFileSync(file, JSON.stringify({ kind: "merge-record", hmac: "0".repeat(64) }));
  M.writeMergeRecord(f.data, state);
  assert.ok(L.signatureValid(json(file), L.approvalKey(f.data, false)));
  assert.ok(fs.existsSync(path.join(f.ticket, "reviews", "merge-rv-1-replaced-1.json")), "the forged file is kept, not silently lost");
});

// ------------------------------------------------- no legacy fallback

test("a ticket that has a worktree can never use the in-place path", () => {
  const f = worktreeTicket("implemented");
  // A legacy-style session (as an older version recorded it) for the same ticket.
  legacyImplement(f, "old", KEY, 1, f.planHash);
  const r = f.run(["report-save", f.data, f.sid("old"), draft(f, "report", `Report ${KEY}\n`)]);
  assert.equal(r.status, 1);
  assert.match(r.out, /has a plugin-managed worktree, so this in-place session .* cannot report/);

  // A legacy-layout report for that ticket can't be reviewed in place.
  const meta = path.join(f.ticket, "impl-r1-1.json");
  const m = json(meta);
  delete m.worktree;
  m.layout = "legacy-in-place";
  fs.writeFileSync(meta, JSON.stringify(m));
  assert.match(f.run(["review-start", f.data, f.sid("review-x"), KEY]).out, /REVIEW: REFUSED\. ABC-1 has a plugin-managed worktree \(or had one\), so an in-place \(legacy\) record can't be used/);
});

test("a shipping session stripped of its worktree layout never ships from the main checkout", () => {
  const f = worktreeTicket("committed");
  const file = path.join(f.data, "sessions", `${f.sid("ship")}.json`);
  const s = json(file);
  const { layout, workspace, ...stripped } = s;
  fs.writeFileSync(file, JSON.stringify(stripped));
  const out = f.run(["ship-push", f.data, f.sid("ship")]).out;
  assert.match(out, /ERROR: push refused: .*(never shipped from the main checkout|not the one shipping was authorized for)/);
  assert.throws(() => git(f.bare, "rev-parse", `refs/heads/jira/${KEY}`));
  fs.writeFileSync(file, JSON.stringify({ ...stripped, layout, workspace }));
  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /PUSHED/);
});

test("checks of a review session never fall back to the main checkout", () => {
  const f = worktreeTicket("implemented");
  assert.match(f.run(["review-start", f.data, f.sid("review"), KEY]).out, /STARTED/);
  const file = path.join(f.data, "sessions", `${f.sid("review")}.json`);
  const s = json(file);
  delete s.workspace;
  fs.writeFileSync(file, JSON.stringify(s));
  const out = f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]);
  assert.equal(out.status, 1);
  assert.match(out.out, /has a plugin-managed worktree \(or had one\), so an in-place \(legacy\) record can't be used/);
});
