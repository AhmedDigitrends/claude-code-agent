// Workflow progress: which internal stage a ticket is in, the Jira comment
// text for it, and the audit ledger of Jira actions.
//
// The stage is derived from the plugin's own signed records (plan, plan
// approval, implementation report, review, review approval, ship record,
// merge record), never from what an agent or the developer says. The ledger
// is an append-only, hash-chained, HMAC-signed JSONL file outside the
// repository.

"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./approval.cjs");
const R = require("./review.cjs");
const RA = require("./review-approval.cjs");
const M = require("./merge.cjs");

const LABELS = {
  planning: "Planning",
  "awaiting-plan-approval": "Awaiting plan approval",
  implementing: "Implementation",
  "in-review": "Review and testing",
  "awaiting-review-approval": "Awaiting developer approval of the review",
  "pr-created": "Pull request created",
  merged: "Merged",
};

// ------------------------------------------------------------------- stage

function signed(dataDir, rec) {
  return !!rec && L.signatureValid(rec, L.approvalKey(dataDir, false));
}

// Returns { stage, facts } for the ticket's latest state, or null when there
// is no plan. `stage` may be "review-approved" (approved, not yet shipped),
// which has no Jira meaning and is never synchronised.
function deriveStage(dataDir, t) {
  const s = L.latestState(t);
  if (!s) return null;
  const facts = { planRevision: s.n, planSha256: s.actualHash };
  if (!s.intact || !s.meta || s.meta.readiness !== "READY") return { stage: "planning", facts };
  if (L.approvalProblem(dataDir, t, s, s.approval, null)) return { stage: "awaiting-plan-approval", facts };

  const report = R.latestReport(t, s.n);
  if (!report || !report.intact) return { stage: "implementing", facts };
  facts.report = report.id;

  const review = R.latestReview(t);
  const rv = review && review.data;
  if (!signed(dataDir, rv) || !rv.identity || rv.identity.planRevision !== s.n || rv.identity.implementationReport !== report.id) {
    return { stage: "implementing", facts };
  }
  facts.reviewId = review.id;
  facts.reviewSha256 = L.sha256(review.file);
  facts.verdict = rv.verdict;

  const ship = M.latestShipRecord(dataDir, t);
  if (ship && ship.reviewId === review.id && ship.planRevision === s.n && ship.reviewSha256 === facts.reviewSha256) {
    facts.pr = ship.pr && ship.pr.url;
    facts.commit = ship.commit;
    const merge = M.latestMergeRecord(dataDir, t);
    if (merge && merge.reviewId === review.id && merge.commit === ship.commit) {
      facts.mergeCommit = merge.mergeCommit;
      return { stage: "merged", facts };
    }
    return { stage: "pr-created", facts };
  }
  if (rv.verdict !== "PASS") return { stage: "in-review", facts };
  const approval = L.readJson(RA.approvalFile(t, review.id));
  if (signed(dataDir, approval) && approval.reviewSha256 === facts.reviewSha256) return { stage: "review-approved", facts };
  return { stage: "awaiting-review-approval", facts };
}

// ----------------------------------------------------------------- comment

// The marker identifies one stage of one state of the work, so the same
// state is never posted twice, while a new plan revision or review is.
function markerFor(issueKey, stage, facts) {
  const id = L.sha256Of([issueKey, stage, facts.planSha256, facts.reviewSha256 || "", facts.pr || "", facts.mergeCommit || ""].join("|")).slice(0, 10);
  return `jdh:${stage}:${id}`;
}

function commentFor(issueKey, stage, facts) {
  const marker = markerFor(issueKey, stage, facts);
  const lines = [
    `[jira-dev-harness] ${LABELS[stage]} (${marker})`,
    `Plan: r${facts.planRevision} (SHA-256 ${facts.planSha256.slice(0, 12)})`,
  ];
  if (facts.reviewId) lines.push(`Independent review: ${facts.reviewId}, verdict ${facts.verdict} (SHA-256 ${facts.reviewSha256.slice(0, 12)})`);
  if (facts.pr) lines.push(`Pull request: ${facts.pr}`);
  if (facts.mergeCommit) lines.push(`Merge commit: ${facts.mergeCommit}`);
  lines.push("Posted from the plugin's own signed records. A Jira status changes only if a transition is listed in the audit trail.");
  const text = lines.join("\n");
  return { marker, text, sha256: L.sha256Of(text) };
}

// ------------------------------------------------------------------ ledger

function ledgerFile(dataDir, site, key) {
  return path.join(dataDir, "progress", site, key, "ledger.jsonl");
}

function readLedger(dataDir, site, key) {
  const file = ledgerFile(dataDir, site, key);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { corrupt: true };
    }
  });
}

// Why the ledger can't be trusted, or null.
function ledgerProblem(dataDir, site, key) {
  const entries = readLedger(dataDir, site, key);
  const k = L.approvalKey(dataDir, false);
  let prev = "";
  for (const [i, e] of entries.entries()) {
    if (e.corrupt) return `entry ${i + 1} is unreadable`;
    if (e.seq !== i + 1 || e.prev !== prev) return `entry ${i + 1} breaks the chain`;
    if (!L.signatureValid(e, k)) return `entry ${i + 1} has an invalid signature`;
    prev = L.sha256Of(JSON.stringify(e));
  }
  return null;
}

// Appends one signed entry. Never throws for the caller's audit path unless
// the ledger is already tampered with, which blocks further writes.
function appendLedger(dataDir, site, key, entry) {
  const file = ledgerFile(dataDir, site, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bad = ledgerProblem(dataDir, site, key);
  if (bad) throw new L.StoreError(`the audit ledger for ${key} is not trustworthy: ${bad}`);
  const entries = readLedger(dataDir, site, key);
  const prev = entries.length ? L.sha256Of(JSON.stringify(entries[entries.length - 1])) : "";
  // JSON round trip: fields left undefined must not be signed as the text
  // "undefined" and then vanish from the stored line.
  const rec = JSON.parse(JSON.stringify({ seq: entries.length + 1, at: new Date().toISOString(), issueKey: key, site, ...entry, prev }));
  rec.hmac = L.sign(rec, L.approvalKey(dataDir, true));
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  return rec;
}

module.exports = { LABELS, deriveStage, markerFor, commentFor, ledgerFile, readLedger, ledgerProblem, appendLedger };
