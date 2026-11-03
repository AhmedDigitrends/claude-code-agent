// Review support for plan-store.cjs: deterministic review facts, recorded
// check evidence, verdict enforcement, and review staleness.
//
// Everything the Reviewer is asked to judge is computed here from git and
// the plan store, not taken from the Developer's report. Everything the
// Reviewer returns is checked here before it is stored, so that a verdict
// cannot claim more than the recorded evidence supports.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./approval.cjs");

const { fail } = L;
const CHECK_NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_LOG_BYTES = 200 * 1024;
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const VERDICTS = ["PASS", "FAIL", "BLOCKED"];
const SEVERITIES = ["blocker", "major", "minor", "info"];
const TC_STATUSES = ["Passed", "Failed", "Blocked", "Not Run"];
const AC_STATUSES = ["Verified", "Not verified", "Failed", "Not verifiable"];
const CHECK_ASSESSMENTS = ["passed", "failed-by-change", "pre-existing-failure", "environment-unavailable", "not-relevant"];

// ------------------------------------------------------------- redaction

// Masks common credential shapes in logs and other untrusted text before it
// is stored or rendered.
function redact(text) {
  return String(text)
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, "[redacted-jwt]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted-token]")
    .replace(/([?&](?:token|access_token|api_key|apikey|key|sig|signature|client_secret|password)=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|secret|password|passwd|token)\s*[=:]\s*)["']?[^\s"',;]{6,}/gi, "$1[redacted]");
}

// --------------------------------------------------------- working tree

// Identity of the working tree: HEAD, the tracked diff, and every untracked
// file's content. Any code change alters it.
function treeIdentity(root) {
  const status = L.gitStatus(root);
  const untracked = status.filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).replace(/^"|"$/g, "")).sort();
  const untrackedFileSha256 = untracked.map((f) => {
    const p = path.join(root, f);
    return `${f}:${fs.existsSync(p) && fs.statSync(p).isFile() ? L.sha256(p) : "-"}`;
  });
  return {
    head: L.git(["rev-parse", "HEAD"], root),
    trackedDiffSha256: L.sha256Of(L.git(["diff", "HEAD", "--binary"], root, { binary: true })),
    untrackedFileSha256,
    status,
  };
}

function sameTree(a, b) {
  return !!a && !!b && a.head === b.head && a.trackedDiffSha256 === b.trackedDiffSha256
    && JSON.stringify(a.untrackedFileSha256) === JSON.stringify(b.untrackedFileSha256);
}

function treeDifferences(expected, actual) {
  const out = [];
  if (expected.headNow !== undefined ? expected.headNow !== actual.head : expected.head !== actual.head) out.push("HEAD moved");
  if (expected.trackedDiffSha256 !== actual.trackedDiffSha256) out.push("tracked changes differ (diff hash mismatch)");
  if (JSON.stringify(expected.untrackedFileSha256) !== JSON.stringify(actual.untrackedFileSha256)) out.push("untracked files differ");
  return out;
}

// ------------------------------------------------------------ plan text

function section(planText, heading) {
  const re = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im");
  const m = re.exec(planText);
  return m ? m[1] : "";
}

// Repo-relative paths named in backticks in the plan's "Files likely to change".
function plannedFiles(planText) {
  return [...section(planText, "Files likely to change").matchAll(/`([^`\s]+)`/g)].map((m) => m[1].replace(/\\/g, "/").replace(/^\.\//, ""));
}

function approvedRuleFiles(planText) {
  return section(planText, "Proposed project-rule updates").split(/\r?\n/)
    .map((l) => l.replace(/`/g, ""))
    .filter((l) => /apply in implementation:\s*\**\s*yes\b/i.test(l))
    .map((l) => (/File:\s*([^\s|]+)/i.exec(l) || [])[1])
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));
}

const INSTRUCTION_FILE = /(^|\/)(claude\.md|claude\.local\.md|agents\.md|specification\.md|contributing\.md)$|^\.claude\/rules\/.+\.md$/i;

function pathOf(statusLine) {
  return statusLine.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, "");
}

// ------------------------------------------------------------- reports

function latestReport(t, revision) {
  const reports = fs.readdirSync(t.dir)
    .map((f) => new RegExp(`^impl-r${revision}-([0-9]+)\\.json$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  if (!reports.length) return null;
  const k = reports[reports.length - 1];
  const json = path.join(t.dir, `impl-r${revision}-${k}.json`);
  const md = path.join(t.dir, `impl-r${revision}-${k}.md`);
  const meta = L.readJson(json);
  const intact = !!meta && fs.existsSync(md) && L.sha256(md) === meta.reportSha256;
  return { id: `impl-r${revision}-${k}`, json, md, meta, intact };
}

function reviewsDir(t) {
  return path.join(t.dir, "reviews");
}

function latestReview(t) {
  const dir = reviewsDir(t);
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir).map((f) => /^review-rv-([0-9]+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!ids.length) return null;
  const n = ids[ids.length - 1];
  return { id: `rv-${n}`, file: path.join(dir, `review-rv-${n}.json`), data: L.readJson(path.join(dir, `review-rv-${n}.json`)) };
}

function findReview(t, id) {
  const file = path.join(reviewsDir(t), `review-${id}.json`);
  return fs.existsSync(file) ? { id, file, data: L.readJson(file) } : null;
}

// ---------------------------------------------------------- review start

// Verifies that the latest revision is approved and implemented in this
// repository, computes the review facts, writes a review bundle, and returns
// the session state for "reviewing" mode.
function startReview(dataDir, ref, cwd) {
  const { t, s, repo } = L.verifyApproved(dataDir, ref, cwd);
  const report = latestReport(t, s.n);
  if (!report) fail(`r${s.n} has no implementation report yet. Run /jira-dev-harness:implement first.`);

  const planText = fs.readFileSync(s.planFile, "utf8");
  const identity = treeIdentity(repo.root);
  const baseline = new Set(report.meta.preExistingChanges || []);
  const changedNow = identity.status.filter((l) => !baseline.has(l));
  const changedPaths = [...new Set(changedNow.map(pathOf))].sort();
  const planned = plannedFiles(planText).map((p) => p.toLowerCase());
  const approvedRules = approvedRuleFiles(planText).map((p) => p.toLowerCase());
  const outOfPlan = changedPaths.filter((p) => !planned.includes(p.toLowerCase()));
  const instructionChanges = changedPaths.filter((p) => INSTRUCTION_FILE.test(p))
    .map((p) => ({ path: p, approvedInPlan: approvedRules.includes(p.toLowerCase()) }));
  const differences = treeDifferences(report.meta, identity);

  const dir = reviewsDir(t);
  fs.mkdirSync(dir, { recursive: true });
  let n = fs.readdirSync(dir).filter((f) => /^rv-[0-9]+$/.test(f)).length + 1;
  let bundle;
  for (;;) {
    bundle = path.join(dir, `rv-${n}`);
    try {
      fs.mkdirSync(bundle);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n += 1;
    }
  }
  fs.mkdirSync(path.join(bundle, "checks"));
  const diffText = L.git(["diff", "HEAD"], repo.root, { binary: true });
  fs.writeFileSync(path.join(bundle, "diff.patch"), redact(diffText.toString("utf8")), { flag: "wx" });
  const facts = {
    reviewId: `rv-${n}`,
    issueKey: t.key,
    site: t.site,
    planRevision: s.n,
    planSha256: s.actualHash,
    planFile: s.planFile.replace(/\\/g, "/"),
    approvalFile: path.join(t.dir, `approval-r${s.n}.json`).replace(/\\/g, "/"),
    implementationReport: { id: report.id, file: report.md.replace(/\\/g, "/"), intact: report.intact, meta: report.meta },
    repo,
    identityAtStart: identity,
    integrity: { matchesImplementationReport: report.intact && differences.length === 0, differences: report.intact ? differences : ["the implementation report file was modified after it was saved", ...differences] },
    preExistingChanges: report.meta.preExistingChanges || [],
    changedSinceAuthorization: changedNow,
    changedFiles: changedPaths,
    plannedFiles: plannedFiles(planText),
    filesOutsidePlan: outOfPlan,
    instructionFileChanges: instructionChanges,
    untrackedFiles: identity.untrackedFileSha256.map((u) => u.replace(/:[^:]*$/, "")),
    diffFile: path.join(bundle, "diff.patch").replace(/\\/g, "/"),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(bundle, "facts.json"), JSON.stringify(facts, null, 2) + "\n", { flag: "wx" });
  return {
    facts,
    bundle: bundle.replace(/\\/g, "/"),
    state: {
      mode: "reviewing",
      issueKey: t.key,
      site: t.site,
      revision: s.n,
      sha256: s.actualHash,
      planFile: facts.planFile,
      repo,
      reviewId: facts.reviewId,
      reviewBundle: bundle.replace(/\\/g, "/"),
    },
  };
}

// ------------------------------------------------------------ run-check

function looksUnavailable(status, output) {
  return status === 127 || status === 9009
    || /command not found|is not recognized as an internal or external command|was not found; run without arguments|No such file or directory.*(python|node|npm|java|go|cargo|dotnet|mvn|gradle)/i.test(output);
}

function truncateLog(text) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_LOG_BYTES) return { text, truncated: false };
  const half = Math.floor(MAX_LOG_BYTES / 2);
  return {
    text: `${buf.subarray(0, half).toString("utf8")}\n\n[... ${buf.length - MAX_LOG_BYTES} bytes omitted ...]\n\n${buf.subarray(buf.length - half).toString("utf8")}`,
    truncated: true,
  };
}

// Runs one project command in the repository root for a reviewing session
// and records it as immutable evidence. The guard makes Claude Code ask the
// developer before every invocation.
function runCheck(state, name, required, command) {
  if (!state || state.mode !== "reviewing") fail("checks can only be recorded in a review session started with /jira-dev-harness:review");
  if (!CHECK_NAME_RE.test(name || "")) fail(`invalid check name: ${name}`);
  if (!["required", "optional"].includes(required)) fail('the fourth argument must be "required" or "optional"');
  if (!command || !command.trim()) fail("no command given");
  const checksDir = path.join(state.reviewBundle, "checks");
  if (!fs.existsSync(checksDir)) fail("the review bundle is missing");
  const root = state.repo.root;
  const before = treeIdentity(root);
  const started = Date.now();
  const r = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const durationMs = Date.now() - started;
  const after = treeIdentity(root);
  const raw = `${r.stdout || ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}${r.error ? `\n[error] ${r.error.message}` : ""}`;
  const { text, truncated } = truncateLog(redact(raw));
  const exitCode = typeof r.status === "number" ? r.status : null;

  let n = fs.readdirSync(checksDir).filter((f) => /^C[0-9]+\.json$/.test(f)).length + 1;
  for (;;) {
    try {
      fs.writeFileSync(path.join(checksDir, `C${n}.log`), text, { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n += 1;
    }
  }
  const meta = {
    id: `C${n}`,
    name,
    required: required === "required",
    command: redact(command),
    cwd: root,
    startedAt: new Date(started).toISOString(),
    durationMs,
    exitCode,
    signal: r.signal || null,
    timedOut: !!(r.error && r.error.code === "ETIMEDOUT"),
    unavailable: looksUnavailable(exitCode, raw),
    treeChanged: !sameTree(before, after),
    treeChanges: sameTree(before, after) ? [] : treeDifferences(before, after),
    logFile: path.join(checksDir, `C${n}.log`).replace(/\\/g, "/"),
    logSha256: L.sha256Of(text),
    logTruncated: truncated,
  };
  fs.writeFileSync(path.join(checksDir, `C${n}.json`), JSON.stringify(meta, null, 2) + "\n", { flag: "wx" });
  return meta;
}

function loadChecks(bundle) {
  const dir = path.join(bundle, "checks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^C[0-9]+\.json$/.test(f))
    .map((f) => L.readJson(path.join(dir, f))).filter(Boolean)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

// ------------------------------------------------------- verdict rules

const str = (v, max = 4000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);

// Normalizes the Reviewer's JSON and applies the review rules. Returns the
// stored review: the Reviewer's content, corrected where it claimed more
// than the evidence shows, plus the enforced verdict and every reason.
function enforce(input, facts, checks, identityAtSave) {
  const corrections = [];
  // failReasons from the system or from criteria; findingFailReasons from
  // the Reviewer's own blocker/major findings (see the verdict rule below).
  const failReasons = [];
  const findingFailReasons = [];
  const blockReasons = [];
  const byCheck = new Map(checks.map((c) => [c.id, c]));
  const checkPassed = (c) => c && c.exitCode === 0 && !c.unavailable && !c.timedOut;

  const reviewerVerdict = VERDICTS.includes(input.verdict) ? input.verdict : "BLOCKED";
  if (!VERDICTS.includes(input.verdict)) corrections.push(`Reviewer verdict "${str(input.verdict, 40)}" is not PASS, FAIL, or BLOCKED; treated as BLOCKED.`);

  const findings = arr(input.findings).map((f, i) => ({
    id: str(f.id, 20) || `F${i + 1}`,
    severity: SEVERITIES.includes(f.severity) ? f.severity : "major",
    title: str(f.title, 300),
    detail: str(f.detail),
    evidence: arr(f.evidence).map((e) => str(e, 500)),
    resolved: f.resolved === true,
    source: "reviewer",
  }));
  const addFinding = (severity, title, detail) => {
    findings.push({ id: `S${findings.filter((f) => f.source === "system").length + 1}`, severity, title, detail, evidence: [], resolved: false, source: "system" });
  };

  if (!facts.integrity.matchesImplementationReport) {
    addFinding("blocker", "Working tree does not match the implementation report", facts.integrity.differences.join("; "));
  }
  // The review's own evidence is unreliable if the tree moved under it. That
  // is not an implementation defect, so it blocks rather than fails.
  if (!sameTree(facts.identityAtStart, identityAtSave)) {
    const diff = treeDifferences(facts.identityAtStart, identityAtSave).join("; ");
    addFinding("minor", "Working tree changed during the review", diff);
    blockReasons.push(`the working tree changed during the review (${diff}); the evidence may not describe the reviewed code`);
  }
  for (const ic of facts.instructionFileChanges.filter((x) => !x.approvedInPlan)) {
    addFinding("blocker", `Unapproved change to instruction file ${ic.path}`, 'The approved plan does not list this file with "Apply in implementation: yes".');
  }
  for (const c of checks.filter((x) => x.treeChanged)) {
    addFinding("minor", `Check ${c.id} (${c.name}) changed the working tree`, c.treeChanges.join("; "));
    blockReasons.push(`check ${c.id} (${c.name}) changed the working tree while running`);
  }

  // Check assessments: every recorded check must be accounted for.
  const assessments = new Map(arr(input.checkAssessments).map((a) => [str(a.checkId, 20), {
    assessment: CHECK_ASSESSMENTS.includes(a.assessment) ? a.assessment : "failed-by-change",
    reason: str(a.reason, 1000),
  }]));
  const checkResults = checks.map((c) => {
    let a = assessments.get(c.id);
    if (checkPassed(c)) {
      if (a && a.assessment !== "passed" && a.assessment !== "not-relevant") corrections.push(`${c.id} exited 0; assessment "${a.assessment}" replaced with "passed".`);
      a = { assessment: a && a.assessment === "not-relevant" ? "not-relevant" : "passed", reason: a ? a.reason : "" };
    } else if (!a || a.assessment === "passed") {
      const auto = c.unavailable ? "environment-unavailable" : "failed-by-change";
      if (a) corrections.push(`${c.id} did not pass (exit ${c.exitCode}); assessment "passed" replaced with "${auto}".`);
      else corrections.push(`${c.id} was not assessed by the Reviewer; recorded as "${auto}".`);
      a = { assessment: auto, reason: a ? a.reason : "" };
    }
    if (c.required) {
      if (a.assessment === "failed-by-change") failReasons.push(`required check ${c.id} (${c.name}) failed`);
      if (a.assessment === "environment-unavailable") blockReasons.push(`required check ${c.id} (${c.name}) could not run: tool or environment unavailable`);
      if (a.assessment === "pre-existing-failure") blockReasons.push(`required check ${c.id} (${c.name}) has a failure the Reviewer attributes to pre-existing code; it still prevents a clean PASS`);
      if (a.assessment === "not-relevant") blockReasons.push(`required check ${c.id} (${c.name}) was marked not relevant`);
    }
    return { ...c, assessment: a.assessment, assessmentReason: a.reason };
  });
  if (!checks.some((c) => c.required)) blockReasons.push("no required project check was recorded for this review");

  // Test cases: executed results must come from recorded checks.
  const testCases = arr(input.testCases).map((tc, i) => {
    const out = {
      id: str(tc.id, 20) || `TC${i + 1}`,
      requirement: str(tc.requirement, 60),
      scenario: str(tc.scenario, 1000),
      preconditions: str(tc.preconditions, 1000),
      steps: arr(tc.steps).map((s) => str(s, 500)),
      expected: str(tc.expected, 1000),
      type: tc.type === "automated" ? "automated" : "manual",
      checkId: tc.checkId ? str(tc.checkId, 20) : null,
      actual: str(tc.actual, 2000),
      status: TC_STATUSES.includes(tc.status) ? tc.status : "Not Run",
      evidence: str(tc.evidence, 2000),
    };
    if (!TC_STATUSES.includes(tc.status)) corrections.push(`${out.id}: status "${str(tc.status, 40)}" is not valid; set to "Not Run".`);
    if (out.type === "manual" && out.status !== "Not Run" && out.status !== "Blocked") {
      corrections.push(`${out.id}: manual test cases are instructions and were not executed in this review; status "${out.status}" set to "Not Run".`);
      out.status = "Not Run";
      out.actual = "";
    }
    if (out.type === "automated" && (out.status === "Passed" || out.status === "Failed")) {
      const c = byCheck.get(out.checkId);
      if (!c) {
        corrections.push(`${out.id}: status "${out.status}" cites no recorded check (${out.checkId || "none"}); set to "Not Run".`);
        out.status = "Not Run";
        out.actual = "";
      } else if (out.status === "Passed" && !checkPassed(c)) {
        corrections.push(`${out.id}: claims "Passed" but ${c.id} exited ${c.exitCode}${c.unavailable ? " (unavailable)" : ""}; set to "${c.unavailable ? "Blocked" : "Failed"}".`);
        out.status = c.unavailable ? "Blocked" : "Failed";
      }
    }
    return out;
  });

  // Acceptance criteria: "Verified" needs evidence and a traced test case.
  const acs = arr(input.acceptanceCriteria).map((ac, i) => {
    const out = {
      id: str(ac.id, 20) || `AC${i + 1}`,
      text: str(ac.text, 2000),
      status: AC_STATUSES.includes(ac.status) ? ac.status : "Not verified",
      evidence: arr(ac.evidence).map((e) => str(e, 500)),
      testCases: testCases.filter((tc) => tc.requirement === (str(ac.id, 20) || `AC${i + 1}`)).map((tc) => tc.id),
    };
    if (out.status === "Verified") {
      const cited = out.evidence.map((e) => (/^check:(C[0-9]+)/.exec(e) || [])[1]).filter(Boolean);
      const badCite = cited.find((id) => !checkPassed(byCheck.get(id)));
      if (out.evidence.length === 0) {
        corrections.push(`${out.id}: "Verified" without evidence; set to "Not verified".`);
        out.status = "Not verified";
      } else if (badCite) {
        corrections.push(`${out.id}: "Verified" cites ${badCite}, which did not pass; set to "Not verified".`);
        out.status = "Not verified";
      }
    }
    if (out.testCases.length === 0) blockReasons.push(`${out.id} has no traceable test case`);
    if (out.status === "Failed") failReasons.push(`${out.id} is not met`);
    else if (out.status !== "Verified") blockReasons.push(`${out.id} is ${out.status.toLowerCase()}`);
    return out;
  });
  if (acs.length === 0) blockReasons.push("the review lists no acceptance criteria");

  for (const f of findings.filter((x) => !x.resolved)) {
    if (f.severity === "blocker" || f.severity === "major") {
      (f.source === "system" ? failReasons : findingFailReasons).push(`${f.severity} finding ${f.id}: ${f.title}`);
    }
  }

  // The rules only ever take a verdict away from PASS, or turn it into FAIL
  // for defects detected by the system or by failed criteria. A Reviewer's
  // BLOCKED stays BLOCKED when its own findings describe why it could not
  // judge (for example, an unavailable environment).
  let verdict = reviewerVerdict;
  if (reviewerVerdict === "PASS") {
    if (failReasons.length || findingFailReasons.length) verdict = "FAIL";
    else if (blockReasons.length) verdict = "BLOCKED";
  } else if (reviewerVerdict === "BLOCKED" && failReasons.length) {
    verdict = "FAIL";
  }
  if (verdict !== reviewerVerdict) corrections.push(`Verdict changed from ${reviewerVerdict} to ${verdict} by the review rules.`);

  return {
    reviewerVerdict,
    verdict,
    failReasons,
    seriousFindings: findingFailReasons,
    blockReasons,
    corrections,
    summary: str(input.summary, 4000),
    requirementsSource: str(input.requirementsSource, 200),
    acceptanceCriteria: acs,
    testCases,
    findings,
    checks: checkResults,
    changedFiles: arr(input.changedFiles).map((c) => ({ path: str(c.path, 500), assessment: str(c.assessment, 2000) })),
    notes: arr(input.notes).map((n) => str(n, 2000)),
  };
}

// State of the latest review for a ticket: VALID while the working tree,
// plan revision, and implementation report are exactly what was reviewed.
function reviewStatus(dataDir, ref, cwd) {
  const t = L.findTicketDir(dataDir, ref);
  const latest = latestReview(t);
  if (!latest || !latest.data) return { t, latest: null, valid: false, reasons: ["no saved review"] };
  const d = latest.data;
  const reasons = [];
  const s = L.latestState(t);
  if (!s || s.n !== d.identity.planRevision || s.actualHash !== d.identity.planSha256) reasons.push("the plan has a newer revision than the one reviewed");
  const report = s ? latestReport(t, s.n) : null;
  if (!report || report.id !== d.identity.implementationReport) reasons.push("a newer implementation report exists");
  let repo;
  try {
    repo = L.repoIdentity(cwd);
  } catch (e) {
    reasons.push(e.message);
  }
  if (repo && !L.sameRepo(repo, d.identity.repo)) reasons.push("this is not the reviewed repository");
  if (repo && L.sameRepo(repo, d.identity.repo)) {
    const now = treeIdentity(repo.root);
    if (!sameTree(d.identity.tree, now)) reasons.push(`the code changed after the review (${treeDifferences(d.identity.tree, now).join("; ")})`);
  }
  return { t, latest, valid: reasons.length === 0, reasons };
}

module.exports = {
  redact, treeIdentity, sameTree, treeDifferences, plannedFiles, approvedRuleFiles,
  latestReport, latestReview, findReview, reviewsDir, startReview, runCheck, loadChecks, enforce, reviewStatus,
  VERDICTS, TC_STATUSES,
};
