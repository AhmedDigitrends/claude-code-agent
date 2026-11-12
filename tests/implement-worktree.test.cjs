// Phase 8C step 3: /implement creates or reuses the sibling ticket worktree,
// hands directory access to the developer (/add-dir), and the guard confines
// the Developer Agent to that worktree. Every repository lives under
// "React Apps/demo app", so the worktree is "React Apps/demo app-ABC-1".
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const L = require("../scripts/lib/approval.cjs");
const { STORE, SITE, KEY, git, makeFixture, guard, legacyImplement, uuid } = require("./helpers.cjs");

const REPO_DIR = path.join("React Apps", "demo app");
const slash = (p) => p.replace(/\\/g, "/");
const planText = (key) => `# Plan ${key}\n\nReadiness: READY\n\n## Files likely to change\n- \`src/app.js\`\n\n## Testing and validation\n- \`node -v\`\n`;

function approvePlan(f, key) {
  const p = f.run(["draft-path", SITE, key, "plan"]).out.trim();
  fs.writeFileSync(p, planText(key));
  assert.match(f.run(["save", f.data, SITE, key, p]).out, /SAVED/);
  const hash = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, key]).out)[1];
  assert.match(f.run(["approve", f.data, f.sid(`plan-${key}`), key, "r1", hash]).out, /APPROVAL: GRANTED/);
  return hash;
}

function fixture() {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  f.hash = approvePlan(f, KEY);
  f.parent = slash(fs.realpathSync.native(path.dirname(f.repo)));
  f.wt = `${f.parent}/demo app-${KEY}`;
  f.implement = (name = "impl", key = KEY, hash = f.hash) => f.run(["implement-start", f.data, f.sid(name), key, "r1", hash]).out;
  f.session = (name = "impl") => JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid(name)}.json`), "utf8"));
  f.dev = (tool, toolInput, name = "impl") => guard(f, { session_id: f.sid(name), agent_type: "jira-dev-harness:developer", tool_name: tool, tool_input: toolInput, permission_mode: "default", cwd: f.repo });
  f.shell = (command, name, tool = "Bash") => guard(f, { session_id: name ? f.sid(name) : uuid(), tool_name: tool, tool_input: { command }, permission_mode: "default", cwd: f.repo });
  f.authorize = (name = "impl", key = KEY, hash = f.hash) => {
    assert.match(f.implement(name, key, hash), /WORKTREE CREATED/);
    const out = f.implement(name, key, hash);
    assert.match(out, /IMPLEMENTATION: AUTHORIZED/);
    return out;
  };
  return f;
}

const mainState = (f) => ({
  head: git(f.repo, "rev-parse", "HEAD"),
  branch: git(f.repo, "branch", "--show-current"),
  status: git(f.repo, "status", "--porcelain", "--ignored"),
  index: git(f.repo, "ls-files", "-s"),
});
const decision = (r) => r.permissionDecision;

// ------------------------------------------------------- creation handoff

test("first /implement creates the sibling worktree and stops for /add-dir; nothing is authorized yet", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "notes.txt"), "local\n");
  const before = mainState(f);
  const out = f.implement();

  assert.match(out, /^JDH-WORKFLOW-SESSION:/m);
  assert.match(out, /IMPLEMENTATION: WORKTREE CREATED for ABC-1 r1\. ACCESS NEEDED, NOT YET AUTHORIZED/);
  assert.doesNotMatch(out, /IMPLEMENTATION: AUTHORIZED/);
  assert.ok(out.includes(`Worktree: ${f.wt}\n`));
  assert.ok(out.includes(`/add-dir "${f.wt}"`), "the /add-dir line quotes the path with spaces");
  assert.ok(out.includes(`claude --add-dir "${f.wt}" --resume`), "the startup fallback is documented");
  assert.match(out, /Run again: \/jira-dev-harness:implement ABC-1 r1 [0-9a-f]{64}/);
  assert.match(out, /never changes Claude Code permissions itself/);
  assert.match(out, /main checkout \(they stay there and are not in the worktree\): \n  \?\? notes\.txt/);

  const s = f.session();
  assert.equal(s.mode, "planning");
  assert.equal(s.pendingWorktree.path, f.wt);
  assert.equal(git(f.wt, "branch", "--show-current"), `jira/${KEY}`);
  assert.deepEqual(mainState(f), before, "the main checkout is unchanged");
  assert.deepEqual(fs.readdirSync(f.parent).sort(), ["demo app", `demo app-${KEY}`], "only the sibling folder is added");
  assert.equal(fs.existsSync(path.join(f.parent, ".worktrees")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(f.parent), ".worktrees")), false);
  assert.equal(decision(f.dev("Write", { file_path: path.join(f.wt, "src", "app.js") })), "deny", "no Developer write before the second run");
});

test("the second /implement reuses the verified worktree and records the signed binding in the session", () => {
  const f = fixture();
  const out = f.authorize();
  assert.ok(out.includes(`Worktree: ${f.wt}\n`));
  assert.match(out, /Branch: jira\/ABC-1/);
  assert.ok(out.includes(`must start with: cd "${f.wt}" && `));
  const s = f.session();
  const b = JSON.parse(fs.readFileSync(path.join(f.data, "plans", SITE, KEY, "worktree-b1.json"), "utf8"));
  assert.equal(s.mode, "implementing");
  assert.deepEqual(s.worktree, { path: f.wt, branch: `jira/${KEY}`, baseHead: b.baseHead, binding: 1, hmac: b.hmac });
  assert.ok(L.sameRepo(s.repo, L.repoIdentity(f.repo)), "the session keeps the primary repository identity");
  assert.equal(s.baseline.head, b.baseHead);
  assert.deepEqual(s.baseline.status, []);

  // Resumed or new session: reused, never a second worktree.
  const again = f.implement("resumed");
  assert.match(again, /IMPLEMENTATION: AUTHORIZED/);
  assert.equal(fs.readdirSync(path.join(f.data, "plans", SITE, KEY)).filter((n) => /^worktree-b/.test(n)).length, 1);
  assert.match(f.run(["worktree-status", f.data, KEY]).out, /^WORKTREE: VERIFIED/);
});

test("relevant uncommitted main-checkout changes block /implement before anything is created", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "local edit\n");
  const before = mainState(f);
  const out = f.implement();
  assert.match(out, /IMPLEMENTATION: REFUSED\. uncommitted changes in the main checkout touch the plan's files[\s\S]*src\/app\.js[\s\S]*Commit or stash them yourself/);
  assert.equal(fs.existsSync(f.wt), false);
  assert.equal(git(f.repo, "branch", "--list", `jira/${KEY}`), "");
  assert.deepEqual(mainState(f), before);
  assert.equal(fs.readdirSync(path.join(f.data, "plans", SITE, KEY)).some((n) => /^worktree-b/.test(n)), false);

  // Also rechecked on reuse.
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 1;\n");
  f.authorize();
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "local edit again\n");
  assert.match(f.implement(), /REFUSED\. uncommitted changes in the main checkout touch the plan's files/);
});

test("a legacy plan without a signed base commit is refused and nothing is created", () => {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  const p = f.run(["draft-path", SITE, KEY, "plan"]).out.trim();
  fs.writeFileSync(p, planText(KEY));
  f.run(["save", f.data, SITE, KEY, p]);
  const metaFile = path.join(f.data, "plans", SITE, KEY, "plan-r1.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  delete meta.baseHead;
  delete meta.dirtyPaths;
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  const hash = meta.sha256;
  assert.match(f.run(["approve", f.data, f.sid("plan"), KEY, "r1", hash]).out, /GRANTED/);
  const out = f.run(["implement-start", f.data, f.sid("impl"), KEY, "r1", hash]).out;
  assert.match(out, /IMPLEMENTATION: REFUSED\. r1 was saved or approved by an older plugin version without a recorded base commit.*Save a new plan revision/s);
  assert.equal(fs.existsSync(path.join(path.dirname(f.repo), `demo app-${KEY}`)), false);
});

// -------------------------------------------------------- Developer writes

test("Developer writes: only inside the verified worktree; never the main checkout or another ticket's worktree", () => {
  const f = fixture();
  f.authorize();
  const hash2 = approvePlan(f, "ABC-2");
  f.authorize("impl2", "ABC-2", hash2);
  const wt2 = `${f.parent}/demo app-ABC-2`;

  assert.equal(decision(f.dev("Edit", { file_path: path.join(f.wt, "src", "app.js") })), "ask");
  assert.equal(decision(f.dev("Write", { file_path: `${f.wt}/src/new file.js` })), "ask", "paths with spaces");
  const main = f.dev("Edit", { file_path: path.join(f.repo, "src", "app.js") });
  assert.equal(decision(main), "deny");
  assert.match(main.permissionDecisionReason, /is in the main checkout .* never changes/);
  assert.equal(decision(f.dev("Write", { file_path: path.join(f.wt, "..", "demo app", "src", "x.js") })), "deny", "traversal into the main checkout");
  assert.equal(decision(f.dev("Write", { file_path: `${wt2}/src/app.js` })), "deny", "another ticket's worktree");
  assert.equal(decision(f.dev("Write", { file_path: `${wt2}/src/app.js` }, "impl2")), "ask", "that ticket's own Developer may");
  assert.equal(decision(f.dev("Write", { file_path: path.join(f.wt, ".git") })), "deny", "the worktree's .git file");
  assert.equal(decision(f.dev("Write", { file_path: path.join(f.wt, ".claude", "jira-dev-harness.json") })), "deny");
  assert.equal(decision(f.dev("Write", { file_path: path.join(f.data, "plans", SITE, KEY, "worktree-b1.json") })), "deny");
  assert.equal(decision(f.dev("Write", { file_path: path.join(f.data, "worktrees", "registry", `${SITE}__${KEY}.json`) })), "deny");

  const linkTarget = path.join(f.repo, "src");
  fs.symlinkSync(linkTarget, path.join(f.wt, "main-src"), "junction");
  assert.equal(decision(f.dev("Write", { file_path: path.join(f.wt, "main-src", "app.js") })), "deny", "a junction into the main checkout");
});

test("Developer writes are denied when the binding is tampered, replaced, or the worktree disappears", () => {
  const f = fixture();
  f.authorize();
  const target = { file_path: path.join(f.wt, "src", "app.js") };
  const file = path.join(f.data, "plans", SITE, KEY, "worktree-b1.json");
  const good = fs.readFileSync(file, "utf8");

  fs.writeFileSync(file, good.replace(/"planRevision": 1/, '"planRevision": 2'));
  assert.match(f.dev("Edit", target).permissionDecisionReason, /invalid signature|binding changed/);
  fs.writeFileSync(file, good);
  assert.equal(decision(f.dev("Edit", target)), "ask");

  // The session's recorded binding no longer matches (as if re-created).
  const sFile = path.join(f.data, "sessions", `${f.sid("impl")}.json`);
  const s = JSON.parse(fs.readFileSync(sFile, "utf8"));
  fs.writeFileSync(sFile, JSON.stringify({ ...s, worktree: { ...s.worktree, hmac: "0".repeat(64) } }));
  assert.match(f.dev("Edit", target).permissionDecisionReason, /binding changed since implementation was authorized/);
  fs.writeFileSync(sFile, JSON.stringify(s));

  fs.renameSync(f.wt, `${f.wt}-moved`);
  assert.match(f.dev("Edit", target).permissionDecisionReason, /does not exist/);
  fs.renameSync(`${f.wt}-moved`, f.wt);
  assert.equal(decision(f.dev("Edit", target)), "ask");
});

test("a legacy in-place session never authorizes new Developer writes, but its report still works", () => {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  const hash = approvePlan(f, KEY);
  legacyImplement(f, "old", KEY, 1, hash);
  const r = guard(f, { session_id: f.sid("old"), agent_type: "jira-dev-harness:developer", tool_name: "Edit", tool_input: { file_path: path.join(f.repo, "src", "app.js") }, permission_mode: "default", cwd: f.repo });
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /no verified ticket worktree.*run \/jira-dev-harness:implement again/);

  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 2;\n");
  const d = f.run(["draft-path", SITE, KEY, "report"]).out.trim();
  fs.writeFileSync(d, `Report ${KEY}\n`);
  assert.match(f.run(["report-save", f.data, f.sid("old"), d]).out, /REPORT SAVED/);
  const meta = JSON.parse(fs.readFileSync(path.join(f.data, "plans", SITE, KEY, "impl-r1-1.json"), "utf8"));
  assert.equal("worktree" in meta, false);
  assert.deepEqual(meta.changedSinceAuthorization, [" M src/app.js"], "the legacy path reports on the main checkout as before");
});

// --------------------------------------------------------- Developer shell

test("Developer shell commands must start in the worktree and stay there", () => {
  const f = fixture();
  f.authorize();
  const d = (command, tool = "Bash") => f.dev(tool, { command });
  const inWt = (c) => `cd "${f.wt}" && ${c}`;

  assert.equal(decision(d(inWt("npm test"))), "ask");
  assert.match(d(inWt("npm test")).permissionDecisionReason, /can still reach files outside it/);
  assert.equal(decision(d(inWt("npm test 2>&1 | tail -5"))), "ask", "pipes keep the prompt");
  assert.equal(decision(d(inWt("git status --porcelain"))), "(none)", "read-only commands follow the normal flow");
  assert.equal(decision(d(`cd '${f.wt}' && npm test`)), "ask", "single quotes");
  assert.equal(decision(d(`Set-Location -LiteralPath "${f.wt}"; npm test`, "PowerShell")), "ask");
  if (process.platform === "win32") {
    const gitBash = f.wt.replace(/^([A-Za-z]):/, (m, l) => `/${l.toLowerCase()}`);
    assert.equal(decision(d(`cd "${gitBash}" && npm test`)), "ask", "Git Bash style path");
  }

  for (const [command, reason] of [
    ["npm test", /must start in the ticket worktree/],
    [`cd "${f.repo}" && npm test`, /must start in the ticket worktree/],
    [`cd ${f.wt} && npm test`, /must start in the ticket worktree/],
    [inWt(`cd "${f.repo}" && npm test`), /may not change directory again/],
    [inWt("pushd .. && npm test"), /may not change directory again/],
    [inWt(`git -C "${f.repo}" log`), /may not point git at another directory/],
    [inWt("git --git-dir=../x/.git log"), /may not point git at another directory/],
    [inWt("git add -A"), /no commits, pushes/],
    [inWt("git commit -m x"), /no commits, pushes/],
    [inWt(`git worktree remove "${f.wt}"`), /plugin-managed worktree/],
    [inWt("rm -rf ."), /plugin-managed worktree/],
  ]) {
    const r = d(command);
    assert.equal(r.permissionDecision, "deny", command);
    assert.match(r.permissionDecisionReason, reason, command);
  }
});

test("quoted git -C paths with spaces are recognised (mutation denied, reads allowed)", () => {
  const f = fixture();
  f.authorize();
  assert.equal(decision(f.dev("Bash", { command: `cd "${f.wt}" && git -c x=y add -A` })), "deny");
  // Main conversation of the implementing session: read-only git in the worktree is allowed.
  assert.equal(decision(f.shell(`git -C "${f.wt}" status --porcelain`, "impl")), "(none)");
  assert.equal(decision(f.shell(`git -C "${f.wt}" diff --stat`, "impl")), "(none)");
  assert.equal(decision(f.shell(`git -C "${f.wt}" add -A`, "impl")), "deny");
});

// ---------------------------------------------------- worktree-status, protection

test("worktree-status is allowed through the guard, pinned to the plugin data directory", () => {
  const f = fixture();
  f.authorize();
  const cmd = (data) => `node "${slash(STORE)}" worktree-status "${slash(data)}" ${KEY}`;
  assert.equal(decision(f.shell(cmd(f.data), "plan-ABC-1")), "(none)");
  assert.equal(decision(f.shell(cmd(f.data), "impl")), "(none)");
  assert.equal(decision(f.shell(cmd(path.join(f.base, "forged")), "impl")), "deny");
});

test("registered worktrees are protected in every session; unrelated git and deletes are not", () => {
  const f = fixture();
  f.authorize();
  const ordinary = (command, tool) => decision(f.shell(command, null, tool));

  for (const command of [
    `git worktree remove "${f.wt}"`,
    `git worktree remove --force "${f.wt}"`,
    `git worktree remove "../demo app-${KEY}"`,
    `git -C "${f.repo}" worktree move "${f.wt}" "${f.parent}/elsewhere"`,
    `git worktree repair "${f.wt}"`,
    `rm -rf "${f.wt}"`,
    `rm -r "${f.parent}"`,
    `rm -rf "../demo app-"*`,
    `cd "${f.parent}" && rm -rf "demo app-${KEY}"`,
  ]) assert.equal(ordinary(command), "deny", command);
  assert.equal(ordinary(`Remove-Item -Recurse -Force "${f.wt}"`, "PowerShell"), "deny");
  assert.equal(ordinary(`rmdir /s /q "${f.wt}"`), "deny");

  for (const command of [
    "git worktree list",
    "git worktree add ../scratch",
    "git worktree remove ../scratch",
    "git worktree prune",
    "rm -rf node_modules",
    `rm "${f.wt}/src/app.js"`,
    "git status",
  ]) assert.equal(ordinary(command), "(none)", command);

  // prune would drop a registered worktree whose directory is missing.
  fs.renameSync(f.wt, `${f.wt}-away`);
  assert.equal(ordinary("git worktree prune"), "deny");
  fs.renameSync(`${f.wt}-away`, f.wt);
});

// ----------------------------------------------------------- concurrency

function implementInChild(f, name, key, hash) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [STORE, "implement-start", f.data, f.sid(name), key, "r1", hash], { cwd: f.repo, env: f.env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", () => resolve(out));
  });
}

test("concurrent tickets get their own sibling worktrees and sessions", async () => {
  const f = fixture();
  const hash2 = approvePlan(f, "ABC-2");
  const [a, b] = await Promise.all([implementInChild(f, "impl", KEY, f.hash), implementInChild(f, "impl2", "ABC-2", hash2)]);
  assert.match(a, /WORKTREE CREATED for ABC-1/);
  assert.match(b, /WORKTREE CREATED for ABC-2/);
  assert.match(f.implement("impl"), /AUTHORIZED for ABC-1/);
  assert.match(f.implement("impl2", "ABC-2", hash2), /AUTHORIZED for ABC-2/);
  assert.deepEqual(fs.readdirSync(f.parent).sort(), ["demo app", "demo app-ABC-1", "demo app-ABC-2"]);
  assert.equal(f.session("impl").worktree.path, f.wt);
  assert.equal(f.session("impl2").worktree.path, `${f.parent}/demo app-ABC-2`);
});

test("two concurrent /implement runs for one ticket give one worktree and one refusal", async () => {
  const f = fixture();
  const outs = await Promise.all([implementInChild(f, "a", KEY, f.hash), implementInChild(f, "b", KEY, f.hash)]);
  assert.equal(outs.filter((o) => /WORKTREE CREATED/.test(o)).length, 1, outs.join("\n---\n"));
  assert.match(outs.find((o) => !/WORKTREE CREATED/.test(o)), /IMPLEMENTATION: (REFUSED|AUTHORIZED)/);
  assert.equal(fs.readdirSync(path.join(f.data, "plans", SITE, KEY)).filter((n) => /^worktree-b/.test(n)).length, 1);
});

// ------------------------------------------------------------ report-save

test("report-save records git facts from the worktree and refuses a tampered binding", () => {
  const f = fixture();
  f.authorize();
  fs.writeFileSync(path.join(f.wt, "src", "app.js"), "module.exports = 2;\n");
  fs.writeFileSync(path.join(f.wt, "src", "new file é.js"), "x\n");
  const before = mainState(f);
  const draft = () => {
    const d = f.run(["draft-path", SITE, KEY, "report"]).out.trim();
    fs.writeFileSync(d, `Report ${KEY}\n`);
    return d;
  };
  const file = path.join(f.data, "plans", SITE, KEY, "worktree-b1.json");
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, good.replace(`"branch": "jira/${KEY}"`, '"branch": "main"'));
  assert.match(f.run(["report-save", f.data, f.sid("impl"), draft()]).out, /ERROR: .*(invalid signature|binding changed)/);
  fs.writeFileSync(file, good);

  assert.match(f.run(["report-save", f.data, f.sid("impl"), draft()]).out, /REPORT SAVED/);
  const meta = JSON.parse(fs.readFileSync(path.join(f.data, "plans", SITE, KEY, "impl-r1-1.json"), "utf8"));
  assert.equal(meta.worktree.path, f.wt);
  assert.deepEqual(meta.changedSinceAuthorization, [" M src/app.js", "?? src/new file é.js"]);
  assert.ok(meta.untrackedFileSha256[0].startsWith("src/new file é.js:") && !meta.untrackedFileSha256[0].endsWith(":-"), "the untracked file is hashed by its real name");
  assert.deepEqual(mainState(f), before, "the main checkout is untouched");
});

// ---------------------------------------------- status parsing, approvals

test("git status lines are exact for spaces, non-ASCII, and renames (NUL-delimited parsing)", () => {
  const f = makeFixture(undefined, { repoDir: REPO_DIR });
  fs.writeFileSync(path.join(f.repo, "my notes.txt"), "n\n");
  fs.writeFileSync(path.join(f.repo, "é.txt"), "e\n");
  fs.writeFileSync(path.join(f.repo, "it's (1).txt"), "q\n");
  git(f.repo, "mv", "src/app.js", "src/app main.js");
  assert.deepEqual(L.gitStatus(f.repo), [
    "R  src/app.js -> src/app main.js",
    "?? it's (1).txt",
    "?? my notes.txt",
    "?? é.txt",
  ]);
});

test("a valid signed approval is never silently overwritten; replaced records are kept", () => {
  const f = fixture();
  const file = path.join(f.data, "plans", SITE, KEY, "approval-r1.json");
  const kept = () => fs.readdirSync(path.dirname(file)).filter((n) => /^approval-r1-replaced-/.test(n)).sort();
  const original = fs.readFileSync(file, "utf8");

  assert.match(f.run(["approve", f.data, f.sid("again"), KEY, "r1", f.hash]).out, /ALREADY GRANTED/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(kept(), []);

  // A legacy approval (signed without the base) is upgraded by the developer's
  // own approve command; the old record is kept byte for byte.
  const legacy = JSON.parse(original);
  delete legacy.baseHead;
  legacy.hmac = L.sign(legacy, L.approvalKey(f.data, false));
  const legacyText = JSON.stringify(legacy, null, 2);
  fs.writeFileSync(file, legacyText);
  assert.match(f.run(["approve", f.data, f.sid("upgrade"), KEY, "r1", f.hash]).out, /APPROVAL: GRANTED/);
  assert.deepEqual(kept(), ["approval-r1-replaced-1.json"]);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), "approval-r1-replaced-1.json"), "utf8"), legacyText);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).baseHead);

  // An invalid (tampered) record is replaced too, and also kept.
  const tampered = fs.readFileSync(file, "utf8").replace(/"approvedAt": "[^"]+"/, '"approvedAt": "2000-01-01T00:00:00.000Z"');
  fs.writeFileSync(file, tampered);
  assert.match(f.run(["approve", f.data, f.sid("fix"), KEY, "r1", f.hash]).out, /APPROVAL: GRANTED/);
  assert.deepEqual(kept(), ["approval-r1-replaced-1.json", "approval-r1-replaced-2.json"]);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), "approval-r1-replaced-2.json"), "utf8"), tampered);

  // Claude cannot write or reach the kept records.
  assert.equal(decision(guard(f, { session_id: uuid(), tool_name: "Write", tool_input: { file_path: path.join(path.dirname(file), "approval-r1-replaced-1.json") }, permission_mode: "default" })), "deny");
});
