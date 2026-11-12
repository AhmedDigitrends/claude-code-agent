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
const W = require("./worktree.cjs");

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

// --------------------------------------------------------- workspace (8C)
//
// A ticket implemented in its own sibling worktree is shipped from that
// worktree, on its fixed branch jira/<KEY>, never from the main checkout. A
// shipping session records its layout explicitly; only a review made in place
// (by a version before Phase 8C) ships from the main checkout.

const isWorktreeState = (state) => state.layout === "worktree" || !!(state.workspace && state.workspace.kind === "worktree");

// The verified root git runs in for a shipping session. A worktree session
// re-verifies the signed binding every time and never falls back.
function workRoot(dataDir, state) {
  const t = L.findTicketDir(dataDir, `${state.site}/${state.issueKey}`);
  if (!isWorktreeState(state)) {
    // In place only for a ticket that never had a worktree.
    if (W.hasWorktreeHistory(dataDir, t.site, t.key)) fail(`${t.key} has a plugin-managed worktree, so it is never shipped from the main checkout`);
    return state.repo.root;
  }
  if (!state.workspace || state.workspace.kind !== "worktree") fail("this shipping session names a worktree but does not record it; run /jira-dev-harness:ship again");
  return R.recordedWorkspaceRoot(dataDir, t, state.workspace, state.repo);
}

// SHA-256 of the developer's review approval record, so that shipping is bound
// to the exact approval it was authorized with.
function reviewApprovalSha256(dataDir, state) {
  const file = RA.approvalFile(L.findTicketDir(dataDir, `${state.site}/${state.issueKey}`), state.reviewId);
  return fs.existsSync(file) ? L.sha256(file) : null;
}

function shipCommitRecordFile(t, reviewId, k) {
  return path.join(R.reviewsDir(t), `ship-commit-${reviewId}${k > 1 ? `-${k}` : ""}.json`);
}

// Signed record of the shipping commit made in a ticket worktree, so that the
// authorized commit is not mistaken for unreviewed work later (a re-review
// after CI feedback, for example). Never overwritten.
function writeShipCommitRecord(dataDir, state, sha, parent) {
  const t = L.findTicketDir(dataDir, `${state.site}/${state.issueKey}`);
  const record = {
    kind: "ship-commit",
    issueKey: state.issueKey,
    site: state.site,
    reviewId: state.reviewId,
    reviewSha256: state.reviewSha256,
    commit: sha,
    parent,
    branch: state.branch,
    workspace: state.workspace,
    createdAt: new Date().toISOString(),
  };
  record.hmac = L.sign(record, L.approvalKey(dataDir, true));
  for (let k = 1; ; k += 1) {
    try {
      fs.writeFileSync(shipCommitRecordFile(t, state.reviewId, k), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      return record;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

// The commit as it must be before anything reaches the provider: HEAD is the
// shipping commit, its parent is the approved HEAD, it contains exactly the
// approved files, and each file's blob is the one hashed from the reviewed
// content at commit time.
function commitContentProblem(root, state) {
  const head = run(root, ["rev-parse", "HEAD"]).stdout;
  if (head !== state.commit) return "HEAD is no longer the commit that was made for this ticket";
  if (run(root, ["rev-parse", `${state.commit}^`]).stdout !== state.approvedHead) return "the shipping commit's parent is not the approved HEAD";
  const committed = run(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", state.commit]).stdout.split(/\r?\n/).filter(Boolean).sort();
  const expected = state.approvedFiles.map((f) => f.path).sort();
  if (JSON.stringify(committed) !== JSON.stringify(expected)) return `the shipping commit contains ${committed.join(", ") || "nothing"}, not the approved files`;
  if (state.committedBlobs) {
    for (const f of state.approvedFiles) {
      const inCommit = run(root, ["rev-parse", "--verify", "--quiet", `${state.commit}:${f.path}`]);
      if (f.sha256 === "-" ? inCommit.status === 0 : inCommit.stdout !== state.committedBlobs[f.path]) {
        return `${f.path} in the shipping commit differs from the reviewed content`;
      }
    }
  }
  return null;
}

// origin must still be the remote that shipping was authorized for.
function remoteProblem(root, state) {
  const r = run(root, ["config", "--get", "remote.origin.url"]);
  const now = P.parseRemote(r.stdout);
  if (!now || now.hasCredentials) return "origin is not a supported remote without embedded credentials";
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!same(now.host, state.remote.host) || !same(now.owner, state.remote.owner) || !same(now.name, state.remote.name)) {
    return `origin changed since shipping was authorized (now ${now.host}/${now.owner}/${now.name}, authorized ${state.remote.host}/${state.remote.owner}/${state.remote.name})`;
  }
  // `git push origin` uses remote.origin.pushurl when it is set, so it must
  // name the same repository too.
  const pushUrls = run(root, ["config", "--get-all", "remote.origin.pushurl"]).stdout.split(/\r?\n/).filter(Boolean);
  for (const u of pushUrls) {
    const p = P.parseRemote(u);
    if (!p || p.hasCredentials || !same(p.host, state.remote.host) || !same(p.owner, state.remote.owner) || !same(p.name, state.remote.name)) {
      return "origin's push URL (remote.origin.pushurl) does not point to the authorized repository";
    }
  }
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
  // Phase 8C: a worktree review ships from the verified worktree (resolved
  // through the signed binding by verifyReview); only an in-place review
  // ships from the main checkout.
  const worktree = v.workspace.kind === "worktree";
  if (worktree && !v.workspaceRoot) fail("the ticket worktree could not be verified; nothing was changed");
  if (worktree && options.branch) {
    fail(`--branch is not allowed for a ticket worktree: ${t.key} ships on its fixed branch ${v.workspace.branch}`);
  }
  const root = worktree ? v.workspaceRoot : repo.root;

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
  if (worktree) {
    // The worktree's own branch, created with it; never created or switched here.
    branch = v.workspace.branch;
    if (branch !== `jira/${t.key}`) fail(`the worktree's recorded branch is ${branch}, not jira/${t.key}`);
    if (current !== branch) fail(`the ticket worktree has ${current || "a detached HEAD"} checked out, not ${branch}; nothing was changed`);
  } else if (!branch) {
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
  // The review's own record of them is used: in a ticket worktree there are
  // none (everything since the approved base is ticket work).
  const files = record.changedFiles.map((f) => f.path);
  const preLines = (v.review.facts && Array.isArray(v.review.facts.preExistingChanges))
    ? v.review.facts.preExistingChanges
    : (R.latestReport(t, s.n).meta.preExistingChanges || []);
  const pre = new Set(preLines.map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, "")));
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
    layout: worktree ? "worktree" : "legacy-in-place",
    workspace: v.workspace,
    remote,
    base,
    branch,
    startBranch: current,
    reviewId,
    reviewSha256: v.fileSha256,
    reviewApprovalSha256: L.sha256(RA.approvalFile(t, reviewId)),
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
    // Phase 8C: the same signed workspace and the same developer approval.
    if (isWorktreeState(state) || v.workspace.kind === "worktree") {
      if (!R.sameWorkspace(v.workspace, state.workspace)) return "the reviewed workspace is not the one shipping was authorized for";
    }
    if (state.reviewApprovalSha256 && reviewApprovalSha256(dataDir, state) !== state.reviewApprovalSha256) {
      return "the developer's review approval changed since shipping was authorized";
    }
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
  const root = workRoot(dataDir, state);
  const worktree = isWorktreeState(state);
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
  if (worktree && cur !== state.branch) {
    // A worktree ships on its own branch; shipping never creates or switches one.
    fail(`the ticket worktree has ${cur || "a detached HEAD"} checked out, not ${state.branch}; nothing was committed`);
  }
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
    // In a worktree, the authorized shipping commit is recorded (signed), so
    // that it is not mistaken for unreviewed work on the ticket branch later.
    if (worktree) writeShipCommitRecord(dataDir, state, sha, parent);
    return { ...state, stage: "committed", commit: sha, committedBlobs: blobs, committedAt: new Date().toISOString(), hookOutput: c.out.split(/\r?\n/).slice(-5) };
  } catch (e) {
    unstage();
    throw e;
  }
}

// --------------------------------------------------------------------- push

// Everything that must still hold before a push or a pull request: the gate
// chain (plan, review, the developer's review approval, the signed worktree
// binding and workspace), the branch, the shipping commit's exact content,
// and the authorized remote. Re-run before every provider write, including
// by the guard before an MCP pull request call.
function committedProblem(dataDir, state) {
  try {
    if (!state || state.mode !== "shipping") return "no shipping authorization in this session";
    if (!state.commit) return "nothing has been committed in this session";
    const gate = gateProblem(dataDir, state, { tree: false });
    if (gate) return gate;
    const root = workRoot(dataDir, state);
    if (currentBranch(root) !== state.branch) return `the checked-out branch is not ${state.branch}`;
    const content = commitContentProblem(root, state);
    if (content) return content;
    const remote = remoteProblem(root, state);
    if (remote) return remote;
    return protectedProblem(state.branch, state.base);
  } catch (e) {
    return e.message;
  }
}

function push(dataDir, state) {
  requireShipping(state, "committed");
  const problem = committedProblem(dataDir, state);
  if (problem) fail(`push refused: ${problem}`);
  const root = workRoot(dataDir, state);
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
// `reviewShareUrl`: a recorded, verified claude.ai artifact URL of the
// review's sanitized share view, or null. It is quoted, never invented.
function prepare(dataDir, state, draftText, reviewShareUrl = null) {
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
  if (reviewShareUrl) body += `\nReview report (read-only copy): ${reviewShareUrl}`;
  return { ...state, prepared: { title, body, bodySha256: L.sha256Of(body) } };
}

function createWithGh(dataDir, state) {
  requireShipping(state, "pushed");
  if (!state.prepared) fail("run ship-prepare-pr first so the title and body are fixed");
  const problem = committedProblem(dataDir, state);
  if (problem) fail(`pull request refused: ${problem}`);
  const info = P.officialGh([state.repo.root, workRoot(dataDir, state)], state.remote.host);
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
// At stage pr-created it records a correction of the pull request details,
// which merge.cjs appends as a new signed ship record revision (the earlier
// record is never overwritten).
function recordPr(dataDir, state, url) {
  requireShipping(state, "pushed", "pr-created");
  if (!state.prepared) fail("no pull request text was prepared in this session");
  const problem = committedProblem(dataDir, state);
  if (problem) fail(`recording the pull request refused: ${problem}`);
  const bad = P.prUrlProblem(state.remote, url);
  if (bad) fail(bad);
  const correction = state.stage === "pr-created";
  return {
    ...state,
    stage: "pr-created",
    pr: { url: url.trim(), via: "github-mcp (reported by Claude; open the link to confirm)", ...(correction ? { correctionOf: state.pr && state.pr.url } : {}) },
    prAt: new Date().toISOString(),
  };
}

function checks(state) {
  requireShipping(state, "pr-created");
  const info = P.officialGh([state.repo.root, state.workspace && state.workspace.path].filter(Boolean), state.remote.host);
  if (!info.ok) return { available: false, reason: info.reason };
  const number = Number(/\/pull\/([0-9]+)$/.exec(state.pr.url)[1]);
  return { available: true, ...P.GhAdapter.pullRequestChecks(info, state.remote, number) };
}

module.exports = {
  BRANCH_RE, protectedProblem, defaultBranch, start, gateProblem, committedProblem, commit, push, prepare, createWithGh, recordPr, checks, requireShipping,
  isWorktreeState, workRoot,
};
