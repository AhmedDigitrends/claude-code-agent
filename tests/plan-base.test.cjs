// Phase 8C step 2: the plan's base commit. `save` records the full HEAD and
// the uncommitted paths, `approve` checks the base and signs it into the
// approval, and the read-only `worktree-status` command reports it. Legacy
// records (without a base) are still readable but never authorize a
// worktree. Every repository lives under "React Apps/jadwa app".
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const W = require("../scripts/lib/worktree.cjs");
const L = require("../scripts/lib/approval.cjs");
const { SITE, KEY, git, makeFixture } = require("./helpers.cjs");

const REPO_DIR = path.join("React Apps", "jadwa app");
const planText = (key) => `# Plan ${key}\n\nReadiness: READY\n\n## Files likely to change\n- \`src/app.js\`\n`;

function fixture() {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  f.ticket = path.join(f.data, "plans", SITE, KEY);
  f.save = () => {
    const p = f.run(["draft-path", SITE, KEY, "plan"]).out.trim();
    fs.writeFileSync(p, planText(KEY));
    const out = f.run(["save", f.data, SITE, KEY, p]).out;
    assert.match(out, /SAVED/);
    return { out, n: Number(/revision r([0-9]+)/.exec(out)[1]), hash: /SHA-256: ([0-9a-f]{64})/.exec(out)[1] };
  };
  f.approve = (rev, hash) => f.run(["approve", f.data, f.sid("plan"), KEY, `r${rev}`, hash]).out;
  f.meta = (n = 1) => JSON.parse(fs.readFileSync(path.join(f.ticket, `plan-r${n}.json`), "utf8"));
  f.writeMeta = (n, meta) => fs.writeFileSync(path.join(f.ticket, `plan-r${n}.json`), JSON.stringify(meta, null, 2) + "\n");
  f.approval = (n = 1) => JSON.parse(fs.readFileSync(path.join(f.ticket, `approval-r${n}.json`), "utf8"));
  f.wtStatus = (ref = KEY) => f.run(["worktree-status", f.data, ref]);
  f.opts = (rev, hash) => ({ site: SITE, key: KEY, revision: rev, planSha256: hash, plannedFiles: ["src/app.js"], mainRoot: f.repo });
  return f;
}

function commit(f, file, text) {
  fs.mkdirSync(path.dirname(path.join(f.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(f.repo, file), text);
  git(f.repo, "add", "--", file);
  git(f.repo, "commit", "-m", `add ${file}`);
}

// Every file under `dir` with its SHA-256, to prove a command wrote nothing.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

// ------------------------------------------------------------------- save

test("save records the full HEAD and the uncommitted paths exactly (spaces, non-ASCII, renames)", () => {
  const f = fixture();
  commit(f, "docs/old name.md", "doc\n");
  git(f.repo, "mv", "docs/old name.md", "docs/new name.md");
  fs.writeFileSync(path.join(f.repo, "my notes.txt"), "n\n");
  fs.writeFileSync(path.join(f.repo, "é.txt"), "e\n");
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "local\n");
  const head = git(f.repo, "rev-parse", "HEAD");

  const { out } = f.save();
  const meta = f.meta();
  assert.equal(meta.baseHead, head);
  assert.match(meta.baseHead, /^[0-9a-f]{40}$/);
  assert.deepEqual(meta.dirtyPaths, ["docs/new name.md", "docs/old name.md", "my notes.txt", "src/app.js", "é.txt"]);
  assert.match(out, new RegExp(`Base commit: ${head}`));
  assert.match(out, /Uncommitted paths when planned: 5\n  docs\/new name\.md\n  docs\/old name\.md\n  my notes\.txt\n  src\/app\.js\n  é\.txt/);
});

test("save in a clean checkout records no uncommitted paths", () => {
  const f = fixture();
  const { out } = f.save();
  assert.deepEqual(f.meta().dirtyPaths, []);
  assert.match(out, /Uncommitted paths when planned: none/);
});

// ---------------------------------------------------------------- approve

test("approve signs the base commit into the approval; status and verify show it", () => {
  const f = fixture();
  const head = git(f.repo, "rev-parse", "HEAD");
  const { hash } = f.save();
  const out = f.approve(1, hash);
  assert.match(out, /APPROVAL: GRANTED/);
  assert.match(out, new RegExp(`Base commit: ${head}`));
  const a = f.approval();
  assert.equal(a.baseHead, head);
  assert.ok(L.signatureValid(a, L.approvalKey(f.data, false)));
  assert.match(f.approve(1, hash), /APPROVAL: ALREADY GRANTED/);
  assert.match(f.run(["status", f.data, KEY]).out, new RegExp(`Base commit: ${head}`));
  assert.equal(f.run(["verify", f.data, KEY]).status, 0);
  assert.equal(W.approvedBase(f.data, SITE, KEY, f.repo).base, head);
});

test("a tampered base in the signed approval invalidates it", () => {
  const f = fixture();
  const { hash } = f.save();
  f.approve(1, hash);
  const a = f.approval();
  a.baseHead = "e".repeat(40);
  fs.writeFileSync(path.join(f.ticket, "approval-r1.json"), JSON.stringify(a, null, 2));
  assert.match(f.run(["status", f.data, KEY]).out, /Approval: NOT VALID \(the approval record's signature is missing or invalid/);
  assert.equal(f.run(["verify", f.data, KEY]).status, 1);
  assert.throws(() => W.create(f.data, f.opts(1, hash)), /signature is missing or invalid/);
  assert.match(f.wtStatus().out, /Plan: r1, not approved \(the approval record's signature/);
});

test("a base edited in the unsigned plan metadata after approval cannot authorize a worktree", () => {
  const f = fixture();
  const { hash } = f.save();
  f.approve(1, hash);
  const meta = f.meta();
  meta.baseHead = "f".repeat(40);
  f.writeMeta(1, meta);
  assert.equal(f.run(["verify", f.data, KEY]).status, 0, "the plan approval itself is still valid");
  assert.throws(() => W.create(f.data, f.opts(1, hash)), /plan-r1\.json does not match the signed approval/);
  assert.match(f.wtStatus().out, /Approved base commit: none \(the base commit in plan-r1\.json does not match the signed approval/);
});

test("approve is refused when HEAD moved after the plan was saved; nothing is written", () => {
  const f = fixture();
  const { hash } = f.save();
  commit(f, "later.txt", "x\n");
  const out = f.approve(1, hash);
  assert.match(out, /APPROVAL: REFUSED\. HEAD moved since r1 was saved \(base [0-9a-f]{40}, HEAD now [0-9a-f]{40}\)/);
  assert.equal(fs.existsSync(path.join(f.ticket, "approval-r1.json")), false);
  // A new revision saved at the new HEAD can be approved.
  const r2 = f.save();
  assert.match(f.approve(2, r2.hash), /APPROVAL: GRANTED/);
  assert.equal(f.approval(2).baseHead, git(f.repo, "rev-parse", "HEAD"));
});

test("approve is refused for a missing, malformed, or foreign base commit", () => {
  const f = fixture();
  const { hash } = f.save();
  const original = f.meta();
  const foreign = git(f.repo, "commit-tree", git(f.repo, "rev-parse", "HEAD^{tree}"), "-m", "unrelated history");
  for (const [base, reason] of [
    ["d".repeat(40), /does not exist in/],
    ["abc123", /is not a full commit id/],
    [foreign, /is not part of this repository's history/],
  ]) {
    f.writeMeta(1, { ...original, baseHead: base });
    assert.match(f.approve(1, hash), reason);
    assert.equal(fs.existsSync(path.join(f.ticket, "approval-r1.json")), false);
  }
});

test("a stale revision cannot be approved or authorize a worktree", () => {
  const f = fixture();
  const r1 = f.save();
  assert.match(f.approve(1, r1.hash), /GRANTED/);
  const r2 = f.save();
  assert.match(f.approve(1, r1.hash), /REFUSED\. r1 is not the latest revision/);
  assert.throws(() => W.create(f.data, f.opts(1, r1.hash)), /no approval record/, "the latest revision r2 is unapproved");
  const st = f.wtStatus().out;
  assert.match(st, /Plan: r2, not approved \(no approval record\)/);
  assert.match(f.approve(2, r2.hash), /GRANTED/);
});

// ----------------------------------------------------------------- legacy

test("legacy plan without a base: still readable and approvable, but never authorizes a worktree", () => {
  const f = fixture();
  const { hash } = f.save();
  const meta = f.meta();
  delete meta.baseHead;
  delete meta.dirtyPaths;
  f.writeMeta(1, meta);

  assert.match(f.run(["status", f.data, KEY]).out, /Base commit: none \(saved by an older plugin version; cannot authorize a ticket worktree\)/);
  const out = f.approve(1, hash);
  assert.match(out, /APPROVAL: GRANTED/);
  assert.match(out, /Base commit: none .*cannot authorize a ticket worktree; save a new revision/);
  assert.equal("baseHead" in f.approval(), false);
  assert.equal(f.run(["verify", f.data, KEY]).status, 0, "existing approval checks still accept it");
  assert.throws(() => W.create(f.data, f.opts(1, hash)), /older plugin version without a recorded base commit.*Save a new plan revision/s);
  const st = f.wtStatus().out;
  assert.match(st, /Base commit recorded at save: none/);
  assert.match(st, /Approved base commit: none \(r1 was saved or approved by an older plugin version/);
});

test("legacy approval without a base for a plan with a base: re-approval adds the base", () => {
  const f = fixture();
  const { hash } = f.save();
  f.approve(1, hash);
  const a = f.approval();
  delete a.baseHead;
  a.hmac = L.sign(a, L.approvalKey(f.data, false)); // as an older plugin version signed it
  fs.writeFileSync(path.join(f.ticket, "approval-r1.json"), JSON.stringify(a, null, 2));
  assert.equal(f.run(["verify", f.data, KEY]).status, 0);
  assert.throws(() => W.create(f.data, f.opts(1, hash)), /without a recorded base commit/);
  assert.match(f.approve(1, hash), /APPROVAL: GRANTED/);
  assert.equal(f.approval().baseHead, f.meta().baseHead);
});

// --------------------------------------------------------- worktree-status

test("worktree-status is read-only and reports NONE, VERIFIED, and NOT VERIFIED", () => {
  const f = fixture();
  const head = git(f.repo, "rev-parse", "HEAD");
  const { hash } = f.save();
  f.approve(1, hash);
  const wt = `${fs.realpathSync.native(path.dirname(f.repo)).replace(/\\/g, "/")}/jadwa app-${KEY}`;

  const quiet = (fn) => {
    const data = tree(f.data);
    const index = fs.readFileSync(path.join(f.repo, ".git", "index"));
    const status = git(f.repo, "status", "--porcelain", "--ignored");
    const r = fn();
    assert.deepEqual(tree(f.data), data, "worktree-status must not write to the plugin data directory");
    assert.ok(fs.readFileSync(path.join(f.repo, ".git", "index")).equals(index), "the main index must not be rewritten");
    assert.equal(git(f.repo, "status", "--porcelain", "--ignored"), status);
    return r;
  };

  let r = quiet(() => f.wtStatus());
  assert.equal(r.status, 0);
  assert.match(r.out, /^WORKTREE: NONE\n/);
  assert.match(r.out, /Plan: r1, approved/);
  assert.match(r.out, new RegExp(`Approved base commit: ${head}`));
  assert.ok(r.out.includes(`Expected path: ${wt}\n`));
  assert.equal(fs.existsSync(wt), false, "status never creates the worktree");

  W.create(f.data, f.opts(1, hash));
  r = quiet(() => f.wtStatus(`${SITE}/${KEY}`));
  assert.match(r.out, /^WORKTREE: VERIFIED\n/);
  assert.ok(r.out.includes(`Path: ${wt}\n`));
  assert.match(r.out, /Branch: jira\/ABC-1\n/);
  assert.match(r.out, new RegExp(`Base commit: ${head} \\(plan r1, created `));
  assert.match(r.out, new RegExp(`HEAD: ${head} \\(0 commit\\(s\\) since base\\)`));
  assert.match(r.out, /Uncommitted changes in the worktree: 0/);
  assert.doesNotMatch(r.out, /Problem:/);

  fs.writeFileSync(path.join(wt, "src", "app.js"), "work\n");
  const wtIndex = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const before = fs.readFileSync(wtIndex);
  r = quiet(() => f.wtStatus());
  assert.match(r.out, /Uncommitted changes in the worktree: 1/);
  assert.ok(fs.readFileSync(wtIndex).equals(before), "the worktree index must not be rewritten");

  const file = path.join(f.ticket, "worktree-b1.json");
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  b.branch = "main";
  fs.writeFileSync(file, JSON.stringify(b));
  r = quiet(() => f.wtStatus());
  assert.equal(r.status, 0);
  assert.match(r.out, /^WORKTREE: NOT VERIFIED\n/);
  assert.match(r.out, /Problem: worktree-b1\.json has a missing or invalid signature/);
  assert.doesNotMatch(r.out, /\nPath: /, "fields of an unverified binding are not shown as facts");
});

test("worktree-status for a ticket without a plan, and for invalid input", () => {
  const f = fixture();
  const r = f.wtStatus(`${SITE}/ABC-7`);
  assert.equal(r.status, 0);
  assert.match(r.out, /WORKTREE: NONE\nTicket: example\.atlassian\.net\/ABC-7\nPlan: none saved/);
  const bad = f.run(["worktree-status", f.data, "abc-7"]);
  assert.equal(bad.status, 1);
  assert.match(bad.out, /ERROR: invalid issue key/);
  assert.equal(f.run(["worktree-status", f.data, KEY, "extra"]).status, 1);
});

test("printable output replaces control characters and keeps spaces and non-ASCII", () => {
  assert.equal(W.printable("C:/React Apps/jadwa app-ABC-1"), "C:/React Apps/jadwa app-ABC-1");
  assert.equal(W.printable("é/ü"), "é/ü");
  assert.equal(W.printable("a\nWORKTREE: VERIFIED\u001b[2J\r"), "a?WORKTREE: VERIFIED?[2J?");
});
