// Developer approval of one review artifact, and the checks that bind it.
//
// A review is signed when it is saved (review-save). Approving it records a
// second signed record, review-approval-<id>.json, bound to the repository,
// ticket, approved plan, implementation report, exact review bytes, exact
// HTML report, current git tree, and the content of every changed file.
// Shipping re-runs every check here before each git or pull request step.

"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./approval.cjs");
const R = require("./review.cjs");

const { fail } = L;
const REVIEW_ID_RE = /^rv-[0-9]+$/;

function safeRelPath(p) {
  const s = String(p || "");
  if (!s || s.startsWith("-") || path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.split(/[\\/]/).includes("..")
      || s.split(/[\\/]/).includes(".git") || /[\0\r\n]/.test(s)) {
    fail(`unsafe changed-file path: ${JSON.stringify(s)}`);
  }
  return s;
}

// Content hash of every file in `paths` as it is on disk now ("-" if it was
// deleted), so that approval covers the bytes, not just the file names.
function changedFileHashes(root, paths) {
  return paths.map((p) => {
    safeRelPath(p);
    const abs = path.join(root, p);
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    if (!st) return { path: p, sha256: "-" };
    if (st.isSymbolicLink()) return { path: p, sha256: `symlink:${L.sha256Of(fs.readlinkSync(abs))}` };
    if (!st.isFile()) return { path: p, sha256: "not-a-file" };
    return { path: p, sha256: L.sha256(abs) };
  });
}

function approvalFile(t, id) {
  return path.join(R.reviewsDir(t), `review-approval-${id}.json`);
}

// Everything that makes a stored review trustworthy as evidence. Returns the
// list of problems; empty means the artifact is intact and a clean PASS.
function reviewArtifactProblems(dataDir, t, id) {
  const problems = [];
  const dir = R.reviewsDir(t);
  const file = path.join(dir, `review-${id}.json`);
  if (!fs.existsSync(file)) return { problems: [`${id} does not exist for ${t.key}`], review: null, file, fileSha256: null };
  const fileSha256 = L.sha256(file);
  const review = L.readJson(file);
  if (!review) return { problems: [`${id} is not valid JSON`], review: null, file, fileSha256 };

  if (!L.signatureValid(review, L.approvalKey(dataDir, false))) {
    problems.push(`${id} has no valid signature (edited, forged, or saved by a plugin version before Phase 6; run /jira-dev-harness:review again)`);
    return { problems, review, file, fileSha256 };
  }
  if (review.reviewId !== id) problems.push(`the file claims to be ${review.reviewId}, not ${id}`);
  if (!review.identity || review.identity.issueKey !== t.key || review.identity.site !== t.site) problems.push("the review is for a different ticket");

  const art = review.artifacts || {};
  for (const [ext, key] of [["html", "htmlSha256"], ["md", "markdownSha256"]]) {
    const f = path.join(dir, `review-${id}.${ext}`);
    if (!art[key] || !fs.existsSync(f) || L.sha256(f) !== art[key]) problems.push(`the ${ext.toUpperCase()} report was modified or is missing`);
  }
  const bundle = path.join(dir, id);
  for (const [name, key] of [["facts.json", "factsSha256"], ["diff.patch", "diffSha256"]]) {
    const f = path.join(bundle, name);
    if (!art[key] || !fs.existsSync(f) || L.sha256(f) !== art[key]) problems.push(`the review bundle's ${name} was modified or is missing`);
  }

  if (review.verdict !== "PASS") problems.push(`the verdict is ${review.verdict}, not PASS`);
  for (const [field, label] of [["failReasons", "fail reason"], ["blockReasons", "block reason"], ["seriousFindings", "open serious finding"]]) {
    if (!Array.isArray(review[field]) || review[field].length) problems.push(`the review lists ${label}s`);
  }
  const openSerious = (review.findings || []).filter((f) => !f.resolved && (f.severity === "blocker" || f.severity === "major"));
  if (openSerious.length) problems.push(`${openSerious.length} blocker or major finding(s) are unresolved`);

  const facts = review.facts || {};
  if (!facts.integrity || facts.integrity.matchesImplementationReport !== true) problems.push("the working tree did not match the implementation report when it was reviewed");
  if ((facts.instructionFileChanges || []).some((c) => !c.approvedInPlan)) problems.push("the review covers unapproved instruction-file changes");

  const checks = Array.isArray(review.checks) ? review.checks : [];
  if (!checks.some((c) => c.required)) problems.push("the review recorded no required project check");
  for (const c of checks) {
    const metaFile = path.join(bundle, "checks", `${c.id}.json`);
    const logFile = path.join(bundle, "checks", `${c.id}.log`);
    const meta = L.readJson(metaFile);
    if (!meta || meta.logSha256 !== c.logSha256 || meta.exitCode !== c.exitCode) {
      problems.push(`check ${c.id} no longer matches its recorded evidence`);
      continue;
    }
    if (!fs.existsSync(logFile) || L.sha256(logFile) !== c.logSha256) problems.push(`the log of check ${c.id} was modified or is missing`);
    if (c.required && !(c.exitCode === 0 && !c.unavailable && !c.timedOut && !c.treeChanged && c.assessment === "passed")) {
      problems.push(`required check ${c.id} (${c.name}) did not pass cleanly`);
    }
  }

  const acs = review.acceptanceCriteria || [];
  if (!acs.length) problems.push("the review lists no acceptance criteria");
  for (const ac of acs) if (ac.status !== "Verified" || !(ac.evidence || []).length) problems.push(`${ac.id} is not verified with evidence`);

  return { problems, review, file, fileSha256 };
}

// Verifies the review of record for the current repository. Throws a
// StoreError listing the reasons when anything is wrong.
//   requireRecord: the developer's approval record must exist and be valid
//   checkTree:     the working tree must still be exactly what was approved
function verifyReview(dataDir, ref, id, cwd, { requireRecord, checkTree }) {
  if (!REVIEW_ID_RE.test(id || "")) fail(`invalid review id "${id}"; expected rv-<number>`);
  const { t, s, repo } = L.verifyApproved(dataDir, ref, cwd);
  const problems = [];

  const latest = R.latestReview(t);
  if (!latest || latest.id !== id) problems.push(`${id} is not the latest review${latest ? ` (the latest is ${latest.id})` : ""}`);

  const art = reviewArtifactProblems(dataDir, t, id);
  problems.push(...art.problems);
  const review = art.review;

  if (review && review.identity) {
    const ident = review.identity;
    if (ident.planRevision !== s.n || ident.planSha256 !== s.actualHash) problems.push("the plan has a newer revision than the one reviewed");
    const report = R.latestReport(t, s.n);
    if (!report || !report.intact) problems.push("the implementation report is missing or was modified");
    else if (report.id !== ident.implementationReport) problems.push("a newer implementation report exists");
    else if (ident.implementationReportSha256 !== report.meta.reportSha256) problems.push("the implementation report differs from the one reviewed");
    if (!L.sameRepo(ident.repo, repo)) problems.push("this is not the reviewed repository");
  }

  let record = null;
  if (requireRecord) {
    record = L.readJson(approvalFile(t, id));
    if (!record) {
      problems.push(`${id} has not been approved; the developer must run /jira-dev-harness:approve-review ${t.key} ${id} <sha256>`);
    } else if (!L.signatureValid(record, L.approvalKey(dataDir, false))) {
      problems.push("the review approval record has no valid signature (edited or forged)");
      record = null;
    } else if (review) {
      const ident = review.identity;
      const checks = [
        [record.kind === "review-approval", "the record is not a review approval"],
        [record.issueKey === t.key && record.site === t.site, "the approval is for a different ticket"],
        [record.reviewId === id, "the approval is for a different review"],
        [record.reviewSha256 === art.fileSha256, "the review file changed after it was approved"],
        [record.reviewHtmlSha256 === (review.artifacts || {}).htmlSha256, "the HTML report changed after it was approved"],
        [record.planRevision === s.n && record.planSha256 === s.actualHash, "the approval is for a different plan revision"],
        [ident && record.implementationReport && record.implementationReport.id === ident.implementationReport
          && record.implementationReport.sha256 === ident.implementationReportSha256, "the approval is for a different implementation report"],
        [L.sameRepo(record.repo, repo), "the approval was given for a different repository"],
      ];
      for (const [ok, msg] of checks) if (!ok) problems.push(msg);
    }
  }

  if (checkTree && review && review.identity) {
    const now = R.treeIdentity(repo.root);
    const approved = record ? record.tree : review.identity.tree;
    if (!R.sameTree(approved, now)) problems.push(`the code changed after the review (${R.treeDifferences(approved, now).join("; ")})`);
    if (record) {
      const hashes = changedFileHashes(repo.root, record.changedFiles.map((f) => f.path));
      const bad = hashes.filter((h, i) => h.sha256 !== record.changedFiles[i].sha256).map((h) => h.path);
      if (bad.length) problems.push(`approved file contents changed: ${bad.join(", ")}`);
    }
  }

  if (problems.length) fail(`${id} cannot be used: ${problems.map((p) => `${p}`).join("; ")}`);
  return { t, s, repo, review, record, fileSha256: art.fileSha256 };
}

// Records the developer's approval of one current, PASS review.
function approveReview(dataDir, sessionId, ref, id, hash, cwd) {
  const v = verifyReview(dataDir, ref, id, cwd, { requireRecord: false, checkTree: true });
  if (hash !== v.fileSha256) fail(`the SHA-256 does not match ${id}. Its SHA-256 is ${v.fileSha256}.`);
  const { t, s, repo, review } = v;
  const file = approvalFile(t, id);

  const existing = L.readJson(file);
  if (existing) {
    try {
      verifyReview(dataDir, ref, id, cwd, { requireRecord: true, checkTree: true });
      return { ...v, already: true, record: existing, file };
    } catch {
      // An invalid record is replaced below.
    }
  }

  const tree = review.identity.tree;
  const changed = changedFileHashes(repo.root, review.facts.changedFiles);
  const record = {
    kind: "review-approval",
    issueKey: t.key,
    site: t.site,
    repo,
    planRevision: s.n,
    planSha256: s.actualHash,
    implementationReport: { id: review.identity.implementationReport, sha256: review.identity.implementationReportSha256 },
    reviewId: id,
    reviewSha256: v.fileSha256,
    reviewHtmlSha256: review.artifacts.htmlSha256,
    verdict: review.verdict,
    tree: { head: tree.head, trackedDiffSha256: tree.trackedDiffSha256, untrackedFileSha256: tree.untrackedFileSha256 },
    changedFiles: changed,
    approvedAt: new Date().toISOString(),
    sessionId,
    method: "developer typed /jira-dev-harness:approve-review (Claude Code user-only skill)",
  };
  record.hmac = L.sign(record, L.approvalKey(dataDir, true));
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return { ...v, already: false, record, file };
}

module.exports = {
  REVIEW_ID_RE, safeRelPath, changedFileHashes, approvalFile, reviewArtifactProblems, verifyReview, approveReview,
};
