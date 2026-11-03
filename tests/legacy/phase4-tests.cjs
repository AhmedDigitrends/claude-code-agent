// Phase 4 unit tests: implement-start authorization, report-save, and the
// guard's Developer Agent policy, using real git repositories.
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");
const PS = path.join(ROOT, "scripts", "plan-store.cjs");
const GUARD = path.join(ROOT, "scripts", "guard.cjs");
const DATA = path.join(os.homedir(), ".claude", "plugins", "data", "jira-dev-harness-unittest");
const BASE = path.join(os.tmpdir(), "jdh-phase4-unit");
const SITE = "acme.atlassian.net";
const KEY = "TEST-1";
const SID_IMPL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SID_PLAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SID_NORMAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SID_FORK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
const g = (args, cwd) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
function mkRepo(name, keys = ["TEST"]) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "jira-dev-harness.json"), JSON.stringify({ jira: { site: SITE, projectKeys: keys } }));
  fs.writeFileSync(path.join(dir, ".claude", "rules", "style.md"), "# style\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# project\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.py"), "x = 1\n");
  g(["init", "-q"], dir); g(["add", "-A"], dir); g(["commit", "-qm", "init"], dir);
  return dir;
}
const repoA = mkRepo("repoA");
const repoB = mkRepo("repoB");
const outside = path.join(BASE, "outside");
fs.mkdirSync(outside);

function ps(args, cwd) {
  const r = spawnSync("node", [PS, ...args], { cwd, encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}
function savePlan(cwd, readiness, extra = "") {
  const draft = ps(["draft-path", SITE, KEY], cwd).trim();
  fs.writeFileSync(draft, `# Implementation plan: ${KEY} demo\n\nTicket: ${KEY} (${SITE})\nReadiness: ${readiness}\n\n## Proposed project-rule updates\n- File: .claude/rules/style.md | Apply in implementation: yes\n- File: CLAUDE.md | Apply in implementation: no\n\n## Open questions and blockers\nNone\n${extra}`);
  const out = ps(["save", DATA, SITE, KEY, draft], cwd);
  return /SHA-256: ([0-9a-f]{64})/.exec(out)[1];
}
function sessionFile(sid) { return path.join(DATA, "sessions", `${sid}.json`); }

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `  -> ${detail}` : ""}`);
}
function guard(input) {
  const r = spawnSync("node", [GUARD], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA }, encoding: "utf8" });
  if (!r.stdout.trim()) return "pass";
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision.toUpperCase();
}
function g4(expect, label, input) {
  const got = guard({ permission_mode: "default", ...input });
  check(got === expect, `${got.padEnd(4)} ${label}`, `expected ${expect}`);
}
const dev = (sid, tool, toolInput, extra = {}) => ({ session_id: sid, agent_type: "jira-dev-harness:developer", agent_id: "dev1", tool_name: tool, tool_input: toolInput, ...extra });

console.log("== implement-start authorization (plan store)");
let h1 = savePlan(repoA, "READY");
const implStart = (sid, args, cwd) => ps(["implement-start", DATA, sid, ...args], cwd).split("\n")[0] + (ps(["implement-start", DATA, sid, ...args], cwd).match(/IMPLEMENTATION: \w+\.?[^\n]*/) || [""])[0];
let out = ps(["implement-start", DATA, SID_IMPL, KEY, "r1", h1], repoA);
check(/IMPLEMENTATION: REFUSED\. no approval record/.test(out), "refused: plan not approved", out.trim());
out = ps(["approve", DATA, SID_IMPL, KEY, "r1", h1], repoA);
check(/APPROVAL: GRANTED/.test(out), "developer approval of r1 granted (setup)", out.trim());
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r1", h1.slice(0, 12)], repoA);
check(/REFUSED\. give the approved plan's full/.test(out), "refused: short hash", out.trim());
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r1", "0".repeat(64)], repoA);
check(/REFUSED\. the SHA-256 does not match/.test(out), "refused: wrong hash", out.trim());
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r1", h1], repoB);
check(/REFUSED\..*planned for/.test(out), "refused: cross-repository (run from repoB)", out.trim());
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r2", h1], repoA);
check(/REFUSED\. r2 is not the latest/.test(out), "refused: wrong revision", out.trim());
fs.appendFileSync(path.join(repoA, ".claude", "jira-dev-harness.json"), " ");
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r1", h1], repoA);
check(/REFUSED\..*uncommitted changes/.test(out), "refused: mapping file modified", out.trim());
g(["checkout", "--", ".claude/jira-dev-harness.json"], repoA);
const apFile = path.join(DATA, "plans", SITE, KEY, "approval-r1.json");
const apGood = fs.readFileSync(apFile, "utf8");
fs.writeFileSync(apFile, apGood.replace(/"revision": 1/, '"revision": 1, "x": 1'));
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r1", h1], repoA);
check(/REFUSED\..*signature/.test(out), "refused: tampered approval record", out.trim());
fs.writeFileSync(apFile, apGood);
// A pre-existing, unrelated user change that must be recorded in the baseline.
fs.writeFileSync(path.join(repoA, "src", "app.py"), "x = 1  # user's own edit\n");
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r1", h1], repoA);
check(/IMPLEMENTATION: AUTHORIZED for TEST-1 r1/.test(out), "authorized: valid approval, full hash, same repo", out.trim());
check(/M src\/app\.py/.test(out), "baseline records the pre-existing change to src/app.py");
check(JSON.parse(fs.readFileSync(sessionFile(SID_IMPL), "utf8")).mode === "implementing", "session state is implementing");
ps(["session-start", DATA, SID_PLAN], repoA);

console.log("== guard: Developer Agent boundaries (implementing session, attended)");
const inA = (...p) => path.join(repoA, ...p);
g4("ASK", "write new source file -> per-edit prompt", dev(SID_IMPL, "Write", { file_path: inA("src", "new_module.py") }));
g4("ASK", "edit existing source file -> per-edit prompt", dev(SID_IMPL, "Edit", { file_path: inA("src", "app.py") }));
g4("ASK", "Git Bash style path inside repo", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py").replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`) }));
g4("DENY", "write outside the repository", dev(SID_IMPL, "Write", { file_path: path.join(outside, "x.txt") }));
g4("DENY", "path traversal out of the repository", dev(SID_IMPL, "Write", { file_path: inA("src", "..", "..", "outside", "y.txt") }));
let linked = false;
try { fs.symlinkSync(outside, inA("linkdir"), "junction"); linked = true; } catch (e) { console.log(`skip junction test: ${e.code}`); }
if (linked) g4("DENY", "write through a junction/symlink pointing outside", dev(SID_IMPL, "Write", { file_path: inA("linkdir", "z.txt") }));
let fileLink = false;
try { fs.symlinkSync(path.join(outside, "t.txt"), inA("src", "link.txt"), "file"); fileLink = true; } catch (e) { console.log(`skip file-symlink test: ${e.code} (needs Windows developer mode)`); }
if (fileLink) g4("DENY", "write to a file symlink", dev(SID_IMPL, "Write", { file_path: inA("src", "link.txt") }));
g4("DENY", ".git/config", dev(SID_IMPL, "Edit", { file_path: inA(".git", "config") }));
g4("DENY", ".git/hooks/pre-commit", dev(SID_IMPL, "Write", { file_path: inA(".git", "hooks", "pre-commit") }));
g4("DENY", ".claude/settings.json", dev(SID_IMPL, "Write", { file_path: inA(".claude", "settings.json") }));
g4("DENY", ".claude/agents/x.md", dev(SID_IMPL, "Write", { file_path: inA(".claude", "agents", "x.md") }));
g4("DENY", "Jira mapping file", dev(SID_IMPL, "Edit", { file_path: inA(".claude", "jira-dev-harness.json") }));
g4("DENY", ".mcp.json", dev(SID_IMPL, "Write", { file_path: inA(".mcp.json") }));
g4("ASK", ".claude/rules/style.md (plan: Apply in implementation: yes)", dev(SID_IMPL, "Edit", { file_path: inA(".claude", "rules", "style.md") }));
g4("DENY", "CLAUDE.md (plan: Apply in implementation: no)", dev(SID_IMPL, "Edit", { file_path: inA("CLAUDE.md") }));
g4("DENY", "AGENTS.md (not in plan)", dev(SID_IMPL, "Write", { file_path: inA("AGENTS.md") }));
g4("DENY", ".claude/rules/other.md (not in plan)", dev(SID_IMPL, "Write", { file_path: inA(".claude", "rules", "other.md") }));
g4("DENY", "plan store file", dev(SID_IMPL, "Write", { file_path: path.join(DATA, "plans", SITE, KEY, "approval-r1.json") }));
g4("DENY", "permission_mode acceptEdits", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }, { permission_mode: "acceptEdits" }));
g4("DENY", "permission_mode bypassPermissions", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }, { permission_mode: "bypassPermissions" }));
g4("DENY", "permission_mode auto", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }, { permission_mode: "auto" }));
g4("DENY", "permission_mode bypass for shell too", dev(SID_IMPL, "Bash", { command: "python -m unittest" }, { permission_mode: "bypassPermissions" }));
g4("ASK", "project check command -> prompt", dev(SID_IMPL, "Bash", { command: "python -m unittest discover -s tests" }));
g4("ASK", "make test -> prompt", dev(SID_IMPL, "Bash", { command: `cd "${repoA}" && make test` }));
g4("ASK", "npm install (unsafe) -> never automatic, prompt", dev(SID_IMPL, "Bash", { command: "npm install left-pad" }));
g4("ASK", "PowerShell project command -> prompt", dev(SID_IMPL, "PowerShell", { command: "pytest -q" }));
g4("pass", "read-only git status (normal flow)", dev(SID_IMPL, "Bash", { command: "git status --porcelain" }));
g4("DENY", "git commit", dev(SID_IMPL, "Bash", { command: "git commit -am x" }));
g4("DENY", "git add", dev(SID_IMPL, "Bash", { command: "git add -A" }));
g4("DENY", "cd && git push", dev(SID_IMPL, "Bash", { command: `cd "${repoA}" && git push origin HEAD` }));
g4("DENY", "git stash", dev(SID_IMPL, "Bash", { command: "git stash" }));
g4("DENY", "git checkout -- file (discard user change)", dev(SID_IMPL, "Bash", { command: "git checkout -- src/app.py" }));
g4("DENY", "pipe into git commit", dev(SID_IMPL, "Bash", { command: "echo x | git commit -F -" }));
g4("DENY", "gh pr create", dev(SID_IMPL, "Bash", { command: "gh pr create --fill" }));
g4("DENY", "shell touching the plan store", dev(SID_IMPL, "Bash", { command: `cat "${path.join(DATA, "keys", "approval.key")}"` }));
g4("DENY", "shell running approve", dev(SID_IMPL, "Bash", { command: `node "${PS}" approve "${DATA}" ${SID_IMPL} ${KEY} r1 ${h1}` }));
g4("DENY", "shell running implement-start", dev(SID_IMPL, "Bash", { command: `node "${PS}" implement-start "${DATA}" ${SID_IMPL} ${KEY} r1 ${h1}` }));
g4("DENY", "Jira write tool", dev(SID_IMPL, "mcp__claude_ai_Atlassian_MCP__transitionJiraIssue", {}));
g4("pass", "Read source file", dev(SID_IMPL, "Read", { file_path: inA("src", "app.py") }));

console.log("== guard: nobody else writes");
g4("DENY", "Developer in a planning session", dev(SID_PLAN, "Write", { file_path: inA("src", "x.py") }));
g4("DENY", "Developer in an ordinary session", dev(SID_NORMAL, "Write", { file_path: inA("src", "x.py") }));
g4("DENY", "main thread write in implementing session", { session_id: SID_IMPL, tool_name: "Write", tool_input: { file_path: inA("src", "x.py") } });
g4("DENY", "main thread project command in implementing session", { session_id: SID_IMPL, tool_name: "Bash", tool_input: { command: "python -m unittest" } });
g4("DENY", "general-purpose subagent write in implementing session", { session_id: SID_IMPL, agent_type: "general-purpose", tool_name: "Edit", tool_input: { file_path: inA("src", "app.py") } });
for (const a of ["analyzer", "planner", "reviewer"]) {
  g4("DENY", `${a} write in implementing session`, { session_id: SID_IMPL, agent_type: `jira-dev-harness:${a}`, tool_name: "Write", tool_input: { file_path: inA("src", "x.py") } });
}
g4("pass", "main thread report draft write", { session_id: SID_IMPL, tool_name: "Write", tool_input: { file_path: path.join(os.tmpdir(), "jira-dev-harness", "drafts", SITE, KEY, "report.md") } });

console.log("== guard: forked implementing session");
const transcript = path.join(BASE, "fork.jsonl");
fs.writeFileSync(transcript, `{"m":"JDH-WORKFLOW-SESSION:${SID_PLAN}"}\n{"m":"JDH-WORKFLOW-SESSION:${SID_IMPL}"}\n`);
g4("ASK", "fork inherits the latest state (implementing) with the same checks", dev(SID_FORK, "Write", { file_path: inA("src", "x.py") }, { transcript_path: transcript }));
g4("DENY", "fork: write outside repo still denied", dev(SID_FORK, "Write", { file_path: path.join(outside, "x.txt") }));

console.log("== report-save");
fs.writeFileSync(inA("src", "new_module.py"), "def f():\n    return 2\n");
const rdraft = ps(["draft-path", SITE, KEY, "report"], repoA).trim();
fs.writeFileSync(rdraft, `## Implementation report: ${KEY} r1\nStatus: COMPLETED\n`);
out = ps(["report-save", DATA, SID_IMPL, rdraft], repoA);
check(/REPORT SAVED: .*impl-r1-1\.md/.test(out), "report saved as impl-r1-1.md", out.trim());
const rmeta = JSON.parse(fs.readFileSync(path.join(DATA, "plans", SITE, KEY, "impl-r1-1.json"), "utf8"));
check(rmeta.changedSinceAuthorization.some((l) => l.includes("src/new_module.py")), "git-computed change list includes src/new_module.py");
check(rmeta.preExistingChanges.some((l) => l.includes("src/app.py")) && !rmeta.changedSinceAuthorization.some((l) => l.includes("src/app.py")), "pre-existing src/app.py change kept separate");
check(rmeta.preExistingChanges.includes(" M src/app.py"), "status lines keep their leading space (regression: first line was trimmed)", JSON.stringify(rmeta.preExistingChanges));
check(/^[0-9a-f]{64}$/.test(rmeta.trackedDiffSha256) && rmeta.headNow === rmeta.baselineHead, "diff hash recorded; HEAD unchanged");
check(guard({ permission_mode: "default", session_id: SID_IMPL, tool_name: "Write", tool_input: { file_path: path.join(DATA, "plans", SITE, KEY, "impl-r1-1.md") } }) === "DENY", "report file cannot be overwritten by Claude");

console.log("== stale and revoked authorizations");
fs.writeFileSync(apFile, apGood.replace(/"hmac": "[0-9a-f]+"/, `"hmac": "${"0".repeat(64)}"`));
g4("DENY", "approval tampered after authorization -> next write denied", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }));
fs.writeFileSync(apFile, apGood);
g4("ASK", "approval restored -> allowed again", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }));
fs.appendFileSync(path.join(DATA, "plans", SITE, KEY, "plan-r1.md"), "edited");
g4("DENY", "plan file edited after authorization -> denied", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }));
const planFile = path.join(DATA, "plans", SITE, KEY, "plan-r1.md");
fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace(/edited$/, ""));
g4("ASK", "plan restored -> allowed again", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }));
savePlan(repoA, "READY", "\nrevised\n");
g4("DENY", "new plan revision r2 saved -> r1 authorization revoked", dev(SID_IMPL, "Write", { file_path: inA("src", "x.py") }));
g4("DENY", "fork also revoked", dev(SID_FORK, "Write", { file_path: inA("src", "x.py") }));
const h3 = savePlan(repoA, "BLOCKED");
out = ps(["implement-start", DATA, SID_IMPL, KEY, "r3", h3], repoA);
check(/REFUSED\..*(no approval record|not READY)/.test(out), "refused: BLOCKED latest revision", out.trim());
ps(["session-start", DATA, SID_IMPL], repoA);
check(JSON.parse(fs.readFileSync(sessionFile(SID_IMPL), "utf8")).mode === "planning", "re-running the ticket skill resets the session to planning");

fs.rmSync(DATA, { recursive: true, force: true });
try { fs.unlinkSync(inA("linkdir")); } catch {}
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PHASE 4 UNIT TESTS PASSED");
process.exit(failures ? 1 : 0);
