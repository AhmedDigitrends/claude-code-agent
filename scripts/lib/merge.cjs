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

// Fields of a ship record that a later revision may never change.
const SHIP_IMMUTABLE = ["kind", "issueKey", "site", "repo", "layout", "workspace", "reviewApprovalSha256", "remote", "reviewId", "reviewSha256", "planRevision", "planSha256", "commit", "branch", "base", "approvedFiles"];

function shipRevisionFile(t, reviewId, k) {
  return k === 1 ? shipRecordFile(t, reviewId) : path.join(R.reviewsDir(t), `ship-${reviewId}-r${k}.json`);
}

// The verified revision chain of one review's ship record: r1 is
// ship-<id>.json, later corrections are ship-<id>-r<k>.json. Each revision is
// signed, names the SHA-256 of the one before it, and keeps every immutable
// field. Returns the revisions, or null if any of them does not verify.
function shipChain(dataDir, t, reviewId) {
  const key = L.approvalKey(dataDir, false);
  const out = [];
  for (let k = 1; ; k += 1) {
    const file = shipRevisionFile(t, reviewId, k);
    if (!fs.existsSync(file)) break;
    const r = L.readJson(file);
    if (!r || !L.signatureValid(r, key) || (r.revision || 1) !== k) return null;
    if (k > 1) {
      const prev = out[k - 2];
      if (r.previousSha256 !== prev.sha256) return null;
      if (SHIP_IMMUTABLE.some((f) => JSON.stringify(r[f]) !== JSON.stringify(prev.record[f]))) return null;
    }
    out.push({ k, file, record: r, sha256: L.sha256(file) });
  }
  // Any revision file beyond the chain (a gap, or revisions without r1)
  // means a revision was removed or inserted: nothing verifies then.
  const dir = R.reviewsDir(t);
  const extra = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => new RegExp(`^ship-${reviewId}-r([0-9]+)\\.json$`).exec(f)).filter(Boolean).map((m) => Number(m[1])) : [];
  if (extra.some((k) => k > out.length)) return null;
  return out;
}

// Signed record of what was shipped, written when a pull request is
// recorded. It is never overwritten: a later correction of the pull request
// details is appended as a new signed revision that names the previous one.
function writeShipRecord(dataDir, state) {
  const t = L.findTicketDir(dataDir, `${state.site}/${state.issueKey}`);
  const record = {
    kind: "ship-record",
    issueKey: state.issueKey,
    site: state.site,
    repo: state.repo,
    // Phase 8C: where it was shipped from (the signed worktree binding, or
    // the main checkout for a legacy in-place ticket), and the exact
    // developer review approval it was shipped under.
    layout: state.layout || "legacy-in-place",
    ...(state.workspace ? { workspace: state.workspace } : {}),
    ...(state.reviewApprovalSha256 ? { reviewApprovalSha256: state.reviewApprovalSha256 } : {}),
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
  const key = L.approvalKey(dataDir, true);
  const chain = shipChain(dataDir, t, state.reviewId);
  if (chain === null) fail(`the existing ship record of ${state.reviewId} does not verify; nothing was recorded`);
  record.revision = chain.length + 1;
  if (chain.length) {
    const prev = chain[chain.length - 1];
    const changed = SHIP_IMMUTABLE.filter((f) => JSON.stringify(record[f]) !== JSON.stringify(prev.record[f]));
    if (changed.length) fail(`a ship record for ${state.reviewId} already exists with a different ${changed.join(", ")}; it is never replaced. Nothing was recorded`);
    record.previousSha256 = prev.sha256;
  }
  record.hmac = L.sign(record, key);
  fs.writeFileSync(shipRevisionFile(t, state.reviewId, record.revision), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  return record;
}

// The latest verified revision of the newest review's ship record, or null
// (no record, or a record or revision that does not verify: fail closed).
function latestShipRecord(dataDir, t) {
  const dir = R.reviewsDir(t);
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir).map((f) => /^ship-rv-([0-9]+)(-r[0-9]+)?\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!ids.length) return null;
  const chain = shipChain(dataDir, t, `rv-${ids[ids.length - 1]}`);
  return chain && chain.length ? chain[chain.length - 1].record : null;
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
  // Immutable: a merge confirmed by the provider is recorded once. A repeat
  // confirmation of the same merge keeps the existing record; anything else
  // is refused.
  const file = path.join(R.reviewsDir(t), `merge-${state.reviewId}.json`);
  if (fs.existsSync(file)) {
    const existing = L.readJson(file);
    const valid = existing && L.signatureValid(existing, L.approvalKey(dataDir, false));
    if (valid && existing.commit === record.commit && existing.mergeCommit === record.mergeCommit) return existing;
    if (valid) fail(`a different merge record for ${state.reviewId} already exists; it is never replaced`);
    // An unsigned or edited file is not a record: keep it under a new name
    // (never overwritten) and write the confirmed one.
    const old = fs.readFileSync(file);
    for (let k = 1; ; k += 1) {
      try {
        fs.writeFileSync(file.replace(/\.json$/, `-replaced-${k}.json`), old, { flag: "wx" });
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    fs.rmSync(file);
  }
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
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
  const v = RA.verifyReview(dataDir, ref, ship.reviewId, cwd, { requireRecord: true, checkTree: false, allowRemovedWorkspace: true });
  if (v.fileSha256 !== ship.reviewSha256) fail("the review is not the one that was shipped");
  if (!L.sameRepo(ship.repo, v.repo)) fail("this is not the repository that was shipped");
  const shipProblem = shipBindingProblem(t, ship, v, Number(prArg));
  if (shipProblem) fail(shipProblem);
  const remote = P.parseRemote(L.git(["config", "--get", "remote.origin.url"], v.repo.root));
  if (!remote || remote.hasCredentials || !P.detectProvider(remote, v.repo.root)) fail("origin is not a supported GitHub remote without embedded credentials");
  // The merge targets exactly the repository that was shipped to.
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  if (ship.remote && (!same(remote.host, ship.remote.host) || !same(remote.owner, ship.remote.owner) || !same(remote.name, ship.remote.name))) {
    fail(`origin is ${remote.host}/${remote.owner}/${remote.name}, but the ticket was shipped to ${ship.remote.host}/${ship.remote.owner}/${ship.remote.name}`);
  }
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
      layout: ship.layout || "legacy-in-place",
      ...(ship.workspace ? { workspace: ship.workspace } : {}),
      ...(ship.reviewApprovalSha256 ? { reviewApprovalSha256: ship.reviewApprovalSha256 } : {}),
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

// Phase 8C: a ship record from a ticket worktree must still match the
// reviewed workspace (the same signed binding, which verifyReview has just
// re-verified) and the exact developer review approval it was shipped under.
// A worktree ship record never falls back to the main checkout.
function shipBindingProblem(t, ship, v, prNumber) {
  const worktree = ship.layout === "worktree" || !!(ship.workspace && ship.workspace.kind === "worktree") || v.workspace.kind === "worktree";
  if (worktree && !R.sameWorkspace(ship.workspace, v.workspace)) return "the shipped worktree is not the reviewed one (binding, branch, or base changed)";
  if (ship.workspace && ship.workspace.kind === "worktree" && ship.branch !== ship.workspace.branch) return "the shipped branch is not the worktree's branch";
  if (ship.reviewApprovalSha256) {
    const file = RA.approvalFile(t, ship.reviewId);
    if (!fs.existsSync(file) || L.sha256(file) !== ship.reviewApprovalSha256) return "the developer's review approval changed since the ticket was shipped";
  }
  // After an authorized removal, the worktree can no longer be inspected, so
  // the signed removal record must agree with the immutable ship evidence:
  // the removed worktree's HEAD, and its origin branch, are the shipped
  // commit, and the pull request is the recorded one. It never replaces the
  // review, the approvals, or this merge authorization.
  const rem = v.workspaceRemoval;
  if (rem) {
    if (!worktree) return "a removal record is only valid for a worktree ticket";
    if (!L.sameRepo(rem.primary, ship.repo)) return "the removal record is for another repository than the ship record";
    if (rem.head !== ship.commit) return `the worktree was removed at ${rem.head}, not at the shipped commit ${ship.commit}`;
    if (!rem.pushed || rem.pushed.commit !== ship.commit) return "the removal record does not show the shipped commit on origin";
    if (rem.branch !== ship.branch) return "the removed worktree's branch is not the shipped branch";
    if (!ship.pr || !ship.pr.url || !String(ship.pr.url).endsWith(`/pull/${prNumber}`)) {
      return `the ship record's pull request (${ship.pr && ship.pr.url}) is not #${prNumber}; after a worktree removal the pull request must match exactly`;
    }
  }
  return null;
}

// The approval chain must still hold whenever the gate is evaluated.
function chainProblem(dataDir, state) {
  try {
    const v = RA.verifyReview(dataDir, `${state.site}/${state.issueKey}`, state.reviewId, state.repo.root, { requireRecord: true, checkTree: false, allowRemovedWorkspace: true });
    if (v.fileSha256 !== state.reviewSha256) return "the review changed";
    const t = L.findTicketDir(dataDir, `${state.site}/${state.issueKey}`);
    // The current ship record (latest verified revision) must still be the
    // one this merge was authorized for.
    const ship = latestShipRecord(dataDir, t);
    if (!ship || ship.reviewId !== state.reviewId || ship.commit !== state.headSha) return "the ship record no longer verifies or no longer names the authorized commit";
    return shipBindingProblem(t, { ...ship, ...state, pr: ship.pr }, v, state.pr);
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
  const info = deps.officialGh([state.repo.root, state.workspace && state.workspace.path].filter(Boolean), state.remote.host);
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
