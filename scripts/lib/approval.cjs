// Shared plan-store and approval logic for plan-store.cjs and guard.cjs, so
// that the guard re-verifies an implementation authorization with exactly the
// same checks that granted it.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SITE_RE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const KEY_RE = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
const REV_RE = /^r?([0-9]+)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READINESS_RE = /^\s*(?:\*\*)?Readiness:(?:\*\*)?\s*(READY|BLOCKED)\b/m;

const TEMP_ROOT = path.join(os.tmpdir(), "jira-dev-harness");
const DRAFTS_ROOT = path.join(TEMP_ROOT, "drafts");
const ATTACH_ROOT = path.join(TEMP_ROOT, "attachments");
const MAPPING_FILE = ".claude/jira-dev-harness.json";

class StoreError extends Error {}

function fail(message) {
  throw new StoreError(message);
}

function sha256Of(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256(file) {
  return sha256Of(fs.readFileSync(file));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function checkDataDir(dataDir) {
  if (!dataDir || dataDir.includes("${") || !path.isAbsolute(dataDir)) {
    fail(`plugin data directory is not an absolute path: ${dataDir}`);
  }
  return path.resolve(dataDir);
}

function checkTicket(site, key) {
  if (!SITE_RE.test(site || "")) fail(`invalid Jira site: ${site}`);
  if (!KEY_RE.test(key || "")) fail(`invalid issue key: ${key}`);
}

// ---------------------------------------------------------------- repository

function git(args, cwd, options = {}) {
  const out = execFileSync("git", args, {
    cwd,
    encoding: options.binary ? "buffer" : "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return options.binary ? out : out.trim();
}

// `git status --porcelain` lines ("XY path", or "XY orig -> path" for a
// rename or copy). Leading spaces are significant (" M" vs "M "), so the
// lines are never trimmed. Read from NUL-delimited output, so a path with
// spaces, quotes, or non-ASCII characters is exact: the plain format quotes
// and octal-escapes such paths.
function gitStatus(root) {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  const tokens = out.split("\0");
  const lines = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.length < 4) continue;
    const code = t.slice(0, 2);
    // With -z a rename or copy is "XY new\0orig\0".
    if (/[RC]/.test(code)) lines.push(`${code} ${tokens[(i += 1)]} -> ${t.slice(3)}`);
    else lines.push(t);
  }
  return lines;
}

// Identity of the git repository containing `cwd`: its root path, its root
// commit(s), and its origin URL. Moving, re-cloning, or re-initialising the
// repository changes the identity, which invalidates approvals.
function repoIdentity(cwd = process.cwd()) {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    fail(`not inside a git repository: ${cwd}`);
  }
  let rootCommits = "";
  try {
    rootCommits = git(["rev-list", "--max-parents=0", "HEAD"], root).split(/\s+/).sort().join(",");
  } catch {
    fail(`the repository at ${root} has no commits`);
  }
  let remote = null;
  try {
    remote = git(["config", "--get", "remote.origin.url"], root) || null;
  } catch {
    remote = null;
  }
  // Credentials embedded in an https URL are never stored or printed.
  if (remote) remote = remote.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
  return { root: path.resolve(root).replace(/\\/g, "/"), rootCommits, remote };
}

function sameRepo(a, b) {
  if (!a || !b) return false;
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(a.root) === norm(b.root) && a.rootCommits === b.rootCommits && (a.remote || null) === (b.remote || null);
}

function describeRepo(r) {
  return `${r.root} (root commit ${r.rootCommits.slice(0, 12)}, origin ${r.remote || "none"})`;
}

// The committed mapping must still exist, be unmodified, and cover the ticket.
function checkMapping(root, site, key) {
  try {
    git(["ls-files", "--error-unmatch", MAPPING_FILE], root);
  } catch {
    fail(`${MAPPING_FILE} is not tracked by git in ${root}; the repository mapping is unverified`);
  }
  if (git(["status", "--porcelain", "--", MAPPING_FILE], root)) {
    fail(`${MAPPING_FILE} has uncommitted changes; the repository mapping is unverified`);
  }
  const mapping = readJson(path.join(root, MAPPING_FILE));
  const projectKey = key.replace(/-[0-9]+$/, "");
  if (!mapping || !mapping.jira || mapping.jira.site !== site || !Array.isArray(mapping.jira.projectKeys)
      || !mapping.jira.projectKeys.includes(projectKey)) {
    fail(`${MAPPING_FILE} does not map ${site} project ${projectKey} to this repository`);
  }
}

// ------------------------------------------------------------- approval HMAC

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function approvalKey(dataDir, create) {
  const file = path.join(dataDir, "keys", "approval.key");
  if (!fs.existsSync(file)) {
    if (!create) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  return fs.readFileSync(file, "utf8").trim();
}

function sign(record, key) {
  const { hmac, ...body } = record;
  return crypto.createHmac("sha256", key).update(canonical(body)).digest("hex");
}

function signatureValid(record, key) {
  if (!record || !key || typeof record.hmac !== "string" || !/^[0-9a-f]{64}$/.test(record.hmac)) return false;
  return crypto.timingSafeEqual(Buffer.from(record.hmac, "hex"), Buffer.from(sign(record, key), "hex"));
}

// -------------------------------------------------------------------- plans

// Resolves "KEY" or "site/KEY" to the one matching ticket directory.
function findTicketDir(dataDir, ref) {
  const plansRoot = path.join(dataDir, "plans");
  let site = null;
  let key = ref;
  if (ref && ref.includes("/")) [site, key] = ref.split("/");
  if (!KEY_RE.test(key || "")) fail(`invalid issue key: ${key}`);
  if (site !== null && !SITE_RE.test(site)) fail(`invalid Jira site: ${site}`);

  const sites = site !== null
    ? [site]
    : (fs.existsSync(plansRoot) ? fs.readdirSync(plansRoot).filter((s) => SITE_RE.test(s)) : []);
  const matches = sites
    .map((s) => ({ site: s, key, dir: path.join(plansRoot, s, key) }))
    .filter((m) => fs.existsSync(m.dir));
  if (matches.length === 0) fail(`no saved plan found for ${ref}`);
  if (matches.length > 1) {
    fail(`${key} has plans on several sites; use one of: ${matches.map((m) => `${m.site}/${key}`).join(", ")}`);
  }
  return matches[0];
}

function revisions(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => /^plan-r([0-9]+)\.md$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

// State of the latest revision. The plan file is re-hashed, so any edit made
// after saving or approving is detected.
function latestState(t) {
  const revs = revisions(t.dir);
  if (revs.length === 0) return null;
  const n = revs[revs.length - 1];
  const planFile = path.join(t.dir, `plan-r${n}.md`);
  const meta = readJson(path.join(t.dir, `plan-r${n}.json`));
  const approval = readJson(path.join(t.dir, `approval-r${n}.json`));
  const actualHash = sha256(planFile);
  const intact = !!meta && meta.sha256 === actualHash;
  const earlierApprovals = revs.filter((r) => r < n && fs.existsSync(path.join(t.dir, `approval-r${r}.json`)));
  return { n, planFile, meta, approval, actualHash, intact, earlierApprovals };
}

// Checks one approval record against everything it must be bound to.
// Returns null when valid, otherwise the reason it is not.
function approvalProblem(dataDir, t, s, approval, repo) {
  if (!approval) return "no approval record";
  if (!signatureValid(approval, approvalKey(dataDir, false))) {
    return "the approval record's signature is missing or invalid (fabricated, edited, or from an older plugin version)";
  }
  if (approval.issueKey !== t.key || approval.site !== t.site) return "the approval is for a different ticket";
  if (approval.revision !== s.n) return `the approval is for r${approval.revision}, not the latest revision r${s.n}`;
  if (approval.sha256 !== s.actualHash) return "the approval's SHA-256 does not match the plan file";
  if (repo && !sameRepo(approval.repo, repo)) return "the approval was given for a different repository";
  return null;
}

// Full check that a ticket's latest revision is approved for the repository
// at `cwd`. Returns { t, s, repo } or throws a StoreError with the reason.
function verifyApproved(dataDir, ref, cwd) {
  const t = findTicketDir(dataDir, ref);
  const s = latestState(t);
  if (!s) fail(`no saved plan revision found for ${ref}`);
  if (!s.intact) fail(`plan-r${s.n}.md changed after it was saved`);
  if (!s.meta || s.meta.readiness !== "READY") fail(`r${s.n} is not READY`);
  const repo = repoIdentity(cwd);
  if (s.meta.repo && !sameRepo(s.meta.repo, repo)) {
    fail(`r${s.n} was planned for ${describeRepo(s.meta.repo)}, not ${describeRepo(repo)}`);
  }
  checkMapping(repo.root, t.site, t.key);
  const problem = approvalProblem(dataDir, t, s, s.approval, repo);
  if (problem) fail(problem);
  return { t, s, repo };
}

// Re-verifies an implementing session's authorization: the approval it was
// granted for must still be the valid approval of the latest revision, in the
// same repository. Returns null when valid, otherwise the reason.
function implementationProblem(dataDir, state) {
  try {
    if (!state || state.mode !== "implementing") return "no implementation is authorized in this session";
    const latest = latestState(findTicketDir(dataDir, `${state.site}/${state.issueKey}`));
    if (latest && latest.n !== state.revision) {
      return `the plan changed: r${latest.n} replaced the authorized r${state.revision}. Review r${latest.n}, approve it, and run /jira-dev-harness:implement again`;
    }
    const { s, repo } = verifyApproved(dataDir, `${state.site}/${state.issueKey}`, state.repo.root);
    if (s.n !== state.revision || s.actualHash !== state.sha256) {
      return `the authorized plan r${state.revision} is no longer the latest approved revision (latest is r${s.n}); a fresh approval and /jira-dev-harness:implement are required`;
    }
    if (!sameRepo(repo, state.repo)) return "the repository identity changed since implementation was authorized";
    return null;
  } catch (e) {
    return e.message;
  }
}

function sessionFile(dataDir, sessionId) {
  return path.join(dataDir, "sessions", `${sessionId}.json`);
}

module.exports = {
  SITE_RE, KEY_RE, REV_RE, SHA256_RE, SESSION_RE, READINESS_RE,
  TEMP_ROOT, DRAFTS_ROOT, ATTACH_ROOT, MAPPING_FILE,
  StoreError, fail, sha256, sha256Of, readJson, checkDataDir, checkTicket,
  git, gitStatus, repoIdentity, sameRepo, describeRepo, checkMapping,
  approvalKey, sign, signatureValid,
  findTicketDir, revisions, latestState, approvalProblem, verifyApproved, implementationProblem,
  sessionFile,
};
