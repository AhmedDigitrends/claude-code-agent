// Phase 5 unit tests: review-start facts, run-check evidence, verdict
// enforcement, HTML escaping and filtering, review staleness, and the
// guard's review rules. Uses real git repositories and the real scripts.
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");
const PS = path.join(ROOT, "scripts", "plan-store.cjs");
const GUARD = path.join(ROOT, "scripts", "guard.cjs");
const { FILTER_SCRIPT } = require(path.join(ROOT, "scripts", "lib", "render-review.cjs"));
const DATA = path.join(os.homedir(), ".claude", "plugins", "data", "jira-dev-harness-unittest");
const BASE = path.join(os.tmpdir(), "jdh-phase5-unit");
const SITE = "acme.atlassian.net";
const KEY = "REV-1";
const SID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SID_REV = "ffffffff-ffff-4fff-8fff-ffffffffffff";

fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
const g = (args, cwd) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, stdio: "pipe" });
const repo = path.join(BASE, "repo");
fs.mkdirSync(path.join(repo, ".claude", "rules"), { recursive: true });
fs.mkdirSync(path.join(repo, "src"));
fs.writeFileSync(path.join(repo, ".claude", "jira-dev-harness.json"), JSON.stringify({ jira: { site: SITE, projectKeys: ["REV"] } }));
fs.writeFileSync(path.join(repo, ".claude", "rules", "style.md"), "# style\n");
fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# project\n");
fs.writeFileSync(path.join(repo, "src", "add.js"), "module.exports = (a, b) => a + b;\n");
fs.writeFileSync(path.join(repo, "notes.txt"), "user notes\n");
g(["init", "-q"], repo); g(["add", "-A"], repo); g(["commit", "-qm", "init"], repo);
fs.writeFileSync(path.join(repo, "notes.txt"), "user notes, edited by the user\n"); // pre-existing change

const ps = (args, cwd = repo) => { const r = spawnSync("node", [PS, ...args], { cwd, encoding: "utf8" }); return (r.stdout || "") + (r.stderr || ""); };
let failures = 0;
const check = (ok, label, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `  -> ${String(detail).slice(0, 400)}` : ""}`); };

// Plan -> approval -> implementation -> report (the Phase 4 path, by script).
const draft = ps(["draft-path", SITE, KEY]).trim();
fs.writeFileSync(draft, `# Implementation plan: ${KEY} subtract\n\nTicket: ${KEY} (${SITE})\nReadiness: READY\n\n## Acceptance criteria\n1. sub(a,b) returns a-b.\n\n## Files likely to change\n- \`src/sub.js\` (new)\n\n## Testing and validation\n- \`node -e "require('./src/sub.js')"\`\n\n## Proposed project-rule updates\nNone\n\n## Open questions and blockers\nNone\n`);
const hash = /SHA-256: ([0-9a-f]{64})/.exec(ps(["save", DATA, SITE, KEY, draft]))[1];
check(/GRANTED/.test(ps(["approve", DATA, SID, KEY, "r1", hash])), "setup: plan approved");
check(/REVIEW: REFUSED\. r1 has no implementation report/.test(ps(["review-start", DATA, SID_REV, KEY])), "review refused before any implementation report");
check(/AUTHORIZED/.test(ps(["implement-start", DATA, SID, KEY, "r1", hash])), "setup: implementation authorized");
fs.writeFileSync(path.join(repo, "src", "sub.js"), "module.exports = (a, b) => a - b;\n");
const rd = ps(["draft-path", SITE, KEY, "report"]).trim();
fs.writeFileSync(rd, `## Implementation report: ${KEY} r1\nStatus: COMPLETED\n`);
check(/REPORT SAVED/.test(ps(["report-save", DATA, SID, rd])), "setup: implementation report saved");

console.log("== review-start facts");
let out = ps(["review-start", DATA, SID_REV, KEY], path.join(BASE));
check(/REVIEW: REFUSED/.test(out), "refused outside the repository", out);
out = ps(["review-start", DATA, SID_REV, KEY]);
check(/REVIEW: STARTED rv-1/.test(out), "review rv-1 started", out);
check(/matches the implementation report: yes/.test(out), "integrity: tree matches implementation report");
check(/Changed files: src\/sub\.js\n/.test(out), "changed files exclude the pre-existing notes.txt change", out);
const bundle = /Review bundle: (.+)/.exec(out)[1].trim();
const facts = JSON.parse(fs.readFileSync(path.join(bundle, "facts.json"), "utf8"));
check(facts.filesOutsidePlan.length === 0 && fs.existsSync(path.join(bundle, "diff.patch")), "facts.json and diff.patch written; nothing outside the plan");
check(JSON.parse(fs.readFileSync(path.join(DATA, "sessions", `${SID_REV}.json`), "utf8")).mode === "reviewing", "session is in reviewing mode");

console.log("== run-check evidence");
const passCmd = "node -e \"require('./src/sub.js'); console.log('sub ok token=abcdef123456 <script>alert(1)</script>')\"";
out = ps(["run-check", DATA, SID_REV, "load", "required", passCmd]);
check(/CHECK RECORDED: C1 load \(required\)/.test(out) && /Exit code: 0/.test(out), "C1 recorded with exit 0", out);
const c1log = fs.readFileSync(path.join(bundle, "checks", "C1.log"), "utf8");
check(/token=\[redacted\]/.test(c1log) && !/abcdef123456/.test(c1log), "credentials redacted in the stored log");
out = ps(["run-check", DATA, SID_REV, "unit", "optional", "node -e \"process.exit(3)\""]);
check(/C2/.test(out) && /Exit code: 3/.test(out), "C2 failing check recorded with exit 3");
out = ps(["run-check", DATA, SID_REV, "py", "required", "definitely-not-a-real-tool-xyz --version"]);
check(/C3/.test(out) && /unavailable/.test(out), "C3 missing tool recorded as unavailable", out);
out = ps(["run-check", DATA, SID_REV, "dirty", "optional", "node -e \"require('fs').writeFileSync('cache.tmp','x')\""]);
check(/Working tree changed by the check: YES/.test(out), "C4 working-tree change detected", out);
fs.unlinkSync(path.join(repo, "cache.tmp"));
check(/REFUSED|ERROR/.test(ps(["run-check", DATA, SID, "x", "required", "node -v"])), "run-check refused in a non-reviewing session");

// review-save with a crafted Reviewer output.
function save(input, sid = SID_REV) {
  const d = ps(["draft-path", SITE, KEY, "review"]).trim();
  fs.writeFileSync(d, JSON.stringify(input));
  return ps(["review-save", DATA, sid, d]);
}
const baseInput = () => ({
  verdict: "PASS",
  summary: "Looks good <img src=x onerror=alert(2)>",
  requirementsSource: "approved plan (Jira unavailable)",
  acceptanceCriteria: [{ id: "AC1", text: "sub(a,b) returns a-b <script>alert(3)</script>", status: "Verified", evidence: ["file:src/sub.js:1", "check:C1"] }],
  findings: [],
  checkAssessments: [{ checkId: "C1", assessment: "passed" }, { checkId: "C2", assessment: "passed", reason: "claimed passing" }, { checkId: "C4", assessment: "not-relevant" }],
  testCases: [
    { id: "TC1", requirement: "AC1", type: "automated", checkId: "C1", scenario: "module loads", steps: ["run C1"], expected: "exit 0", actual: "exit 0", status: "Passed", evidence: "sub ok" },
    { id: "TC2", requirement: "AC1", type: "manual", scenario: "sub(5,3)", steps: ["call sub(5,3)"], expected: "2", status: "Passed" },
    { id: "TC3", requirement: "REG-add", type: "automated", checkId: "C9", scenario: "fabricated", steps: [], expected: "x", status: "Passed" },
    { id: "TC4", requirement: "AC1", type: "automated", checkId: "C2", scenario: "unit", steps: [], expected: "pass", status: "Passed" },
  ],
  changedFiles: [{ path: "src/sub.js", assessment: "new module" }],
  notes: ["</script><script>alert(4)</script>"],
});

console.log("== verdict enforcement (rv-1: missing tool, failing optional check, tree-changing check)");
out = save(baseInput());
check(/VERDICT: BLOCKED \(Reviewer said PASS/.test(out), "PASS lowered to BLOCKED: required check C3 unavailable", out);
const rv1 = JSON.parse(fs.readFileSync(path.join(path.dirname(bundle), "review-rv-1.json"), "utf8"));
const tc = Object.fromEntries(rv1.testCases.map((t) => [t.id, t]));
check(tc.TC2.status === "Not Run", "manual test case claimed Passed -> Not Run");
check(tc.TC3.status === "Not Run", "test case citing a nonexistent check -> Not Run (no fabricated pass)");
check(tc.TC4.status === "Failed", "test case claiming Passed on failing C2 -> Failed");
check(rv1.checks.find((c) => c.id === "C2").assessment === "failed-by-change", "C2 assessment 'passed' corrected to failed-by-change");
check(rv1.checks.find((c) => c.id === "C3").assessment === "environment-unavailable", "unassessed unavailable C3 -> environment-unavailable");
check(rv1.findings.some((f) => f.source === "system" && /C4/.test(f.title)), "automatic finding: C4 changed the working tree");
check(rv1.blockReasons.some((r) => /C3/.test(r)), "block reason lists the unavailable required check");
const html = fs.readFileSync(path.join(path.dirname(bundle), "review-rv-1.html"), "utf8");
check(!/<script>alert|<img|<\/script><script>/i.test(html.replace(/<script>\(function\(\)\{[\s\S]*?<\/script>/, "")), "HTML: no injected markup survives (script, img, script breakout)");
check(rv1.blockReasons.some((r) => /C4 \(dirty\) changed the working tree/.test(r)) && !rv1.failReasons.some((r) => /C4/.test(r)), "a tree-changing check blocks (unreliable evidence) rather than fails");
check(/&lt;script&gt;alert\(3\)&lt;\/script&gt;/.test(html) && /&lt;img src=x onerror=alert\(2\)&gt;/.test(html), "HTML: malicious content shown escaped");
check((html.match(/<script/g) || []).length === 1, "HTML: exactly one script element (the filter)");
check(/Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-/.test(html), "HTML: CSP allows only the hashed filter script");
const hashInCsp = /script-src 'sha256-([^']+)'/.exec(html)[1];
check(hashInCsp === require("crypto").createHash("sha256").update(FILTER_SCRIPT).digest("base64") && html.includes(`<script>${FILTER_SCRIPT}</script>`), "HTML: CSP hash matches the embedded script");
check(!/abcdef123456/.test(html), "HTML: redacted token not present");
check(/<tr data-status="Passed">/.test(html) && /<tr data-status="Not Run">/.test(html) && /<tr data-status="Failed">/.test(html), "HTML: test-case rows carry their status");
check(fs.existsSync(path.join(path.dirname(bundle), "review-rv-1.md")), "Markdown summary written");
check(/already saved/.test(save(baseInput())), "a saved review cannot be overwritten");

console.log("== HTML filter behaviour (DOM shim)");
function runFilter(statuses, checked) {
  const rows = statuses.map((s) => ({ attrs: { "data-status": s }, hidden: false, getAttribute(n) { return this.attrs[n]; } }));
  const boxes = ["Passed", "Failed", "Blocked", "Not Run"].map((s) => ({ checked: checked.includes(s), getAttribute: () => s, addEventListener() {} }));
  const counter = { textContent: "" };
  const document = { querySelectorAll: (sel) => (sel.startsWith("input") ? boxes : rows), getElementById: () => counter };
  vm.runInNewContext(FILTER_SCRIPT, { document, window: {} });
  return { visible: rows.filter((r) => !r.hidden).map((r) => r.attrs["data-status"]), counter: counter.textContent };
}
let f = runFilter(["Passed", "Failed", "Not Run", "Blocked", "Passed"], ["Failed", "Blocked"]);
check(JSON.stringify(f.visible) === '["Failed","Blocked"]' && f.counter === "2 of 5 shown", "filter shows only checked statuses and updates the count", JSON.stringify(f));
f = runFilter(["Passed", "Not Run"], ["Passed", "Failed", "Blocked", "Not Run"]);
check(f.visible.length === 2, "all statuses checked shows all rows");

console.log("== PASS, FAIL, and invalidation (rv-2, rv-3)");
const SID_R2 = "12121212-1212-4121-8121-121212121212";
ps(["review-start", DATA, SID_R2, KEY]);
ps(["run-check", DATA, SID_R2, "load", "required", "node -e \"require('./src/sub.js')\""]);
const passInput = {
  verdict: "PASS", summary: "ok", requirementsSource: "approved plan",
  acceptanceCriteria: [{ id: "AC1", text: "sub", status: "Verified", evidence: ["file:src/sub.js:1", "check:C1"] }],
  findings: [{ id: "F1", severity: "minor", title: "no unit test file", detail: "", evidence: [] }],
  checkAssessments: [{ checkId: "C1", assessment: "passed" }],
  testCases: [{ id: "TC1", requirement: "AC1", type: "automated", checkId: "C1", scenario: "loads", steps: [], expected: "exit 0", status: "Passed" }],
  changedFiles: [], notes: [],
};
out = save(passInput, SID_R2);
check(/VERDICT: PASS\n/.test(out), "clean evidence keeps PASS (minor finding allowed)", out);
check(/REVIEW: CURRENT/.test(ps(["review-status", DATA, KEY])), "review-status: CURRENT right after the review");
fs.appendFileSync(path.join(repo, "src", "sub.js"), "// later edit\n");
out = ps(["review-status", DATA, KEY]);
check(/REVIEW: STALE/.test(out) && /code changed after the review/.test(out), "code change after review -> STALE", out);
const SID_R3 = "13131313-1313-4131-8131-131313131313";
out = ps(["review-start", DATA, SID_R3, KEY]);
check(/matches the implementation report: NO/.test(out), "review-start detects tree differing from the implementation report", out);
ps(["run-check", DATA, SID_R3, "load", "required", "node -e \"require('./src/sub.js')\""]);
out = save({ ...passInput, findings: [] }, SID_R3);
check(/VERDICT: FAIL/.test(out) && /does not match the implementation report/.test(out), "integrity mismatch forces FAIL even when the Reviewer says PASS", out);
fs.writeFileSync(path.join(repo, "src", "sub.js"), "module.exports = (a, b) => a - b;\n");

console.log("== Reviewer BLOCKED is kept for environment problems, but not for system-detected defects (rv-4, rv-5)");
const SID_R5 = "16161616-1616-4161-8161-161616161616";
ps(["review-start", DATA, SID_R5, KEY]);
ps(["run-check", DATA, SID_R5, "py", "required", "definitely-not-a-real-tool-xyz --version"]);
const blockedInput = { ...passInput, verdict: "BLOCKED", acceptanceCriteria: [{ id: "AC1", text: "sub", status: "Not verified", evidence: ["file:src/sub.js:1"] }], findings: [{ id: "F1", severity: "major", title: "required tests could not run (tool missing)", detail: "", evidence: ["check:C1"] }], checkAssessments: [{ checkId: "C1", assessment: "environment-unavailable" }], testCases: [{ id: "TC1", requirement: "AC1", type: "automated", checkId: "C1", scenario: "unit", steps: [], expected: "exit 0", status: "Blocked" }] };
out = save(blockedInput, SID_R5);
check(/VERDICT: BLOCKED\n/.test(out), "Reviewer BLOCKED with its own major 'environment' finding stays BLOCKED", out);
fs.writeFileSync(path.join(repo, "src", "sub.js"), "module.exports = (a, b) => b - a;\n"); // tree no longer matches the report
const SID_R6 = "17171717-1717-4171-8171-171717171717";
ps(["review-start", DATA, SID_R6, KEY]);
ps(["run-check", DATA, SID_R6, "py", "required", "definitely-not-a-real-tool-xyz --version"]);
out = save(blockedInput, SID_R6);
check(/VERDICT: FAIL \(Reviewer said BLOCKED; changed by the review rules\)/.test(out), "Reviewer BLOCKED becomes FAIL on a system-detected integrity mismatch", out);
fs.writeFileSync(path.join(repo, "src", "sub.js"), "module.exports = (a, b) => a - b;\n");

console.log("== unapproved instruction change and missing criteria (rv-6)");
fs.appendFileSync(path.join(repo, "CLAUDE.md"), "new rule\n");
const SID_R4 = "14141414-1414-4141-8141-141414141414";
out = ps(["review-start", DATA, SID_R4, KEY]);
check(/Unapproved instruction-file changes: CLAUDE\.md/.test(out), "facts flag the unapproved CLAUDE.md change", out);
ps(["run-check", DATA, SID_R4, "load", "required", "node -e \"require('./src/sub.js')\""]);
out = save({ ...passInput, acceptanceCriteria: [{ id: "AC1", text: "sub", status: "Verified", evidence: [] }, { id: "AC2", text: "documented", status: "Failed", evidence: ["file:README.md"] }], findings: [] }, SID_R4);
check(/VERDICT: FAIL/.test(out), "unapproved rule change and failed AC2 -> FAIL", out);
const rv4 = JSON.parse(fs.readFileSync(path.join(path.dirname(bundle), "review-rv-6.json"), "utf8"));
check(rv4.findings.some((f) => /Unapproved change to instruction file CLAUDE\.md/.test(f.title)), "automatic blocker for the unapproved instruction change");
check(rv4.acceptanceCriteria[0].status === "Not verified", "Verified without evidence -> Not verified");
check(rv4.blockReasons.some((r) => /AC2 has no traceable test case/.test(r)), "criterion without a test case is reported");
g(["checkout", "--", "CLAUDE.md"], repo);

console.log("== guard: review rules");
const guard = (input) => { const r = spawnSync("node", [GUARD], { input: JSON.stringify({ permission_mode: "default", ...input }), env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA }, encoding: "utf8" }); return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision.toUpperCase() : "pass"; };
const g5 = (expect, label, input) => { const got = guard(input); check(got === expect, `${got.padEnd(4)} ${label}`, `expected ${expect}`); };
const rc = `node "${PS}" run-check "${DATA}" ${SID_R4} unit required 'npm test && echo done'`;
g5("ASK", "run-check by the main thread in a reviewing session -> prompt", { session_id: SID_R4, tool_name: "Bash", tool_input: { command: rc } });
g5("ASK", "run-check in PowerShell -> prompt", { session_id: SID_R4, tool_name: "PowerShell", tool_input: { command: rc } });
g5("DENY", "run-check in bypassPermissions mode", { session_id: SID_R4, permission_mode: "bypassPermissions", tool_name: "Bash", tool_input: { command: rc } });
g5("DENY", "run-check chained with another command", { session_id: SID_R4, tool_name: "Bash", tool_input: { command: `${rc}; rm -rf src` } });
g5("DENY", "reviewer agent running run-check", { session_id: SID_R4, agent_type: "jira-dev-harness:reviewer", tool_name: "Bash", tool_input: { command: rc } });
g5("DENY", "review-start by Claude (reserved)", { session_id: SID_R4, tool_name: "Bash", tool_input: { command: `node "${PS}" review-start "${DATA}" ${SID_R4} ${KEY}` } });
g5("pass", "review-save by the main thread", { session_id: SID_R4, tool_name: "Bash", tool_input: { command: `node "${PS}" review-save "${DATA}" ${SID_R4} "${path.join(os.tmpdir(), "jira-dev-harness", "drafts", SITE, KEY, "review.json")}"` } });
g5("pass", "review-status", { session_id: SID_R4, tool_name: "Bash", tool_input: { command: `node "${PS}" review-status "${DATA}" ${KEY}` } });
g5("pass", "review draft write", { session_id: SID_R4, tool_name: "Write", tool_input: { file_path: path.join(os.tmpdir(), "jira-dev-harness", "drafts", SITE, KEY, "review.json") } });
g5("DENY", "main thread source write in reviewing session", { session_id: SID_R4, tool_name: "Write", tool_input: { file_path: path.join(repo, "src", "x.js") } });
g5("DENY", "reviewer agent Write", { session_id: SID_R4, agent_type: "jira-dev-harness:reviewer", tool_name: "Write", tool_input: { file_path: path.join(repo, "src", "x.js") } });
g5("DENY", "reviewer agent Edit", { session_id: SID_R4, agent_type: "jira-dev-harness:reviewer", tool_name: "Edit", tool_input: { file_path: path.join(repo, "src", "sub.js") } });
g5("DENY", "developer agent write in reviewing session", { session_id: SID_R4, agent_type: "jira-dev-harness:developer", tool_name: "Write", tool_input: { file_path: path.join(repo, "src", "x.js") } });
g5("DENY", "overwrite stored review HTML", { session_id: SID_R4, tool_name: "Write", tool_input: { file_path: path.join(path.dirname(bundle), "review-rv-1.html") } });
g5("DENY", "shell edit of facts.json", { session_id: SID_R4, tool_name: "Bash", tool_input: { command: "echo {} > facts.json" } });
g5("DENY", "Jira write in reviewing session", { session_id: SID_R4, tool_name: "mcp__claude_ai_Atlassian_MCP__addOrEditJiraIssueComment", tool_input: {} });
g5("pass", "reviewer agent Read of the bundle", { session_id: SID_R4, agent_type: "jira-dev-harness:reviewer", tool_name: "Read", tool_input: { file_path: path.join(bundle, "facts.json") } });
g5("DENY", "reviewer agent Read of the approval key", { session_id: SID_R4, agent_type: "jira-dev-harness:reviewer", tool_name: "Read", tool_input: { file_path: path.join(DATA, "keys", "approval.key") } });
const tr = path.join(BASE, "fork.jsonl");
fs.writeFileSync(tr, `{"m":"JDH-WORKFLOW-SESSION:${SID_R4}"}\n`);
g5("DENY", "fork of reviewing session: source write denied", { session_id: "15151515-1515-4151-8151-151515151515", transcript_path: tr, tool_name: "Edit", tool_input: { file_path: path.join(repo, "src", "sub.js") } });
g5("DENY", "fork of reviewing session: developer write denied", { session_id: "15151515-1515-4151-8151-151515151515", agent_type: "jira-dev-harness:developer", tool_name: "Edit", tool_input: { file_path: path.join(repo, "src", "sub.js") } });

fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PHASE 5 UNIT TESTS PASSED");
process.exit(failures ? 1 : 0);
