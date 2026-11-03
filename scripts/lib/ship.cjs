// The shipping workflow: commit the approved changes on a ticket branch, push
// that branch, and open a pull request. It never merges.
//
// Every step re-verifies the whole gate chain (approved plan, current PASS
// review, developer approval of that review, unchanged tree) before it
// touches git or the hosting provider. Git state changes are done here, with
// fixed arguments, rather than by free-form commands from Claude.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./approval.cjs");
const R = require("./review.cjs");
const RA = require("./review-approval.cjs");
const P = require("./provider.cjs");

const { fail } = L;

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
// Names that are never pushed to, in addition to the repository's default branch.
const PROTECTED_BRANCH = /^(main|master|develop|development|dev|trunk|prod|production|stable|staging|release([/-].*)?)$/i;
const SENSITIVE_FILE = /(^|\/)(\.env(\..*)?|id_rsa[^/]*|id_ed25519[^/]*|id_ecdsa[^/]*|.*\.(pem|p12|pfx|keystore|jks)|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$/i;
const SECRET_LINE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

function run(root, args, options = {}) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout || 10 * 60 * 1000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: R.redact(r.stderr || "").trim(), out: R.redact(`${r.stdout || ""}${r.stderr || ""}`).trim() };
}

function runOrFail(root, args, what) {
  const r = run(root, args);
  if (r.status !== 0) fail(`${what} failed: ${r.out || `git exited ${r.status}`}`);
  return r.stdout;
}

const currentBranch = (root) => run(root, ["branch", "--show-current"]).stdout;

function defaultBranch(root) {
  const r = run(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return r.status === 0 && r.stdout.startsWith("origin/") ? r.stdout.slice("origin/".length) : null;
}

function protectedProblem(branch, base) {
  if (branch === base) return `${branch} is the repository's default branch`;
  if (PROTECTED_BRANCH.test(branch)) return `${branch} is a conventional protected branch name`;
  return null;
}

function requireShipping(state, ...stages) {
  if (!state || state.mode !== "shipping") fail("this session has no shipping authorization; the developer must run /jira-dev-harness:ship");
  if (stages.length && !stages.includes(state.stage)) fail(`this step needs stage ${stages.join(" or ")}, but the session is at "${state.stage}"`);
}

// -------------------------------------------------------------------- start

// Verifies the gates for a review the developer has approved, and returns
// the shipping state for this session. Changes nothing in git.
function start(dataDir, sessionId, ref, reviewId, hash, options, cwd) {
  if (!L.SESSION_RE.test(sessionId || "")) fail("the session could not be identified");
  hash = (hash || "").toLowerCase();
  if (!L.SHA256_RE.test(hash)) fail("give the review's full 64-character SHA-256");
  const v = RA.verifyReview(dataDir, ref, reviewId, cwd, { requireRecord: true, checkTree: true });
  if (hash !== v.fileSha256) fail(`the SHA-256 does not match ${reviewId}. Its SHA-256 is ${v.fileSha256}.`);
  const { t, s, repo, record } = v;
  const root = repo.root;

  const remote = P.parseRemote(L.git(["config", "--get", "remote.origin.url"], root));
  if (!remote) fail("the repository has no recognisable origin remote; a ticket branch can only be shipped to a hosted repository");
  if (remote.hasCredentials) fail("the origin URL contains embedded credentials. Remove them and use a credential helper or SSH, then try again");
  if (!P.detectProvider(remote, root)) {
    fail(`${remote.host} is not a supported provider. GitHub is supported; for a GitHub Enterprise host, list it under "git.githubHosts" in the committed ${L.MAPPING_FILE}`);
  }
  const base = defaultBranch(root);
  if (!base) fail('the default branch is unknown. Run "git remote set-head origin --auto" and try again');

  const current = currentBranch(root);
  let branch = options.branch;
  if (!branch) {
    branch = current && !protectedProblem(current, base) && current.toLowerCase().includes(t.key.toLowerCase())
      ? current
      : `jira/${t.key}`;
  }
  if (!BRANCH_RE.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")
      || run(root, ["check-ref-format", "--branch", branch]).status !== 0) {
    fail(`invalid branch name: ${branch}`);
  }
  const why = protectedProblem(branch, base);
  if (why) fail(`will not ship to a protected or default branch: ${why}`);
  if (!branch.toLowerCase().includes(t.key.toLowerCase())) fail(`the ticket branch name must contain ${t.key}`);
  if (branch !== current && run(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
    fail(`branch ${branch} already exists locally and is not checked out. Check it out yourself if you want to use it`);
  }

  // Changes the developer already had before implementation can't be
  // separated from the implementation inside one file, so they stop the commit.
  const files = record.changedFiles.map((f) => f.path);
  const pre = new Set((R.latestReport(t, s.n).meta.preExistingChanges || []).map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, "")));
  const overlap = files.filter((f) => pre.has(f));
  if (!files.length) fail("the approved review has no changed files to commit");
  if (overlap.length) fail(`these files already had uncommitted changes before implementation, so the commit can't be limited to the approved work: ${overlap.join(", ")}`);
  const sensitive = files.filter((f) => SENSITIVE_FILE.test(f));
  if (sensitive.length) fail(`refusing to commit files that commonly hold secrets: ${sensitive.join(", ")}`);

  return {
    mode: "shipping",
    stage: "started",
    issueKey: t.key,
    site: t.site,
    revision: s.n,
    sha256: s.actualHash,
    planFile: s.planFile.replace(/\\/g, "/"),
    repo,
    remote,
    base,
    branch,
    startBranch: current,
    reviewId,
    reviewSha256: v.fileSha256,
    approvedHead: record.tree.head,
    approvedFiles: record.changedFiles,
    jiraUrl: `https://${t.site}/browse/${t.key}`,
    authorizedAt: new Date().toISOString(),
  };
}

// Re-verifies the gate chain for an existing shipping session. After the
// commit exists, the tree no longer matches the review by design; the commit
// itself is checked instead.
function gateProblem(dataDir, state, { tree }) {
  try {
    if (!state || state.mode !== "shipping") return "no shipping authorization in this session";
    const v = RA.verifyReview(dataDir, `${state.site}/${state.issueKey}`, state.reviewId, state.repo.root, { requireRecord: true, checkTree: tree });
    if (v.fileSha256 !== state.reviewSha256) return "the review is not the one that was authorized for shipping";
    if (!L.sameRepo(v.repo, state.repo)) return "the repository identity changed";
    return null;
  } catch (e) {
    return e.message;
  }
}

function checkMessage(text, state) {
  const msg = String(text).replace(/\r\n/g, "\n").trim();
  if (!msg) fail("the commit message is empty");
  const subject = msg.split("\n")[0];
  if (subject.length > 200) fail("the commit message's first line is longer than 200 characters");
  if (!msg.includes(state.issueKey)) fail(`the commit message must mention ${state.issueKey}`);
  if (R.redact(msg) !== msg) fail("the commit message appears to contain a credential");
  return `${msg}\n`;
}

function addedLinesWithSecrets(diff) {
  return diff.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++") && SECRET_LINE.test(l)).length;
}

// ------------------------------------------------------------------- commit

function commit(dataDir, state, messageText) {
  requireShipping(state, "started");
  const problem = gateProblem(dataDir, state, { tree: true });
  if (problem) fail(`commit refused: ${problem}`);
  const root = state.repo.root;
  const message = checkMessage(messageText, state);
  const why = protectedProblem(state.branch, state.base);
  if (why) fail(`will not commit for a protected or default branch: ${why}`);

  if (run(root, ["diff", "--cached", "--name-only"]).stdout) {
    fail("the index already has staged changes; unstage them (git restore --staged .) so that only the approved files are committed");
  }
  const files = state.approvedFiles.map((f) => f.path);
  const head = runOrFail(root, ["rev-parse", "HEAD"], "reading HEAD");
  if (head !== state.approvedHead) fail("HEAD moved since the review was approved");

  const cur = currentBranch(root);
  if (cur !== state.branch) {
    if (run(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${state.branch}`]).status === 0) {
      fail(`branch ${state.branch} already exists locally`);
    }
    runOrFail(root, ["switch", "-c", state.branch], `creating branch ${state.branch}`);
  }

  const unstage = () => run(root, ["reset", "-q", "--", ...files]);
  try {
    runOrFail(root, ["add", "--", ...files], "staging the approved files");
    const staged = run(root, ["diff", "--cached", "--name-only"]).stdout.split(/\r?\n/).filter(Boolean).sort();
    const expected = [...files].sort();
    if (JSON.stringify(staged) !== JSON.stringify(expected)) {
      fail(`the staged files differ from the approved files (staged: ${staged.join(", ") || "none"}; approved: ${expected.join(", ")})`);
    }
    const blobs = {};
    for (const f of state.approvedFiles) {
      if (f.sha256 === "-") continue;
      blobs[f.path] = runOrFail(root, ["hash-object", `--path=${f.path}`, "--", f.path], `hashing ${f.path}`);
    }
    const secrets = addedLinesWithSecrets(run(root, ["diff", "--cached", "--no-color"]).stdout);
    if (secrets) fail(`${secrets} added line(s) look like credentials or private keys; nothing was committed`);

    const msgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jdh-commit-")), "message.txt");
    fs.writeFileSync(msgFile, message);
    const c = run(root, ["commit", "-F", msgFile]);
    fs.rmSync(path.dirname(msgFile), { recursive: true, force: true });
    if (c.status !== 0) fail(`git commit failed (a commit hook may have rejected it): ${c.out}`);

    const sha = runOrFail(root, ["rev-parse", "HEAD"], "reading the new commit");
    const parent = run(root, ["rev-parse", `${sha}^`]).stdout;
    const committed = run(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).stdout.split(/\r?\n/).filter(Boolean).sort();
    const wrong = [];
    if (parent !== state.approvedHead) wrong.push("the commit's parent is not the approved HEAD");
    if (JSON.stringify(committed) !== JSON.stringify(expected)) wrong.push(`the commit contains ${committed.join(", ")}`);
    for (const f of state.approvedFiles) {
      const inCommit = run(root, ["rev-parse", "--verify", "--quiet", `${sha}:${f.path}`]);
      if (f.sha256 === "-" ? inCommit.status === 0 : inCommit.stdout !== blobs[f.path]) wrong.push(`${f.path} in the commit differs from the approved content (a hook or filter changed it)`);
    }
    if (wrong.length) {
      fail(`commit ${sha.slice(0, 12)} was created on ${state.branch} but does not match what was approved: ${wrong.join("; ")}. Nothing will be pushed. Inspect it, and undo it yourself if needed`);
    }
    return { ...state, stage: "committed", commit: sha, committedAt: new Date().toISOString(), hookOutput: c.out.split(/\r?\n/).slice(-5) };
  } catch (e) {
    unstage();
    throw e;
  }
}

// --------------------------------------------------------------------- push

function committedProblem(dataDir, state) {
  const root = state.repo.root;
  const gate = gateProblem(dataDir, state, { tree: false });
  if (gate) return gate;
  if (run(root, ["rev-parse", "HEAD"]).stdout !== state.commit) return "HEAD is no longer the commit that was made for this ticket";
  if (currentBranch(root) !== state.branch) return `the checked-out branch is not ${state.branch}`;
  return protectedProblem(state.branch, state.base);
}

function push(dataDir, state) {
  requireShipping(state, "committed");
  const problem = committedProblem(dataDir, state);
  if (problem) fail(`push refused: ${problem}`);
  const root = state.repo.root;
  const ref = `refs/heads/${state.branch}`;
  // No force, no other refspec: the new branch fast-forwards or the push fails.
  const r = run(root, ["push", "--set-upstream", "origin", `${ref}:${ref}`]);
  if (r.status !== 0) {
    fail(`git push failed: ${r.out}\nPushing needs a git transport that is already authorized on this machine (an SSH key or a credential helper). The plugin never asks for or stores credentials.`);
  }
  const remoteHead = run(root, ["ls-remote", "origin", ref]).stdout.split(/\s+/)[0];
  if (remoteHead !== state.commit) fail(`the push reported success, but origin's ${state.branch} is ${remoteHead || "missing"}, not ${state.commit}`);
  return { ...state, stage: "pushed", pushedAt: new Date().toISOString(), pushOutput: r.out.split(/\r?\n/).slice(-6) };
}

// ------------------------------------------------------------ pull request

// Turns the drafted title and body into the exact text that will be used.
// The Jira link and the review evidence are always added by the plugin.
function prepare(dataDir, state, draftText) {
  requireShipping(state, "pushed");
  const problem = committedProblem(dataDir, state);
  if (problem) fail(`pull request refused: ${problem}`);
  const lines = String(draftText).replace(/\r\n/g, "\n").trim().split("\n");
  let title = lines[0].replace(/^#+\s*/, "").trim();
  let body = lines.slice(1).join("\n").trim();
  if (!title) fail("the first line of the pull request draft must be its title");
  if (!title.includes(state.issueKey)) title = `${state.issueKey}: ${title}`;
  if (title.length > 250) fail("the pull request title is longer than 250 characters");
  if (R.redact(`${title}\n${body}`) !== `${title}\n${body}`) fail("the pull request text appears to contain a credential");
  if (!body.includes(state.jiraUrl)) body = `${body}\n\nJira: ${state.jiraUrl}`.trim();
  body += `\n\n---\nPlan: ${state.issueKey} r${state.revision} (${state.sha256})\nIndependent review: ${state.reviewId} PASS (${state.reviewSha256}), approved by the developer before this commit.`;
  return { ...state, prepared: { title, body, bodySha256: L.sha256Of(body) } };
}

function createWithGh(state) {
  requireShipping(state, "pushed");
  if (!state.prepared) fail("run ship-prepare-pr first so the title and body are fixed");
  const info = P.officialGh(state.repo.root, state.remote.host);
  if (!info.ok) {
    fail(`the GitHub CLI adapter is unavailable: ${info.reason}. Use your GitHub MCP connection, or open the pull request manually with the prepared title and body`);
  }
  const existing = P.GhAdapter.findPullRequest(info, state.remote, state.branch);
  if (existing) return { ...state, stage: "pr-created", pr: { url: existing.url, via: "github-cli", existing: true }, prAt: new Date().toISOString() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdh-pr-"));
  const bodyFile = path.join(dir, "body.md");
  fs.writeFileSync(bodyFile, state.prepared.body);
  try {
    const url = P.GhAdapter.createPullRequest(info, state.remote, { base: state.base, head: state.branch, title: state.prepared.title, bodyFile });
    const bad = P.prUrlProblem(state.remote, url);
    if (bad) fail(bad);
    return { ...state, stage: "pr-created", pr: { url, via: "github-cli", ghVersion: info.version }, prAt: new Date().toISOString() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Records a pull request that Claude created through the developer's GitHub
// MCP connection. The URL is Claude's report, so it is only checked for
// belonging to this repository and is labelled as reported.
function recordPr(state, url) {
  requireShipping(state, "pushed");
  if (!state.prepared) fail("no pull request text was prepared in this session");
  const bad = P.prUrlProblem(state.remote, url);
  if (bad) fail(bad);
  return { ...state, stage: "pr-created", pr: { url: url.trim(), via: "github-mcp (reported by Claude; open the link to confirm)" }, prAt: new Date().toISOString() };
}

function checks(state) {
  requireShipping(state, "pr-created");
  const info = P.officialGh(state.repo.root, state.remote.host);
  if (!info.ok) return { available: false, reason: info.reason };
  const number = Number(/\/pull\/([0-9]+)$/.exec(state.pr.url)[1]);
  return { available: true, ...P.GhAdapter.pullRequestChecks(info, state.remote, number) };
}

module.exports = {
  BRANCH_RE, protectedProblem, defaultBranch, start, gateProblem, commit, push, prepare, createWithGh, recordPr, checks, requireShipping,
};
