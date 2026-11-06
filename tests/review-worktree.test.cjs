// Phase 8C step 4: independent review and the developer's review approval
// on the verified ticket worktree. Review facts, recorded checks, review
// records, the HTML report, and the approval all refer to the worktree; a
// worktree review never falls back to the main checkout; legacy in-place
// reviews keep working. Every repository lives under "React Apps/jadwa app".
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("../scripts/lib/approval.cjs");
const R = require("../scripts/lib/review.cjs");
const { ROOT, SITE, KEY, git, makeFixture, draft, reviewJson, legacyImplement, guard, uuid } = require("./helpers.cjs");

const REPO_DIR = path.join("React Apps", "jadwa app");
const slash = (p) => p.replace(/\\/g, "/");
const PLAN = `# Plan ${KEY}\n\nReadiness: READY\n\n## Files likely to change\n- \`src/app.js\`\n\n## Testing and validation\n- \`node -v\`\n`;
// Passes only where src/app.js exports 2: in the worktree, not in the main checkout.
const CHECK = `node -e "process.exit(require('./src/app.js') === 2 ? 0 : 1)"`;

function approved() {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  f.run(["save", f.data, SITE, KEY, draft(f, "plan", PLAN)]);
  f.planHash = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, KEY]).out)[1];
  assert.match(f.run(["approve", f.data, f.sid("plan"), KEY, "r1", f.planHash]).out, /APPROVAL: GRANTED/);
  f.ticket = path.join(f.data, "plans", SITE, KEY);
  f.mainState = () => ({
    head: git(f.repo, "rev-parse", "HEAD"),
    status: git(f.repo, "status", "--porcelain", "--ignored"),
    index: git(f.repo, "ls-files", "-s"),
    app: fs.readFileSync(path.join(f.repo, "src", "app.js"), "utf8"),
  });
  return f;
}

// Plan approved, implemented in the worktree (src/app.js -> 2, plus an
// untracked file with spaces and non-ASCII), reported.
function implemented() {
  const f = approved();
  assert.match(f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", f.planHash]).out, /WORKTREE CREATED/);
  assert.match(f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", f.planHash]).out, /AUTHORIZED/);
  f.wt = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid("impl")}.json`), "utf8")).worktree.path;
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  fs.writeFileSync(path.join(f.wt, "src", "new file é.js"), "module.exports = 'x';\n");
  assert.match(f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `Report ${KEY}\n`)]).out, /REPORT SAVED/);
  f.binding = JSON.parse(fs.readFileSync(path.join(f.ticket, "worktree-b1.json"), "utf8"));
  return f;
}

// ...then reviewed: review started, the check recorded, the review saved.
function reviewed(verdict = "PASS", cwdName) {
  const f = implemented();
  f.before = f.mainState();
  const cwd = cwdName === "worktree" ? f.wt : f.repo;
  f.started = f.run(["review-start", f.data, f.sid("review"), KEY], cwd).out;
  assert.match(f.started, /REVIEW: STARTED rv-1/);
  f.check = f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]).out;
  f.saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson(verdict))]).out;
  f.reviewHash = (/Review SHA-256: ([0-9a-f]{64})/.exec(f.saved) || [])[1];
  f.review = () => JSON.parse(fs.readFileSync(path.join(f.ticket, "reviews", "review-rv-1.json"), "utf8"));
  f.approveReview = (cwd = f.repo) => f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", f.reviewHash], cwd).out;
  f.status = (cwd = f.repo) => f.run(["review-status", f.data, KEY], cwd);
  return f;
}

const expectedWorkspace = (f) => ({ kind: "worktree", path: f.wt, branch: `jira/${KEY}`, baseHead: f.binding.baseHead, binding: 1, bindingHmac: f.binding.hmac });

// ---------------------------------------------------------- the happy path

test("a worktree review: facts, checks, records, HTML, and approval all refer to the verified worktree", () => {
  const f = reviewed();
  assert.ok(f.started.includes(`Reviewed workspace: ticket worktree ${f.wt} (branch jira/${KEY}, base ${f.binding.baseHead}, binding worktree-b1)`));
  assert.ok(f.started.includes(`Workspace root (the Reviewer reads the code here, not in the main checkout): ${f.wt}`));
  assert.ok(f.started.includes(`/add-dir "${f.wt}"`));
  assert.match(f.started, /Changed files: src\/app\.js, src\/new file é\.js\n/);
  assert.match(f.started, /Working tree matches the implementation report: yes/);

  const bundle = path.join(f.ticket, "reviews", "rv-1");
  const facts = JSON.parse(fs.readFileSync(path.join(bundle, "facts.json"), "utf8"));
  assert.deepEqual(facts.workspace, expectedWorkspace(f));
  assert.ok(L.sameRepo(facts.repo, L.repoIdentity(f.repo)), "the primary identity is kept");
  assert.match(fs.readFileSync(path.join(bundle, "diff.patch"), "utf8"), /\+module\.exports = 2;/);

  // The check ran in the worktree: it passes there and would fail in the main checkout.
  assert.match(f.check, /CHECK RECORDED: C1 app \(required\)/);
  assert.match(f.check, /Exit code: 0/);
  assert.ok(f.check.includes(`Ran in: ${f.wt} (ticket worktree)`));
  assert.equal(spawnSync(CHECK, { cwd: f.repo, shell: true }).status, 1, "control: the same check fails in the main checkout");
  const c1 = JSON.parse(fs.readFileSync(path.join(bundle, "checks", "C1.json"), "utf8"));
  assert.equal(c1.cwd, f.wt);
  assert.equal(c1.workspace, "worktree");

  assert.match(f.saved, /VERDICT: PASS/);
  const review = f.review();
  assert.ok(L.signatureValid(review, L.approvalKey(f.data, false)));
  assert.deepEqual(review.identity.workspace, expectedWorkspace(f));
  assert.deepEqual(review.facts.preExistingChanges, [], "in a worktree everything since the base is ticket work");
  const html = fs.readFileSync(path.join(f.ticket, "reviews", "review-rv-1.html"), "utf8");
  for (const s of [`ticket worktree ${f.wt}`, `Ticket branch</dt><dd>jira/${KEY}`, `Approved base commit</dt><dd>${f.binding.baseHead}`, "worktree-b1.json", "in the reviewed workspace (ticket worktree"]) {
    assert.ok(html.includes(s), `HTML includes: ${s}`);
  }
  assert.ok(fs.readFileSync(path.join(f.ticket, "reviews", "review-rv-1.md"), "utf8").includes(`Reviewed workspace: ticket worktree ${f.wt}, branch jira/${KEY}`));

  assert.equal(f.status().status, 0);
  assert.match(f.status().out, /REVIEW: CURRENT/);

  const approval = f.approveReview();
  assert.match(approval, /REVIEW APPROVAL: GRANTED/);
  assert.ok(approval.includes(`Reviewed workspace: ticket worktree ${f.wt}`));
  assert.match(approval, /It ships from the ticket worktree, on its fixed branch jira\/ABC-1 \(no --branch\)/);
  const record = JSON.parse(fs.readFileSync(path.join(f.ticket, "reviews", "review-approval-rv-1.json"), "utf8"));
  assert.ok(L.signatureValid(record, L.approvalKey(f.data, false)));
  assert.deepEqual(record.workspace, expectedWorkspace(f));
  const hashOf = (p) => L.sha256(path.join(f.wt, p));
  assert.deepEqual(record.changedFiles, [
    { path: "src/app.js", sha256: hashOf("src/app.js") },
    { path: "src/new file é.js", sha256: hashOf("src/new file é.js") },
  ], "content hashes come from the worktree files");
  assert.match(f.approveReview(), /ALREADY GRANTED/);

  assert.deepEqual(f.mainState(), f.before, "review, checks, and approval never touch the main checkout");
  // Shipping (Phase 8C step 5, see ship-worktree tests) starts from the worktree and changes nothing yet.
  assert.match(f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", f.reviewHash]).out, /SHIP: AUTHORIZED/);
  assert.deepEqual(f.mainState(), f.before);
});

test("review commands also work from inside the worktree, still bound to the primary identity", () => {
  const f = reviewed("PASS", "worktree");
  assert.match(f.status(f.wt).out, /REVIEW: CURRENT/);
  assert.match(f.approveReview(f.wt), /REVIEW APPROVAL: GRANTED/);
  const record = JSON.parse(fs.readFileSync(path.join(f.ticket, "reviews", "review-approval-rv-1.json"), "utf8"));
  assert.ok(L.sameRepo(record.repo, L.repoIdentity(f.repo)), "the approval binds the main checkout's identity, not the worktree's");
  assert.equal(L.sameRepo(record.repo, L.repoIdentity(f.wt)), false);
});

// ---------------------------------------------------- main-checkout isolation

test("main-checkout changes don't affect a worktree review; worktree changes invalidate it and its approval", () => {
  const f = reviewed();
  assert.match(f.approveReview(), /GRANTED/);
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 'main checkout edit';\n");
  fs.writeFileSync(path.join(f.repo, "scratch.txt"), "x\n");
  assert.match(f.status().out, /REVIEW: CURRENT/, "the main checkout is not the reviewed code");
  assert.match(f.approveReview(), /ALREADY GRANTED/);

  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 3;\n");
  const st = f.status();
  assert.equal(st.status, 1);
  assert.match(st.out, /REVIEW: STALE[\s\S]*the code changed after the review \(tracked changes differ/);
  assert.match(f.approveReview(), /REVIEW APPROVAL: REFUSED\. .*the code changed after the review/);

  // Restoring the exact content makes the same tree again (content-bound).
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  assert.match(f.status().out, /REVIEW: CURRENT/);

  // An untracked file in the worktree changes the tree too.
  fs.writeFileSync(path.join(f.wt, "notes.txt"), "later\n");
  assert.match(f.status().out, /REVIEW: STALE[\s\S]*untracked files differ/);
});

test("the approval binds file contents: a changed approved file is reported by name", () => {
  const f = reviewed();
  assert.match(f.approveReview(), /GRANTED/);
  const RA = require("../scripts/lib/review-approval.cjs");
  fs.writeFileSync(path.join(f.wt, "src", "new file é.js"), "module.exports = 'changed';\n");
  assert.throws(() => RA.verifyReview(f.data, KEY, "rv-1", f.repo, { requireRecord: true, checkTree: true }),
    /untracked files differ.*approved file contents changed: src\/new file é\.js/s);
});

// --------------------------------------------------------------- tampering

test("review-start refuses a missing, tampered, re-created, or moved worktree binding; it never falls back", () => {
  const f = implemented();
  const file = path.join(f.ticket, "worktree-b1.json");
  const good = fs.readFileSync(file, "utf8");
  const start = () => f.run(["review-start", f.data, f.sid(`review-${uuid()}`), KEY]).out;
  const noBundle = () => assert.equal(fs.existsSync(path.join(f.ticket, "reviews")), false, "no review bundle is created");

  fs.writeFileSync(file, good.replace(`"branch": "jira/${KEY}"`, '"branch": "main"'));
  assert.match(start(), /REVIEW: REFUSED\. .*binding changed|REVIEW: REFUSED\. .*invalid signature/);
  noBundle();

  fs.rmSync(file);
  assert.match(start(), /REVIEW: REFUSED\. the ticket worktree's binding \(worktree-b1\.json\) is missing; the review never falls back to the main checkout/);
  noBundle();
  fs.writeFileSync(file, good);

  // A different, validly signed binding (as if the worktree were re-created).
  const b2 = { ...JSON.parse(good), binding: 2 };
  delete b2.hmac;
  b2.hmac = L.sign(b2, L.approvalKey(f.data, false));
  fs.writeFileSync(path.join(f.ticket, "worktree-b2.json"), JSON.stringify(b2));
  assert.match(start(), /REVIEW: REFUSED\. the ticket worktree's binding changed \(expected worktree-b1\.json as recorded\)/);
  fs.rmSync(path.join(f.ticket, "worktree-b2.json"));
  noBundle();

  fs.renameSync(f.wt, `${f.wt}-moved`);
  assert.match(start(), /REVIEW: REFUSED\. the ticket worktree failed verification: .*does not exist/);
  fs.renameSync(`${f.wt}-moved`, f.wt);
  noBundle();

  // The report's recorded binding signature must match.
  const reportMeta = path.join(f.ticket, "impl-r1-1.json");
  const meta = JSON.parse(fs.readFileSync(reportMeta, "utf8"));
  fs.writeFileSync(reportMeta, JSON.stringify({ ...meta, worktree: { ...meta.worktree, bindingHmac: "0".repeat(64) } }));
  assert.match(start(), /REVIEW: REFUSED\. the ticket worktree's binding changed/);
  fs.writeFileSync(reportMeta, JSON.stringify(meta));
  assert.match(start(), /REVIEW: STARTED rv-1/);
});

test("a binding tampered during a review stops checks, the save, the status, and the approval", () => {
  const f = implemented();
  assert.match(f.run(["review-start", f.data, f.sid("review"), KEY]).out, /STARTED/);
  const file = path.join(f.ticket, "worktree-b1.json");
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, good.replace(/"planRevision": 1/, '"planRevision": 9'));
  const check = f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]);
  assert.equal(check.status, 1);
  assert.match(check.out, /ERROR: .*(binding changed|invalid signature)/);
  assert.equal(fs.readdirSync(path.join(f.ticket, "reviews", "rv-1", "checks")).length, 0, "no check evidence is recorded");
  const save = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson("PASS"))]);
  assert.match(save.out, /ERROR: .*(binding changed|invalid signature)/);
  fs.writeFileSync(file, good);

  f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]);
  const saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson("PASS"))]).out;
  const hash = /Review SHA-256: ([0-9a-f]{64})/.exec(saved)[1];
  fs.writeFileSync(file, good.replace(/"planRevision": 1/, '"planRevision": 9'));
  assert.match(f.run(["review-status", f.data, KEY]).out, /REVIEW: STALE[\s\S]*(binding changed|invalid signature)/);
  assert.match(f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", hash]).out, /REVIEW APPROVAL: REFUSED\. .*(binding changed|invalid signature)/);
  assert.equal(fs.existsSync(path.join(f.ticket, "reviews", "review-approval-rv-1.json")), false);
});

test("an edited workspace in a signed review or approval is rejected", () => {
  const f = reviewed();
  assert.match(f.approveReview(), /GRANTED/);
  const rfile = path.join(f.ticket, "reviews", "review-approval-rv-1.json");
  const rec = JSON.parse(fs.readFileSync(rfile, "utf8"));
  fs.writeFileSync(rfile, JSON.stringify({ ...rec, workspace: { kind: R.LEGACY, path: f.repo } }));
  const RA = require("../scripts/lib/review-approval.cjs");
  assert.throws(() => RA.verifyReview(f.data, KEY, "rv-1", f.repo, { requireRecord: true, checkTree: true }), /no valid signature/);

  const file = path.join(f.ticket, "reviews", "review-rv-1.json");
  const review = JSON.parse(fs.readFileSync(file, "utf8"));
  review.identity.workspace = { kind: R.LEGACY, path: slash(f.repo) };
  fs.writeFileSync(file, JSON.stringify(review));
  const st = f.status();
  assert.equal(st.status, 1);
  assert.match(st.out, /REVIEW: STALE[\s\S]*the review record has no valid signature/, "never compared with the main checkout");
  assert.match(f.approveReview(), /REVIEW APPROVAL: REFUSED\. .*no valid signature/);
});

test("stale reviews: a new implementation report or plan revision invalidates the review", () => {
  const f = reviewed();
  assert.match(f.approveReview(), /GRANTED/);
  assert.match(f.run(["implement-start", f.data, f.sid("impl2"), KEY, "r1", f.planHash]).out, /AUTHORIZED/);
  assert.match(f.run(["report-save", f.data, f.sid("impl2"), draft(f, "report", `Report 2 ${KEY}\n`)]).out, /REPORT SAVED/);
  assert.match(f.status().out, /REVIEW: STALE[\s\S]*a newer implementation report exists/);
  assert.match(f.approveReview(), /REFUSED\. .*a newer implementation report exists/);

  assert.match(f.run(["save", f.data, SITE, KEY, draft(f, "plan", `${PLAN}\nrevised\n\n## Existing worktree changes\n- src/app.js, src/new file é.js: kept\n`)]).out, /SAVED/);
  assert.match(f.status().out, /REVIEW: STALE[\s\S]*the plan has a newer revision than the one reviewed/);
});

// ------------------------------------------------------------ report layout

test("reports state their layout explicitly; a worktree session never reports in place", () => {
  const f = implemented();
  const meta = JSON.parse(fs.readFileSync(path.join(f.ticket, "impl-r1-1.json"), "utf8"));
  assert.equal(meta.layout, "worktree");
  assert.deepEqual(meta.worktree, { path: f.wt, branch: `jira/${KEY}`, baseHead: f.binding.baseHead, binding: 1, bindingHmac: f.binding.hmac });

  // A session marked as a worktree session but without its worktree is refused,
  // not treated as in place.
  const sFile = path.join(f.data, "sessions", `${f.sid("impl")}.json`);
  const s = JSON.parse(fs.readFileSync(sFile, "utf8"));
  delete s.worktree;
  fs.writeFileSync(sFile, JSON.stringify(s));
  const r = f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `Report ${KEY}\n`)]);
  assert.equal(r.status, 1);
  assert.match(r.out, /ERROR: .*no verified ticket worktree/);

  assert.equal(R.reportLayout({ layout: "worktree" }), "worktree");
  assert.equal(R.reportLayout({ worktree: { path: "x" } }), "worktree", "a report naming a worktree is a worktree report even without the layout field");
  assert.equal(R.reportLayout({ layout: "legacy-in-place" }), "legacy-in-place");
  assert.equal(R.reportLayout({}), "legacy-in-place", "a report from a version before Phase 8C");
  assert.equal(R.reportLayout({ layout: "elsewhere" }), null);
});

test("a report that names a worktree without its signed binding identity is refused", () => {
  const f = implemented();
  const reportMeta = path.join(f.ticket, "impl-r1-1.json");
  const meta = JSON.parse(fs.readFileSync(reportMeta, "utf8"));
  delete meta.worktree.bindingHmac; // as an unreleased step-3 report had it
  fs.writeFileSync(reportMeta, JSON.stringify(meta));
  assert.match(f.run(["review-start", f.data, f.sid("review"), KEY]).out, /REVIEW: REFUSED\. the record names a ticket worktree but does not identify its signed binding/);
});

// ------------------------------------------------------------------ legacy

test("legacy in-place implementations keep their review, approval, and shipping path", () => {
  const f = approved();
  legacyImplement(f, "old", KEY, 1, f.planHash);
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 2;\n");
  assert.match(f.run(["report-save", f.data, f.sid("old"), draft(f, "report", `Report ${KEY}\n`)]).out, /REPORT SAVED/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.ticket, "impl-r1-1.json"), "utf8")).layout, "legacy-in-place");
  const started = f.run(["review-start", f.data, f.sid("review"), KEY]).out;
  assert.match(started, /Reviewed workspace: main checkout \(legacy in-place implementation\)/);
  const check = f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]).out;
  assert.ok(check.includes("(main checkout, legacy in-place review)"));
  const saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson("PASS"))]).out;
  assert.match(saved, /VERDICT: PASS/);
  const review = JSON.parse(fs.readFileSync(path.join(f.ticket, "reviews", "review-rv-1.json"), "utf8"));
  assert.equal(review.identity.workspace.kind, "legacy-in-place");
  assert.match(fs.readFileSync(path.join(f.ticket, "reviews", "review-rv-1.html"), "utf8"), /main checkout \(legacy in-place implementation\)/);
  const hash = /Review SHA-256: ([0-9a-f]{64})/.exec(saved)[1];
  const approval = f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", hash]).out;
  assert.match(approval, /REVIEW APPROVAL: GRANTED/);
  assert.match(approval, /To ship it, the developer runs: \/jira-dev-harness:ship/);
  assert.doesNotMatch(f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", hash]).out, /ticket worktree/);
});

test("a review saved before this step (no workspace field) is treated as in place, as it was made", () => {
  // helpers.reviewed() builds such a review through the legacy session path;
  // the phase 6 and merge suites cover approval and shipping. Here: the record
  // without a workspace verifies against the main checkout.
  const ws = undefined;
  assert.equal(R.sameWorkspace(ws, undefined), true);
  assert.equal(R.sameWorkspace(ws, { kind: "legacy-in-place", path: "x" }), true);
  assert.equal(R.sameWorkspace(ws, { kind: "worktree", path: "x", binding: 1, bindingHmac: "a".repeat(64) }), false);
});

// ------------------------------------------------------- guard, independence

test("nobody writes into the worktree during a review; the Reviewer stays read-only", () => {
  const f = implemented();
  assert.match(f.run(["review-start", f.data, f.sid("review"), KEY]).out, /STARTED/);
  const g = (input) => guard(f, { session_id: f.sid("review"), permission_mode: "default", cwd: f.repo, ...input }).permissionDecision;
  const target = { file_path: path.join(f.wt, "src", "app.js") };
  assert.equal(g({ tool_name: "Write", tool_input: target }), "deny");
  assert.equal(g({ agent_type: "jira-dev-harness:reviewer", tool_name: "Edit", tool_input: target }), "deny");
  assert.equal(g({ agent_type: "jira-dev-harness:reviewer", tool_name: "Bash", tool_input: { command: `cd "${f.wt}" && npm test` } }), "deny");
  assert.equal(g({ agent_type: "jira-dev-harness:developer", tool_name: "Edit", tool_input: target }), "deny", "no implementation authorization in a review session");
  assert.equal(g({ agent_type: "jira-dev-harness:reviewer", tool_name: "Read", tool_input: target }), "(none)");
  const runCheck = `node "${slash(path.join(ROOT, "scripts", "plan-store.cjs"))}" run-check "${slash(f.data)}" ${f.sid("review")} app required '${CHECK.replace(/'/g, "")}'`;
  assert.equal(g({ tool_name: "Bash", tool_input: { command: runCheck } }), "ask", "every recorded check needs the developer's approval");

  const reviewer = fs.readFileSync(path.join(ROOT, "agents", "reviewer.md"), "utf8");
  assert.match(reviewer, /^tools: Read, Grep, Glob$/m);
  assert.match(reviewer, /model: opus/);
  assert.match(reviewer, /the main\s+checkout does not contain the change and must not be reviewed instead/);
  const skill = fs.readFileSync(path.join(ROOT, "skills", "review", "SKILL.md"), "utf8");
  assert.match(skill, /never review the main checkout instead/);
  assert.match(skill, /reviewed workspace root/);
});
