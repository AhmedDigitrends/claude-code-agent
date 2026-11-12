// Phase 8C: plugin-managed sibling git worktrees.
//
// Every approved ticket is implemented in its own worktree next to the main
// checkout, never inside it:
//
//   web/app            the developer's main checkout (never changed here)
//   web/app-PROJ-101    worktree for PROJ-101 on branch jira/PROJ-101
//
// This module creates and verifies those worktrees. It runs git only with
// fixed arguments, and never removes, resets, or cleans anything.
//
// Records under <dataDir>:
//   plans/<site>/<KEY>/worktree-b<N>.json    signed binding N (never overwritten)
//   worktrees/registry/<site>__<KEY>.json   managed path, read by the guard
//                                           to protect it (deny-only, so it
//                                           is not trusted for authorization)
//   worktrees/locks/<site>__<KEY>.lock      exclusive per-ticket creation lock
//   worktrees/empty-hooks/                  empty core.hooksPath for creation
//
// The binding holds the primary repository identity in the existing
// repoIdentity() format, so sameRepo() and the signed plan approvals are
// unchanged. A worktree has a different root, so it is verified through its
// binding, not through sameRepo().

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./approval.cjs");

const { fail } = L;

const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Same patterns as the ship step's sensitive files (ship.cjs SENSITIVE_FILE).
const SENSITIVE_FILE = /(^|\/)(\.env(\..*)?|id_rsa[^/]*|id_ed25519[^/]*|id_ecdsa[^/]*|.*\.(pem|p12|pfx|keystore|jks)|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$/i;
// Windows MAX_PATH is 260 including the terminating NUL.
const WIN_MAX_PATH = 259;

const slash = (p) => p.replace(/\\/g, "/");
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const samePath = (a, b) => {
  const n = (p) => slash(path.resolve(p)).replace(/\/+$/, "");
  return CASE_INSENSITIVE_FS ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const real = (p) => slash(fs.realpathSync.native(p));
const branchFor = (key) => `jira/${key}`;
const recordName = (site, key) => `${site}__${key}`;

// Read-only or creating git call with fixed arguments; never prompts.
function run(cwd, args, options = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: options.binary ? "buffer" : "utf8",
    input: options.input,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout || 10 * 60 * 1000,
    // GIT_OPTIONAL_LOCKS=0: read-only queries such as `git status` do not
    // refresh (rewrite) the index.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
  });
  const text = (b) => (b == null ? "" : Buffer.isBuffer(b) ? b.toString("utf8") : b);
  return { status: r.status, stdout: options.binary ? r.stdout : text(r.stdout).trim(), stderr: text(r.stderr).trim() };
}

function runOrFail(cwd, args, what) {
  const r = run(cwd, args);
  if (r.status !== 0) fail(`${what} failed: ${r.stderr || `git exited ${r.status}`}`);
  return r.stdout;
}

// ------------------------------------------------------------------ layout

function dirs(dataDir) {
  const base = path.join(dataDir, "worktrees");
  return {
    base,
    registry: path.join(base, "registry"),
    locks: path.join(base, "locks"),
    hooks: path.join(base, "empty-hooks"),
  };
}

function ticketDir(dataDir, site, key) {
  return path.join(dataDir, "plans", site, key);
}

// The main checkout must be a repository's primary working tree (not itself a
// linked worktree, not a bare repository), given as its top-level directory.
function checkMainRoot(mainRoot) {
  const top = run(mainRoot, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) fail(`not inside a git repository: ${mainRoot}`);
  if (!samePath(real(top.stdout), real(mainRoot))) fail(`run this from the repository's top-level directory: ${top.stdout}`);
  const gitDir = runOrFail(mainRoot, ["rev-parse", "--path-format=absolute", "--git-dir"], "reading the git directory");
  const commonDir = runOrFail(mainRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "reading the common git directory");
  if (!samePath(gitDir, commonDir)) {
    fail(`${slash(mainRoot)} is itself a linked worktree. Run the workflow from the repository's main checkout`);
  }
  return { root: real(top.stdout), commonDir: real(commonDir) };
}

// <realpath(parent of main)>/<basename(main)>-<KEY>
function pathFor(mainRoot, key) {
  if (!L.KEY_RE.test(key || "")) fail(`invalid issue key: ${key}`);
  const root = real(mainRoot);
  const parent = path.dirname(root);
  if (!parent || samePath(parent, root)) fail(`the main checkout ${root} is at a filesystem root; a sibling worktree cannot be created next to it`);
  const name = `${path.basename(root)}-${key}`;
  const realParent = real(parent);
  const target = slash(path.join(realParent, name));
  if (samePath(target, root) || slash(target).toLowerCase().startsWith(`${slash(root).toLowerCase()}/`)) {
    fail(`the worktree path ${target} would be inside the main checkout`);
  }
  return { parent: realParent, name, path: target };
}

// Any existing entry with the same name in any letter case (a directory, a
// file, a symbolic link, or a junction) blocks creation.
function collisionProblem(parent, name) {
  let entries;
  try {
    entries = fs.readdirSync(parent);
  } catch (e) {
    return `the parent directory ${slash(parent)} cannot be read: ${e.code || e.message}`;
  }
  const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  if (!hit) return null;
  let kind = "an entry";
  try {
    const st = fs.lstatSync(path.join(parent, hit));
    kind = st.isSymbolicLink() ? "a symbolic link or junction" : st.isDirectory() ? "a directory" : "a file";
  } catch { /* reported generically */ }
  const variant = hit === name ? "" : ` (same name in a different letter case: ${hit})`;
  return `${slash(path.join(parent, hit))} already exists as ${kind}${variant}. Nothing was changed. Move or rename it, then run the command again`;
}

// Refuses a worktree whose deepest tracked file would exceed the Windows path
// limit, unless git's long-path support is enabled.
function longPathProblem({ platform = process.platform, longpaths = false, worktreePath, longestTracked = 0 }) {
  if (platform !== "win32") return null;
  const total = worktreePath.length + 1 + longestTracked;
  if (total <= WIN_MAX_PATH || longpaths) return null;
  return `the worktree's deepest file path would be ${total} characters, over the Windows limit of ${WIN_MAX_PATH}, and git's core.longpaths is not enabled. Nothing was changed. Move the project to a shorter path, or enable long paths (Windows LongPathsEnabled and \`git config --global core.longpaths true\`) yourself, then run the command again`;
}

function longestTrackedPath(mainRoot, base) {
  const r = run(mainRoot, ["ls-tree", "-r", "-z", "--name-only", base], { binary: true });
  if (r.status !== 0) fail(`listing the files of ${base} failed`);
  return r.stdout.toString("utf8").split("\0").filter(Boolean).reduce((m, p) => Math.max(m, p.length), 0);
}

function gitBool(cwd, name) {
  const r = run(cwd, ["config", "--type=bool", "--get", name]);
  return r.status === 0 && r.stdout === "true";
}

// A warning, not a refusal: the sibling directory would appear as untracked
// content of an enclosing repository. Found by looking for .git entries, so no
// command runs in the enclosing repository.
function nestedRepoWarning(parent) {
  let d = path.resolve(parent);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) {
      return `the worktree's parent directory is inside another git repository (${slash(d)}). The worktree will show there as untracked content; nothing is added to that repository`;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// ------------------------------------------------------------- main checkout

// `git status` entries from NUL-separated output, so that paths with spaces,
// quotes, or non-ASCII characters arrive exactly as stored (the plain
// porcelain format quotes and octal-escapes them). A rename or copy carries
// its original path in `orig`.
function statusEntries(root, extra = []) {
  const r = run(root, ["status", "--porcelain=v1", "-z", ...extra], { binary: true });
  if (r.status !== 0) fail(`git status failed in ${slash(root)}`);
  const tokens = r.stdout.toString("utf8").split("\0");
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.length < 4) continue;
    const e = { code: t.slice(0, 2), path: t.slice(3) };
    if (/[RC]/.test(e.code)) e.orig = tokens[(i += 1)];
    out.push(e);
  }
  return out;
}

// Every path with an uncommitted change (both sides of a rename), sorted.
function dirtyPaths(root) {
  const set = new Set();
  for (const e of statusEntries(root, ["--untracked-files=all"])) {
    set.add(e.path);
    if (e.orig) set.add(e.orig);
  }
  return [...set].sort();
}

// Current uncommitted changes of the main checkout, split into those that
// touch the plan's files (they would be missing from the worktree, which is
// created from the committed base) and the rest.
function mainChanges(mainRoot, plannedFiles = []) {
  const planned = plannedFiles.map((f) => slash(f).replace(/^\.\//, "").replace(/\/+$/, ""));
  const touches = (p) => planned.some((f) => p === f || p.startsWith(`${f}/`) || f.startsWith(`${p.replace(/\/$/, "")}/`));
  const relevant = [];
  const other = [];
  for (const e of statusEntries(mainRoot, ["--untracked-files=all"])) {
    const line = `${e.code} ${e.orig ? `${e.orig} -> ` : ""}${e.path}`;
    (touches(e.path) || (e.orig && touches(e.orig)) ? relevant : other).push(line);
  }
  return { relevant, other };
}

// Checkout filters stay enabled (Git LFS needs them). They come from the
// developer's own git configuration, never from repository content. This
// reports the configured smudge/process filters that the base commit's
// attributes actually select, because they run during creation.
function filterReport(mainRoot, base) {
  const cfg = run(mainRoot, ["config", "--get-regexp", "^filter\\..*\\.(smudge|process)$"]);
  if (cfg.status !== 0 || !cfg.stdout) return [];
  const configured = new Map();
  for (const line of cfg.stdout.split(/\r?\n/)) {
    const m = /^filter\.(.+)\.(smudge|process)\s+(.*)$/.exec(line);
    if (m) configured.set(m[1], { name: m[1], command: m[3], files: 0 });
  }
  if (configured.size === 0) return [];
  const names = run(mainRoot, ["ls-tree", "-r", "-z", "--name-only", base], { binary: true });
  const attrs = names.status === 0
    ? run(mainRoot, ["check-attr", "-z", "--stdin", `--source=${base}`, "filter"], { input: names.stdout, binary: true })
    : { status: 1 };
  if (attrs.status !== 0) {
    return [...configured.values()].map((f) => ({ ...f, files: null }));
  }
  const parts = attrs.stdout.toString("utf8").split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const f = configured.get(parts[i + 2]);
    if (f) f.files += 1;
  }
  return [...configured.values()].filter((f) => f.files > 0);
}

// ----------------------------------------------------------------- worktrees

function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9) };
      out.push(cur);
    } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7);
    else if (cur && line === "bare") cur.bare = true;
    else if (cur && line === "detached") cur.detached = true;
    else if (cur && (line === "locked" || line.startsWith("locked "))) cur.locked = true;
    else if (cur && (line === "prunable" || line.startsWith("prunable "))) cur.prunable = true;
  }
  return out;
}

function listWorktrees(mainRoot) {
  return parseWorktreeList(runOrFail(mainRoot, ["worktree", "list", "--porcelain"], "listing worktrees"));
}

function branchExists(mainRoot, branch) {
  return run(mainRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

// ------------------------------------------------------------------ bindings

function bindingNumbers(dataDir, site, key) {
  const dir = ticketDir(dataDir, site, key);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => /^worktree-b([0-9]+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

// The latest binding of the ticket, unless a removal record closes it.
function activeBinding(dataDir, site, key) {
  const ns = bindingNumbers(dataDir, site, key);
  if (ns.length === 0) return null;
  const n = ns[ns.length - 1];
  const dir = ticketDir(dataDir, site, key);
  if (fs.existsSync(path.join(dir, `worktree-b${n}-removed.json`))) return null;
  const file = path.join(dir, `worktree-b${n}.json`);
  return { n, file, record: L.readJson(file) };
}

function registryFile(dataDir, site, key) {
  return path.join(dirs(dataDir).registry, `${recordName(site, key)}.json`);
}

// Managed worktree paths, for the guard. Unreadable entries are skipped.
function registeredPaths(dataDir) {
  const dir = dirs(dataDir).registry;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => L.readJson(path.join(dir, f)))
    .filter((r) => r && typeof r.path === "string")
    .map((r) => ({ site: r.site, issueKey: r.issueKey, path: r.path }));
}

// Checks one ticket's binding against the signature, the filesystem, and git.
// Returns { binding, problems }; problems is empty when the worktree is the
// ticket's authorized worktree.
function verify(dataDir, site, key, mainRoot) {
  L.checkTicket(site, key);
  const active = activeBinding(dataDir, site, key);
  if (!active) return { binding: null, problems: [`${key} has no worktree binding`] };
  const b = active.record;
  const problems = [];
  if (!L.signatureValid(b, L.approvalKey(dataDir, false))) {
    return { binding: b, problems: [`worktree-b${active.n}.json has a missing or invalid signature (edited or fabricated)`] };
  }
  if (b.kind !== "worktree-binding" || b.issueKey !== key || b.site !== site || b.binding !== active.n) {
    problems.push("the worktree binding is for a different ticket");
  }
  if (b.branch !== branchFor(key)) problems.push(`the binding names branch ${b.branch}, not ${branchFor(key)}`);

  const main = checkMainRoot(mainRoot);
  if (!L.sameRepo(b.primary, L.repoIdentity(main.root))) {
    problems.push(`the binding was created for ${L.describeRepo(b.primary)}, not ${main.root}`);
  }
  let expected;
  try {
    expected = pathFor(main.root, key).path;
  } catch (e) {
    problems.push(e.message);
  }
  if (expected && !samePath(expected, b.path)) problems.push(`the binding's path ${b.path} is not the expected sibling path ${expected}`);
  if (!samePath(main.commonDir, b.commonDir)) problems.push("the main checkout's git directory changed since the worktree was created");

  let st = null;
  try {
    st = fs.lstatSync(b.path);
  } catch {
    problems.push(`the worktree directory ${b.path} does not exist`);
  }
  if (st && st.isSymbolicLink()) problems.push(`${b.path} is a symbolic link or junction, not the worktree directory`);
  else if (st && !st.isDirectory()) problems.push(`${b.path} is not a directory`);
  if (problems.length) return { binding: b, problems };
  if (!samePath(real(b.path), b.path)) {
    return { binding: b, problems: [`${b.path} resolves to ${real(b.path)} (a link in its path)`] };
  }
  let dotGit = null;
  try {
    dotGit = fs.lstatSync(path.join(b.path, ".git"));
  } catch { /* reported below */ }
  if (!dotGit || !dotGit.isFile()) problems.push(`${b.path} is not a linked worktree (its .git is not a file)`);

  const listed = listWorktrees(main.root).find((w) => samePath(w.path, b.path));
  if (!listed) problems.push(`${b.path} is not a worktree of ${main.root}`);
  else if (listed.branch !== `refs/heads/${b.branch}`) {
    problems.push(`the worktree has ${listed.branch ? listed.branch.replace(/^refs\/heads\//, "branch ") : "a detached HEAD"} checked out, not ${b.branch}`);
  }
  if (problems.length) return { binding: b, problems };

  const wtCommon = run(b.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (wtCommon.status !== 0 || !samePath(real(wtCommon.stdout), main.commonDir)) {
    problems.push(`${b.path} does not share the main checkout's git directory`);
  }
  const top = run(b.path, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !samePath(real(top.stdout), b.path)) problems.push(`${b.path} is not the top level of its worktree`);
  if (run(b.path, ["merge-base", "--is-ancestor", b.baseHead, "HEAD"]).status !== 0) {
    problems.push(`the worktree's HEAD does not descend from the approved base ${b.baseHead}`);
  }
  return { binding: b, problems };
}

// The primary repository identity and the ticket worktree are resolved
// separately. When a command runs from inside a plugin-managed ticket
// worktree, this returns the main checkout's root, so that approvals and
// sameRepo() still bind the primary identity; the worktree itself is always
// taken from the signed binding. Any other directory is returned unchanged.
function primaryCwd(dataDir, cwd) {
  try {
    const top = run(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) return cwd;
    const gitDir = run(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout;
    const commonDir = run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
    if (!gitDir || !commonDir || samePath(gitDir, commonDir)) return cwd;
    const here = real(top.stdout);
    if (!registeredPaths(dataDir).some((r) => samePath(r.path, here))) return cwd;
    const main = listWorktrees(here)[0];
    return main && main.path ? main.path : cwd;
  } catch {
    return cwd;
  }
}

// Re-verifies the worktree recorded in an implementing session: the ticket's
// active binding must be the exact signed binding the session was authorized
// with, and it must still verify. Returns null when valid, otherwise the
// reason. A session without a worktree (authorized in place by a version
// before Phase 8C) never authorizes new Developer writes.
function sessionWorktreeProblem(dataDir, state) {
  try {
    if (!state || !state.worktree) {
      return "this session has no verified ticket worktree (it was authorized in place by an older plugin version). New Developer writes need one: run /jira-dev-harness:implement again";
    }
    const w = state.worktree;
    const active = activeBinding(dataDir, state.site, state.issueKey);
    if (!active || active.n !== w.binding || !active.record || active.record.hmac !== w.hmac) {
      return "the ticket's worktree binding changed since implementation was authorized; run /jira-dev-harness:implement again";
    }
    const { binding, problems } = verify(dataDir, state.site, state.issueKey, state.repo.root);
    if (problems.length) return `the ticket worktree failed verification: ${problems.join("; ")}`;
    if (!samePath(binding.path, w.path)) return "the session's worktree path differs from the signed binding";
    return null;
  } catch (e) {
    return e.message;
  }
}

// Ignored top-level entries of the main checkout that are missing in the
// worktree (dependency folders, local configuration). Report only: nothing
// is copied, linked, or installed.
function dependencyReport(mainRoot, worktreePath) {
  let entries;
  try {
    entries = statusEntries(mainRoot, ["--ignored", "--untracked-files=normal"]);
  } catch {
    return { missing: [], sensitive: [] };
  }
  const tops = new Set();
  for (const e of entries) {
    if (e.code !== "!!") continue;
    tops.add(e.path.split("/")[0] + (e.path.includes("/") ? "/" : ""));
  }
  const missing = [...tops].filter((p) => !fs.existsSync(path.join(worktreePath, p))).sort();
  return { missing, sensitive: missing.filter((p) => SENSITIVE_FILE.test(p.replace(/\/$/, ""))) };
}

// ------------------------------------------------------------------- create

function acquireLock(dataDir, site, key) {
  const { locks } = dirs(dataDir);
  fs.mkdirSync(locks, { recursive: true });
  const file = path.join(locks, `${recordName(site, key)}.lock`);
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    fail(`another worktree operation for ${key} is in progress (lock ${slash(file)}). Nothing was changed. If no other command is running, the lock is left over from an interrupted run: delete that file yourself, then run the command again`);
  }
  return () => fs.rmSync(file, { force: true });
}

// An empty directory owned by the plugin, used as core.hooksPath so that no
// repository hook runs during creation. Refused if anything appears in it.
function emptyHooksDir(dataDir) {
  const { hooks } = dirs(dataDir);
  fs.mkdirSync(hooks, { recursive: true });
  if (fs.readdirSync(hooks).length) fail(`${slash(hooks)} must be empty; something was placed in it. Nothing was changed`);
  return slash(hooks);
}

// Null when `base` is a full commit id that exists in the repository at
// `root` and whose history starts at the repository identity's root commits;
// otherwise the reason it is not a valid base.
function baseProblem(root, repo, base) {
  if (!COMMIT_RE.test(base || "")) return `the base commit "${printable(String(base))}" is not a full commit id`;
  if (run(root, ["cat-file", "-e", `${base}^{commit}`]).status !== 0) return `the base commit ${base} does not exist in ${slash(root)}`;
  const roots = run(root, ["rev-list", "--max-parents=0", base]);
  const allowed = new Set(String(repo.rootCommits).split(","));
  if (roots.status !== 0 || !roots.stdout || roots.stdout.split(/\s+/).some((c) => !allowed.has(c))) {
    return `the base commit ${base} is not part of this repository's history (its root commits differ from the repository identity)`;
  }
  return null;
}

// The base commit of the ticket's latest approved revision, taken from the
// signed approval (plan-r<N>.json is not signed, so it must agree with it).
// Throws for a legacy approval without a base: a new revision and approval
// are needed before a worktree can be created.
function approvedBase(dataDir, site, key, mainRoot) {
  const { t, s, repo } = L.verifyApproved(dataDir, `${site}/${key}`, mainRoot);
  const base = s.approval.baseHead;
  if (!COMMIT_RE.test(base || "")) {
    fail(`r${s.n} was saved or approved by an older plugin version without a recorded base commit, so it cannot authorize a worktree. Save a new plan revision and approve it`);
  }
  if (!s.meta || s.meta.baseHead !== base) {
    fail(`the base commit in plan-r${s.n}.json does not match the signed approval (${base}). Save a new plan revision and approve it`);
  }
  const problem = baseProblem(mainRoot, repo, base);
  if (problem) fail(problem);
  return { t, s, repo, base };
}

// Creates the ticket's worktree. Every check runs before git does, and each
// refusal leaves the main checkout, branches, and filesystem unchanged.
//
// opts: { site, key, revision, planSha256, baseHead?, plannedFiles, mainRoot }
// The base commit comes from the signed approval; a given `baseHead` must
// equal it. The caller has verified the approval; it is verified again here.
function create(dataDir, opts) {
  dataDir = L.checkDataDir(dataDir);
  const { site, key, revision, planSha256, plannedFiles = [] } = opts;
  L.checkTicket(site, key);
  const main = checkMainRoot(opts.mainRoot);

  const { s, repo, base: baseHead } = approvedBase(dataDir, site, key, main.root);
  if (s.n !== revision || s.actualHash !== planSha256) fail(`r${revision} is not the latest approved revision (latest is r${s.n})`);
  if (opts.baseHead !== undefined && opts.baseHead !== baseHead) fail(`the approved base commit is ${baseHead}, not ${printable(String(opts.baseHead))}`);

  const release = acquireLock(dataDir, site, key);
  try {
    const existing = activeBinding(dataDir, site, key);
    if (existing) fail(`${key} already has a worktree binding (worktree-b${existing.n}.json). Nothing was changed`);

    const head = runOrFail(main.root, ["rev-parse", "HEAD"], "reading HEAD");
    if (head !== baseHead) {
      fail(`the main checkout is at ${head}, but the plan was approved for base ${baseHead}. Nothing was changed. Check out the base commit or plan the ticket again; the worktree is never rebased`);
    }
    const changes = mainChanges(main.root, plannedFiles);
    if (changes.relevant.length) {
      fail(`uncommitted changes in the main checkout touch the plan's files and would be missing from the worktree:\n${changes.relevant.map((l) => `  ${l}`).join("\n")}\nNothing was changed. Commit or stash them yourself, then run the command again`);
    }
    const branch = branchFor(key);
    if (branchExists(main.root, branch)) fail(`branch ${branch} already exists. Nothing was changed. The plugin creates this branch itself and never reuses one it did not create`);
    const target = pathFor(main.root, key);
    const collision = collisionProblem(target.parent, target.name);
    if (collision) fail(collision);
    const lp = longPathProblem({
      worktreePath: target.path,
      longpaths: gitBool(main.root, "core.longpaths"),
      longestTracked: longestTrackedPath(main.root, baseHead),
    });
    if (lp) fail(lp);
    const warnings = [];
    if (changes.other.length) warnings.push(`the main checkout has ${changes.other.length} other uncommitted change(s); they stay there and are not in the worktree`);
    const nested = nestedRepoWarning(target.parent);
    if (nested) warnings.push(nested);
    const filters = filterReport(main.root, baseHead);
    const hooks = emptyHooksDir(dataDir);

    const add = run(main.root, ["-c", `core.hooksPath=${hooks}`, "worktree", "add", "-b", branch, target.path, baseHead]);
    if (add.status !== 0) fail(`git worktree add failed: ${add.stderr || `git exited ${add.status}`}`);

    // Post-creation checks: a real directory at the expected path.
    const st = fs.lstatSync(target.path);
    if (st.isSymbolicLink() || !st.isDirectory() || !samePath(real(target.path), target.path)) {
      fail(`${target.path} is not a plain directory after creation. The worktree was left in place for you to inspect; no binding was written`);
    }
    const created = runOrFail(target.path, ["rev-parse", "HEAD"], "reading the worktree HEAD");
    if (created !== baseHead) fail(`the new worktree is at ${created}, not ${baseHead}. It was left in place for you to inspect; no binding was written`);

    const n = (bindingNumbers(dataDir, site, key).pop() || 0) + 1;
    const record = {
      kind: "worktree-binding",
      issueKey: key,
      site,
      binding: n,
      planRevision: revision,
      planSha256,
      baseHead,
      branch,
      path: target.path,
      commonDir: main.commonDir,
      primary: repo,
      createdAt: new Date().toISOString(),
    };
    record.hmac = L.sign(record, L.approvalKey(dataDir, true));
    const file = path.join(ticketDir(dataDir, site, key), `worktree-b${n}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });

    fs.mkdirSync(dirs(dataDir).registry, { recursive: true });
    fs.writeFileSync(registryFile(dataDir, site, key), JSON.stringify({ site, issueKey: key, path: target.path, binding: n }, null, 2) + "\n");

    return { created: true, binding: record, file: slash(file), warnings, filters, dependencies: dependencyReport(main.root, target.path) };
  } finally {
    release();
  }
}

// Reuses the ticket's verified worktree, or creates it. Reuse requires the
// same approved base commit (decision: replanning after a FAIL reuses the
// worktree only for the same base).
function ensure(dataDir, opts) {
  dataDir = L.checkDataDir(dataDir);
  const { site, key } = opts;
  L.checkTicket(site, key);
  if (!activeBinding(dataDir, site, key)) return create(dataDir, opts);
  const main = checkMainRoot(opts.mainRoot);
  const { s, base: baseHead } = approvedBase(dataDir, site, key, main.root);
  if (s.n !== opts.revision || s.actualHash !== opts.planSha256) fail(`r${opts.revision} is not the latest approved revision (latest is r${s.n})`);
  const { binding, problems } = verify(dataDir, site, key, main.root);
  if (problems.length) fail(`the worktree for ${key} failed verification:\n${problems.map((p) => `  - ${p}`).join("\n")}\nNothing was changed`);
  if (binding.baseHead !== baseHead) {
    fail(`the existing worktree for ${key} is based on ${binding.baseHead}, but the approved plan is based on ${baseHead}. Nothing was changed. Remove the worktree with /jira-dev-harness:worktree-remove ${key} first, or plan against its base`);
  }
  return { created: false, binding, warnings: [], filters: [], dependencies: dependencyReport(main.root, binding.path) };
}

// ------------------------------------------------------------------ removal
//
// /jira-dev-harness:worktree-remove (user-only). A worktree is never removed
// automatically. Removal runs `git worktree remove` without --force, so git
// itself refuses tracked or untracked changes; this code refuses them first,
// together with unpushed commits, active sessions, and sensitive ignored
// files. Other ignored files (dependencies, build output) are listed, and
// removed only after the developer confirmed their exact count, and only if
// the exact set is unchanged since it was listed. The ticket branch is kept,
// nothing is pruned, and a signed removal record closes the binding.

// Every ignored file in the worktree, individually (directories expanded).
function ignoredFiles(root) {
  return statusEntries(root, ["--ignored=traditional", "--untracked-files=all"])
    .filter((e) => e.code === "!!").map((e) => e.path).sort();
}

// Fingerprint of the exact ignored-file set: each path with its size and
// modification time (lstat, never following links), so that a file whose
// content changed after the listing is noticed without hashing large
// dependency trees.
function fingerprint(files, root) {
  const parts = files.map((f) => {
    if (!root) return f;
    try {
      const st = fs.lstatSync(path.join(root, f));
      return `${f}\u0001${st.size}\u0001${Math.trunc(st.mtimeMs)}`;
    } catch {
      return `${f}\u0001missing`;
    }
  });
  return L.sha256Of(parts.join("\0"));
}

// Symbolic links and junctions anywhere in the worktree (outside .git), found
// without following any of them. `git worktree remove` deletes ignored and
// untracked content recursively and follows an ignored junction into its
// target (verified on Windows with git 2.53: the target's files outside the
// worktree were deleted). Tracked symlinks (mode 120000) are repository
// content and are excluded.
function untrackedLinks(root) {
  const tracked = new Set();
  const ls = run(root, ["ls-files", "-s", "-z"], { binary: true });
  if (ls.status === 0) {
    for (const entry of ls.stdout.toString("utf8").split("\0")) {
      const m = /^120000 [0-9a-f]+ [0-9]+\t(.+)$/.exec(entry);
      if (m) tracked.add(m[1]);
    }
  }
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!rel && e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) {
        if (!tracked.has(r)) out.push(r);
      } else if (st.isDirectory()) {
        walk(abs, r);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

// Sessions that still act on the ticket: implementing or reviewing, or
// shipping before a pull request was recorded. Merge and Jira sync sessions
// do not need the worktree.
function activeTicketSessions(dataDir, site, key, exceptSession) {
  const dir = path.join(dataDir, "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => L.readJson(path.join(dir, f)))
    .filter((s) => s && s.issueKey === key && s.site === site && s.sessionId !== exceptSession)
    .filter((s) => s.mode === "implementing" || s.mode === "reviewing" || (s.mode === "shipping" && s.stage !== "pr-created"))
    .map((s) => ({ sessionId: s.sessionId, mode: s.mode, stage: s.stage || null }));
}

function previewFile(dataDir, site, key) {
  return path.join(dirs(dataDir).base, "removal-previews", `${recordName(site, key)}.json`);
}

// Everything removal depends on, read-only. `problems` lists every reason it
// is refused now (except the ignored-file confirmation, handled separately).
function removalInspection(dataDir, site, key, mainRoot, exceptSession) {
  const out = { binding: null, problems: [], ignored: [], sensitive: [], sessions: [], head: null, unpushed: [] };
  const v = verify(dataDir, site, key, mainRoot);
  out.binding = v.binding;
  if (!activeBinding(dataDir, site, key)) {
    out.problems.push(`${key} has no active worktree binding; nothing to remove`);
    return out;
  }
  if (v.problems.length) {
    out.problems.push(...v.problems.map((p) => `the worktree failed verification: ${p}`));
    return out;
  }
  const b = v.binding;
  out.head = runOrFail(b.path, ["rev-parse", "HEAD"], "reading the worktree HEAD");
  const changes = statusEntries(b.path, ["--untracked-files=all"]);
  if (changes.length) {
    out.problems.push(`the worktree has ${changes.length} uncommitted change(s) (tracked or untracked); commit and push them, or move them yourself: ${changes.slice(0, 10).map((e) => printable(`${e.code} ${e.path}`)).join(", ")}${changes.length > 10 ? ", ..." : ""}`);
  }
  // Commits on the ticket branch that no origin branch contains.
  const unpushed = run(b.path, ["rev-list", `${b.baseHead}..HEAD`, "--not", "--remotes=origin"]);
  out.unpushed = unpushed.status === 0 ? unpushed.stdout.split(/\s+/).filter(Boolean) : ["(unknown)"];
  if (out.unpushed.length) out.problems.push(`the ticket branch ${b.branch} has ${out.unpushed.length} commit(s) that are not on origin; push them first (/jira-dev-harness:ship)`);
  out.sessions = activeTicketSessions(dataDir, site, key, exceptSession);
  // A link or junction could make git delete files outside the worktree.
  out.links = untrackedLinks(b.path);
  if (out.links.length) {
    out.problems.push(`the worktree contains symbolic links or junctions that git's removal could follow and delete files outside the worktree through: ${out.links.slice(0, 10).map(printable).join(", ")}${out.links.length > 10 ? ", ..." : ""}. Remove those links yourself (the link only, not its target), then run the command again`);
  }
  out.ignored = ignoredFiles(b.path);
  out.sensitive = out.ignored.filter((f) => SENSITIVE_FILE.test(f));
  if (out.sensitive.length) {
    out.problems.push(`sensitive ignored files are in the worktree and would be deleted: ${out.sensitive.map(printable).join(", ")}. Move them out of the worktree yourself; the plugin never deletes them`);
  }
  return out;
}

// Removes the ticket worktree. opts: { site, key, mainRoot, sessionId,
// confirmIgnored (number or undefined), endSessions (session ids) }.
function remove(dataDir, opts) {
  dataDir = L.checkDataDir(dataDir);
  const { site, key, sessionId } = opts;
  L.checkTicket(site, key);
  const main = checkMainRoot(opts.mainRoot);
  const release = acquireLock(dataDir, site, key);
  try {
    let insp = removalInspection(dataDir, site, key, main.root, sessionId);
    const b = insp.binding;
    const endable = new Set(opts.endSessions || []);
    const blocking = insp.sessions.filter((s) => !endable.has(s.sessionId));
    if (blocking.length) {
      insp.problems.push(`active session(s) still act on ${key}: ${blocking.map((s) => `${s.sessionId} (${s.mode}${s.stage ? `, ${s.stage}` : ""})`).join(", ")}. Finish or close them, then end them explicitly with --end-session <id>`);
    }
    const unknownEnds = [...endable].filter((id) => !insp.sessions.some((s) => s.sessionId === id));
    if (unknownEnds.length) insp.problems.push(`--end-session names no active session of ${key}: ${unknownEnds.join(", ")}`);
    // A shipping session that has not recorded its pull request still has a
    // pending provider write; it is finished, never ended from here.
    const pendingShip = insp.sessions.filter((s) => endable.has(s.sessionId) && s.mode === "shipping");
    if (pendingShip.length) {
      insp.problems.push(`--end-session cannot end a shipping session before its pull request is recorded (${pendingShip.map((s) => `${s.sessionId}, ${s.stage}`).join("; ")}); finish shipping first`);
    }
    if (insp.problems.length) fail(`nothing was removed:\n${insp.problems.map((p) => `  - ${p}`).join("\n")}`);

    // Ignored files: listed first, then removed only after the developer
    // confirmed exactly this set.
    const pfile = previewFile(dataDir, site, key);
    const fp = fingerprint(insp.ignored, b.path);
    const key2 = L.approvalKey(dataDir, true);
    const writePreview = () => {
      const p = { kind: "worktree-removal-preview", site, issueKey: key, binding: b.binding, bindingHmac: b.hmac, head: insp.head, count: insp.ignored.length, fingerprint: fp, files: insp.ignored, listedAt: new Date().toISOString() };
      p.hmac = L.sign(p, key2);
      fs.mkdirSync(path.dirname(pfile), { recursive: true });
      fs.writeFileSync(pfile, JSON.stringify(p, null, 2) + "\n");
    };
    const listing = () => insp.ignored.slice(0, 50).map((f) => `  ${printable(f)}`).join("\n") + (insp.ignored.length > 50 ? `\n  ... and ${insp.ignored.length - 50} more` : "");
    if (insp.ignored.length) {
      if (opts.confirmIgnored === undefined) {
        writePreview();
        fail(`the worktree holds ${insp.ignored.length} ignored file(s) (for example dependencies or build output) that removal deletes. Nothing was removed. Review them:\n${listing()}\nTo remove the worktree with exactly these files, run again with --confirm-ignored ${insp.ignored.length}`);
      }
      const prev = L.readJson(pfile);
      const prevOk = prev && L.signatureValid(prev, key2) && prev.binding === b.binding && prev.bindingHmac === b.hmac;
      if (opts.confirmIgnored !== insp.ignored.length || !prevOk || prev.fingerprint !== fp || prev.head !== insp.head) {
        writePreview();
        fail(`the confirmed count (${opts.confirmIgnored}) does not match the ignored files listed${prevOk ? "" : " (they were not listed yet)"}, or they changed since they were listed. Nothing was removed. The current list (${insp.ignored.length} file(s)):\n${listing()}\nConfirm again with --confirm-ignored ${insp.ignored.length}`);
      }
    } else if (opts.confirmIgnored !== undefined && opts.confirmIgnored !== 0) {
      fail(`--confirm-ignored ${opts.confirmIgnored} was given, but the worktree holds no ignored files. Nothing was removed`);
    }

    // End the sessions the developer named, to the most restrictive mode.
    // Each session's previous state is kept first in sessions/history/
    // (exclusive create, never overwritten), and a session whose state
    // changed since it was inspected is not ended.
    const ended = [];
    for (const s of insp.sessions.filter((x) => endable.has(x.sessionId))) {
      const file = L.sessionFile(dataDir, s.sessionId);
      const raw = fs.readFileSync(file);
      const old = L.readJson(file) || {};
      if (old.mode !== s.mode || (old.stage || null) !== s.stage || old.issueKey !== key || old.site !== site) {
        fail(`session ${s.sessionId} changed while removal was being prepared; nothing was removed`);
      }
      const histDir = path.join(dataDir, "sessions", "history");
      fs.mkdirSync(histDir, { recursive: true });
      let kept = null;
      for (let k = 1; ; k += 1) {
        const h = path.join(histDir, `${s.sessionId}-${k}.json`);
        try {
          fs.writeFileSync(h, raw, { flag: "wx" });
          kept = slash(h);
          break;
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
      fs.writeFileSync(file, JSON.stringify({ sessionId: s.sessionId, mode: "planning", startedAt: old.startedAt || new Date().toISOString(), endedBy: "worktree-remove", endedAt: new Date().toISOString(), previousState: kept }, null, 2) + "\n");
      ended.push({ ...s, previousState: kept });
    }

    // Recheck everything immediately before git removes anything.
    insp = removalInspection(dataDir, site, key, main.root, sessionId);
    if (insp.problems.length || insp.sessions.length) {
      fail(`the worktree changed just before removal; nothing was removed:\n${[...insp.problems, ...insp.sessions.map((s) => `active session ${s.sessionId}`)].map((p) => `  - ${p}`).join("\n")}`);
    }
    if (fingerprint(insp.ignored, b.path) !== fp || insp.binding.hmac !== b.hmac) fail("the ignored files or the binding changed just before removal; nothing was removed. Run the command again to see the current list");

    const hooks = emptyHooksDir(dataDir);
    const r = run(main.root, ["-c", `core.hooksPath=${hooks}`, "worktree", "remove", b.path]);
    if (r.status !== 0) fail(`git worktree remove refused or failed (nothing is forced): ${r.stderr || `git exited ${r.status}`}`);

    let stillThere = true;
    try { fs.lstatSync(b.path); } catch { stillThere = false; }
    const listed = listWorktrees(main.root).some((w) => samePath(w.path, b.path));
    const branchKept = branchExists(main.root, b.branch);
    const pushedRef = run(main.root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b.branch}`]).stdout || null;

    const record = {
      kind: "worktree-removal",
      issueKey: key,
      site,
      binding: b.binding,
      bindingHmac: b.hmac,
      path: b.path,
      branch: b.branch,
      baseHead: b.baseHead,
      head: insp.head,
      pushed: { ref: `refs/remotes/origin/${b.branch}`, commit: pushedRef },
      branchKept,
      ignoredRemoved: { count: insp.ignored.length, fingerprint: fp },
      endedSessions: ended,
      primary: b.primary,
      removedAt: new Date().toISOString(),
      sessionId,
      method: "developer typed /jira-dev-harness:worktree-remove (Claude Code user-only skill); git worktree remove without --force",
    };
    record.hmac = L.sign(record, key2);
    const file = path.join(ticketDir(dataDir, site, key), `worktree-b${b.binding}-removed.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    fs.rmSync(registryFile(dataDir, site, key), { force: true });
    fs.rmSync(pfile, { force: true });
    return { record, file: slash(file), stillThere, listed };
  } finally {
    release();
  }
}

// True once the ticket has ever had a plugin-managed worktree. Such a ticket
// is a worktree ticket for good: no in-place (legacy) path applies to it.
function hasWorktreeHistory(dataDir, site, key) {
  return bindingNumbers(dataDir, site, key).length > 0;
}

// The ticket's latest binding when it was closed by a removal record, with
// both records and whether they verify. Used only to accept a shipped and
// removed worktree in merge verification; it never authorizes anything.
function removedBinding(dataDir, site, key) {
  const ns = bindingNumbers(dataDir, site, key);
  if (!ns.length) return null;
  const n = ns[ns.length - 1];
  const dir = ticketDir(dataDir, site, key);
  const removalFile = path.join(dir, `worktree-b${n}-removed.json`);
  if (!fs.existsSync(removalFile)) return null;
  const k = L.approvalKey(dataDir, false);
  const binding = L.readJson(path.join(dir, `worktree-b${n}.json`));
  const removal = L.readJson(removalFile);
  const valid = !!binding && !!removal && L.signatureValid(binding, k) && L.signatureValid(removal, k)
    && binding.kind === "worktree-binding" && removal.kind === "worktree-removal"
    && binding.binding === n && removal.binding === n && removal.bindingHmac === binding.hmac
    && removal.issueKey === key && removal.site === site && binding.issueKey === key && binding.site === site;
  return { n, binding, removal, valid };
}

// ------------------------------------------------------------------- status

// Text safe to print on one line: control characters (including newlines and
// terminal escape sequences) become "?". Spaces and non-ASCII are kept.
function printable(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

// Read-only summary of a ticket's plan base and worktree. It creates,
// locks, and writes nothing (git runs with GIT_OPTIONAL_LOCKS=0, so even the
// index is not refreshed). Every field is filled in as far as it can be.
function status(dataDir, site, key, mainRoot) {
  L.checkTicket(site, key);
  const out = { site, key, plan: null, expectedPath: null, binding: null, problems: [] };
  const t = { site, key, dir: ticketDir(dataDir, site, key) };
  const s = fs.existsSync(t.dir) ? L.latestState(t) : null;
  if (s) {
    let repo = null;
    try { repo = L.repoIdentity(mainRoot); } catch { repo = null; }
    const approvalProblem = s.intact ? L.approvalProblem(dataDir, t, s, s.approval, repo) : "the plan file changed after it was saved";
    out.plan = {
      revision: s.n,
      savedBase: (s.meta && s.meta.baseHead) || null,
      dirtyAtSave: (s.meta && Array.isArray(s.meta.dirtyPaths)) ? s.meta.dirtyPaths.length : null,
      approved: !approvalProblem,
      approvalProblem,
      approvedBase: null,
      baseProblem: null,
    };
    if (!approvalProblem) {
      try {
        out.plan.approvedBase = approvedBase(dataDir, site, key, mainRoot).base;
      } catch (e) {
        out.plan.baseProblem = e.message;
      }
    }
  }
  try {
    out.expectedPath = pathFor(mainRoot, key).path;
  } catch (e) {
    out.problems.push(e.message);
  }
  const active = activeBinding(dataDir, site, key);
  if (!active) {
    const removed = removedBinding(dataDir, site, key);
    if (removed) {
      out.state = removed.valid ? "REMOVED" : "REMOVAL RECORD NOT VALID";
      out.binding = removed.n;
      if (removed.valid) Object.assign(out, { path: removed.removal.path, branch: removed.removal.branch, baseHead: removed.removal.baseHead, removedAt: removed.removal.removedAt, removedHead: removed.removal.head });
      return out;
    }
    out.state = "NONE";
    return out;
  }
  out.binding = active.n;
  let v;
  try {
    v = verify(dataDir, site, key, mainRoot);
  } catch (e) {
    v = { binding: null, problems: [e.message] };
  }
  out.problems.push(...v.problems);
  out.state = v.problems.length ? "NOT VERIFIED" : "VERIFIED";
  // Fields come from the signed binding only when its signature is valid.
  const b = v.binding && L.signatureValid(v.binding, L.approvalKey(dataDir, false)) ? v.binding : null;
  if (b) {
    Object.assign(out, { path: b.path, branch: b.branch, baseHead: b.baseHead, planRevision: b.planRevision, createdAt: b.createdAt });
  }
  if (b && out.state === "VERIFIED") {
    out.head = run(b.path, ["rev-parse", "HEAD"]).stdout || null;
    const count = run(b.path, ["rev-list", "--count", `${b.baseHead}..HEAD`]);
    out.commitsSinceBase = count.status === 0 ? Number(count.stdout) : null;
    try {
      const entries = statusEntries(b.path, ["--untracked-files=all"]);
      out.uncommitted = entries.length;
      out.changes = entries.map((e) => `${e.code} ${e.orig ? `${e.orig} -> ` : ""}${e.path}`);
    } catch {
      out.uncommitted = null;
      out.changes = [];
    }
    const log = run(b.path, ["log", "--format=%H %s", `${b.baseHead}..HEAD`]);
    out.commits = log.status === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : [];
    // Every path the earlier work touched: uncommitted (both sides of a
    // rename) and changed by commits since the base.
    const touched = new Set();
    try {
      for (const e of statusEntries(b.path, ["--untracked-files=all"])) {
        touched.add(e.path);
        if (e.orig) touched.add(e.orig);
      }
    } catch { /* reported as unknown above */ }
    const diff = run(b.path, ["diff", "--name-only", "-z", `${b.baseHead}..HEAD`], { binary: true });
    if (diff.status === 0) for (const p of diff.stdout.toString("utf8").split("\0").filter(Boolean)) touched.add(p);
    out.touchedPaths = [...touched].sort();
    if (out.plan && out.plan.approvedBase && out.plan.approvedBase !== b.baseHead) {
      out.problems.push(`the worktree is based on ${b.baseHead}, but the latest approved plan r${out.plan.revision} is based on ${out.plan.approvedBase}; it would not be reused`);
    }
  }
  return out;
}

module.exports = {
  SENSITIVE_FILE, WIN_MAX_PATH, COMMIT_RE, branchFor, samePath, printable,
  checkMainRoot, pathFor, collisionProblem, longPathProblem, nestedRepoWarning,
  statusEntries, dirtyPaths, mainChanges, filterReport, parseWorktreeList, listWorktrees,
  activeBinding, registryFile, registeredPaths, verify, primaryCwd, sessionWorktreeProblem, dependencyReport,
  baseProblem, approvedBase, create, ensure, status,
  ignoredFiles, fingerprint, untrackedLinks, activeTicketSessions, removalInspection, remove, removedBinding, previewFile, hasWorktreeHistory,
};
