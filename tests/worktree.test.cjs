// Phase 8C step 1: sibling worktree creation, verification, the signed
// binding, and the safety checks around them. Every fixture repository lives
// in a path with spaces ("React Apps/demo app"), so the worktree is
// "React Apps/demo app-ABC-1". No network, Jira, or GitHub is involved.
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const W = require("../scripts/lib/worktree.cjs");
const L = require("../scripts/lib/approval.cjs");
const { ROOT, SITE, KEY, git, makeFixture } = require("./helpers.cjs");

const REPO_DIR = path.join("React Apps", "demo app");
const slash = (p) => p.replace(/\\/g, "/");

const planText = (key) => `# Plan ${key}\n\nReadiness: READY\n\n## Files likely to change\n- \`src/app.js\`\n\n## Testing and validation\n- \`node -v\`\n`;

// Approves a plan for `key` in the fixture repository; returns its SHA-256.
function approvePlan(f, key) {
  const p = f.run(["draft-path", SITE, key, "plan"]).out.trim();
  fs.writeFileSync(p, planText(key));
  assert.match(f.run(["save", f.data, SITE, key, p]).out, /SAVED/);
  const hash = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, key]).out)[1];
  assert.match(f.run(["approve", f.data, f.sid(`plan-${key}`), key, "r1", hash]).out, /APPROVAL: GRANTED/);
  return hash;
}

// A repository with ignored dependency and secret files, an approved plan,
// and helpers. `setup(f)` runs before the plan is saved.
function fixture(setup) {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  fs.writeFileSync(path.join(f.repo, ".gitignore"), "node_modules/\n.env\n");
  git(f.repo, "add", ".gitignore");
  git(f.repo, "commit", "-m", "ignore dependencies");
  fs.mkdirSync(path.join(f.repo, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(f.repo, "node_modules", "dep", "index.js"), "module.exports = 0;\n");
  fs.writeFileSync(path.join(f.repo, ".env"), "SECRET=1\n");
  if (setup) setup(f);
  f.head = git(f.repo, "rev-parse", "HEAD");
  f.hash = approvePlan(f, KEY);
  f.parent = path.dirname(f.repo);
  f.wt = slash(path.join(fs.realpathSync.native(f.parent), `demo app-${KEY}`));
  f.opts = (over = {}) => ({
    site: SITE, key: KEY, revision: 1, planSha256: f.hash, baseHead: f.head,
    plannedFiles: ["src/app.js"], mainRoot: f.repo, ...over,
  });
  return f;
}

// Everything about the main checkout and its parent that a refusal must not change.
function snapshot(f) {
  return {
    head: git(f.repo, "rev-parse", "HEAD"),
    branch: git(f.repo, "branch", "--show-current"),
    status: git(f.repo, "status", "--porcelain", "--ignored", "--untracked-files=all"),
    index: git(f.repo, "ls-files", "-s"),
    refs: git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    worktrees: git(f.repo, "worktree", "list", "--porcelain"),
    siblings: fs.readdirSync(f.parent).sort().join("|"),
    env: fs.readFileSync(path.join(f.repo, ".env"), "utf8"),
  };
}

const bindings = (f, key = KEY) => fs.readdirSync(path.join(f.data, "plans", SITE, key)).filter((n) => /^worktree-b/.test(n));

function refused(f, fn, pattern) {
  const before = snapshot(f);
  assert.throws(fn, pattern);
  assert.deepEqual(snapshot(f), before, "a refusal must leave the main checkout and its parent unchanged");
  assert.deepEqual(bindings(f), [], "a refusal must not write a binding");
}

// ------------------------------------------------------------ path rules

test("the worktree path is a sibling named <project>-<KEY>, also with spaces", () => {
  const f = fixture();
  const p = W.pathFor(f.repo, KEY);
  assert.equal(p.path, f.wt);
  assert.equal(p.name, `demo app-${KEY}`);
  assert.ok(W.samePath(p.parent, fs.realpathSync.native(f.parent)));
  assert.throws(() => W.pathFor(f.repo, "abc-1"), /invalid issue key/);
  assert.throws(() => W.pathFor(f.repo, "../ABC-1"), /invalid issue key/);
  assert.throws(() => W.pathFor(path.parse(f.repo).root, KEY), /filesystem root/);
});

test("collisions: any existing entry, in any letter case, blocks the path", () => {
  const f = fixture();
  const p = W.pathFor(f.repo, KEY);
  assert.equal(W.collisionProblem(p.parent, p.name), null);
  fs.writeFileSync(path.join(p.parent, `DEMO APP-abc-1`), "x");
  assert.match(W.collisionProblem(p.parent, p.name), /already exists as a file \(same name in a different letter case/);
});

test("Windows long paths are refused unless git long paths are enabled", () => {
  const long = { platform: "win32", worktreePath: "C:/" + "a".repeat(200), longestTracked: 80 };
  assert.match(W.longPathProblem(long), /over the Windows limit of 259.*core\.longpaths is not enabled.*Nothing was changed/s);
  assert.equal(W.longPathProblem({ ...long, longpaths: true }), null);
  assert.equal(W.longPathProblem({ ...long, longestTracked: 10 }), null);
  assert.equal(W.longPathProblem({ ...long, platform: "linux" }), null);
});

test("worktree list parsing", () => {
  const list = W.parseWorktreeList("worktree C:/a b/x\nHEAD 1111\nbranch refs/heads/main\n\nworktree C:/a b/x-ABC-1\nHEAD 2222\ndetached\nlocked reason\n");
  assert.deepEqual(list, [
    { path: "C:/a b/x", head: "1111", branch: "refs/heads/main" },
    { path: "C:/a b/x-ABC-1", head: "2222", detached: true, locked: true },
  ]);
});

test("main-checkout changes are split into plan-relevant and other", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "changed\n");
  fs.writeFileSync(path.join(f.repo, "notes.txt"), "n\n");
  const c = W.mainChanges(f.repo, ["src/app.js"]);
  assert.deepEqual(c.relevant, [" M src/app.js"]);
  assert.deepEqual(c.other, ["?? notes.txt"]);
  assert.deepEqual(W.mainChanges(f.repo, ["src/"]).relevant, [" M src/app.js"]);
  assert.deepEqual(W.mainChanges(f.repo, []).relevant, []);
});

// --------------------------------------------------------------- creation

test("create: worktree on jira/<KEY> at the approved base, signed binding, main checkout untouched", () => {
  const f = fixture();
  const before = snapshot(f);
  const r = W.create(f.data, f.opts());

  assert.equal(r.created, true);
  assert.equal(r.binding.path, f.wt);
  assert.equal(r.binding.branch, `jira/${KEY}`);
  assert.equal(r.binding.baseHead, f.head);
  assert.equal(git(f.wt, "rev-parse", "HEAD"), f.head);
  assert.equal(git(f.wt, "branch", "--show-current"), `jira/${KEY}`);
  assert.ok(fs.lstatSync(path.join(f.wt, ".git")).isFile(), "a linked worktree's .git is a file");

  // Signed binding with the unchanged primary identity format.
  const rec = JSON.parse(fs.readFileSync(path.join(f.data, "plans", SITE, KEY, "worktree-b1.json"), "utf8"));
  assert.ok(L.signatureValid(rec, L.approvalKey(f.data, false)));
  assert.ok(L.sameRepo(rec.primary, L.repoIdentity(f.repo)));
  assert.equal(L.sameRepo(L.repoIdentity(f.wt), L.repoIdentity(f.repo)), false, "sameRepo is unchanged: a worktree is a different root");
  assert.deepEqual(Object.keys(rec).sort(), ["baseHead", "binding", "branch", "commonDir", "createdAt", "hmac", "issueKey", "kind", "path", "planRevision", "planSha256", "primary", "site"]);

  // Registry entry for the guard.
  assert.deepEqual(W.registeredPaths(f.data), [{ site: SITE, issueKey: KEY, path: f.wt }]);

  // Main checkout: only the new branch and the worktree entry changed.
  const after = snapshot(f);
  for (const k of ["head", "branch", "status", "index", "env"]) assert.deepEqual(after[k], before[k], k);
  const added = after.refs.split("\n").filter((l) => !before.refs.split("\n").includes(l));
  assert.deepEqual(added, [`refs/heads/jira/${KEY} ${f.head}`], "the only new ref is the ticket branch at the base");
  assert.deepEqual(after.siblings.split("|").sort(), [...before.siblings.split("|"), `demo app-${KEY}`].sort());

  // Dependency report: reported, never copied.
  assert.deepEqual(r.dependencies.missing, [".env", "node_modules/"]);
  assert.deepEqual(r.dependencies.sensitive, [".env"]);
  assert.equal(fs.existsSync(path.join(f.wt, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(f.wt, ".env")), false);

  assert.deepEqual(W.verify(f.data, SITE, KEY, f.repo).problems, []);
});

test("no repository hook runs during creation (also with a repository core.hooksPath)", () => {
  const marker = (f, name) => path.join(f.base, `HOOK_RAN_${name}`);
  const hook = (file, out) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho ran > "${slash(out)}"\n`);
    fs.chmodSync(file, 0o755);
  };
  const f = fixture((g) => {
    hook(path.join(g.repo, ".git", "hooks", "post-checkout"), path.join(g.base, "HOOK_RAN_default"));
    hook(path.join(g.base, "custom-hooks", "post-checkout"), path.join(g.base, "HOOK_RAN_custom"));
  });

  // Control: the hook does run for an ordinary worktree add.
  git(f.repo, "worktree", "add", "--detach", path.join(f.base, "control"), "HEAD");
  assert.ok(fs.existsSync(marker(f, "default")), "control: the default hook runs without the plugin's protection");
  fs.rmSync(marker(f, "default"));

  git(f.repo, "config", "core.hooksPath", slash(path.join(f.base, "custom-hooks")));
  W.create(f.data, f.opts());
  assert.equal(fs.existsSync(marker(f, "default")), false);
  assert.equal(fs.existsSync(marker(f, "custom")), false);
  assert.equal(git(f.wt, "rev-parse", "HEAD"), f.head);
});

test("ensure reuses the verified worktree for the same base and refuses a different base", () => {
  const f = fixture();
  const first = W.ensure(f.data, f.opts());
  assert.equal(first.created, true);
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  git(f.wt, "commit", "-am", "work in progress");

  const again = W.ensure(f.data, f.opts());
  assert.equal(again.created, false);
  assert.equal(again.binding.path, f.wt);
  assert.deepEqual(bindings(f), ["worktree-b1.json"]);
  assert.equal(fs.readFileSync(path.join(f.wt, "src", "app.js"), "utf8"), "module.exports = 2;\n", "existing work is kept");

  assert.throws(() => W.create(f.data, f.opts()), /already has a worktree binding/);

  // Re-planned at a new base (r2 approved after a commit in the main checkout):
  // the existing worktree is not reused.
  fs.writeFileSync(path.join(f.repo, "README.md"), "readme\n");
  git(f.repo, "add", "README.md");
  git(f.repo, "commit", "-m", "main moved on");
  const p = f.run(["draft-path", SITE, KEY, "plan"]).out.trim();
  fs.writeFileSync(p, `${planText(KEY)}\n## Existing worktree changes\n- src/app.js: kept\n`);
  f.run(["save", f.data, SITE, KEY, p]);
  const h2 = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, KEY]).out)[1];
  assert.match(f.run(["approve", f.data, f.sid("plan2"), KEY, "r2", h2]).out, /APPROVAL: GRANTED/);
  assert.throws(() => W.ensure(f.data, f.opts({ revision: 2, planSha256: h2, baseHead: undefined })),
    /is based on .* but the approved plan is based on .*Nothing was changed/s);
  assert.throws(() => W.ensure(f.data, f.opts()), /r1 is not the latest approved revision/);
  assert.deepEqual(bindings(f), ["worktree-b1.json"]);
});

test("other uncommitted main-checkout changes give a warning and stay in the main checkout", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "notes.txt"), "local\n");
  const r = W.create(f.data, f.opts());
  assert.match(r.warnings.join("\n"), /1 other uncommitted change/);
  assert.equal(fs.existsSync(path.join(f.wt, "notes.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.repo, "notes.txt"), "utf8"), "local\n");
});

test("a parent directory inside another git repository gives a warning", () => {
  const f = fixture();
  git(f.base, "init", "-b", "main");
  const r = W.create(f.data, f.opts());
  assert.match(r.warnings.join("\n"), /inside another git repository/);
  assert.deepEqual(W.verify(f.data, SITE, KEY, f.repo).problems, []);
});

test("checkout filters stay enabled and the ones the base selects are reported", () => {
  const f = fixture((g) => {
    git(g.repo, "config", "filter.probe.smudge", "cat");
    git(g.repo, "config", "filter.probe.clean", "cat");
    git(g.repo, "config", "filter.unused.smudge", "cat");
    fs.writeFileSync(path.join(g.repo, ".gitattributes"), "*.txt filter=probe\n");
    fs.writeFileSync(path.join(g.repo, "a.txt"), "a\n");
    git(g.repo, "add", ".gitattributes", "a.txt");
    git(g.repo, "commit", "-m", "filtered file");
  });
  const r = W.create(f.data, f.opts());
  assert.deepEqual(r.filters, [{ name: "probe", command: "cat", files: 1 }]);
  assert.equal(fs.readFileSync(path.join(f.wt, "a.txt"), "utf8"), "a\n");
});

// --------------------------------------------------------------- refusals

test("the base comes from the signed approval; a different base or a moved main checkout is refused", () => {
  const f = fixture();
  const older = git(f.repo, "rev-parse", "HEAD~1");
  refused(f, () => W.create(f.data, f.opts({ baseHead: older })), /approved base commit is .*, not /);
  refused(f, () => W.create(f.data, f.opts({ baseHead: "b".repeat(40) })), /approved base commit is/);

  fs.writeFileSync(path.join(f.repo, "README.md"), "readme\n");
  git(f.repo, "add", "README.md");
  git(f.repo, "commit", "-m", "after approval");
  refused(f, () => W.create(f.data, f.opts({ baseHead: undefined })), /main checkout is at .* but the plan was approved for base .*never rebased/s);
});

test("refused when uncommitted main-checkout changes touch the plan's files (checked at creation time)", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "unsaved local work\n");
  refused(f, () => W.create(f.data, f.opts()), /touch the plan's files[\s\S]*src\/app\.js[\s\S]*Commit or stash them yourself/);
  assert.equal(fs.readFileSync(path.join(f.repo, "src", "app.js"), "utf8"), "unsaved local work\n");
});

test("refused for an unapproved or superseded plan", () => {
  const f = fixture();
  refused(f, () => W.create(f.data, f.opts({ planSha256: "c".repeat(64) })), /not the latest approved revision/);
  refused(f, () => W.create(f.data, f.opts({ revision: 2 })), /not the latest approved revision/);
});

test("refused for an existing branch, directory, case variant, junction, or foreign worktree", () => {
  const f = fixture();
  git(f.repo, "branch", `jira/${KEY}`);
  refused(f, () => W.create(f.data, f.opts()), /branch jira\/ABC-1 already exists/);
  git(f.repo, "branch", "-D", `jira/${KEY}`);

  fs.mkdirSync(f.wt);
  refused(f, () => W.create(f.data, f.opts()), /already exists as a directory\. Nothing was changed/);
  fs.rmdirSync(f.wt);

  fs.mkdirSync(path.join(f.parent, `demo app-abc-1`));
  refused(f, () => W.create(f.data, f.opts()), /different letter case/);
  fs.rmdirSync(path.join(f.parent, `demo app-abc-1`));

  const elsewhere = path.join(f.base, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "keep.txt"), "keep\n");
  fs.symlinkSync(elsewhere, f.wt, "junction");
  refused(f, () => W.create(f.data, f.opts()), /symbolic link or junction/);
  fs.unlinkSync(f.wt);
  assert.deepEqual(fs.readdirSync(elsewhere), ["keep.txt"]);

  git(f.repo, "worktree", "add", "--detach", f.wt, "HEAD");
  refused(f, () => W.create(f.data, f.opts()), /already exists as a directory/);
});

test("refused while another operation holds the ticket lock, or if the empty hooks directory is not empty", () => {
  const f = fixture();
  const lock = path.join(f.data, "worktrees", "locks", `${SITE}__${KEY}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "{}");
  refused(f, () => W.create(f.data, f.opts()), /in progress.*delete that file yourself/s);
  fs.rmSync(lock);

  const hooks = path.join(f.data, "worktrees", "empty-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\n");
  refused(f, () => W.create(f.data, f.opts()), /must be empty/);
  assert.equal(fs.existsSync(lock), false, "the lock is released after a refusal");
});

test("refused when run from a linked worktree instead of the main checkout", () => {
  const f = fixture();
  W.create(f.data, f.opts());
  assert.throws(() => W.create(f.data, f.opts({ mainRoot: f.wt })), /itself a linked worktree/);
});

// ------------------------------------------------------------ verification

test("verify rejects a tampered binding and a switched branch, and accepts ticket commits", () => {
  const f = fixture();
  W.create(f.data, f.opts());
  const file = path.join(f.data, "plans", SITE, KEY, "worktree-b1.json");
  const original = fs.readFileSync(file, "utf8");

  const forged = JSON.parse(original);
  forged.path = slash(path.join(f.base, "elsewhere"));
  fs.writeFileSync(file, JSON.stringify(forged));
  assert.match(W.verify(f.data, SITE, KEY, f.repo).problems.join("\n"), /invalid signature/);
  fs.writeFileSync(file, original);
  assert.deepEqual(W.verify(f.data, SITE, KEY, f.repo).problems, []);

  git(f.wt, "switch", "-c", "other");
  assert.match(W.verify(f.data, SITE, KEY, f.repo).problems.join("\n"), /branch other checked out, not jira\/ABC-1/);
  git(f.wt, "switch", `jira/${KEY}`);

  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 3;\n");
  git(f.wt, "commit", "-am", "progress");
  assert.deepEqual(W.verify(f.data, SITE, KEY, f.repo).problems, [], "commits on the ticket branch keep the binding valid");

  assert.match(W.verify(f.data, SITE, "ABC-9", f.repo).problems.join("\n"), /no worktree binding/);
});

test("verify rejects a missing worktree directory and one replaced by a junction", () => {
  const f = fixture();
  W.create(f.data, f.opts());
  const moved = path.join(f.base, "moved");
  fs.renameSync(f.wt, moved);
  assert.match(W.verify(f.data, SITE, KEY, f.repo).problems.join("\n"), /does not exist/);
  fs.symlinkSync(moved, f.wt, "junction");
  assert.match(W.verify(f.data, SITE, KEY, f.repo).problems.join("\n"), /symbolic link or junction/);
});

// ------------------------------------------------------------- concurrency

function createInChild(f, opts) {
  const script = `
    const W = require(${JSON.stringify(path.join(ROOT, "scripts", "lib", "worktree.cjs"))});
    try { W.create(process.argv[1], JSON.parse(process.argv[2])); console.log("CREATED"); }
    catch (e) { console.log("REFUSED: " + e.message); }`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", script, f.data, JSON.stringify(opts)], { env: f.env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", () => resolve(out.trim()));
  });
}

test("two concurrent creates for the same ticket give one worktree and one refusal", async () => {
  const f = fixture();
  const results = await Promise.all([createInChild(f, f.opts()), createInChild(f, f.opts())]);
  assert.equal(results.filter((r) => r === "CREATED").length, 1, results.join("\n"));
  assert.match(results.find((r) => r !== "CREATED"), /^REFUSED: .*(in progress|already has a worktree binding|already exists)/s);
  assert.deepEqual(bindings(f), ["worktree-b1.json"]);
  assert.equal(W.listWorktrees(f.repo).length, 2);
});

test("two tickets get separate sibling worktrees concurrently", async () => {
  const f = fixture();
  const hash2 = approvePlan(f, "ABC-2");
  const results = await Promise.all([
    createInChild(f, f.opts()),
    createInChild(f, f.opts({ key: "ABC-2", planSha256: hash2 })),
  ]);
  assert.deepEqual(results, ["CREATED", "CREATED"]);
  const paths = W.listWorktrees(f.repo).map((w) => w.path).sort();
  assert.deepEqual(paths.slice(1).map((p) => path.basename(p)), ["demo app-ABC-1", "demo app-ABC-2"]);
  assert.deepEqual(W.verify(f.data, SITE, "ABC-2", f.repo).problems, []);
  assert.equal(W.registeredPaths(f.data).length, 2);
});

test("the module never runs a destructive git command (its only removal is one unforced git worktree remove)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "lib", "worktree.cjs"), "utf8");
  const arrays = src.match(/\["[^\]]*\]/g);
  const gitArgs = arrays.join("\n");
  for (const bad of ["prune", "--force", "-f", "reset", "clean", "checkout", "rm", "-D", "-d", "push", "branch", "repair", "move"]) {
    assert.ok(!gitArgs.includes(`"${bad}"`), `worktree.cjs must not pass ${bad} to git`);
  }
  const removals = arrays.filter((a) => a.includes('"remove"'));
  assert.equal(removals.length, 1, "exactly one removal call");
  assert.match(removals[0], /"worktree", "remove", b\.path\]$/, "git worktree remove <path>, with nothing else");
  assert.doesNotMatch(src, /fs\.rmSync\([^)]*b\.path|rmdirSync|recursive: true[^}]*b\.path/, "the worktree directory is never deleted outside git");
  execFileSync(process.execPath, ["--check", path.join(ROOT, "scripts", "lib", "worktree.cjs")]);
});
