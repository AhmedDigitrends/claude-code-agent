// Shared fixtures for the Phase 6 tests: disposable repositories, a local
// bare "origin", a private plugin data directory, and a guard runner.

"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const STORE = path.join(ROOT, "scripts", "plan-store.cjs");
const GUARD = path.join(ROOT, "scripts", "guard.cjs");

const SITE = "example.atlassian.net";
const KEY = "ABC-1";
const uuid = () => crypto.randomUUID();

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const DEFAULT_MAPPING = { jira: { site: SITE, projectKeys: ["ABC"] } };

function makeFixture(mapping = DEFAULT_MAPPING) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jdh-test-"));
  const tmp = path.join(base, "tmp");
  const data = path.join(base, "plugins", "data", "jira-dev-harness");
  const repo = path.join(base, "repo");
  const bare = path.join(base, "origin.git");
  for (const d of [tmp, data, repo]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, CLAUDE_PLUGIN_DATA: data };

  const f = { base, tmp, data, repo, bare, env, sessions: {} };
  f.run = (args, cwd = repo, extraEnv = {}) => {
    const r = spawnSync("node", [STORE, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
    return { out: `${r.stdout}${r.stderr}`, status: r.status };
  };
  f.sid = (name) => (f.sessions[name] = f.sessions[name] || uuid());

  git(base, "init", "--bare", "-b", "main", bare);
  git(repo, "init", "-b", "main");
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    git(repo, "config", k, v);
  }
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", "jira-dev-harness.json"), JSON.stringify(mapping));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  git(repo, "config", `url.${bare.replace(/\\/g, "/")}.insteadOf`, "https://github.com/acme/widgets.git");
  git(repo, "push", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return f;
}

const draft = (f, kind, text) => {
  const p = f.run(["draft-path", SITE, KEY, kind]).out.trim();
  fs.writeFileSync(p, text);
  return p;
};

const reviewJson = (verdict) => JSON.stringify({
  verdict,
  summary: "test review",
  requirementsSource: "plan",
  acceptanceCriteria: [{ id: "AC1", text: "app exports 2", status: verdict === "PASS" ? "Verified" : "Failed", evidence: ["check:C1"] }],
  testCases: [{ id: "TC1", requirement: "AC1", scenario: "version", type: "automated", checkId: "C1", status: "Passed", steps: [], expected: "ok" }],
  findings: verdict === "PASS" ? [] : [{ id: "F1", severity: "blocker", title: "broken", detail: "x", evidence: [] }],
  checkAssessments: [{ checkId: "C1", assessment: "passed", reason: "" }],
  changedFiles: [{ path: "src/app.js", assessment: "ok" }],
});

// Builds the state after a review has been saved: plan approved, implemented
// (a real change to src/app.js), reported, checked, and reviewed.
function reviewed(verdict = "PASS", mapping) {
  const f = makeFixture(mapping);
  const plan = `# Plan ${KEY}\n\nReadiness: READY\n\n## Files likely to change\n- \`src/app.js\`\n\n## Testing and validation\n- \`node -v\`\n`;
  f.run(["save", f.data, SITE, KEY, draft(f, "plan", plan)]);
  const planHash = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, KEY]).out)[1];
  assert.match(f.run(["approve", f.data, f.sid("plan"), KEY, "r1", planHash]).out, /APPROVAL: GRANTED/);
  assert.match(f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", planHash]).out, /AUTHORIZED/);
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 2;\n");
  assert.match(f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `Report for ${KEY}\n`)]).out, /REPORT SAVED/);
  assert.match(f.run(["review-start", f.data, f.sid("review"), KEY]).out, /REVIEW: STARTED/);
  assert.match(f.run(["run-check", f.data, f.sid("review"), "node", "required", "node -v"]).out, /CHECK RECORDED/);
  const saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson(verdict))]).out;
  f.reviewHash = (/Review SHA-256: ([0-9a-f]{64})/.exec(saved) || [])[1];
  f.saved = saved;
  f.reviewFile = path.join(f.data, "plans", SITE, KEY, "reviews", "review-rv-1.json");
  f.approve = (hash = f.reviewHash, id = "rv-1") => f.run(["approve-review", f.data, f.sid("approve"), KEY, id, hash]).out;
  f.ship = (hash = f.reviewHash, ...extra) => f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", hash, ...extra]).out;
  return f;
}


function guard(f, input) {
  const r = spawnSync("node", [GUARD], { input: JSON.stringify(input), env: f.env, encoding: "utf8" });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : { permissionDecision: "(none)", permissionDecisionReason: "" };
}

module.exports = { ROOT, STORE, GUARD, SITE, KEY, uuid, git, makeFixture, draft, reviewJson, reviewed, guard };
