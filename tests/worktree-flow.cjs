// Shared Phase 8C fixtures: a ticket taken through the worktree workflow up
// to a chosen point, in a repository under "React Apps/jadwa app" with a
// local bare origin, plus mocked GitHub provider responses fed through the
// real evidence hook. No network, Jira, or GitHub is involved.

"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, SITE, KEY, git, makeFixture, draft, reviewJson } = require("./helpers.cjs");

const REPO_DIR = path.join("React Apps", "jadwa app");
const PLAN = `# Implementation plan: ${KEY} export two\n\nTicket: ${KEY} (${SITE})\nReadiness: READY\n\n## Acceptance criteria\n1. src/app.js exports 2.\n\n## Existing worktree changes\nNone\n\n## Files likely to change\n- \`src/app.js\`\n\n## Testing and validation\n- \`node -v\`\n\n## Proposed project-rule updates\nNone\n\n## Open questions and blockers\nNone\n`;
const CHECK = `node -e "process.exit(require('./src/app.js') === 2 ? 0 : 1)"`;
const PR = 7;
const EVIDENCE = path.join(ROOT, "scripts", "evidence.cjs");

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Stages: "approved" (plan), "implemented", "reviewed" (PASS, approved by
// the developer), "committed", "pushed", "shipped" (pull request recorded).
function worktreeTicket(until = "shipped") {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  f.ticket = path.join(f.data, "plans", SITE, KEY);
  f.session = (name) => json(path.join(f.data, "sessions", `${f.sid(name)}.json`));
  f.main = () => ({
    head: git(f.repo, "rev-parse", "HEAD"),
    branch: git(f.repo, "branch", "--show-current"),
    status: git(f.repo, "status", "--porcelain", "--ignored"),
    index: git(f.repo, "ls-files", "-s"),
    app: fs.readFileSync(path.join(f.repo, "src", "app.js"), "utf8"),
  });
  f.before = f.main();
  const steps = ["approved", "implemented", "reviewed", "committed", "pushed", "shipped"];
  const upTo = (s) => steps.indexOf(s) <= steps.indexOf(until);

  f.run(["save", f.data, SITE, KEY, draft(f, "plan", PLAN)]);
  f.planHash = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, KEY]).out)[1];
  assert.match(f.run(["approve", f.data, f.sid("plan"), KEY, "r1", f.planHash]).out, /APPROVAL: GRANTED/);
  if (!upTo("implemented")) return f;

  assert.match(f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", f.planHash]).out, /WORKTREE CREATED/);
  assert.match(f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", f.planHash]).out, /AUTHORIZED/);
  f.wt = f.session("impl").worktree.path;
  f.bindingFile = path.join(f.ticket, "worktree-b1.json");
  f.binding = json(f.bindingFile);
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  assert.match(f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `## Implementation report: ${KEY} r1\nStatus: COMPLETED\n`)]).out, /REPORT SAVED/);
  if (!upTo("reviewed")) return f;

  assert.match(f.run(["review-start", f.data, f.sid("review"), KEY]).out, /REVIEW: STARTED/);
  assert.match(f.run(["run-check", f.data, f.sid("review"), "app", "required", CHECK]).out, /Exit code: 0/);
  const saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", reviewJson("PASS"))]).out;
  assert.match(saved, /VERDICT: PASS/);
  f.reviewHash = /Review SHA-256: ([0-9a-f]{64})/.exec(saved)[1];
  assert.match(f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", f.reviewHash]).out, /REVIEW APPROVAL: GRANTED/);
  f.approvalFile = path.join(f.ticket, "reviews", "review-approval-rv-1.json");
  if (!upTo("committed")) return f;

  assert.match(f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", f.reviewHash]).out, /SHIP: AUTHORIZED/);
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: export 2\n`)]).out, /COMMITTED/);
  f.sha = git(f.wt, "rev-parse", "HEAD");
  if (!upTo("pushed")) return f;

  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /PUSHED/);
  if (!upTo("shipped")) return f;

  f.prep = f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Export two\n\nChanges the export.\n")]).out;
  assert.match(f.run(["ship-record-pr", f.data, f.sid("ship"), `https://github.com/acme/widgets/pull/${PR}`]).out, /RECORDED/);
  return f;
}

// Mocked GitHub REST responses for a pull request that may be merged.
function goodEvidence(sha, o = {}) {
  const repo = "acme/widgets";
  return {
    pr: { number: PR, state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean", commits: 1,
      html_url: `https://github.com/${repo}/pull/${PR}`, user: { login: "dev" },
      head: { sha, ref: `jira/${KEY}`, repo: { full_name: repo } }, base: { ref: "main", repo: { full_name: repo } }, ...o.pr },
    files: [{ filename: "src/app.js", status: "modified" }],
    reviews: [{ user: { login: "rev" }, state: "APPROVED", commit_id: sha }],
    checks: { total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success", head_sha: sha }] },
    protection: { required_status_checks: { contexts: ["ci"] }, required_pull_request_reviews: { required_approving_review_count: 1 }, enforce_admins: { enabled: true } },
    repo: { full_name: repo, permissions: { push: true } },
  };
}

const TOOLS = {
  pr: "mcp__github__get_pull_request", files: "mcp__github__get_pull_request_files", reviews: "mcp__github__get_pull_request_reviews",
  checks: "mcp__github__list_check_runs", protection: "mcp__github__get_branch_protection", repo: "mcp__github__get_repository",
};

// Sends a provider response through the real PostToolUse evidence hook.
function feed(f, sid, tool, data) {
  spawnSync("node", [EVIDENCE], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid, tool_name: tool, tool_input: {}, tool_response: [{ type: "text", text: JSON.stringify(data) }] }),
    env: f.env, encoding: "utf8",
  });
}
const feedAll = (f, sid, ev) => { for (const [k, d] of Object.entries(ev)) feed(f, sid, TOOLS[k], d); };

module.exports = { REPO_DIR, PLAN, CHECK, PR, TOOLS, json, worktreeTicket, goodEvidence, feed, feedAll };
