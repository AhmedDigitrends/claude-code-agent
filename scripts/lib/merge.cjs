// The separately authorized merge workflow.
//
// Nothing in the plugin merges until the developer types
// /jira-dev-harness:merge with the pull request number, the exact 40-character
// head SHA, and the merge method. Even then a merge happens only if the
// merge gate (merge-gate.cjs) passes on raw provider evidence:
//
// - gh route:  the plugin itself fetches read-only evidence with the official
//              gh, evaluates it, merges with --match-head-commit, and then
//              reads the pull request back to confirm the provider says merged.
// - MCP route: a PostToolUse hook (evidence.cjs) records the real responses of
//              the developer's GitHub MCP read tools. The guard evaluates the
//              gate before a merge tool call may reach the permission prompt,
//              and merge-record confirms the result from a recorded response.
//
// An agent's own summary is never evidence.

"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./approval.cjs");
const R = require("./review.cjs");
const RA = require("./review-approval.cjs");
const P = require("./provider.cjs");
const G = require("./merge-gate.cjs");

const { fail } = L;
const METHODS = ["squash", "merge", "rebase"];
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

// ------------------------------------------------------------ ship record

function shipRecordFile(t, reviewId) {
  return path.join(R.reviewsDir(t), `ship-${reviewId}.json`);
}

// Signed record of what was shipped, written when a pull request is recorded.
function writeShipRecord(dataDir, state) {
  const t = L.findTicketDir(dataDir, `${state.site}/${state.issueKey}`);
  const record = {
    kind: "ship-record",
    issueKey: state.issueKey,
    site: state.site,
    repo: state.repo,
    remote: state.remote,
    reviewId: state.reviewId,
    reviewSha256: state.reviewSha256,
    planRevision: state.revision,
    planSha256: state.sha256,
    commit: state.commit,
    branch: state.branch,
    base: state.base,
    approvedFiles: state.approvedFiles,
    pr: state.pr,
    createdAt: new Date().toISOString(),
  };
  record.hmac = L.sign(record, L.approvalKey(dataDir, true));
  fs.writeFileSync(shipRecordFile(t, state.reviewId), JSON.stringify(record, null, 2) + "\n");
  return record;
}

function latestShipRecord(dataDir, t) {
  const dir = R.reviewsDir(t);
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir).map((f) => /^ship-rv-([0-9]+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!ids.length) return null;
  const record = L.readJson(path.join(dir, `ship-rv-${ids[ids.length - 1]}.json`));
  return record && L.signatureValid(record, L.approvalKey(dataDir, false)) ? record : null;
}

// Signed record of a merge that the provider confirmed. Phase 7 reads it to
// know that the work is merged.
function writeMergeRecord(dataDir, state) {
  const t = L.findTicketDir(dataDir, `${state.site}/${state.issueKey}`);
  const record = {
    kind: "merge-record",
    issueKey: state.issueKey,
    site: state.site,
    repo: state.repo,
    remote: state.remote,
    reviewId: state.reviewId,
    reviewSha256: state.reviewSha256,
    commit: state.headSha,
    pr: state.pr,
    mergeCommit: state.mergeCommit,
    mergedVia: state.mergedVia,
    mergedAt: state.mergedAt,
  };
  record.hmac = L.sign(record, L.approvalKey(dataDir, true));
  fs.writeFileSync(path.join(R.reviewsDir(t), `merge-${state.reviewId}.json`), JSON.stringify(record, null, 2) + "\n");
  return record;
}

function latestMergeRecord(dataDir, t) {
  const dir = R.reviewsDir(t);
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir).map((f) => /^merge-rv-([0-9]+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!ids.length) return null;
  const record = L.readJson(path.join(dir, `merge-rv-${ids[ids.length - 1]}.json`));
  return record && L.signatureValid(record, L.approvalKey(dataDir, false)) ? record : null;
}

// ---------------------------------------------------------------- evidence

function evidenceDir(dataDir, sessionId) {
  return path.join(dataDir, "evidence", sessionId);
}

function saveEvidence(dataDir, sessionId, record, source) {
  const dir = evidenceDir(dataDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ source, ...record });
  if (body.length > MAX_EVIDENCE_BYTES) return false;
  const n = fs.readdirSync(dir).length + 1;
  fs.writeFileSync(path.join(dir, `${String(n).padStart(5, "0")}.json`), body, { flag: "wx" });
  return true;
}

function loadEvidence(dataDir, sessionId) {
  const dir = evidenceDir(dataDir, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => L.readJson(path.join(dir, f))).filter((r) => r && r.at);
}

// ------------------------------------------------------------------- start

function start(dataDir, sessionId, ref, prArg, shaArg, method, cwd) {
  if (!L.SESSION_RE.test(sessionId || "")) fail("the session could not be identified");
  if (!/^[1-9][0-9]{0,8}$/.test(prArg || "")) fail(`invalid pull request number "${prArg}"`);
  const headSha = String(shaArg || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) fail("give the pull request's full 40-character head commit SHA");
  if (!METHODS.includes(method)) fail(`give the merge method explicitly: --method ${METHODS.join("|")}`);

  const t = L.findTicketDir(dataDir, ref);
  const ship = latestShipRecord(dataDir, t);
  if (!ship) fail("nothing was shipped for this ticket (no valid ship record); run /jira-dev-harness:ship first");
  if (ship.commit !== headSha) fail(`the shipped commit is ${ship.commit}, not ${headSha}`);
  // The review approval chain must still hold. The tree is committed now, so
  // only the plan, report, review, and approval records are re-checked.
  const v = RA.verifyReview(dataDir, ref, ship.reviewId, cwd, { requireRecord: true, checkTree: false });
  if (v.fileSha256 !== ship.reviewSha256) fail("the review is not the one that was shipped");
  if (!L.sameRepo(ship.repo, v.repo)) fail("this is not the repository that was shipped");
  const remote = P.parseRemote(L.git(["config", "--get", "remote.origin.url"], v.repo.root));
  if (!remote || remote.hasCredentials || !P.detectProvider(remote, v.repo.root)) fail("origin is not a supported GitHub remote without embedded credentials");
  const warnings = [];
  if (ship.pr && ship.pr.url && !ship.pr.url.endsWith(`/pull/${prArg}`)) {
    warnings.push(`the recorded pull request is ${ship.pr.url}; the provider's own response decides which pull request #${prArg} is`);
  }
  return {
    state: {
      mode: "merging",
      stage: "started",
      issueKey: t.key,
      site: t.site,
      revision: ship.planRevision,
      sha256: ship.planSha256,
      repo: v.repo,
      remote,
      reviewId: ship.reviewId,
      reviewSha256: ship.reviewSha256,
      branch: ship.branch,
      base: ship.base,
      approvedFiles: ship.approvedFiles,
      pr: Number(prArg),
      headSha,
      method,
      startedAt: new Date().toISOString(),
    },
    warnings,
  };
}

function requireMerging(state, ...stages) {
  if (!state || state.mode !== "merging") fail("this session has no merge authorization; the developer must run /jira-dev-harness:merge");
  if (stages.length && !stages.includes(state.stage)) fail(`this step needs stage ${stages.join(" or ")}, but the session is at "${state.stage}"`);
}

// The approval chain must still hold whenever the gate is evaluated.
function chainProblem(dataDir, state) {
  try {
    const v = RA.verifyReview(dataDir, `${state.site}/${state.issueKey}`, state.reviewId, state.repo.root, { requireRecord: true, checkTree: false });
    return v.fileSha256 === state.reviewSha256 ? null : "the review changed";
  } catch (e) {
    return e.message;
  }
}

// Evaluates the gate on whatever evidence has been recorded for the session.
// With `server`, only evidence recorded from that MCP server counts (plus the
// plugin's own gh fetches), so one server's responses can't authorize a merge
// call made through another.
function gate(dataDir, state, now, server) {
  const chain = chainProblem(dataDir, state);
  const records = loadEvidence(dataDir, state.sessionId)
    .filter((r) => !server || r.source === "gh" || (/^mcp__(.+?)__/.exec(r.tool || "") || [])[1] === server)
    .map((r) => ({ ...r, data: r.data !== undefined ? r.data : G.jsonOf(r.response) }));
  const result = G.evaluate(state, records.filter((r) => r.data !== null && r.data !== undefined), now);
  if (chain) result.reasons.unshift(`the approval chain no longer holds: ${chain}`);
  result.ok = result.reasons.length === 0;
  return result;
}

// ------------------------------------------------------------- gh route

const defaultDeps = () => ({ officialGh: P.officialGh, adapter: P.GhAdapter });

function ghInfo(state, deps) {
  const info = deps.officialGh(state.repo.root, state.remote.host);
  if (!info.ok) fail(`the GitHub CLI adapter is unavailable: ${info.reason}. Use your GitHub MCP connection, or merge in the provider yourself`);
  return info;
}

function collectGh(dataDir, state, deps = defaultDeps()) {
  requireMerging(state, "started", "verified");
  const info = ghInfo(state, deps);
  const records = deps.adapter.mergeEvidence(info, state.remote, state.pr, state.base, state.headSha);
  for (const r of records) saveEvidence(dataDir, state.sessionId, r, "gh");
  return records.length;
}

function verify(dataDir, state, now = Date.now()) {
  requireMerging(state, "started", "verified");
  const result = gate(dataDir, state, now);
  return { result, state: result.ok ? { ...state, stage: "verified", verifiedAt: new Date(now).toISOString() } : state };
}

// Fetches fresh evidence, re-evaluates the gate, merges with the head SHA
// pinned, and confirms the result from the provider.
function runGh(dataDir, state, deps = defaultDeps()) {
  requireMerging(state, "started", "verified");
  const info = ghInfo(state, deps);
  const fresh = deps.adapter.mergeEvidence(info, state.remote, state.pr, state.base, state.headSha);
  for (const r of fresh) saveEvidence(dataDir, state.sessionId, r, "gh");
  const chain = chainProblem(dataDir, state);
  const result = G.evaluate(state, fresh);
  if (chain) result.reasons.unshift(`the approval chain no longer holds: ${chain}`);
  if (chain || !result.ok) fail(`merge blocked: ${result.reasons.join("; ")}`);

  deps.adapter.mergePullRequest(info, state.remote, { number: state.pr, sha: state.headSha, method: state.method });

  const after = deps.adapter.mergeEvidence(info, state.remote, state.pr, state.base, state.headSha).find((r) => G.classify(r.tool, r.data) === "pr");
  for (const r of after ? [after] : []) saveEvidence(dataDir, state.sessionId, r, "gh");
  return confirmMerged(state, after, "github-cli");
}

// A merge counts only if a provider response says so.
function confirmMerged(state, prRecord, via) {
  const pr = prRecord && prRecord.data;
  if (!pr || pr.number !== state.pr || pr.merged !== true) {
    fail("the provider did not confirm that the pull request is merged; check its page before relying on it");
  }
  const baseRepo = pr.base && pr.base.repo && pr.base.repo.full_name;
  if (String(baseRepo).toLowerCase() !== `${state.remote.owner}/${state.remote.name}`.toLowerCase()) fail("the provider's pull request is in another repository");
  if (String(pr.head && pr.head.sha).toLowerCase() !== state.headSha) fail("the merged pull request's head is not the authorized commit");
  if (typeof pr.merge_commit_sha !== "string" || !/^[0-9a-f]{40}$/i.test(pr.merge_commit_sha)) fail("the provider did not report a merge commit");
  return { ...state, stage: "merged", mergedAt: new Date().toISOString(), mergeCommit: pr.merge_commit_sha, mergedVia: via };
}

// MCP route: after the merge tool ran, the developer's MCP read tool must
// have returned the pull request as merged; that recorded response decides.
function recordMcp(dataDir, state) {
  requireMerging(state, "started", "verified");
  const prs = loadEvidence(dataDir, state.sessionId)
    .map((r) => ({ ...r, data: r.data !== undefined ? r.data : G.jsonOf(r.response) }))
    .filter((r) => r.source === "mcp" && G.classify(r.tool, r.data) === "pr" && Date.parse(r.at) >= Date.parse(state.verifiedAt || state.startedAt));
  const latest = prs[prs.length - 1];
  if (!latest) fail("no pull request response was recorded after verification; read the pull request with your GitHub MCP tool first");
  return confirmMerged(state, latest, "github-mcp");
}

module.exports = {
  METHODS, shipRecordFile, writeShipRecord, latestShipRecord, writeMergeRecord, latestMergeRecord, evidenceDir, saveEvidence, loadEvidence,
  start, requireMerging, gate, collectGh, verify, runGh, recordMcp, confirmMerged,
};
