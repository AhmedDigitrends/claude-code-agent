// Renders a stored review as a standalone HTML test report and a Markdown
// summary. All content (Jira text, source code, logs, Reviewer output) is
// untrusted: every value is HTML-escaped, the page loads nothing external,
// and its only script is a status filter allowed by a CSP sha256 hash.

"use strict";

const crypto = require("crypto");
const { redact } = require("./review.cjs");

function esc(value) {
  return redact(value == null ? "" : String(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, "-");

// Pure filter logic, also exercised by the plugin's tests: given the checked
// statuses, returns which row statuses are shown.
const FILTER_SCRIPT = `(function(){
function visible(status, checked){return checked.indexOf(status) !== -1;}
function apply(){
  var boxes = document.querySelectorAll("input[data-filter]");
  var checked = [];
  for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) checked.push(boxes[i].getAttribute("data-filter"));
  var rows = document.querySelectorAll("tr[data-status]");
  var shown = 0;
  for (var j = 0; j < rows.length; j++) { var on = visible(rows[j].getAttribute("data-status"), checked); rows[j].hidden = !on; if (on) shown++; }
  var counter = document.getElementById("tc-shown");
  if (counter) counter.textContent = shown + " of " + rows.length + " shown";
}
var boxes = document.querySelectorAll("input[data-filter]");
for (var k = 0; k < boxes.length; k++) boxes[k].addEventListener("change", apply);
apply();
if (typeof window !== "undefined") window.__jdhFilter = { visible: visible, apply: apply };
})();`;

function badge(text, cls) {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function list(items) {
  return items && items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "<p class=\"muted\">None</p>";
}

// The reviewed workspace (Phase 8C): the ticket worktree with its signed
// binding, or the main checkout for a legacy in-place review.
function workspaceRows(ws) {
  if (!ws || ws.kind !== "worktree") {
    return `<dt>Reviewed workspace</dt><dd>main checkout (legacy in-place implementation)${ws && ws.path ? `: ${esc(ws.path)}` : ""}</dd>`;
  }
  return [
    `<dt>Reviewed workspace</dt><dd>ticket worktree ${esc(ws.path)}</dd>`,
    `<dt>Ticket branch</dt><dd>${esc(ws.branch)}</dd>`,
    `<dt>Approved base commit</dt><dd>${esc(ws.baseHead)}</dd>`,
    `<dt>Worktree binding</dt><dd>worktree-b${esc(ws.binding)}.json · signature ${esc(String(ws.bindingHmac).slice(0, 16))}…</dd>`,
  ].join("\n");
}

function workspaceLine(ws) {
  if (!ws || ws.kind !== "worktree") return `- Reviewed workspace: main checkout (legacy in-place implementation)`;
  return `- Reviewed workspace: ticket worktree ${ws.path}, branch ${ws.branch}, base ${ws.baseHead}, binding worktree-b${ws.binding} (signature ${String(ws.bindingHmac).slice(0, 16)}…)`;
}

function renderHtml(review, logs) {
  const id = review.identity;
  const statuses = ["Passed", "Failed", "Blocked", "Not Run"];
  const counts = Object.fromEntries(statuses.map((s) => [s, review.testCases.filter((t) => t.status === s).length]));
  const scriptHash = crypto.createHash("sha256").update(FILTER_SCRIPT).digest("base64");
  const verdictCls = review.verdict === "PASS" ? "pass" : review.verdict === "FAIL" ? "fail" : "blocked";
  const openFindings = review.findings.filter((f) => !f.resolved);

  const acRows = review.acceptanceCriteria.map((ac) => `<tr><td>${esc(ac.id)}</td><td>${esc(ac.text)}</td><td>${badge(ac.status, slug(ac.status))}</td><td>${list(ac.evidence)}</td><td>${esc(ac.testCases.join(", ") || "none")}</td></tr>`).join("");
  const tcRows = review.testCases.map((tc) => `<tr data-status="${esc(tc.status)}"><td>${esc(tc.id)}</td><td>${esc(tc.requirement)}</td><td>${esc(tc.type)}${tc.checkId ? `<br><small>${esc(tc.checkId)}</small>` : ""}</td><td><b>${esc(tc.scenario)}</b><br><small>Preconditions: ${esc(tc.preconditions || "none")}</small><ol>${tc.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></td><td>${esc(tc.expected)}</td><td>${esc(tc.actual || (tc.type === "manual" ? "Manual test: not executed" : "Not executed"))}</td><td>${badge(tc.status, slug(tc.status))}</td><td>${esc(tc.evidence)}</td></tr>`).join("");
  const checkRows = review.checks.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.name)}${c.required ? " <small>(required)</small>" : " <small>(optional)</small>"}</td><td><code>${esc(c.command)}</code></td><td>${c.exitCode === null ? "none" : esc(c.exitCode)}${c.timedOut ? " (timed out)" : ""}${c.unavailable ? " (tool unavailable)" : ""}</td><td>${esc(c.assessment)}${c.assessmentReason ? `<br><small>${esc(c.assessmentReason)}</small>` : ""}</td><td>${esc(Math.round(c.durationMs / 100) / 10)} s${c.treeChanged ? "<br><b>changed the working tree</b>" : ""}</td></tr>
<tr class="log"><td colspan="6"><details><summary>Log for ${esc(c.id)} (sha256 ${esc(c.logSha256.slice(0, 16))}…${c.logTruncated ? ", truncated" : ""})</summary><pre>${esc(logs[c.id] || "")}</pre></details></td></tr>`).join("");
  const findingRows = review.findings.map((f) => `<tr><td>${esc(f.id)}</td><td>${badge(f.severity, f.severity)}</td><td>${esc(f.title)}${f.source === "system" ? " <small>(automatic)</small>" : ""}</td><td>${esc(f.detail)}${f.evidence.length ? list(f.evidence) : ""}</td><td>${f.resolved ? "resolved" : "open"}</td></tr>`).join("");
  const fileRows = review.facts.changedFiles.map((p) => {
    const a = review.changedFiles.find((c) => c.path.replace(/\\/g, "/").toLowerCase() === p.toLowerCase());
    const outside = review.facts.filesOutsidePlan.includes(p);
    return `<tr><td><code>${esc(p)}</code></td><td>${outside ? badge("outside plan", "fail") : badge("in plan", "pass")}</td><td>${esc(a ? a.assessment : "")}</td></tr>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; img-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<title>${esc(id.issueKey)} review ${esc(review.reviewId)}: ${esc(review.verdict)}</title>
<style>
:root{--bg:#fff;--fg:#1d2433;--muted:#5d6b82;--line:#d9dee7;--pass:#0f7b3f;--fail:#b42318;--blocked:#9a5b00;--chip:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ef;--muted:#9aa4b5;--line:#2c323c;--chip:#222831;--pass:#4cc38a;--fail:#ff6b5e;--blocked:#e9a23b}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.muted,small{color:var(--muted)}code,pre{font-family:ui-monospace,Consolas,monospace;font-size:12px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--chip);padding:8px;max-height:400px;overflow:auto}
.verdict{display:inline-block;font-size:20px;font-weight:700;padding:6px 14px;border-radius:6px;color:#fff;margin:8px 0}
.verdict.pass{background:var(--pass)}.verdict.fail{background:var(--fail)}.verdict.blocked{background:var(--blocked)}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;background:var(--chip);font-size:12px;white-space:nowrap}
.badge.pass,.badge.passed,.badge.verified,.badge.info{color:var(--pass)}.badge.fail,.badge.failed,.badge.blocker,.badge.major{color:var(--fail)}
.badge.blocked,.badge.not-run,.badge.not-verified,.badge.not-verifiable,.badge.minor{color:var(--blocked)}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--chip)}dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
.filters label{margin-right:14px;white-space:nowrap}tr.log td{background:transparent}
</style>
</head>
<body>
<main>
<h1>Test report: ${esc(id.issueKey)}</h1>
<div class="muted">jira-dev-harness independent review ${esc(review.reviewId)} · ${esc(review.reviewedAt)}</div>
<div class="verdict ${verdictCls}">${esc(review.verdict)}</div>
${review.reviewerVerdict !== review.verdict ? `<p><b>Reviewer verdict ${esc(review.reviewerVerdict)} was changed to ${esc(review.verdict)} by the review rules.</b></p>` : ""}
<p>${esc(review.summary)}</p>
<p class="muted">This report is a record, not an approval. It does not authorize a pull request or merge, and opening it performs no git or Jira action. It is valid only while the working tree, plan revision, and implementation report below are unchanged; check with <code>plan-store.cjs review-status</code>.</p>

<h2>Ticket and repository</h2>
<dl>
<dt>Ticket</dt><dd>${esc(id.issueKey)} (${esc(id.site)})</dd>
<dt>Requirements source</dt><dd>${esc(review.requirementsSource)}</dd>
<dt>Approved plan</dt><dd>r${esc(id.planRevision)} · sha256 ${esc(id.planSha256)}</dd>
<dt>Implementation report</dt><dd>${esc(id.implementationReport)}</dd>
<dt>Repository (primary identity)</dt><dd>${esc(id.repo.root)}</dd>
<dt>Root commit / origin</dt><dd>${esc(id.repo.rootCommits)} / ${esc(id.repo.remote || "none")}</dd>
${workspaceRows(id.workspace)}
<dt>HEAD</dt><dd>${esc(id.tree.head)}</dd>
<dt>Tracked diff sha256</dt><dd>${esc(id.tree.trackedDiffSha256)}</dd>
<dt>Untracked files</dt><dd>${esc(id.tree.untrackedFileSha256.join(", ") || "none")}</dd>
<dt>Matches implementation report</dt><dd>${review.facts.integrity.matchesImplementationReport ? "yes" : `NO: ${esc(review.facts.integrity.differences.join("; "))}`}</dd>
<dt>Reviewed at</dt><dd>${esc(review.reviewedAt)}</dd>
</dl>

<h2>Why this verdict</h2>
${review.failReasons.length ? `<p><b>Failing conditions</b></p>${list(review.failReasons)}` : ""}
${(review.seriousFindings || []).length ? `<p><b>Open blocker or major findings from the Reviewer</b></p>${list(review.seriousFindings)}` : ""}
${review.blockReasons.length ? `<p><b>Blocking conditions</b></p>${list(review.blockReasons)}` : ""}
${!review.failReasons.length && !review.blockReasons.length && !(review.seriousFindings || []).length ? "<p>All review rules are satisfied.</p>" : ""}
${review.corrections.length ? `<p><b>Corrections applied to the Reviewer's output</b></p>${list(review.corrections)}` : ""}

<h2>Acceptance-criteria coverage</h2>
<div class="table"><table><thead><tr><th>ID</th><th>Criterion</th><th>Status</th><th>Evidence</th><th>Test cases</th></tr></thead><tbody>${acRows || '<tr><td colspan="5">None</td></tr>'}</tbody></table></div>

<h2>Test cases</h2>
<p class="filters">${statuses.map((s) => `<label><input type="checkbox" data-filter="${esc(s)}" checked> ${esc(s)} (${counts[s]})</label>`).join("")} <span id="tc-shown" class="muted"></span></p>
<p class="muted">Automated results come only from checks recorded below. Manual test cases are instructions and were not executed.</p>
<div class="table"><table><thead><tr><th>ID</th><th>Requirement</th><th>Type</th><th>Scenario and steps</th><th>Expected</th><th>Actual</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${tcRows || '<tr><td colspan="8">None</td></tr>'}</tbody></table></div>

<h2>Executed checks</h2>
<p class="muted">Run by jira-dev-harness in the reviewed workspace (${esc(id.workspace && id.workspace.kind === "worktree" ? `ticket worktree ${id.workspace.path}` : "main checkout")}) after the developer approved each command. Logs are recorded verbatim apart from credential redaction.</p>
<div class="table"><table><thead><tr><th>ID</th><th>Check</th><th>Command</th><th>Exit</th><th>Assessment</th><th>Duration</th></tr></thead><tbody>${checkRows || '<tr><td colspan="6">No checks were recorded.</td></tr>'}</tbody></table></div>

<h2>Unresolved findings (${openFindings.length})</h2>
<div class="table"><table><thead><tr><th>ID</th><th>Severity</th><th>Finding</th><th>Detail and evidence</th><th>State</th></tr></thead><tbody>${findingRows || '<tr><td colspan="5">None</td></tr>'}</tbody></table></div>

<h2>Changed files (from git)</h2>
<div class="table"><table><thead><tr><th>File</th><th>Plan scope</th><th>Reviewer assessment</th></tr></thead><tbody>${fileRows || '<tr><td colspan="3">None</td></tr>'}</tbody></table></div>
<p class="muted">Pre-existing changes excluded: ${esc(review.facts.preExistingChanges.join(", ") || "none")}</p>
${review.notes.length ? `<h2>Notes</h2>${list(review.notes)}` : ""}
</main>
<script>${FILTER_SCRIPT}</script>
</body>
</html>
`;
}

function renderMarkdown(review) {
  const id = review.identity;
  const md = (s) => redact(String(s == null ? "" : s)).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const lines = [
    `# Test report: ${md(id.issueKey)} (${md(review.reviewId)})`,
    "",
    `**Verdict: ${review.verdict}**${review.reviewerVerdict !== review.verdict ? ` (Reviewer said ${review.reviewerVerdict}; changed by the review rules)` : ""}`,
    "",
    md(review.summary),
    "",
    `- Plan: r${id.planRevision}, sha256 ${id.planSha256}`,
    `- Implementation report: ${md(id.implementationReport)}`,
    `- Repository: ${md(id.repo.root)} (root commit ${md(id.repo.rootCommits)})`,
    md(workspaceLine(id.workspace)),
    `- HEAD ${md(id.tree.head)}, tracked diff sha256 ${md(id.tree.trackedDiffSha256)}`,
    `- Reviewed at ${md(review.reviewedAt)}`,
    "",
    "## Why this verdict",
    ...review.failReasons.map((r) => `- FAIL: ${md(r)}`),
    ...review.blockReasons.map((r) => `- BLOCKED: ${md(r)}`),
    ...review.corrections.map((r) => `- Correction: ${md(r)}`),
    "",
    "## Acceptance criteria",
    "| ID | Status | Test cases | Criterion |",
    "| :- | :- | :- | :- |",
    ...review.acceptanceCriteria.map((a) => `| ${md(a.id)} | ${md(a.status)} | ${md(a.testCases.join(", "))} | ${md(a.text)} |`),
    "",
    "## Test cases",
    "| ID | Requirement | Type | Status | Scenario |",
    "| :- | :- | :- | :- | :- |",
    ...review.testCases.map((t) => `| ${md(t.id)} | ${md(t.requirement)} | ${md(t.type)} | ${md(t.status)} | ${md(t.scenario)} |`),
    "",
    "## Checks",
    "| ID | Command | Exit | Assessment |",
    "| :- | :- | :- | :- |",
    ...review.checks.map((c) => `| ${md(c.id)} | \`${md(c.command)}\` | ${c.exitCode}${c.unavailable ? " (unavailable)" : ""} | ${md(c.assessment)} |`),
    "",
    "## Open findings",
    ...review.findings.filter((f) => !f.resolved).map((f) => `- [${f.severity}] ${md(f.id)}: ${md(f.title)}`),
    "",
  ];
  return lines.join("\n");
}

// ------------------------------------------------------------ share view
//
// A sanitized, read-only copy of a saved review for publishing as a
// claude.ai artifact. It keeps the verdict, acceptance criteria, test cases,
// check results, findings, and the review SHA-256. It never contains raw
// check logs, check commands, local paths, repository locations or remotes,
// any URL, or credentials, and it has no script. It is not the approved
// artifact: approval stays bound to the signed local review and report.

// Removes credentials (the shared redaction), absolute paths, URLs, and any
// caller-supplied local strings (repository and worktree roots).
function sanitize(value, local = []) {
  let s = redact(value == null ? "" : String(value));
  for (const l of local.filter((x) => x && String(x).length > 2)) {
    for (const v of new Set([String(l), String(l).replace(/\//g, "\\"), String(l).replace(/\\/g, "/")])) s = s.split(v).join("[local path removed]");
  }
  return s
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[link removed]")
    .replace(/\b[\w.-]+@[\w.-]+:[\w.-]+\/[\w./-]+/g, "[link removed]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g, "[email removed]")
    .replace(/\\\\[^\s"'<>]+/g, "[path removed]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, "[path removed]")
    .replace(/(^|[\s("'=:])\/(?:Users|home|tmp|var|mnt|opt|private|root|etc|srv|Volumes|[a-z])\/[^\s"'<>]*/g, "$1[path removed]");
}

// Manual QA checklist script of the share view. The developer's results are
// kept only in the viewer's own browser (localStorage, keyed by ticket,
// review, and review hash); nothing is sent anywhere, and nothing here can
// approve, commit, push, merge, or change the verdict. Automated results are
// read-only: only manual test-case ids are accepted. The core functions are
// also exercised by the plugin's tests (window.__jdhQa).
const QA_SCRIPT = `(function(){
var STATUSES = ["Passed", "Failed", "Blocked", "Not Tested"];
function clean(state, ids) {
  var out = {};
  for (var i = 0; i < ids.length; i++) {
    var r = state && Object.prototype.hasOwnProperty.call(state, ids[i]) ? state[ids[i]] : null;
    out[ids[i]] = {
      status: r && STATUSES.indexOf(r.status) >= 0 ? r.status : "Not Tested",
      notes: r && typeof r.notes === "string" ? r.notes.slice(0, 2000) : ""
    };
  }
  return out;
}
function counts(state, ids) {
  var c = { "Passed": 0, "Failed": 0, "Blocked": 0, "Not Tested": 0 };
  var s = clean(state, ids);
  for (var i = 0; i < ids.length; i++) c[s[ids[i]].status] += 1;
  return c;
}
function oneLine(t) { return String(t == null ? "" : t).replace(/\\s+/g, " ").trim(); }
function exportText(d, state, now) {
  var ids = d.manual.map(function (m) { return m.id; });
  var s = clean(state, ids);
  var c = counts(s, ids);
  var out = [
    "jira-dev-harness manual QA results",
    "Ticket: " + d.issueKey,
    "Review: " + d.reviewId + " (review SHA-256 " + d.reviewSha256 + ")",
    "Automated review verdict: " + d.verdict,
    "Exported: " + now + " (kept only in this browser; not recorded by jira-dev-harness; does not approve anything)",
    "Manual: Passed " + c["Passed"] + ", Failed " + c["Failed"] + ", Blocked " + c["Blocked"] + ", Not Tested " + c["Not Tested"]
  ];
  for (var i = 0; i < d.manual.length; i++) {
    var m = d.manual[i], r = s[m.id];
    out.push("- " + m.id + " [" + r.status + "] " + oneLine(m.scenario) + (r.notes ? " | Notes: " + oneLine(r.notes) : ""));
  }
  out.push("Automated (read-only): " + (d.automated.length ? d.automated.map(function (a) { return a.id + " " + a.status + (a.checkId ? " (" + a.checkId + ")" : ""); }).join("; ") : "none"));
  return out.join("\\n");
}
var api = { STATUSES: STATUSES, clean: clean, counts: counts, exportText: exportText };
if (typeof window !== "undefined") window.__jdhQa = api;
if (typeof document === "undefined") return;
var dataEl = document.getElementById("qa-data");
if (!dataEl) return;
var d = JSON.parse(dataEl.textContent);
var ids = d.manual.map(function (m) { return m.id; });
var key = "jdh-qa:" + d.issueKey + ":" + d.reviewId + ":" + d.reviewSha256.slice(0, 16);
var state = {};
try { state = JSON.parse(window.localStorage.getItem(key) || "{}") || {}; } catch (e) { state = {}; }
state = clean(state, ids);
function note(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
function save() {
  try { window.localStorage.setItem(key, JSON.stringify(state)); note("qa-store", "Your results are saved in this browser only."); }
  catch (e) { note("qa-store", "This browser does not allow saving: your results last only until you leave this page."); }
}
function render() {
  var c = counts(state, ids);
  for (var k in c) { var el = document.querySelector('[data-count="' + k + '"]'); if (el) el.textContent = String(c[k]); }
  var cards = document.querySelectorAll("[data-qa-card]");
  for (var i = 0; i < cards.length; i++) { var s = state[cards[i].getAttribute("data-qa-card")]; if (s) cards[i].setAttribute("data-result", s.status); }
  var out = document.getElementById("qa-export");
  if (out) out.value = exportText(d, state, new Date().toISOString());
}
var radios = document.querySelectorAll("input[data-qa-id]");
for (var i = 0; i < radios.length; i++) {
  var r = radios[i], rid = r.getAttribute("data-qa-id");
  if (!state[rid]) { r.disabled = true; continue; }
  r.checked = state[rid].status === r.value;
  r.addEventListener("change", function (ev) { var t = ev.target, id = t.getAttribute("data-qa-id"); if (state[id] && STATUSES.indexOf(t.value) >= 0) { state[id].status = t.value; save(); render(); } });
}
var notes = document.querySelectorAll("textarea[data-qa-notes]");
for (var j = 0; j < notes.length; j++) {
  var n = notes[j], nid = n.getAttribute("data-qa-notes");
  if (!state[nid]) { n.disabled = true; continue; }
  n.value = state[nid].notes;
  n.addEventListener("input", function (ev) { var t = ev.target, id = t.getAttribute("data-qa-notes"); if (state[id]) { state[id].notes = String(t.value).slice(0, 2000); save(); render(); } });
}
var copy = document.getElementById("qa-copy");
if (copy) copy.addEventListener("click", function () {
  render();
  var out = document.getElementById("qa-export"), text = out ? out.value : "";
  function fallback() { if (out) { out.focus(); out.select(); } note("qa-copied", "Copying is blocked here: the text below is selected, press Ctrl+C (Cmd+C on a Mac)."); }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { note("qa-copied", "Copied."); }, fallback);
    else fallback();
  } catch (e) { fallback(); }
});
render();
})();`;

function renderShareHtml(review, reviewSha256, local = []) {
  const id = review.identity;
  const e = (v) => esc(sanitize(v, local));
  const items = (arr) => (arr && arr.length ? `<ul>${arr.map((i) => `<li>${e(i)}</li>`).join("")}</ul>` : "<p class=\"muted\">None</p>");
  const groups = [["Passed", "pass"], ["Failed", "fail"], ["Blocked", "blocked"], ["Not Run", "notrun"]];
  const counts = Object.fromEntries(groups.map(([s]) => [s, review.testCases.filter((t) => t.status === s).length]));
  const verdictCls = review.verdict === "PASS" ? "pass" : review.verdict === "FAIL" ? "fail" : "blocked";
  const tcTable = (cases) => `<div class="table"><table><thead><tr><th>ID</th><th>Requirement</th><th>Type</th><th>Scenario and steps</th><th>Expected</th><th>Actual</th><th>Evidence</th></tr></thead><tbody>${cases.map((tc) => `<tr><td>${e(tc.id)}</td><td>${e(tc.requirement)}</td><td>${e(tc.type)}${tc.checkId ? ` (${e(tc.checkId)})` : ""}</td><td><b>${e(tc.scenario)}</b>${tc.steps.length ? `<ol>${tc.steps.map((s) => `<li>${e(s)}</li>`).join("")}</ol>` : ""}</td><td>${e(tc.expected)}</td><td>${e(tc.actual || (tc.type === "manual" ? "Manual test: not executed" : "Not executed"))}</td><td>${tc.type === "automated" && tc.checkId ? `check ${e(tc.checkId)} (log not included)` : e(tc.evidence)}</td></tr>`).join("")}</tbody></table></div>`;
  // Automated cases: read-only, grouped by their recorded result.
  const automated = review.testCases.filter((t) => t.type === "automated");
  const manual = review.testCases.filter((t) => t.type !== "automated");
  const tcSections = groups.map(([s, cls]) => {
    const cases = automated.filter((t) => t.status === s);
    return `<h4><span class="badge ${cls}">${s}</span> ${cases.length}</h4>${cases.length ? tcTable(cases) : "<p class=\"muted\">None</p>"}`;
  }).join("\n");
  // Manual cases: an interactive checklist (results stay in this browser).
  const qaOptions = [["Passed", "Pass"], ["Failed", "Fail"], ["Blocked", "Blocked"], ["Not Tested", "Not Tested"]];
  const qaCards = manual.map((tc, i) => `<section class="qa-card" data-qa-card="${e(tc.id)}" data-result="Not Tested">
<h4>${e(tc.id)} <span class="muted">· ${e(tc.requirement)}</span></h4>
<p><b>${e(tc.scenario)}</b></p>
${tc.preconditions ? `<p><span class="muted">Preconditions:</span> ${e(tc.preconditions)}</p>` : ""}
${tc.steps.length ? `<ol>${tc.steps.map((s) => `<li>${e(s)}</li>`).join("")}</ol>` : "<p class=\"muted\">No steps were given.</p>"}
<p><span class="muted">Expected:</span> ${e(tc.expected) || "<span class=\"muted\">not stated</span>"}</p>
<fieldset><legend>Your result</legend>${qaOptions.map(([v, label]) => `<label><input type="radio" name="qa-${i}" value="${v}" data-qa-id="${e(tc.id)}"${v === "Not Tested" ? " checked" : ""}> ${label}</label>`).join(" ")}</fieldset>
<label class="qa-notes">Notes (optional)<textarea data-qa-notes="${e(tc.id)}" maxlength="2000" rows="2"></textarea></label>
</section>`).join("\n");
  const qaData = {
    issueKey: sanitize(id.issueKey, local),
    reviewId: sanitize(review.reviewId, local),
    reviewSha256,
    verdict: sanitize(review.verdict, local),
    manual: manual.map((tc) => ({ id: sanitize(tc.id, local), scenario: sanitize(tc.scenario, local) })),
    automated: automated.map((tc) => ({ id: sanitize(tc.id, local), status: sanitize(tc.status, local), checkId: tc.checkId ? sanitize(tc.checkId, local) : null })),
  };
  // Inert data for the checklist script; "<" is escaped so it can't end the block.
  const qaJson = JSON.stringify(qaData).replace(/</g, "\\u003c");
  const acRows = review.acceptanceCriteria.map((ac) => `<tr><td>${e(ac.id)}</td><td>${e(ac.text)}</td><td>${e(ac.status)}</td><td>${e((ac.evidence || []).join(", "))}</td><td>${e((ac.testCases || []).join(", ") || "none")}</td></tr>`).join("");
  const checkRows = review.checks.map((c) => {
    const result = c.unavailable ? "unavailable" : c.timedOut ? "timed out" : c.exitCode === 0 ? "passed" : `failed (exit ${c.exitCode})`;
    return `<tr><td>${e(c.id)}</td><td>${e(c.name)}</td><td>${c.required ? "required" : "optional"}</td><td>${e(result)}</td><td>${e(c.assessment)}</td></tr>`;
  }).join("");
  const findingRows = review.findings.map((f) => `<tr><td>${e(f.id)}</td><td>${e(f.severity)}</td><td>${e(f.title)}</td><td>${e(f.detail)}</td><td>${f.resolved ? "resolved" : "open"}</td></tr>`).join("");
  const approve = review.verdict === "PASS"
    ? `<p>The developer approves this review only in Claude Code, with <code>/jira-dev-harness:approve-review ${e(id.issueKey)} ${e(review.reviewId)} ${e(reviewSha256)}</code>. This page cannot approve anything.</p>`
    : "<p>This review did not pass; it cannot be approved.</p>";
  // Written as page content without its own document wrapper: Claude Code's
  // artifact viewer wraps the file in its own skeleton (charset, viewport).
  // A browser opening the local file directly renders it the same way.
  return `<meta charset="utf-8">
<title>${e(id.issueKey)} review report</title>
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#fff;--fg:#1d2433;--muted:#5d6b82;--line:#d9dee7;--chip:#f2f4f7;--pass:#0f7b3f;--fail:#b42318;--blocked:#9a5b00;--notrun:#5d6b82}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14171c;--fg:#e6e9ef;--muted:#9aa4b5;--line:#2c323c;--chip:#222831;--pass:#4cc38a;--fail:#ff6b5e;--blocked:#e9a23b;--notrun:#9aa4b5;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#14171c;--fg:#e6e9ef;--muted:#9aa4b5;--line:#2c323c;--chip:#222831;--pass:#4cc38a;--fail:#ff6b5e;--blocked:#e9a23b;--notrun:#9aa4b5;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding-block:24px 64px;padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px))}
input:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:15px;margin:16px 0 6px}
.muted{color:var(--muted)}code{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
.verdict{display:inline-block;font-size:20px;font-weight:700;padding:6px 14px;border-radius:6px;color:#fff;margin:8px 0}
.verdict.pass{background:var(--pass)}.verdict.fail{background:var(--fail)}.verdict.blocked{background:var(--blocked)}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;background:var(--chip);font-size:12px;font-weight:600}
.badge.pass{color:var(--pass)}.badge.fail{color:var(--fail)}.badge.blocked{color:var(--blocked)}.badge.notrun{color:var(--notrun)}
.counts span{margin-right:12px}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--chip)}
h4{font-size:14px;margin:12px 0 6px}
.qa-card{border:1px solid var(--line);border-left:4px solid var(--notrun);border-radius:6px;padding:8px 12px;margin:10px 0}
.qa-card[data-result="Passed"]{border-left-color:var(--pass)}.qa-card[data-result="Failed"]{border-left-color:var(--fail)}.qa-card[data-result="Blocked"]{border-left-color:var(--blocked)}
fieldset{border:0;padding:0;margin:6px 0}legend{font-weight:600;padding:0;margin-bottom:4px}fieldset label{margin-right:14px;white-space:nowrap}
.qa-notes{display:block}textarea{display:block;width:100%;box-sizing:border-box;margin-top:4px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:6px;font:inherit}
#qa-export{font-family:ui-monospace,Consolas,monospace;font-size:12px}
button{background:var(--chip);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:6px 12px;font:inherit;cursor:pointer}
</style>
<main>
<h1>Test report: ${e(id.issueKey)} (${e(review.reviewId)})</h1>
<div class="muted">jira-dev-harness independent review · ${e(review.reviewedAt)} · plan r${e(id.planRevision)}</div>
<div class="verdict ${verdictCls}">${e(review.verdict)}</div>
${review.reviewerVerdict !== review.verdict ? `<p><b>The Reviewer's ${e(review.reviewerVerdict)} was changed to ${e(review.verdict)} by the review rules.</b></p>` : ""}
<p>${e(review.summary)}</p>
<p class="muted">Review SHA-256: <code>${e(reviewSha256)}</code></p>
${approve}
<p class="muted">Sanitized copy. Omitted: raw check logs, check commands, local paths, repository location and remote, links, and credentials. The signed review record stays with the developer. Only the manual QA checklist below is interactive.</p>

<h2>Why this verdict</h2>
${review.failReasons.length ? `<p><b>Failing conditions</b></p>${items(review.failReasons)}` : ""}
${(review.seriousFindings || []).length ? `<p><b>Open blocker or major findings</b></p>${items(review.seriousFindings)}` : ""}
${review.blockReasons.length ? `<p><b>Blocking conditions</b></p>${items(review.blockReasons)}` : ""}
${!review.failReasons.length && !review.blockReasons.length && !(review.seriousFindings || []).length ? "<p>All review rules are satisfied.</p>" : ""}

<h2>Acceptance criteria</h2>
<div class="table"><table><thead><tr><th>ID</th><th>Criterion</th><th>Status</th><th>Evidence</th><th>Test cases</th></tr></thead><tbody>${acRows || "<tr><td colspan=\"5\">None</td></tr>"}</tbody></table></div>

<h2>Test cases</h2>
<p class="counts">${groups.map(([s, cls]) => `<span><span class="badge ${cls}">${s}</span> ${counts[s]}</span>`).join("")}</p>
<p class="muted">Recorded by the review. Automated results come only from checks the plugin executed; manual test cases were not executed by the review.</p>

<h3>Automated test cases (read-only)</h3>
<p class="muted">These results come from executed checks and cannot be changed here.</p>
${automated.length ? tcSections : "<p class=\"muted\">None</p>"}

<h3>Manual QA checklist</h3>
${manual.length ? `<p class="muted">Record your own manual testing. Your results are kept <b>only in this browser</b>: they are not saved centrally, not shared with other people who open this page, and not recorded by jira-dev-harness. They do not change the review verdict and cannot approve, commit, push, or merge anything. To keep or share them, copy them below.</p>
<p class="counts qa-counts"><span><span class="badge pass">Passed</span> <b data-count="Passed">0</b></span><span><span class="badge fail">Failed</span> <b data-count="Failed">0</b></span><span><span class="badge blocked">Blocked</span> <b data-count="Blocked">0</b></span><span><span class="badge notrun">Not Tested</span> <b data-count="Not Tested">${manual.length}</b></span></p>
<p id="qa-store" class="muted" aria-live="polite"></p>
${qaCards}
<h3>Export your QA results</h3>
<p><button type="button" id="qa-copy">Copy QA results</button> <span id="qa-copied" class="muted" aria-live="polite"></span></p>
<textarea id="qa-export" readonly rows="8" aria-label="QA results to copy"></textarea>
<script type="application/json" id="qa-data">${qaJson}</script>
<script>${QA_SCRIPT}</script>` : "<p class=\"muted\">This review has no manual test cases.</p>"}

<h2>Executed checks</h2>
<div class="table"><table><thead><tr><th>ID</th><th>Check</th><th>Kind</th><th>Result</th><th>Assessment</th></tr></thead><tbody>${checkRows || "<tr><td colspan=\"5\">No checks were recorded.</td></tr>"}</tbody></table></div>

<h2>Findings</h2>
<div class="table"><table><thead><tr><th>ID</th><th>Severity</th><th>Finding</th><th>Detail</th><th>State</th></tr></thead><tbody>${findingRows || "<tr><td colspan=\"5\">None</td></tr>"}</tbody></table></div>
</main>
`;
}

module.exports = { renderHtml, renderMarkdown, renderShareHtml, sanitize, esc, FILTER_SCRIPT, QA_SCRIPT };
