#!/usr/bin/env node
// jira-dev-harness plan store.
//
// Stores ticket plans as immutable revisions outside the application
// repository, records workflow sessions, records the developer's approval of
// one exact plan revision, authorizes implementation, and stores
// implementation reports.
//
// Layout under <dataDir>:
//   plans/<site>/<ISSUE-KEY>/plan-r<N>.md          saved revision N (never overwritten)
//   plans/<site>/<ISSUE-KEY>/plan-r<N>.json        metadata: sha256, readiness, repository identity, base commit, uncommitted paths
//   plans/<site>/<ISSUE-KEY>/worktree-b<N>.json    signed binding of the ticket's sibling worktree (Phase 8C)
//   plans/<site>/<ISSUE-KEY>/approval-r<N>.json    approval of revision N (HMAC-signed)
//   plans/<site>/<ISSUE-KEY>/impl-r<N>-<k>.md      implementation report k for revision N
//   plans/<site>/<ISSUE-KEY>/impl-r<N>-<k>.json    report metadata: git-computed changes, diff hash
//   sessions/<session-id>.json                      workflow session state, read by guard.cjs
//   keys/approval.key                               HMAC key for approval records
//
// Claude Code treats files under ~/.claude (where plugin data lives) as
// sensitive, so skills never write there directly. They write drafts under
// <os temp>/jira-dev-harness/drafts/, and this script moves them into place.
//
// Usage (repository-dependent commands use the current directory's git repo):
//   plan-store.cjs session-start   <dataDir> <session-id>
//   plan-store.cjs implement-start <dataDir> <session-id> <ISSUE-KEY> <rN> <sha256>
//   plan-store.cjs draft-path      <site> <ISSUE-KEY> [plan|report]
//   plan-store.cjs save            <dataDir> <site> <ISSUE-KEY> <draftPath>
//   plan-store.cjs report-save     <dataDir> <session-id> <draftPath>
//   plan-store.cjs status          <dataDir> <ISSUE-KEY | site/ISSUE-KEY>
//   plan-store.cjs approve         <dataDir> <session-id> <ISSUE-KEY | site/ISSUE-KEY> <rN> <sha256>
//   plan-store.cjs verify          <dataDir> <ISSUE-KEY | site/ISSUE-KEY>
//   plan-store.cjs attach-dir
//   plan-store.cjs clean-attach    <dir>
//   plan-store.cjs review-start    <dataDir> <session-id> <ISSUE-KEY | site/ISSUE-KEY>
//   plan-store.cjs run-check       <dataDir> <session-id> <name> <required|optional> '<command>'
//   plan-store.cjs review-save     <dataDir> <session-id> <draftPath>
//   plan-store.cjs review-status   <dataDir> <ISSUE-KEY | site/ISSUE-KEY>
//   plan-store.cjs approve-review  <dataDir> <session-id> <ISSUE-KEY | site/ISSUE-KEY> <rv-N> <sha256>
//   plan-store.cjs ship-start      <dataDir> <session-id> <ISSUE-KEY | site/ISSUE-KEY> <rv-N> <sha256> [--branch <name>]
//   plan-store.cjs ship-commit     <dataDir> <session-id> <draftPath>
//   plan-store.cjs ship-push       <dataDir> <session-id>
//   plan-store.cjs ship-prepare-pr <dataDir> <session-id> <draftPath>
//   plan-store.cjs ship-pr         <dataDir> <session-id>
//   plan-store.cjs ship-record-pr  <dataDir> <session-id> <pull-request-url>
//   plan-store.cjs ship-status     <dataDir> <session-id>
//   plan-store.cjs ship-checks     <dataDir> <session-id>
//   plan-store.cjs merge-start     <dataDir> <session-id> <ISSUE-KEY | site/ISSUE-KEY> <pr-number> <head-sha> --method <squash|merge|rebase>
//   plan-store.cjs merge-collect   <dataDir> <session-id>
//   plan-store.cjs merge-verify    <dataDir> <session-id>
//   plan-store.cjs merge-run       <dataDir> <session-id>
//   plan-store.cjs merge-record    <dataDir> <session-id>
//   plan-store.cjs merge-status    <dataDir> <session-id>
//   plan-store.cjs mapping-check
//   plan-store.cjs ticket-ref      [<ticket URL | KEY>]   (read-only; no argument means: list my assigned tickets)
//   plan-store.cjs assigned-jql    [--include-done]       (prints the one discovery query)
//   plan-store.cjs mapping-status  <site> <ISSUE-KEY>     (read-only; the ticket workflow's mapping verdict)
//   plan-store.cjs worktree-status <dataDir> <ISSUE-KEY | site/ISSUE-KEY>  (read-only; Phase 8C ticket worktree)
//   plan-store.cjs worktree-remove <dataDir> <session-id> <ISSUE-KEY | site/ISSUE-KEY> [--confirm-ignored <n>] [--end-session <id>]...  (user-only skill)
//   plan-store.cjs jira-start      <dataDir> <session-id> <ISSUE-KEY | site/ISSUE-KEY> [--allow-done]
//   plan-store.cjs jira-plan       <dataDir> <session-id>
//   plan-store.cjs jira-confirm    <dataDir> <session-id>
//   plan-store.cjs jira-status     <dataDir> <session-id>
//   plan-store.cjs jira-ledger     <dataDir> <ISSUE-KEY | site/ISSUE-KEY>
//
// Reviews live under plans/<site>/<ISSUE-KEY>/reviews/: a bundle directory
// rv-<n>/ (facts.json, diff.patch, checks/C<k>.json and .log) and the
// immutable outputs review-rv-<n>.json, .html, and .md.
//
// A review approval is plans/<site>/<ISSUE-KEY>/reviews/review-approval-rv-<n>.json (HMAC-signed).
// `approve-review` and `ship-start` are run only by user-only skills. ship-commit,
// ship-push, and ship-pr are run by Claude but always need a permission prompt
// (see guard.cjs) and re-verify every gate. There is no merge command.
//
// `session-start`, `implement-start`, `review-start`, and `approve` are run only by skills
// that Claude cannot invoke (`disable-model-invocation`), through injected
// commands that run when the developer types the slash command. guard.cjs
// blocks Claude from running them through its own tools. This makes
// approvals tamper-evident, not authenticated: see README "Security model".
//
// `approve` and `implement-start` always exit 0 and print their verdict so
// that their skills can show it. `verify` exits 1 unless the latest revision
// has a valid approval for the current repository.

"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./lib/approval.cjs");
const R = require("./lib/review.cjs");
const RA = require("./lib/review-approval.cjs");
const S = require("./lib/ship.cjs");
const M = require("./lib/merge.cjs");
const JM = require("./lib/jira-mapping.cjs");
const JS = require("./lib/jira-sync.cjs");
const D = require("./lib/discover.cjs");
const P = require("./lib/progress.cjs");
const W = require("./lib/worktree.cjs");
const { renderHtml, renderMarkdown } = require("./lib/render-review.cjs");

const { fail } = L;

function draftsDir(site, key) {
  return path.join(L.DRAFTS_ROOT, site, key);
}

function checkDraft(site, key, draftFile, ext = ".md") {
  const expectedDir = draftsDir(site, key);
  const draft = path.resolve(draftFile || "");
  if (path.dirname(draft).toLowerCase() !== expectedDir.toLowerCase() || !draft.endsWith(ext)) {
    fail(`draft must be a ${ext} file directly inside ${expectedDir}`);
  }
  if (!fs.existsSync(draft)) fail(`draft not found: ${draft}`);
  return draft;
}

function readSession(dataDir, sessionId) {
  if (!L.SESSION_RE.test(sessionId || "")) fail(`invalid session id: ${sessionId}`);
  return L.readJson(L.sessionFile(dataDir, sessionId));
}

function writeSession(dataDir, state) {
  const file = L.sessionFile(dataDir, state.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  fs.rmSync(file.replace(/\.json$/, ".none"), { force: true });
}

// Writes `text` to the first free <prefix><n>.md in `dir`, never overwriting.
function claimNext(dir, prefix, first, text) {
  let n = first;
  for (;;) {
    const file = path.join(dir, `${prefix}${n}.md`);
    try {
      fs.writeFileSync(file, text, { flag: "wx" });
      return { n, file };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n += 1;
    }
  }
}

// ----------------------------------------------------------------- commands

function sessionStart([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const existing = readSession(dataDir, sessionId);
  // Always (re)enter planning mode, the most restrictive workflow mode. Any
  // implementation authorization in this session ends here.
  writeSession(dataDir, {
    sessionId,
    mode: "planning",
    startedAt: (existing && existing.startedAt) || new Date().toISOString(),
    cwd: process.cwd().replace(/\\/g, "/"),
  });
  // The marker lets guard.cjs recognise forks of this session (--fork-session).
  console.log(`JDH-WORKFLOW-SESSION:${sessionId}`);
  console.log("Workflow mode for this session: planning. Repository writes, git changes, and Jira writes are blocked for the rest of this session, including after --resume and inside subagents.");
}

function implementStart([dataDir, sessionId, ref, rev, hash, ...extra]) {
  dataDir = L.checkDataDir(dataDir);
  const usage = "Usage: /jira-dev-harness:implement <ISSUE-KEY> <rN> <full 64-character SHA-256>";
  if (extra.length) fail(`too many arguments. ${usage}`);
  if (!L.SESSION_RE.test(sessionId || "")) fail("the session could not be identified");
  const revMatch = L.REV_RE.exec(rev || "");
  if (!revMatch) fail(`invalid revision "${rev}". ${usage}`);
  hash = (hash || "").toLowerCase();
  if (!L.SHA256_RE.test(hash)) fail(`give the approved plan's full 64-character SHA-256. ${usage}`);
  const n = Number(revMatch[1]);

  const { t, s, repo } = L.verifyApproved(dataDir, ref, process.cwd());
  if (n !== s.n) fail(`r${n} is not the latest revision. The latest is r${s.n}.`);
  if (hash !== s.actualHash) fail(`the SHA-256 does not match r${n}. Its SHA-256 is ${s.actualHash}.`);

  // Phase 8C: the ticket is implemented in its own sibling worktree, created
  // from the base commit signed into the approval (a legacy approval without
  // one is refused here), or reused when it already exists for that base.
  W.approvedBase(dataDir, t.site, t.key, repo.root);
  const plannedFiles = R.plannedFiles(fs.readFileSync(s.planFile, "utf8"));
  // The main checkout's uncommitted changes, read now, right before the
  // worktree is created or reused. Changes to the plan's files would be
  // missing from the worktree, so they block; others are reported.
  const mainNow = W.mainChanges(repo.root, plannedFiles);
  if (mainNow.relevant.length) {
    fail(`uncommitted changes in the main checkout touch the plan's files and would be missing from the ticket worktree:\n${mainNow.relevant.map((l) => `  ${W.printable(l)}`).join("\n")}\nNothing was changed. Commit or stash them yourself, then run /jira-dev-harness:implement again.`);
  }
  const wt = W.ensure(dataDir, { site: t.site, key: t.key, revision: n, planSha256: s.actualHash, plannedFiles, mainRoot: repo.root });
  const b = wt.binding;
  const p = W.printable;
  const existing = readSession(dataDir, sessionId);
  const printReports = () => {
    for (const w of wt.warnings) console.log(`Warning: ${p(w)}`);
    console.log(`Uncommitted changes in the main checkout (they stay there and are not in the worktree): ${mainNow.other.length ? "" : "none"}`);
    for (const line of mainNow.other) console.log(`  ${p(line)}`);
    const missing = wt.dependencies;
    console.log(`Ignored entries of the main checkout missing in the worktree: ${missing.missing.length ? missing.missing.map(p).join(", ") : "none"}`);
    if (missing.missing.length) {
      console.log("  Nothing was copied, linked, or installed. Installing dependencies needs the developer's explicit permission.");
      if (missing.sensitive.length) console.log(`  Sensitive files are never copied by the plugin: ${missing.sensitive.map(p).join(", ")}`);
    }
    for (const f of wt.filters) {
      console.log(`Checkout filter from your git config ran: ${p(f.name)} (${p(f.command)}) for ${f.files === null ? "an unknown number of" : f.files} file(s). It runs your own configured command, with your rights.`);
    }
  };

  if (wt.created) {
    // Stop here: Claude Code must be given access to the sibling directory
    // by the developer before the Developer Agent can work in it. The
    // session stays in the most restrictive mode until /implement runs again.
    writeSession(dataDir, {
      sessionId,
      mode: "planning",
      startedAt: (existing && existing.startedAt) || new Date().toISOString(),
      cwd: process.cwd().replace(/\\/g, "/"),
      pendingWorktree: { issueKey: t.key, site: t.site, path: b.path },
    });
    console.log(`JDH-WORKFLOW-SESSION:${sessionId}`);
    console.log(`IMPLEMENTATION: WORKTREE CREATED for ${t.key} r${n}. ACCESS NEEDED, NOT YET AUTHORIZED`);
    console.log(`Worktree: ${p(b.path)}`);
    console.log(`Branch: ${b.branch}`);
    console.log(`Base commit: ${b.baseHead}`);
    console.log(`Binding: worktree-b${b.binding}.json (signed)`);
    printReports();
    console.log("Next steps for the developer:");
    console.log(`  1. Give Claude Code access to the worktree by typing: /add-dir "${p(b.path)}"`);
    console.log(`  2. Run again: /jira-dev-harness:implement ${t.key} r${n} ${s.actualHash}`);
    console.log(`  If /add-dir is unavailable, restart with: claude --add-dir "${p(b.path)}" --resume`);
    console.log("The plugin never changes Claude Code permissions itself. Directory access may not persist across sessions; add it again if Claude Code blocks the worktree.");
    return;
  }

  const state = {
    sessionId,
    mode: "implementing",
    startedAt: (existing && existing.startedAt) || new Date().toISOString(),
    authorizedAt: new Date().toISOString(),
    issueKey: t.key,
    site: t.site,
    revision: n,
    sha256: s.actualHash,
    planFile: s.planFile.replace(/\\/g, "/"),
    repo,
    layout: "worktree",
    worktree: { path: b.path, branch: b.branch, baseHead: b.baseHead, binding: b.binding, hmac: b.hmac },
    baseline: {
      head: L.git(["rev-parse", "HEAD"], b.path),
      status: L.gitStatus(b.path),
    },
  };
  writeSession(dataDir, state);
  console.log(`JDH-WORKFLOW-SESSION:${sessionId}`);
  console.log(`IMPLEMENTATION: AUTHORIZED for ${t.key} r${n}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Jira site: ${t.site}`);
  console.log(`Plan file: ${state.planFile}`);
  console.log(`SHA-256: ${s.actualHash}`);
  console.log(`Repository (main checkout, not changed by implementation): ${repo.root}`);
  console.log(`Worktree: ${p(b.path)}`);
  console.log(`Branch: ${b.branch}`);
  console.log(`Base commit: ${b.baseHead}`);
  console.log(`Baseline HEAD (worktree): ${state.baseline.head}`);
  console.log(`Changes already in the worktree, from earlier attempts (must be preserved): ${state.baseline.status.length ? "" : "none"}`);
  for (const line of state.baseline.status) console.log(`  ${p(line)}`);
  printReports();
  console.log(`Only the jira-dev-harness:developer agent may write, only inside the worktree, in attended mode with a permission prompt for every edit. Every Developer shell command must start with: cd "${p(b.path)}" && `);
  console.log("The authorization and the worktree binding are re-checked on every write and end if the plan changes.");
  console.log(`If Claude Code blocks access to the worktree, the developer types: /add-dir "${p(b.path)}"`);
}

function draftPath([site, key, kind = "plan"]) {
  L.checkTicket(site, key);
  const names = { plan: "draft.md", report: "report.md", review: "review.json", commit: "commit.md", pr: "pr.md" };
  if (!names[kind]) fail(`unknown draft kind: ${kind}`);
  const dir = draftsDir(site, key);
  fs.mkdirSync(dir, { recursive: true });
  console.log(path.join(dir, names[kind]));
}

function save([dataDir, site, key, draftFile]) {
  dataDir = L.checkDataDir(dataDir);
  L.checkTicket(site, key);
  const repo = L.repoIdentity();
  const draft = checkDraft(site, key, draftFile);
  const text = fs.readFileSync(draft, "utf8");
  const readiness = L.READINESS_RE.exec(text);
  if (!readiness) fail("plan has no 'Readiness: READY' or 'Readiness: BLOCKED' line");
  if (!text.includes(key)) fail(`plan does not mention the issue key ${key}`);
  // The committed base the plan was written against, and the uncommitted
  // paths at that moment (Phase 8C: the ticket worktree starts at this base).
  const baseHead = L.git(["rev-parse", "HEAD"], repo.root);
  if (!W.COMMIT_RE.test(baseHead)) fail(`could not read the full HEAD commit of ${repo.root}`);
  const dirtyPaths = W.dirtyPaths(repo.root);
  // Re-planning while the ticket's worktree already holds work (for example
  // after a FAIL): the plan must say what happens to that work, so that it is
  // never discarded silently. The worktree is reused only for the same base.
  let wtNow = null;
  try { wtNow = W.status(dataDir, site, key, repo.root); } catch { wtNow = null; }
  const wtWork = !!wtNow && wtNow.state === "VERIFIED" && ((wtNow.uncommitted || 0) > 0 || (wtNow.commitsSinceBase || 0) > 0);
  if (wtWork && !/^##\s*Existing worktree changes\s*$/im.test(text)) {
    fail(`the ticket worktree ${W.printable(wtNow.path)} already holds work (${wtNow.uncommitted} uncommitted change(s), ${wtNow.commitsSinceBase} commit(s) since its base), and the plan has no "## Existing worktree changes" section. The plan must say, for each changed file, whether it is kept, revised, or reverted; nothing is discarded silently`);
  }
  if (wtWork) {
    // Every path the earlier work touched must be named in that section, on a
    // line that decides keep, revise, or revert. This shows the plan was made
    // with the actual worktree changes in front of the Planner.
    const lines = R.sectionText(text, "Existing worktree changes").split(/\r?\n/).map((l) => l.replace(/`/g, "").replace(/\\/g, "/"));
    const undecided = (wtNow.touchedPaths || []).filter((p) => !lines.some((l) => l.includes(p) && /\b(keep|kept|revise|revised|revert|reverted)\b/i.test(l)));
    if (undecided.length) {
      fail(`the plan's "## Existing worktree changes" section does not decide keep, revise, or revert for these changed paths in the ticket worktree: ${undecided.map(W.printable).join(", ")}. Run worktree-status to see the earlier work, and give the Analyzer and Planner that list; nothing is discarded silently`);
    }
  }

  const dir = path.join(dataDir, "plans", site, key);
  fs.mkdirSync(dir, { recursive: true });
  // Claim the next revision with an exclusive create, so an existing revision
  // is never overwritten even if two saves race.
  const { n, file: planFile } = claimNext(dir, "plan-r", (L.revisions(dir).pop() || 0) + 1, text);
  const meta = {
    issueKey: key,
    site,
    revision: n,
    sha256: L.sha256(planFile),
    readiness: readiness[1],
    repo,
    baseHead,
    dirtyPaths,
    ...(wtNow && wtNow.state === "VERIFIED" ? { worktreeAtSave: { binding: wtNow.binding, baseHead: wtNow.baseHead, uncommitted: wtNow.uncommitted, commitsSinceBase: wtNow.commitsSinceBase } } : {}),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, `plan-r${n}.json`), JSON.stringify(meta, null, 2) + "\n", { flag: "wx" });
  fs.unlinkSync(draft);

  console.log(`SAVED: ${key} revision r${n}`);
  console.log(`File: ${planFile}`);
  console.log(`SHA-256: ${meta.sha256}`);
  console.log(`Readiness: ${meta.readiness}`);
  console.log(`Repository: ${repo.root}`);
  console.log(`Base commit: ${baseHead}`);
  console.log(`Uncommitted paths when planned: ${dirtyPaths.length ? dirtyPaths.length : "none"}`);
  for (const p of dirtyPaths.slice(0, 20)) console.log(`  ${W.printable(p)}`);
  if (dirtyPaths.length > 20) console.log(`  ... and ${dirtyPaths.length - 20} more`);
  if (wtNow && wtNow.state === "VERIFIED") {
    console.log(`Ticket worktree: ${W.printable(wtNow.path)} (base ${wtNow.baseHead}; ${wtNow.uncommitted} uncommitted change(s), ${wtNow.commitsSinceBase} commit(s) since base)`);
    if (wtNow.baseHead !== baseHead) {
      console.log(`Warning: this revision's base is ${baseHead}, but the worktree is based on ${wtNow.baseHead}. /jira-dev-harness:implement will refuse to reuse it. Plan again with the main checkout at ${wtNow.baseHead}, or, once its work is pushed, remove it with /jira-dev-harness:worktree-remove ${key}. Its work is never discarded automatically.`);
    }
  } else if (wtNow && wtNow.state === "NOT VERIFIED") {
    console.log(`Warning: the ticket worktree failed verification (${W.printable(wtNow.problems.join("; "))}); /jira-dev-harness:implement will refuse until that is resolved.`);
  }
  if (n > 1) {
    const earlier = n === 2 ? "Revision r1 is" : `Revisions r1-r${n - 1} are`;
    console.log(`${earlier} superseded; any earlier approval no longer applies.`);
  }
  if (meta.readiness === "READY") {
    console.log("Review the plan file itself, then the developer approves it in this repository with:");
    console.log(`/jira-dev-harness:approve ${key} r${n} ${meta.sha256}`);
  } else {
    console.log("This revision is BLOCKED and cannot be approved until its blockers are resolved in a new revision.");
  }
}

// Stores an implementation report for the session's authorized revision,
// together with what git itself reports about the working tree, so that the
// reviewer does not depend on the report's own claims.
function reportSave([dataDir, sessionId, draftFile]) {
  dataDir = L.checkDataDir(dataDir);
  const state = readSession(dataDir, sessionId);
  if (!state || !state.issueKey || !state.repo) fail("this session has no implementation authorization to report on");
  const draft = checkDraft(state.site, state.issueKey, draftFile);
  const text = fs.readFileSync(draft, "utf8");
  if (!text.includes(state.issueKey)) fail(`report does not mention the issue key ${state.issueKey}`);

  // Phase 8C: the work is in the ticket worktree, re-verified here. A legacy
  // in-place session (authorized before Phase 8C) reports on the main
  // checkout as before, so its existing review and shipping path still works.
  // A session counts as legacy only when it carries neither the worktree
  // layout marker nor a worktree, which every session from Phase 8C on has.
  const worktreeSession = state.layout === "worktree" || !!state.worktree;
  if (worktreeSession) {
    const problem = W.sessionWorktreeProblem(dataDir, state);
    if (problem) fail(problem);
  } else if (W.hasWorktreeHistory(dataDir, state.site, state.issueKey)) {
    // A legacy in-place session never reports for a ticket that has (or had) a worktree.
    fail(`${state.issueKey} has a plugin-managed worktree, so this in-place session (from an older plugin version) cannot report; run /jira-dev-harness:implement again`);
  }
  const root = worktreeSession ? state.worktree.path : state.repo.root;
  const status = L.gitStatus(root);
  const pathOf = (line) => line.slice(3).replace(/^"|"$/g, "");
  const baseline = new Set(state.baseline.status);
  const untracked = status.filter((l) => l.startsWith("?? ")).map(pathOf).sort();
  const hashes = untracked.map((f) => {
    const p = path.join(root, f);
    return `${f}:${fs.existsSync(p) && fs.statSync(p).isFile() ? L.sha256(p) : "-"}`;
  });
  const diff = L.git(["diff", "HEAD", "--binary"], root, { binary: true });
  const meta = {
    issueKey: state.issueKey,
    site: state.site,
    planRevision: state.revision,
    planSha256: state.sha256,
    repo: state.repo,
    // Where the work is, stated explicitly for the review (Phase 8C).
    layout: worktreeSession ? "worktree" : "legacy-in-place",
    ...(worktreeSession ? { worktree: { path: state.worktree.path, branch: state.worktree.branch, baseHead: state.worktree.baseHead, binding: state.worktree.binding, bindingHmac: state.worktree.hmac } } : {}),
    sessionId,
    baselineHead: state.baseline.head,
    headNow: L.git(["rev-parse", "HEAD"], root),
    preExistingChanges: state.baseline.status,
    changesNow: status,
    changedSinceAuthorization: status.filter((l) => !baseline.has(l)),
    trackedDiffSha256: L.sha256Of(diff),
    untrackedFileSha256: hashes,
    createdAt: new Date().toISOString(),
  };

  const dir = path.join(dataDir, "plans", state.site, state.issueKey);
  const prefix = `impl-r${state.revision}-`;
  const first = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".md")).length + 1;
  const { file } = claimNext(dir, prefix, first, text);
  meta.reportSha256 = L.sha256(file);
  fs.writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify(meta, null, 2) + "\n", { flag: "wx" });
  fs.unlinkSync(draft);

  console.log(`REPORT SAVED: ${file}`);
  console.log(`Report SHA-256: ${meta.reportSha256}`);
  console.log(`HEAD unchanged: ${meta.headNow === meta.baselineHead ? "yes" : `NO (was ${meta.baselineHead}, now ${meta.headNow})`}`);
  console.log(`Changed since authorization (git): ${meta.changedSinceAuthorization.length ? "" : "none"}`);
  for (const line of meta.changedSinceAuthorization) console.log(`  ${line}`);
}

function status([dataDir, ref]) {
  dataDir = L.checkDataDir(dataDir);
  const t = L.findTicketDir(dataDir, ref);
  const s = L.latestState(t);
  if (!s) fail(`no saved plan revision found for ${ref}`);
  let repo = null;
  try { repo = L.repoIdentity(); } catch { repo = null; }
  console.log(`Plan: ${t.site}/${t.key}, latest revision r${s.n}`);
  console.log(`File: ${s.planFile}`);
  console.log(`SHA-256: ${s.actualHash}`);
  console.log(`Readiness: ${s.meta ? s.meta.readiness : "unknown (metadata missing)"}`);
  console.log(`Saved for repository: ${s.meta && s.meta.repo ? s.meta.repo.root : "unknown (saved by an older plugin version)"}`);
  console.log(`Base commit: ${s.meta && s.meta.baseHead ? W.printable(s.meta.baseHead) : "none (saved by an older plugin version; cannot authorize a ticket worktree)"}`);
  if (!s.intact) console.log("INTEGRITY: the plan file changed after it was saved. It cannot be approved; save a new revision.");
  const problem = s.intact ? L.approvalProblem(dataDir, t, s, s.approval, repo) : "the plan file changed after it was saved";
  console.log(`Approval: ${problem ? `NOT VALID (${problem})` : `APPROVED at ${s.approval.approvedAt} for this repository`}`);
  if (s.earlierApprovals.length) {
    console.log(`Superseded approvals (do not apply to r${s.n}): ${s.earlierApprovals.map((r) => `r${r}`).join(", ")}`);
  }
  const reports = fs.readdirSync(t.dir).filter((f) => /^impl-r[0-9]+-[0-9]+\.md$/.test(f));
  if (reports.length) console.log(`Implementation reports: ${reports.join(", ")}`);
}

function approve([dataDir, sessionId, ref, rev, hash, ...extra]) {
  dataDir = L.checkDataDir(dataDir);
  const usage = "Usage: /jira-dev-harness:approve <ISSUE-KEY> <rN> <full 64-character SHA-256>";
  if (extra.length) fail(`too many arguments. ${usage}`);
  if (!L.SESSION_RE.test(sessionId || "")) fail("the approving session could not be identified");
  const revMatch = L.REV_RE.exec(rev || "");
  if (!revMatch) fail(`invalid revision "${rev}". ${usage}`);
  hash = (hash || "").toLowerCase();
  if (!L.SHA256_RE.test(hash)) fail(`give the plan's full 64-character SHA-256, exactly as the save step printed it. ${usage}`);
  const n = Number(revMatch[1]);

  const t = L.findTicketDir(dataDir, ref);
  const s = L.latestState(t);
  if (!s) fail(`no saved plan revision found for ${ref}`);
  if (n !== s.n) fail(`r${n} is not the latest revision. The latest is r${s.n}; review it and approve it explicitly.`);
  if (!s.intact) fail(`plan-r${n}.md changed after it was saved. Save a new revision and review it.`);
  if (hash !== s.actualHash) fail(`the SHA-256 does not match r${n}. Its SHA-256 is ${s.actualHash}.`);
  if (s.meta.readiness !== "READY") fail(`r${n} is marked ${s.meta.readiness}. Resolve its blockers in a new revision first.`);
  if (!s.meta.repo) fail(`r${n} was saved by an older plugin version without a repository identity. Save a new revision.`);

  const repo = L.repoIdentity();
  if (!L.sameRepo(s.meta.repo, repo)) {
    fail(`this plan was saved for ${L.describeRepo(s.meta.repo)}, but you are approving from ${L.describeRepo(repo)}. Approve it from the repository it was planned for.`);
  }
  L.checkMapping(repo.root, t.site, t.key);

  // Phase 8C: the approval also binds the plan's base commit. It must belong
  // to this repository and still be the checked-out HEAD, so the developer
  // approves the plan against the code it was written for. A plan saved by an
  // older version has no base: it can still be approved, but that approval
  // can never authorize a worktree.
  const baseHead = s.meta.baseHead;
  if (baseHead !== undefined) {
    const problem = W.baseProblem(repo.root, repo, baseHead);
    if (problem) fail(`${problem}. Save a new revision.`);
    const head = L.git(["rev-parse", "HEAD"], repo.root);
    if (head !== baseHead) {
      fail(`HEAD moved since r${n} was saved (base ${baseHead}, HEAD now ${head}). The plan may not match the code; plan the ticket again and save a new revision.`);
    }
  }

  if (!L.approvalProblem(dataDir, t, s, s.approval, repo) && s.approval.baseHead === baseHead) {
    console.log(`APPROVAL: ALREADY GRANTED for ${t.key} r${n} (${s.actualHash}) at ${s.approval.approvedAt}`);
    return;
  }
  const record = {
    issueKey: t.key,
    site: t.site,
    revision: n,
    sha256: s.actualHash,
    repo,
    approvedAt: new Date().toISOString(),
    sessionId,
    method: "developer typed /jira-dev-harness:approve (Claude Code user-only skill)",
  };
  if (baseHead !== undefined) record.baseHead = baseHead;
  record.hmac = L.sign(record, L.approvalKey(dataDir, true));
  // An existing record is replaced only here, by the developer's own approve
  // command, when it is invalid or was signed without the base commit. The
  // old record is kept first, under a new name that is never overwritten.
  const approvalFile = path.join(t.dir, `approval-r${n}.json`);
  if (fs.existsSync(approvalFile)) {
    const old = fs.readFileSync(approvalFile);
    for (let k = 1; ; k += 1) {
      try {
        fs.writeFileSync(path.join(t.dir, `approval-r${n}-replaced-${k}.json`), old, { flag: "wx" });
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }
  fs.writeFileSync(approvalFile, JSON.stringify(record, null, 2) + "\n");
  console.log(`APPROVAL: GRANTED for ${t.key} r${n}`);
  console.log(`SHA-256: ${s.actualHash}`);
  console.log(`Repository: ${repo.root}`);
  if (baseHead !== undefined) {
    console.log(`Base commit: ${baseHead}`);
  } else {
    console.log(`Base commit: none (r${n} was saved by an older plugin version). This approval cannot authorize a ticket worktree; save a new revision and approve it for that.`);
  }
  console.log("This approval applies only to this exact revision, hash, and repository. A new revision, an edit to the plan file, or a different repository invalidates it.");
  console.log(`To implement it, the developer runs: /jira-dev-harness:implement ${t.key} r${n} ${s.actualHash}`);
}

function verify([dataDir, ref]) {
  dataDir = L.checkDataDir(dataDir);
  try {
    const { t, s, repo } = L.verifyApproved(dataDir, ref, process.cwd());
    console.log(`VALID: ${t.key} r${s.n} approved (${s.actualHash}) for ${repo.root}`);
  } catch (e) {
    if (!(e instanceof L.StoreError)) throw e;
    console.log(`INVALID: ${ref}: ${e.message}`);
    process.exit(1);
  }
}

// Creates a fresh directory for attachment downloads, outside any repository.
function attachDir() {
  fs.mkdirSync(L.ATTACH_ROOT, { recursive: true });
  console.log(fs.mkdtempSync(path.join(L.ATTACH_ROOT, "dl-")));
}

// Deletes one attachment download directory, and nothing outside ATTACH_ROOT.
function cleanAttach([dir]) {
  const target = path.resolve(dir || "");
  const rel = path.relative(L.ATTACH_ROOT, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep) || !rel.startsWith("dl-")) {
    fail(`refusing to delete ${target}: only directories created by attach-dir can be removed`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`REMOVED: ${target}`);
}

// ------------------------------------------------------------------ review

function reviewStart([dataDir, sessionId, ref, ...extra]) {
  dataDir = L.checkDataDir(dataDir);
  if (extra.length) fail("too many arguments. Usage: /jira-dev-harness:review <ISSUE-KEY>");
  const existing = readSession(dataDir, sessionId);
  const { facts, bundle, state } = R.startReview(dataDir, ref, W.primaryCwd(dataDir, process.cwd()));
  writeSession(dataDir, {
    sessionId,
    startedAt: (existing && existing.startedAt) || new Date().toISOString(),
    ...state,
  });
  console.log(`JDH-WORKFLOW-SESSION:${sessionId}`);
  console.log(`REVIEW: STARTED ${facts.reviewId} for ${facts.issueKey} r${facts.planRevision}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Jira site: ${facts.site}`);
  console.log(`Repository (primary identity): ${facts.repo.root}`);
  console.log(`Reviewed workspace: ${W.printable(R.describeWorkspace(facts.workspace))}`);
  if (facts.workspace.kind === "worktree") {
    console.log(`Workspace root (the Reviewer reads the code here, not in the main checkout): ${W.printable(facts.workspace.path)}`);
    console.log(`If Claude Code blocks reading it, the developer types: /add-dir "${W.printable(facts.workspace.path)}"`);
  }
  console.log(`Review bundle: ${bundle}`);
  console.log(`  facts.json  (computed by git, not by any agent)`);
  console.log(`  diff.patch  (git diff HEAD, credentials redacted)`);
  console.log(`Plan file: ${facts.planFile}`);
  console.log(`Implementation report: ${facts.implementationReport.file}`);
  console.log(`Working tree matches the implementation report: ${facts.integrity.matchesImplementationReport ? "yes" : `NO (${facts.integrity.differences.join("; ")})`}`);
  console.log(`Changed files: ${facts.changedFiles.join(", ") || "none"}`);
  console.log(`Changed files outside the plan: ${facts.filesOutsidePlan.join(", ") || "none"}`);
  const unapproved = facts.instructionFileChanges.filter((c) => !c.approvedInPlan).map((c) => c.path);
  console.log(`Unapproved instruction-file changes: ${unapproved.join(", ") || "none"}`);
  console.log("This session is now in reviewing mode: nobody may change the repository or the worktree, and project checks run only through run-check, in the reviewed workspace, with your approval.");
}

function runCheck([dataDir, sessionId, name, required, command, ...extra]) {
  dataDir = L.checkDataDir(dataDir);
  if (extra.length) fail("the command must be a single quoted argument");
  const state = readSession(dataDir, sessionId);
  const meta = R.runCheck(dataDir, state, name, required, command);
  console.log(`CHECK RECORDED: ${meta.id} ${meta.name} (${meta.required ? "required" : "optional"})`);
  console.log(`Command: ${meta.command}`);
  console.log(`Ran in: ${W.printable(meta.cwd)} (${meta.workspace === "worktree" ? "ticket worktree" : "main checkout, legacy in-place review"})`);
  console.log(`Exit code: ${meta.exitCode === null ? "none" : meta.exitCode}${meta.timedOut ? " (timed out)" : ""}${meta.unavailable ? " (tool or environment unavailable)" : ""}`);
  console.log(`Duration: ${meta.durationMs} ms`);
  console.log(`Working tree changed by the check: ${meta.treeChanged ? `YES (${meta.treeChanges.join("; ")})` : "no"}`);
  console.log(`Log: ${meta.logFile}`);
  const log = fs.readFileSync(meta.logFile, "utf8").split(/\r?\n/);
  console.log("Last lines of the log:");
  for (const line of log.slice(-15)) console.log(`  ${line}`);
}

function reviewSave([dataDir, sessionId, draftFile]) {
  dataDir = L.checkDataDir(dataDir);
  const state = readSession(dataDir, sessionId);
  if (!state || state.mode !== "reviewing") fail("this session has no review in progress");
  const draft = checkDraft(state.site, state.issueKey, draftFile, ".json");
  let input;
  try {
    input = JSON.parse(fs.readFileSync(draft, "utf8"));
  } catch (e) {
    fail(`the review draft is not valid JSON: ${e.message}`);
  }
  const facts = L.readJson(path.join(state.reviewBundle, "facts.json"));
  if (!facts || facts.reviewId !== state.reviewId) fail("the review bundle does not match this session");
  const dir = path.dirname(state.reviewBundle);
  const out = path.join(dir, `review-${facts.reviewId}`);
  if (fs.existsSync(`${out}.json`)) fail(`${facts.reviewId} was already saved; start a new review with /jira-dev-harness:review`);

  const checks = R.loadChecks(state.reviewBundle);
  // The workspace is re-verified (binding, path, branch) before its tree is
  // read; it must be the one the review started on.
  if (!R.sameWorkspace(state.workspace, facts.workspace)) fail("the session's workspace does not match the review bundle");
  const identityAtSave = R.treeIdentity(R.sessionWorkspaceRoot(dataDir, state));
  const result = R.enforce(input, facts, checks, identityAtSave);
  const review = {
    reviewId: facts.reviewId,
    reviewedAt: new Date().toISOString(),
    reviewer: "jira-dev-harness:reviewer (agents/reviewer.md, model: opus)",
    identity: {
      issueKey: facts.issueKey,
      site: facts.site,
      planRevision: facts.planRevision,
      planSha256: facts.planSha256,
      implementationReport: facts.implementationReport.id,
      implementationReportSha256: facts.implementationReport.meta.reportSha256,
      repo: facts.repo,
      ...(facts.workspace ? { workspace: facts.workspace } : {}),
      tree: { head: identityAtSave.head, trackedDiffSha256: identityAtSave.trackedDiffSha256, untrackedFileSha256: identityAtSave.untrackedFileSha256 },
    },
    facts: {
      integrity: facts.integrity,
      changedFiles: facts.changedFiles,
      filesOutsidePlan: facts.filesOutsidePlan,
      instructionFileChanges: facts.instructionFileChanges,
      preExistingChanges: facts.preExistingChanges,
    },
    ...result,
  };
  const logs = Object.fromEntries(checks.map((c) => [c.id, fs.existsSync(c.logFile) ? fs.readFileSync(c.logFile, "utf8") : ""]));
  // The rendered reports are bound into the signed record, so that the page
  // the developer read is the page that gets approved.
  const html = renderHtml(review, logs);
  const markdown = renderMarkdown(review);
  review.artifacts = {
    htmlSha256: L.sha256Of(html),
    markdownSha256: L.sha256Of(markdown),
    factsSha256: L.sha256(path.join(state.reviewBundle, "facts.json")),
    diffSha256: L.sha256(path.join(state.reviewBundle, "diff.patch")),
  };
  review.hmac = L.sign(review, L.approvalKey(dataDir, true));
  const json = JSON.stringify(review, null, 2) + "\n";
  fs.writeFileSync(`${out}.json`, json, { flag: "wx" });
  fs.writeFileSync(`${out}.html`, html, { flag: "wx" });
  fs.writeFileSync(`${out}.md`, markdown, { flag: "wx" });
  fs.unlinkSync(draft);

  console.log(`REVIEW SAVED: ${facts.reviewId} for ${facts.issueKey} r${facts.planRevision}`);
  console.log(`VERDICT: ${review.verdict}${review.verdict !== review.reviewerVerdict ? ` (Reviewer said ${review.reviewerVerdict}; changed by the review rules)` : ""}`);
  for (const r of review.failReasons) console.log(`  fail: ${r}`);
  for (const r of review.seriousFindings) console.log(`  open finding: ${r}`);
  for (const r of review.blockReasons) console.log(`  blocked: ${r}`);
  for (const r of review.corrections) console.log(`  correction: ${r}`);
  console.log(`HTML report: ${out}.html`);
  console.log(`JSON record: ${out}.json`);
  console.log(`Markdown summary: ${out}.md`);
  console.log(`Open the HTML report in a browser, for example: start "" "${out}.html" (Windows), open "${out}.html" (macOS), xdg-open "${out}.html" (Linux).`);
  console.log(`Review SHA-256: ${L.sha256Of(json)}`);
  console.log("The verdict is valid only until the code, plan, or implementation report changes. It does not authorize a commit, push, pull request, or merge.");
  if (review.verdict === "PASS") {
    console.log("After reading the HTML report, the developer approves exactly this artifact with:");
    console.log(`/jira-dev-harness:approve-review ${facts.issueKey} ${facts.reviewId} ${L.sha256Of(json)}`);
  }
}

function reviewStatusCmd([dataDir, ref]) {
  dataDir = L.checkDataDir(dataDir);
  const st = R.reviewStatus(dataDir, ref, W.primaryCwd(dataDir, process.cwd()));
  if (!st.latest) {
    console.log(`REVIEW: NONE for ${ref}`);
    process.exit(1);
  }
  const d = st.latest.data;
  console.log(`Review: ${st.latest.id} (${d.reviewedAt}), verdict ${d.verdict}`);
  console.log(`Reviewed workspace: ${W.printable(R.describeWorkspace(d.identity && d.identity.workspace))}`);
  console.log(`Review SHA-256: ${L.sha256(st.latest.file)}`);
  console.log(`Developer approval: ${fs.existsSync(RA.approvalFile(st.t, st.latest.id)) ? "recorded (checked when you ship)" : "none"}`);
  console.log(`HTML report: ${st.latest.file.replace(/\.json$/, ".html")}`);
  if (st.valid) {
    console.log(`REVIEW: CURRENT. The working tree, plan r${d.identity.planRevision}, and ${d.identity.implementationReport} are unchanged since the review.`);
    return;
  }
  console.log("REVIEW: STALE. The verdict no longer applies:");
  for (const r of st.reasons) console.log(`  ${r}`);
  process.exit(1);
}

// ---------------------------------------------------- review approval, ship

function approveReviewCmd([dataDir, sessionId, ref, id, hash, ...extra]) {
  dataDir = L.checkDataDir(dataDir);
  const usage = "Usage: /jira-dev-harness:approve-review <ISSUE-KEY> <review-id> <full 64-character SHA-256>";
  if (extra.length) fail(`too many arguments. ${usage}`);
  if (!L.SESSION_RE.test(sessionId || "")) fail("the approving session could not be identified");
  hash = (hash || "").toLowerCase();
  if (!L.SHA256_RE.test(hash)) fail(`give the review's full 64-character SHA-256, exactly as the review step printed it. ${usage}`);
  if (!RA.REVIEW_ID_RE.test(id || "")) fail(`invalid review id "${id}". ${usage}`);
  const r = RA.approveReview(dataDir, sessionId, ref, id, hash, W.primaryCwd(dataDir, process.cwd()));
  console.log(`REVIEW APPROVAL: ${r.already ? "ALREADY GRANTED" : "GRANTED"} for ${r.t.key} ${id}`);
  console.log(`Review SHA-256: ${r.fileSha256}`);
  console.log(`Plan: r${r.record.planRevision} (${r.record.planSha256})`);
  console.log(`Implementation report: ${r.record.implementationReport.id} (${r.record.implementationReport.sha256})`);
  console.log(`Repository: ${r.repo.root}`);
  console.log(`Reviewed workspace: ${W.printable(R.describeWorkspace(r.record.workspace))}`);
  console.log(`Git HEAD: ${r.record.tree.head}`);
  console.log(`Approved changed files (${r.record.changedFiles.length}), with content hashes:`);
  for (const f of r.record.changedFiles) console.log(`  ${f.path}  ${f.sha256}`);
  console.log("This approval applies only to this exact review, tree, and file content. Any further change to the code, plan, report, or review invalidates it. It does not run git, push, or create a pull request.");
  console.log(`To ship it, the developer runs: /jira-dev-harness:ship ${r.t.key} ${id} ${r.fileSha256}`);
  if (r.record.workspace && r.record.workspace.kind === "worktree") {
    console.log(`It ships from the ticket worktree, on its fixed branch ${W.printable(r.record.workspace.branch)} (no --branch).`);
  }
}

function shipSession(dataDir, sessionId) {
  const state = readSession(dataDir, sessionId);
  S.requireShipping(state);
  return state;
}

function shipStartCmd([dataDir, sessionId, ref, id, hash, ...rest]) {
  dataDir = L.checkDataDir(dataDir);
  const usage = "Usage: /jira-dev-harness:ship <ISSUE-KEY> <review-id> <full 64-character SHA-256> [--branch <name>]";
  const options = {};
  if (rest.length) {
    if (rest.length === 2 && rest[0] === "--branch") options.branch = rest[1];
    else fail(`unexpected arguments. ${usage}`);
  }
  if (!RA.REVIEW_ID_RE.test(id || "")) fail(`invalid review id "${id}". ${usage}`);
  const existing = readSession(dataDir, sessionId);
  const state = S.start(dataDir, sessionId, ref, id, hash, options, process.cwd());
  writeSession(dataDir, { sessionId, startedAt: (existing && existing.startedAt) || new Date().toISOString(), ...state });
  console.log(`JDH-WORKFLOW-SESSION:${sessionId}`);
  console.log(`SHIP: AUTHORIZED for ${state.issueKey} (${state.reviewId})`);
  console.log(`Session: ${sessionId}`);
  console.log(`Jira site: ${state.site}`);
  console.log(`Repository (primary identity): ${state.repo.root}`);
  console.log(`Shipped from: ${W.printable(R.describeWorkspace(state.workspace))}`);
  console.log(`Remote: ${state.remote.host}/${state.remote.owner}/${state.remote.name} (origin)`);
  console.log(`Base branch: ${state.base}`);
  console.log(`Ticket branch: ${state.branch}${state.layout === "worktree" ? " (the worktree's fixed branch, already checked out there; never switched)" : state.branch === state.startBranch ? " (already checked out)" : " (will be created from the current HEAD)"}`);
  console.log(`Files to commit (${state.approvedFiles.length}):`);
  for (const f of state.approvedFiles) console.log(`  ${f.path}`);
  console.log(`Jira link for the pull request: ${state.jiraUrl}`);
  console.log("Each of commit, push, and pull request creation is a separate step and needs your permission prompt. Nothing has been changed yet. The plugin never merges.");
}

function shipCommitCmd([dataDir, sessionId, draftFile]) {
  dataDir = L.checkDataDir(dataDir);
  const state = shipSession(dataDir, sessionId);
  const draft = checkDraft(state.site, state.issueKey, draftFile);
  const next = S.commit(dataDir, state, fs.readFileSync(draft, "utf8"));
  writeSession(dataDir, next);
  fs.unlinkSync(draft);
  console.log(`COMMITTED: ${next.commit} on ${next.branch}`);
  console.log(`Files: ${next.approvedFiles.map((f) => f.path).join(", ")}`);
  for (const line of next.hookOutput) console.log(`  ${line}`);
  console.log("Next: push the branch with ship-push.");
}

function shipPushCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const next = S.push(dataDir, shipSession(dataDir, sessionId));
  writeSession(dataDir, next);
  console.log(`PUSHED: ${next.branch} at ${next.commit} to origin (${next.remote.host}/${next.remote.owner}/${next.remote.name})`);
  for (const line of next.pushOutput) console.log(`  ${line}`);
  console.log("Next: prepare the pull request text with ship-prepare-pr.");
}

function shipPrepareCmd([dataDir, sessionId, draftFile]) {
  dataDir = L.checkDataDir(dataDir);
  const state = shipSession(dataDir, sessionId);
  const draft = checkDraft(state.site, state.issueKey, draftFile);
  const next = S.prepare(dataDir, state, fs.readFileSync(draft, "utf8"));
  writeSession(dataDir, next);
  fs.unlinkSync(draft);
  console.log("PULL REQUEST TEXT PREPARED");
  console.log(`Repository: ${next.remote.owner}/${next.remote.name}`);
  console.log(`Head: ${next.branch}`);
  console.log(`Base: ${next.base}`);
  console.log(`Title: ${next.prepared.title}`);
  console.log("Body (use it exactly, byte for byte):");
  console.log("-----BEGIN PR BODY-----");
  console.log(next.prepared.body);
  console.log("-----END PR BODY-----");
}

function shipPrCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const next = S.createWithGh(dataDir, shipSession(dataDir, sessionId));
  M.writeShipRecord(dataDir, next);
  writeSession(dataDir, next);
  console.log(`PULL REQUEST ${next.pr.existing ? "ALREADY OPEN" : "CREATED"}: ${next.pr.url}`);
  console.log("It has not been merged, and the plugin has no merge command.");
}

function shipRecordCmd([dataDir, sessionId, url]) {
  dataDir = L.checkDataDir(dataDir);
  const next = S.recordPr(dataDir, shipSession(dataDir, sessionId), url);
  const rec = M.writeShipRecord(dataDir, next);
  writeSession(dataDir, next);
  console.log(`PULL REQUEST RECORDED: ${next.pr.url}${rec.revision > 1 ? ` (ship record revision ${rec.revision}; earlier revisions are kept unchanged)` : ""}`);
  console.log(`Created via: ${next.pr.via}`);
}

function shipStatusCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const state = shipSession(dataDir, sessionId);
  console.log(`Shipping ${state.issueKey} (${state.reviewId}): stage ${state.stage}`);
  console.log(`Branch: ${state.branch} -> ${state.base} on ${state.remote.host}/${state.remote.owner}/${state.remote.name}`);
  if (state.commit) console.log(`Commit: ${state.commit}`);
  if (state.pr) console.log(`Pull request: ${state.pr.url} (${state.pr.via})`);
  const problem = S.gateProblem(dataDir, state, { tree: state.stage === "started" });
  console.log(`Gates: ${problem ? `NOT VALID (${problem})` : "valid"}`);
}

function shipChecksCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const r = S.checks(shipSession(dataDir, sessionId));
  if (!r.available) {
    console.log(`CI STATUS: UNAVAILABLE through the GitHub CLI adapter (${r.reason}). Use read-only tools of your GitHub MCP connection, or open the pull request page.`);
    return;
  }
  console.log(`CI STATUS (gh exit ${r.status}; non-zero means failing, pending, or no checks):`);
  console.log(r.text);
}

// ------------------------------------------------------------------- merge

function mergeSession(dataDir, sessionId) {
  const state = readSession(dataDir, sessionId);
  M.requireMerging(state);
  return state;
}

function printGate(result) {
  console.log(`Required checks: ${result.facts.requiredContexts.join(", ") || "none found"}`);
  console.log(`Required approving reviews: ${result.facts.requiredReviews}; approvals of the current commit: ${result.facts.approvals}`);
  console.log(`Files in the pull request: ${result.facts.files.join(", ") || "unknown"}`);
  for (const w of result.warnings) console.log(`  note: ${w}`);
}

function mergeStartCmd([dataDir, sessionId, ref, pr, sha, ...rest]) {
  dataDir = L.checkDataDir(dataDir);
  const usage = "Usage: /jira-dev-harness:merge <ISSUE-KEY> <pull-request-number> <full 40-character head SHA> --method <squash|merge|rebase>";
  if (rest.length !== 2 || rest[0] !== "--method") fail(`give the merge method explicitly. ${usage}`);
  const existing = readSession(dataDir, sessionId);
  const { state, warnings } = M.start(dataDir, sessionId, ref, pr, sha, rest[1], process.cwd());
  writeSession(dataDir, { sessionId, startedAt: (existing && existing.startedAt) || new Date().toISOString(), ...state, startedAt: state.startedAt });
  console.log(`JDH-WORKFLOW-SESSION:${sessionId}`);
  console.log(`MERGE: AUTHORIZED for ${state.issueKey} pull request #${state.pr}, head ${state.headSha}, method ${state.method}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Repository: ${state.remote.host}/${state.remote.owner}/${state.remote.name}`);
  console.log(`Branch: ${state.branch} -> ${state.base}`);
  for (const w of warnings) console.log(`  note: ${w}`);
  console.log("This authorizes one attempt for this exact head commit. Nothing is merged unless the provider itself confirms the pull request identity, the head SHA, the required checks, the reviews, branch protection, and your permissions. The plugin never bypasses protections, uses auto-merge, or deletes branches.");
}

function mergeCollectCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const n = M.collectGh(dataDir, mergeSession(dataDir, sessionId));
  console.log(`EVIDENCE COLLECTED through the GitHub CLI: ${n} provider response(s) recorded.`);
}

function mergeVerifyCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const { result, state } = M.verify(dataDir, mergeSession(dataDir, sessionId));
  if (result.ok) writeSession(dataDir, state);
  console.log(`MERGE GATE: ${result.ok ? "PASS" : "BLOCKED"} (from recorded provider responses only)`);
  printGate(result);
  for (const r of result.reasons) console.log(`  blocked: ${r}`);
  if (result.ok) console.log("Merge with the GitHub MCP merge tool (the guard checks it) or with merge-run. Evidence expires after 10 minutes.");
}

function mergeRunCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const next = M.runGh(dataDir, mergeSession(dataDir, sessionId));
  M.writeMergeRecord(dataDir, next);
  writeSession(dataDir, next);
  console.log(`MERGED (confirmed by the provider): pull request #${next.pr}, merge commit ${next.mergeCommit}, via ${next.mergedVia}`);
}

function mergeRecordCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const next = M.recordMcp(dataDir, mergeSession(dataDir, sessionId));
  M.writeMergeRecord(dataDir, next);
  writeSession(dataDir, next);
  console.log(`MERGED (confirmed by a recorded provider response): pull request #${next.pr}, merge commit ${next.mergeCommit}, via ${next.mergedVia}`);
}

function mergeStatusCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const state = mergeSession(dataDir, sessionId);
  console.log(`Merging ${state.issueKey} #${state.pr} (${state.headSha}): stage ${state.stage}`);
  if (state.mergeCommit) console.log(`Merge commit: ${state.mergeCommit} (${state.mergedVia})`);
  const result = M.gate(dataDir, state);
  console.log(`Gate on recorded evidence: ${result.ok ? "PASS" : "BLOCKED"}`);
  for (const r of result.reasons) console.log(`  ${r}`);
}

// -------------------------------------------------------------- Jira progress

function jiraSession(dataDir, sessionId) {
  const state = readSession(dataDir, sessionId);
  JS.requireSyncing(state);
  return state;
}

function mappingCheckCmd() {
  const repo = L.repoIdentity();
  const { errors, mapping } = JM.readMapping(repo.root);
  if (errors.length) {
    console.log("MAPPING: INVALID");
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  }
  console.log(`MAPPING: VALID for ${repo.root}`);
  console.log(`Jira site: ${mapping.site}; projects: ${mapping.projectKeys.join(", ")}`);
  console.log(mapping.board ? `Board: ${mapping.board.id}${mapping.board.name ? ` (${mapping.board.name})` : ""}, verification ${mapping.board.verification}` : "Board: not configured (Jira progress sync is blocked until jira.board is committed)");
  const stages = Object.entries(mapping.progress.stages);
  console.log(`Comments: ${mapping.progress.comments ? "on" : "off"}; stage mappings: ${stages.length ? stages.map(([k, v]) => `${k} -> ${v.toStatuses.join(" / ")}`).join("; ") : "none (comment-only)"}`);
  console.log("This only reads the committed file. Board identity and membership are verified against Jira at sync time, never trusted from the file.");
}

function jiraStartCmd([dataDir, sessionId, ref, ...rest]) {
  dataDir = L.checkDataDir(dataDir);
  const usage = "Usage: /jira-dev-harness:jira-sync <ISSUE-KEY> [--allow-done]";
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--allow-done")) fail(`unexpected arguments. ${usage}`);
  if (!ref) fail(usage);
  const existing = readSession(dataDir, sessionId);
  const state = JS.start(dataDir, sessionId, ref, { allowDone: rest[0] === "--allow-done" }, process.cwd());
  writeSession(dataDir, { sessionId, ...state, startedAt: state.startedAt });
  console.log(`JDH-WORKFLOW-SESSION:${sessionId}`);
  console.log(`JIRA SYNC: AUTHORIZED for ${state.issueKey}, stage "${state.stage}" (${P.LABELS[state.stage]})`);
  console.log(`Session: ${sessionId}`);
  console.log(`Jira site: ${state.site}; mapped projects: ${state.mapping.projectKeys.join(", ")}`);
  console.log(state.mapping.board ? `Board: ${state.mapping.board.id} (verification: ${state.mapping.board.verification})` : "Board: NOT CONFIGURED in the committed mapping; the sync will be blocked");
  const cfg = state.mapping.progress.stages[state.stage];
  console.log(cfg ? `Status mapped for this stage: ${cfg.toStatuses.join(" / ")} (matched against Jira's own transitions)` : "No status is mapped for this stage; only a comment can be posted");
  console.log(`Comment marker: ${state.comment.marker}`);
  console.log(`Allowed Jira writes in this session: at most one transition and one comment on ${state.issueKey}, exactly as planned from Jira's own responses, each behind your permission prompt. Nothing else in Jira can change.`);
  void existing;
}

function jiraPlanCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const { plan, state } = JS.makePlan(dataDir, jiraSession(dataDir, sessionId));
  if (plan.ok) writeSession(dataDir, state);
  console.log(`JIRA PLAN: ${plan.ok ? "READY" : "BLOCKED"} (from recorded Jira responses only)`);
  if (plan.issue) console.log(`Ticket: ${plan.issue.key}, project ${plan.issue.project}, status "${plan.issue.status && plan.issue.status.name}"`);
  console.log(`Board: ${plan.board.configured ? (plan.board.verified ? "verified (identity and membership)" : "not verified") : "not configured"}`);
  for (const r of plan.reasons) console.log(`  blocked: ${r}`);
  for (const w of plan.warnings) console.log(`  note: ${w}`);
  for (const sk of plan.skipped) console.log(`  skipped: ${sk}`);
  if (!plan.ok) return;
  const a = plan.actions;
  if (!a.transition && !a.comment) console.log("Nothing to write. The ticket is left unchanged.");
  if (a.transition) {
    console.log(`WRITE 1 (transition): cloudId ${plan.cloudId}, issue ${state.issueKey}, transition id ${a.transition.id} ("${a.transition.name}": ${a.transition.from} -> ${a.transition.toName})`);
    console.log("  Use the transition tool with exactly: the cloudId, the issue key, and the transition id above. No fields, resolution, assignee, or comment.");
  }
  if (a.comment) {
    console.log(`WRITE 2 (comment): cloudId ${plan.cloudId}, issue ${state.issueKey}, body exactly:`);
    console.log("-----BEGIN COMMENT-----");
    console.log(a.comment.text);
    console.log("-----END COMMENT-----");
  }
  console.log("Evidence expires after 10 minutes. After the writes, read the ticket and its comments again, then run jira-confirm.");
}

function jiraConfirmCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const results = JS.confirm(dataDir, jiraSession(dataDir, sessionId));
  if (!results.length) console.log("JIRA CONFIRM: nothing to confirm (no executed write is waiting for confirmation).");
  for (const r of results) console.log(`${r.ok ? "CONFIRMED" : "UNCONFIRMED"}: ${r.kind}: ${r.detail}`);
  if (results.some((r) => !r.ok)) console.log("An unconfirmed write may or may not have happened: open the ticket in Jira before relying on it. Nothing is retried automatically.");
}

function jiraStatusCmd([dataDir, sessionId]) {
  dataDir = L.checkDataDir(dataDir);
  const state = jiraSession(dataDir, sessionId);
  const bad = P.ledgerProblem(dataDir, state.site, state.issueKey);
  const mine = P.readLedger(dataDir, state.site, state.issueKey).filter((x) => x.sessionId === sessionId);
  // The session's phase stays "planned" after the writes (the guard allows
  // writes only in that phase, and the ledger blocks repeats), so the
  // progress shown here is derived from the signed ledger.
  const planned = Object.keys(state.planned || {});
  const last = Object.fromEntries(planned.map((k) => [k, ([...mine].reverse().find((e) => e.kind === k) || {}).status || "not attempted"]));
  let progress = state.phase;
  if (state.phase === "planned") {
    const st = Object.values(last);
    if (!planned.length) progress = "planned (nothing to write)";
    else if (st.every((s) => s === "confirmed")) progress = "complete (all planned writes confirmed)";
    else if (st.some((s) => ["failed", "blocked", "unconfirmed"].includes(s))) progress = "attention needed (see the writes below)";
    else if (st.some((s) => s === "executed")) progress = "written, awaiting confirmation";
  }
  console.log(`Jira sync for ${state.issueKey}: stage "${state.stage}", ${progress}`);
  if (planned.length) console.log(`Planned writes: ${planned.map((k) => `${k} ${last[k]}`).join(", ")}`);
  console.log(`Audit ledger: ${bad ? `NOT TRUSTWORTHY (${bad})` : "intact"}`);
  for (const e of mine) {
    console.log(`  #${e.seq} ${e.at} ${e.kind} ${e.status}${e.detail ? `: ${e.detail}` : ""}`);
  }
}

function jiraLedgerCmd([dataDir, ref]) {
  dataDir = L.checkDataDir(dataDir);
  const t = L.findTicketDir(dataDir, ref);
  const bad = P.ledgerProblem(dataDir, t.site, t.key);
  console.log(`Audit ledger for ${t.site}/${t.key}: ${bad ? `NOT TRUSTWORTHY (${bad})` : "intact (hash-chained, signed)"}`);
  for (const e of P.readLedger(dataDir, t.site, t.key)) {
    console.log(`#${e.seq} ${e.at} [${e.stage || "-"}] ${e.kind} ${e.status}${e.detail ? `: ${e.detail}` : ""}`);
  }
}

// ------------------------------------------------- assigned-ticket discovery
// Read-only helpers for /jira-dev-harness:ticket. They print text; they never
// contact Jira, write files, or change git.

function ticketRefCmd(args) {
  if (args.length > 1) fail("give one ticket URL or key");
  let defaultSite = null;
  try {
    defaultSite = D.mappedSite(L.repoIdentity().root);
  } catch {
    defaultSite = null;
  }
  const ref = D.parseRef(args[0], { defaultSite });
  if (ref.mode === "invalid") fail(`invalid ticket reference: ${ref.reason}`);
  if (ref.mode === "discover") {
    console.log("TICKET-REF: none given. List the developer's assigned tickets and wait for an explicit selection.");
    return;
  }
  console.log(`TICKET-REF: site=${ref.site || "unknown"} key=${ref.key} project=${ref.project}`);
  if (!ref.site) console.log("The site is not in the reference. Use the site of the one accessible Jira site, or ask the developer which site; never guess.");
}

function assignedJqlCmd(args) {
  if (args.length > 1 || args.some((a) => a !== "--include-done")) fail("usage: assigned-jql [--include-done]");
  console.log(D.assignedJql({ includeDone: args[0] === "--include-done" }));
}

function mappingStatusCmd([site, key]) {
  L.checkTicket(site, key);
  const r = D.mappingStatus(L.repoIdentity().root, site, key);
  console.log(`MAPPING-STATUS: ${r.state.toUpperCase()} - ${r.reason}`);
}

// Read-only: whether the ticket has a verified sibling worktree, with its
// path, branch, and base, plus the plan's recorded and approved base. Run from
// the main checkout. It writes nothing and always exits 0 after a valid
// request; the verdict is the WORKTREE line.
function worktreeStatusCmd([dataDir, ref, ...extra]) {
  dataDir = L.checkDataDir(dataDir);
  if (extra.length) fail("usage: worktree-status <dataDir> <ISSUE-KEY | site/ISSUE-KEY>");
  let site;
  let key;
  try {
    ({ site, key } = L.findTicketDir(dataDir, ref));
  } catch (e) {
    if (!(e instanceof L.StoreError) || !String(ref).includes("/")) throw e;
    [site, key] = String(ref).split("/");
    L.checkTicket(site, key);
  }
  const r = W.status(dataDir, site, key, process.cwd());
  const p = W.printable;
  console.log(`WORKTREE: ${r.state}`);
  console.log(`Ticket: ${site}/${key}`);
  if (r.plan) {
    console.log(`Plan: r${r.plan.revision}, ${r.plan.approved ? "approved" : `not approved (${p(r.plan.approvalProblem)})`}`);
    console.log(`Base commit recorded at save: ${r.plan.savedBase ? p(r.plan.savedBase) : "none (saved by an older plugin version)"}`);
    if (r.plan.dirtyAtSave !== null) console.log(`Uncommitted paths when planned: ${r.plan.dirtyAtSave}`);
    if (r.plan.approved) {
      console.log(`Approved base commit: ${r.plan.approvedBase || `none (${p(r.plan.baseProblem)})`}`);
    }
  } else {
    console.log("Plan: none saved");
  }
  if (r.expectedPath) console.log(`Expected path: ${p(r.expectedPath)}`);
  if (r.binding !== null) console.log(`Binding: worktree-b${r.binding}.json`);
  if (r.path && r.state === "REMOVED") {
    console.log(`Removed worktree: ${p(r.path)} (branch ${p(r.branch)} kept, at ${p(r.removedHead)}), removed ${p(r.removedAt)}`);
  } else if (r.path) {
    console.log(`Path: ${p(r.path)}`);
    console.log(`Branch: ${p(r.branch)}`);
    console.log(`Base commit: ${p(r.baseHead)} (plan r${r.planRevision}, created ${p(r.createdAt)})`);
  }
  if (r.head) console.log(`HEAD: ${p(r.head)} (${r.commitsSinceBase === null ? "unknown number of" : r.commitsSinceBase} commit(s) since base)`);
  for (const c of r.commits || []) console.log(`  commit ${p(c)}`);
  if (r.uncommitted !== undefined) console.log(`Uncommitted changes in the worktree: ${r.uncommitted === null ? "unknown" : r.uncommitted}`);
  for (const c of (r.changes || []).slice(0, 100)) console.log(`  ${p(c)}`);
  if ((r.changes || []).length > 100) console.log(`  ... and ${r.changes.length - 100} more`);
  if ((r.touchedPaths || []).length) {
    console.log(`Paths touched by earlier work (a re-plan must decide keep, revise, or revert for each): ${r.touchedPaths.length}`);
    for (const t of r.touchedPaths.slice(0, 200)) console.log(`  ${p(t)}`);
  }
  for (const problem of r.problems) console.log(`Problem: ${p(problem)}`);
}

// User-only (/jira-dev-harness:worktree-remove). Removes the ticket's
// verified worktree with `git worktree remove` (never --force), keeps the
// branch, and writes a signed removal record. Always exits 0 and prints its
// verdict, like approve, so the skill can show it.
function worktreeRemoveCmd([dataDir, sessionId, ref, ...rest]) {
  dataDir = L.checkDataDir(dataDir);
  const usage = "Usage: /jira-dev-harness:worktree-remove <ISSUE-KEY | site/ISSUE-KEY> [--confirm-ignored <count>] [--end-session <session-id>]...";
  if (!L.SESSION_RE.test(sessionId || "")) fail("the session could not be identified");
  const opts = { endSessions: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === "--confirm-ignored" && /^[0-9]{1,7}$/.test(value || "") && opts.confirmIgnored === undefined) opts.confirmIgnored = Number(value);
    else if (flag === "--end-session" && L.SESSION_RE.test(value || "")) opts.endSessions.push(value);
    else fail(`unexpected arguments. ${usage}`);
  }
  const { site, key } = L.findTicketDir(dataDir, ref);
  const r = W.remove(dataDir, { site, key, mainRoot: W.primaryCwd(dataDir, process.cwd()), sessionId, ...opts });
  const p = W.printable;
  console.log(`WORKTREE REMOVAL: REMOVED ${site}/${key}`);
  console.log(`Removed worktree: ${p(r.record.path)}`);
  console.log(`Branch kept: ${p(r.record.branch)} at ${r.record.head}${r.record.branchKept ? "" : " (WARNING: the branch was not found after removal)"}`);
  console.log(`On origin: ${r.record.pushed.commit ? `${p(r.record.branch)} at ${r.record.pushed.commit}` : "no remote-tracking branch"}`);
  console.log(`Ignored files removed: ${r.record.ignoredRemoved.count}`);
  for (const s of r.record.endedSessions) console.log(`Ended session (now planning): ${s.sessionId} (was ${s.mode})`);
  console.log(`Removal record (signed, never overwritten): ${r.file}`);
  if (r.stillThere || r.listed) console.log("WARNING: git reported success, but the directory or its worktree entry is still present; inspect it yourself. Nothing else was done.");
  console.log("The worktree binding and every earlier record are kept. Nothing was pruned, forced, or deleted outside git's own removal.");
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  "session-start": sessionStart,
  "implement-start": implementStart,
  "review-start": reviewStart,
  "run-check": runCheck,
  "review-save": reviewSave,
  "review-status": reviewStatusCmd,
  "approve-review": approveReviewCmd,
  "ship-start": shipStartCmd,
  "ship-commit": shipCommitCmd,
  "ship-push": shipPushCmd,
  "ship-prepare-pr": shipPrepareCmd,
  "ship-pr": shipPrCmd,
  "ship-record-pr": shipRecordCmd,
  "ship-status": shipStatusCmd,
  "ship-checks": shipChecksCmd,
  "merge-start": mergeStartCmd,
  "merge-collect": mergeCollectCmd,
  "merge-verify": mergeVerifyCmd,
  "merge-run": mergeRunCmd,
  "merge-record": mergeRecordCmd,
  "merge-status": mergeStatusCmd,
  "mapping-check": mappingCheckCmd,
  "ticket-ref": ticketRefCmd,
  "assigned-jql": assignedJqlCmd,
  "mapping-status": mappingStatusCmd,
  "worktree-status": worktreeStatusCmd,
  "worktree-remove": worktreeRemoveCmd,
  "jira-start": jiraStartCmd,
  "jira-plan": jiraPlanCmd,
  "jira-confirm": jiraConfirmCmd,
  "jira-status": jiraStatusCmd,
  "jira-ledger": jiraLedgerCmd,
  "draft-path": draftPath,
  save,
  "report-save": reportSave,
  status,
  approve,
  verify,
  "attach-dir": attachDir,
  "clean-attach": cleanAttach,
};
try {
  if (!commands[command]) fail(`usage: plan-store.cjs <${Object.keys(commands).join("|")}> ...`);
  commands[command](args);
} catch (e) {
  // The approve and implement skills abort on a non-zero exit and would hide
  // the reason, so their refusals are reported on stdout with exit code 0.
  if (command === "approve") {
    console.log(`APPROVAL: REFUSED. ${e.message}`);
  } else if (command === "implement-start") {
    console.log(`IMPLEMENTATION: REFUSED. ${e.message}`);
  } else if (command === "review-start") {
    console.log(`REVIEW: REFUSED. ${e.message}`);
  } else if (command === "approve-review") {
    console.log(`REVIEW APPROVAL: REFUSED. ${e.message}`);
  } else if (command === "ship-start") {
    console.log(`SHIP: REFUSED. ${e.message}`);
  } else if (command === "merge-start") {
    console.log(`MERGE: REFUSED. ${e.message}`);
  } else if (command === "jira-start") {
    console.log(`JIRA SYNC: REFUSED. ${e.message}`);
  } else if (command === "worktree-remove") {
    console.log(`WORKTREE REMOVAL: REFUSED. ${e.message}`);
  } else {
    console.log(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
