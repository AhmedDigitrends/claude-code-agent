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

module.exports = { renderHtml, renderMarkdown, esc, FILTER_SCRIPT };
