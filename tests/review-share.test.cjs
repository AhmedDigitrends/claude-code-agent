// Shareable review report: the sanitized share view written by review-save,
// the guard's rules for publishing it with Claude Code's Artifact tool, the
// recorded artifact URL, and its use in the pull request description. The
// signed review, its approval, and every gate are unchanged. No network, no
// artifact is actually published (the Artifact tool is exercised through the
// guard only). Repositories live under "React Apps/demo app".
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../scripts/lib/approval.cjs");
const { sanitize } = require("../scripts/lib/render-review.cjs");
const { SITE, KEY, draft, guard, uuid } = require("./helpers.cjs");
const { worktreeTicket } = require("./worktree-flow.cjs");

const TOKEN = `ghp_${"A".repeat(36)}`;
const LOGMARK = "LOGMARK-7c1f";
const REMOTE = "https://github.com/example-org/demo_app.git";
const URL1 = "https://claude.ai/code/artifact/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

// A PASS review with a passing required check (whose log carries a marker,
// a local path, a private remote, and a token), a failing optional check, a
// manual case, and a finding that quotes local and private details.
function reviewedForShare() {
  const f = worktreeTicket("implemented");
  f.reviewsDir = path.join(f.ticket, "reviews");
  const start = f.run(["review-start", f.data, f.sid("review"), KEY]).out;
  assert.match(start, /REVIEW: STARTED rv-1/);
  const noisy = `node -e "console.log('${LOGMARK} ${f.wt.replace(/\\/g, "/")}/src/app.js ${REMOTE} token=${TOKEN}'); process.exit(require('./src/app.js') === 2 ? 0 : 1)"`;
  assert.match(f.run(["run-check", f.data, f.sid("review"), "app", "required", noisy]).out, /Exit code: 0/);
  f.run(["run-check", f.data, f.sid("review"), "lint", "optional", `node -e "process.exit(3)"`]);
  const review = {
    verdict: "PASS",
    summary: `Exports 2. Checked in ${f.repo} against ${REMOTE}.`,
    requirementsSource: "plan",
    acceptanceCriteria: [{ id: "AC1", text: "app exports 2", status: "Verified", evidence: ["check:C1", "file:src/app.js:1"] }],
    testCases: [
      { id: "TC1", requirement: "AC1", scenario: "export value", type: "automated", checkId: "C1", status: "Passed", steps: [], expected: "2", actual: "2", evidence: `${LOGMARK} ok` },
      { id: "TC2", requirement: "AC1", scenario: "lint", type: "automated", checkId: "C2", status: "Failed", steps: [], expected: "clean", actual: "exit 3", evidence: "" },
      { id: "TC3", requirement: "AC1", scenario: "manual smoke", type: "manual", status: "Not Run", steps: ["open the app"], expected: "renders", evidence: "" },
    ],
    findings: [{ id: "F1", severity: "minor", title: "style", detail: `See ${f.wt}\\src\\app.js and ${REMOTE}; key ${TOKEN}`, evidence: [] }],
    checkAssessments: [{ checkId: "C1", assessment: "passed", reason: "" }, { checkId: "C2", assessment: "not-relevant", reason: "optional lint" }],
    changedFiles: [{ path: "src/app.js", assessment: "ok" }],
  };
  f.saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", JSON.stringify(review))]).out;
  assert.match(f.saved, /VERDICT: PASS/, f.saved);
  f.reviewHash = /Review SHA-256: ([0-9a-f]{64})/.exec(f.saved)[1];
  f.shareFile = path.join(f.reviewsDir, "review-rv-1.share.html");
  f.record = (url, sid = f.sid("review")) => f.run(["review-share-record", f.data, sid, url]);
  f.artifact = (toolInput, ctx = {}) => guard(f, { session_id: f.sid("review"), tool_name: "Artifact", tool_input: toolInput, permission_mode: "default", cwd: f.repo, ...ctx });
  return f;
}

// ---------------------------------------------------------------- the view

test("review-save writes a sanitized share view without changing the signed review", () => {
  const f = reviewedForShare();
  assert.ok(f.saved.includes(`Share view (sanitized, for an optional claude.ai artifact): ${path.join(f.reviewsDir, "review-rv-1")}.share.html`));
  const html = fs.readFileSync(f.shareFile, "utf8");

  // Content: verdict, criteria, test cases by result, checks, findings, hash.
  assert.match(html, /<div class="verdict pass">PASS<\/div>/);
  assert.match(html, /AC1<\/td><td>app exports 2<\/td><td>Verified/);
  // Automated cases: read-only, grouped by recorded result.
  for (const [s, n] of [["Passed", 1], ["Failed", 1], ["Blocked", 0], ["Not Run", 0]]) {
    assert.match(html, new RegExp(`<h4><span class="badge [a-z]+">${s}</span> ${n}</h4>`), s);
  }
  assert.match(html, /<h3>Automated test cases \(read-only\)<\/h3>[\s\S]*<td>TC1<\/td>[\s\S]*<td>TC2<\/td>[\s\S]*<h3>Manual QA checklist<\/h3>/);
  // Manual cases: a checklist card with steps, expected result, the four options, and notes.
  assert.match(html, /<section class="qa-card" data-qa-card="TC3"[\s\S]*<li>open the app<\/li>[\s\S]*Expected:<\/span> renders/);
  for (const v of ["Passed", "Failed", "Blocked", "Not Tested"]) assert.ok(html.includes(`value="${v}" data-qa-id="TC3"`), v);
  assert.ok(!/data-qa-id="TC1"|data-qa-id="TC2"/.test(html), "automated cases have no controls");
  assert.match(html, /<textarea data-qa-notes="TC3"/);
  assert.match(html, /kept <b>only in this browser<\/b>: they are not saved centrally, not shared with other people/);
  assert.match(html, /cannot approve, commit, push, or merge anything/);
  assert.match(html, /<button type="button" id="qa-copy">Copy QA results<\/button>/);
  assert.match(html, /<td>C1<\/td><td>app<\/td><td>required<\/td><td>passed<\/td>/);
  assert.match(html, /<td>C2<\/td><td>lint<\/td><td>optional<\/td><td>failed \(exit 3\)<\/td>/);
  assert.ok(html.includes(`Review SHA-256: <code>${f.reviewHash}</code>`));
  assert.ok(html.includes(`/jira-dev-harness:approve-review ${KEY} rv-1 ${f.reviewHash}`));
  assert.match(html, /This page cannot approve anything/);

  // Exclusions: logs, commands, local paths, remote, links, credentials, script.
  const lower = html.toLowerCase();
  for (const bad of [LOGMARK, TOKEN, "github.com", "process.exit", f.repo, f.wt, f.data, f.repo.replace(/\\/g, "/"), f.wt.replace(/\//g, "\\")]) {
    assert.ok(!lower.includes(String(bad).toLowerCase()), `the share view must not contain ${bad}`);
  }
  // Scripts: exactly the inert data block and the checklist script; nothing external, no network.
  assert.equal((html.match(/<script\b/g) || []).length, 2);
  assert.match(html, /<script type="application\/json" id="qa-data">/);
  assert.doesNotMatch(html, /<script[^>]+src=|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|import\(|<form|<iframe|<link\b/);
  assert.ok(!/[A-Za-z]:[\\/]/.test(html.replace(/https?:/g, "")), "no drive-letter paths");
  assert.match(html, /\[local path removed\]|\[path removed\]/);
  assert.match(html, /\[link removed\]/);

  // Signed record of the view; the signed review, its HTML, and approval are unchanged.
  const view = JSON.parse(fs.readFileSync(path.join(f.reviewsDir, "review-rv-1.share.json"), "utf8"));
  assert.ok(L.signatureValid(view, L.approvalKey(f.data, false)));
  assert.equal(view.sha256, L.sha256(f.shareFile));
  assert.equal(view.reviewSha256, f.reviewHash);
  assert.equal(L.sha256(path.join(f.reviewsDir, "review-rv-1.json")), f.reviewHash);
  const full = fs.readFileSync(path.join(f.reviewsDir, "review-rv-1.html"), "utf8");
  assert.ok(full.includes(LOGMARK), "the full local report still holds the check log");
  assert.match(f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", f.reviewHash]).out, /REVIEW APPROVAL: GRANTED/);
});

// ------------------------------------------------- manual QA checklist script

const vm = require("vm");
const { QA_SCRIPT, renderShareHtml } = require("../scripts/lib/render-review.cjs");
const DATA = {
  issueKey: "ABC-407", reviewId: "rv-2", reviewSha256: "b".repeat(64), verdict: "PASS",
  manual: [{ id: "TC3", scenario: "manual smoke" }, { id: "TC4", scenario: "edge case" }],
  automated: [{ id: "TC1", status: "Passed", checkId: "C1" }, { id: "TC2", status: "Failed", checkId: "C2" }],
};
const core = () => { const window = {}; vm.runInNewContext(QA_SCRIPT, { window }); return window.__jdhQa; };
// Objects made inside the sandbox have its own prototypes; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

test("checklist core: only manual cases and valid results count; automated results can't be overridden", () => {
  const qa = core();
  const ids = DATA.manual.map((m) => m.id);
  assert.deepEqual(plain(qa.counts({}, ids)), { Passed: 0, Failed: 0, Blocked: 0, "Not Tested": 2 });
  const state = { TC3: { status: "Passed", notes: "ok on Chrome" }, TC4: { status: "Approved" }, TC1: { status: "Failed" }, __proto__x: { status: "Passed" } };
  const clean = plain(qa.clean(state, ids));
  assert.deepEqual(Object.keys(clean), ["TC3", "TC4"], "automated ids and unknown keys are dropped");
  assert.equal(clean.TC4.status, "Not Tested", "an unknown status is not accepted");
  assert.deepEqual(plain(qa.counts(state, ids)), { Passed: 1, Failed: 0, Blocked: 0, "Not Tested": 1 });
  assert.equal(qa.clean({ TC3: { status: "Blocked", notes: "x".repeat(5000) } }, ids).TC3.notes.length, 2000);
});

test("checklist export: ticket, review, hash, every manual case with result and notes, automated read-only", () => {
  const text = core().exportText(DATA, { TC3: { status: "Failed", notes: "button\nmissing" }, TC4: { status: "Blocked" } }, "2026-11-10T12:00:00.000Z");
  assert.equal(text, [
    "jira-dev-harness manual QA results",
    "Ticket: ABC-407",
    `Review: rv-2 (review SHA-256 ${"b".repeat(64)})`,
    "Automated review verdict: PASS",
    "Exported: 2026-11-10T12:00:00.000Z (kept only in this browser; not recorded by jira-dev-harness; does not approve anything)",
    "Manual: Passed 0, Failed 1, Blocked 1, Not Tested 0",
    "- TC3 [Failed] manual smoke | Notes: button missing",
    "- TC4 [Blocked] edge case",
    "Automated (read-only): TC1 Passed (C1); TC2 Failed (C2)",
  ].join("\n"));
});

// A small stand-in for the browser page: the elements the script uses, built
// from the generated HTML, with change/input/click events and localStorage.
function fakePage(html, storage) {
  const els = [];
  const make = (tag, attrs) => {
    const el = { tagName: tag, attrs, listeners: {}, value: attrs.value || "", checked: "checked" in attrs, disabled: false, textContent: "", focus() {}, select() { this.selected = true; } };
    el.getAttribute = (n) => (n in el.attrs ? el.attrs[n] : null);
    el.setAttribute = (n, v) => { el.attrs[n] = String(v); };
    el.addEventListener = (ev, fn) => { (el.listeners[ev] = el.listeners[ev] || []).push(fn); };
    el.fire = (ev) => (el.listeners[ev] || []).forEach((fn) => fn({ target: el }));
    els.push(el);
    return el;
  };
  const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], (m[2] || "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&")]));
  for (const m of html.matchAll(/<(input|textarea|section|b|p|span|button)\b([^>]*)>/g)) make(m[1], attrsOf(m[2]));
  const data = /<script type="application\/json" id="qa-data">([\s\S]*?)<\/script>/.exec(html)[1];
  const byId = (id) => (id === "qa-data" ? { textContent: data } : els.find((e) => e.attrs.id === id) || null);
  const match = (sel) => {
    const m = /^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    return els.filter((e) => (!m[1] || e.tagName === m[1]) && m[2] in e.attrs && (m[3] === undefined || e.attrs[m[2]] === m[3]));
  };
  const document = { getElementById: byId, querySelectorAll: match, querySelector: (s) => match(s)[0] || null };
  const window = { localStorage: storage };
  const clipboard = { text: null, writeText(t) { this.text = t; return Promise.resolve(); } };
  vm.runInNewContext(QA_SCRIPT, { window, document, navigator: { clipboard } });
  return { els, byId, match, clipboard };
}

const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };

test("checklist page: choosing results updates live counts, notes, the export, and this browser's storage only", async () => {
  const review = {
    reviewId: "rv-2", reviewedAt: "t", verdict: "PASS", reviewerVerdict: "PASS", summary: "s", failReasons: [], blockReasons: [], seriousFindings: [], findings: [], checks: [], acceptanceCriteria: [],
    identity: { issueKey: "ABC-407", planRevision: 1 },
    testCases: [
      { id: "TC1", requirement: "AC1", type: "automated", checkId: "C1", scenario: "auto", steps: [], expected: "", status: "Passed" },
      { id: "TC3", requirement: "AC1", type: "manual", scenario: "manual smoke", steps: ["open"], expected: "renders", status: "Not Run" },
      { id: "TC4", requirement: "AC2", type: "manual", scenario: "edge case", steps: [], expected: "", status: "Not Run" },
    ],
  };
  const html = renderShareHtml(review, "c".repeat(64));
  const storage = memoryStorage();
  const page = fakePage(html, storage);
  const count = (k) => page.match(`[data-count="${k}"]`)[0].textContent;
  assert.equal(count("Not Tested"), "2");

  const radio = (id, v) => page.match(`input[data-qa-id="${id}"]`).find((e) => e.attrs.value === v);
  radio("TC3", "Passed").fire("change");
  radio("TC4", "Failed").fire("change");
  const notes = page.match('textarea[data-qa-notes="TC4"]')[0];
  notes.value = "crashes on save";
  notes.fire("input");
  assert.deepEqual(["Passed", "Failed", "Blocked", "Not Tested"].map(count), ["1", "1", "0", "0"]);
  assert.equal(page.match('[data-qa-card="TC4"]')[0].attrs["data-result"], "Failed");
  const exported = page.byId("qa-export").value;
  assert.match(exported, /- TC3 \[Passed\] manual smoke\n- TC4 \[Failed\] edge case \| Notes: crashes on save/);
  assert.match(exported, /Automated \(read-only\): TC1 Passed \(C1\)/);

  // Stored only in this browser, keyed by ticket, review, and review hash.
  assert.deepEqual([...storage.map.keys()], [`jdh-qa:ABC-407:rv-2:${"c".repeat(16)}`]);
  assert.match(page.byId("qa-store").textContent, /saved in this browser only/);

  // Copy puts exactly the export on the clipboard.
  page.byId("qa-copy").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.equal(page.clipboard.text, page.byId("qa-export").value);
  assert.equal(page.byId("qa-copied").textContent, "Copied.");

  // A reload restores the same results; a new review starts empty.
  const again = fakePage(html, storage);
  assert.equal(again.match('[data-count="Failed"]')[0].textContent, "1");
  assert.equal(again.match('textarea[data-qa-notes="TC4"]')[0].value, "crashes on save");
  const newer = fakePage(renderShareHtml({ ...review, reviewId: "rv-3" }, "d".repeat(64)), storage);
  assert.equal(newer.match('[data-count="Not Tested"]')[0].textContent, "2");
});

test("checklist page still works when the browser blocks storage", () => {
  const html = renderShareHtml({
    reviewId: "rv-2", reviewedAt: "t", verdict: "FAIL", reviewerVerdict: "FAIL", summary: "s", failReasons: ["x"], blockReasons: [], seriousFindings: [], findings: [], checks: [], acceptanceCriteria: [],
    identity: { issueKey: "ABC-407", planRevision: 1 }, testCases: [{ id: "TC3", requirement: "AC1", type: "manual", scenario: "m", steps: [], expected: "", status: "Not Run" }],
  }, "e".repeat(64));
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };
  const page = fakePage(html, blocked);
  page.match('input[data-qa-id="TC3"]').find((e) => e.attrs.value === "Blocked").fire("change");
  assert.equal(page.match('[data-count="Blocked"]')[0].textContent, "1");
  assert.match(page.byId("qa-store").textContent, /does not allow saving: your results last only until you leave this page/);
});

test("sanitize removes paths, links, and credentials and keeps ordinary text", () => {
  const out = sanitize(`C:\\Users\\dev\\repo\\a.js /home/dev/x.js D:/work/y.js \\\\server\\share\\z https://github.com/o/r.git git@github.com:o/r.git token=${TOKEN} src/app.js:3 keep me`, ["D:/work"]);
  for (const bad of ["Users", "/home/dev", "D:/work", "server", "github.com", TOKEN]) assert.ok(!out.includes(bad), bad);
  assert.match(out, /src\/app\.js:3 keep me/);
});

// ------------------------------------------------------ publishing (guard)

test("the guard lets only the review session publish exactly the intact share view, and always asks", () => {
  const f = reviewedForShare();
  const ok = f.artifact({ file_path: f.shareFile, description: "review" });
  assert.equal(ok.permissionDecision, "ask");
  assert.match(ok.permissionDecisionReason, /omits raw logs, check commands, local paths, the repository location and remote, links, and credentials/);
  assert.equal(f.artifact({ action: "publish", file_path: f.shareFile.replace(/\\/g, "/") }).permissionDecision, "ask");

  const deny = (input, ctx, why) => {
    const r = f.artifact(input, ctx);
    assert.equal(r.permissionDecision, "deny", JSON.stringify(input));
    if (why) assert.match(r.permissionDecisionReason, why);
  };
  deny({ file_path: path.join(f.reviewsDir, "review-rv-1.html") }, {}, /only .*share\.html may be published/);
  deny({ file_path: path.join(f.reviewsDir, "rv-1", "checks", "C1.log") });
  deny({ file_path: path.join(f.wt, "src", "app.js") });
  deny({ file_path: f.shareFile, files: { "x.html": path.join(f.reviewsDir, "review-rv-1.html") } }, {}, /"files" option is not allowed/);
  deny({ file_path: f.shareFile, url: "https://claude.ai/code/artifact/abc12345" }, {}, /"url" option/);
  deny({ file_path: f.shareFile, capabilities: { db: {} } }, {}, /capabilities/);
  deny({ file_path: f.shareFile }, { agent_type: "jira-dev-harness:reviewer" }, /may not publish/);
  deny({ file_path: f.shareFile }, { permission_mode: "bypassPermissions" }, /attended mode/);
  deny({ file_path: f.shareFile }, { session_id: f.sid("impl") }, /nothing may be published in implementing mode/);

  // A modified share view is never published.
  const good = fs.readFileSync(f.shareFile, "utf8");
  fs.writeFileSync(f.shareFile, good.replace("</main>", `<p>${TOKEN}</p></main>`));
  deny({ file_path: f.shareFile }, {}, /modified after it was generated/);
  fs.writeFileSync(f.shareFile, good);

  // Other Artifact actions follow the normal flow; ordinary sessions are unaffected.
  assert.equal(f.artifact({ action: "list" }).permissionDecision, "(none)");
  assert.equal(f.artifact({ file_path: path.join(f.wt, "notes.html") }, { session_id: uuid() }).permissionDecision, "(none)");
});

// ---------------------------------------------- the URL and the pull request

test("only a real claude.ai artifact URL for the session's current review is recorded", () => {
  const f = reviewedForShare();
  for (const bad of ["https://example.com/report", "https://claude.ai/chat/abc12345", "claude.ai/artifact/abc12345", "https://claude.ai/artifact/x", ""]) {
    const r = f.record(bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.out, /is not a claude\.ai artifact URL/);
  }
  assert.match(f.record(URL1, f.sid("impl")).out, /ERROR: this session has no review/);
  const good = fs.readFileSync(f.shareFile, "utf8");
  fs.writeFileSync(f.shareFile, `${good}<!-- edited -->`);
  assert.match(f.record(URL1).out, /ERROR: the share view file was modified/);
  fs.writeFileSync(f.shareFile, good);

  const out = f.record(URL1).out;
  assert.match(out, /REVIEW SHARE URL RECORDED: https:\/\/claude\.ai\/code\/artifact\//);
  assert.match(out, /approval is still only \/jira-dev-harness:approve-review/);
  const rec = JSON.parse(fs.readFileSync(path.join(f.reviewsDir, "review-rv-1.share-url-1.json"), "utf8"));
  assert.ok(L.signatureValid(rec, L.approvalKey(f.data, false)));
  assert.equal(rec.reviewSha256, f.reviewHash);
  assert.equal(rec.url, URL1);
  // Claude may run the command; the guard keeps it pinned to the plugin's data folder.
  const cmd = (data) => `node "${path.join(__dirname, "..", "scripts", "plan-store.cjs").replace(/\\/g, "/")}" review-share-record "${data.replace(/\\/g, "/")}" ${f.sid("review")} ${URL1}`;
  assert.equal(guard(f, { session_id: f.sid("review"), tool_name: "Bash", tool_input: { command: cmd(f.data) }, permission_mode: "default" }).permissionDecision, "(none)");
  assert.equal(guard(f, { session_id: f.sid("review"), tool_name: "Bash", tool_input: { command: cmd(path.join(f.base, "forged")) }, permission_mode: "default" }).permissionDecision, "deny");
});

function shipTo(f) {
  assert.match(f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", f.reviewHash]).out, /GRANTED/);
  assert.match(f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", f.reviewHash]).out, /SHIP: AUTHORIZED/);
  assert.match(f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: export 2\n`)]).out, /COMMITTED/);
  assert.match(f.run(["ship-push", f.data, f.sid("ship")]).out, /PUSHED/);
  return f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Export two\n\nChanges the export.\n")]).out;
}

test("a recorded review URL is included in the pull request body; the prepared body is what the PR must carry", () => {
  const f = reviewedForShare();
  f.record(URL1);
  const prep = shipTo(f);
  assert.ok(prep.includes(`Review report link: ${URL1}`));
  const body = /-----BEGIN PR BODY-----\n([\s\S]*?)\n-----END PR BODY-----/.exec(prep)[1];
  assert.ok(body.includes(`Review report (read-only copy): ${URL1}`));
  const title = /^Title: (.*)$/m.exec(prep)[1];
  const create = (b) => guard(f, { session_id: f.sid("ship"), permission_mode: "default", tool_name: "mcp__github__create_pull_request", tool_input: { owner: "acme", repo: "widgets", head: `jira/${KEY}`, base: "main", title, body: b }, cwd: f.repo });
  assert.equal(create(body).permissionDecision, "ask");
  assert.equal(create(body.replace(URL1, "https://claude.ai/code/artifact/ffffffff-0000")).permissionDecision, "deny", "a different link is refused");
});

test("without a recorded URL (or with an invalid record) no link is added and none is invented", () => {
  const f = reviewedForShare();
  let prep = shipTo(f);
  assert.match(prep, /Review report link: none recorded \(no published review artifact; nothing is added\)/);
  assert.doesNotMatch(prep, /claude\.ai\//);

  const g = reviewedForShare();
  g.record(URL1);
  const file = path.join(g.reviewsDir, "review-rv-1.share-url-1.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...rec, url: "https://claude.ai/code/artifact/forged-0000-1111" }));
  prep = shipTo(g);
  assert.match(prep, /Review report link: none recorded/);
  assert.doesNotMatch(prep, /forged/);
});

test("the review skill asks before publishing, publishes only the share view, and never invents a URL", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "skills", "review", "SKILL.md"), "utf8");
  assert.match(skill, /## Step 5: Optional shareable report \(only with the developer's consent\)/);
  assert.match(skill, /Continue only on an explicit yes/);
  assert.match(skill, /\*\*Never invent or guess a URL\*\*/);
  assert.match(skill, /review-share-record/);
  assert.doesNotMatch(skill.split("\n").find((l) => l.startsWith("allowed-tools:")), /Artifact/, "publishing keeps its permission prompt");
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hooks", "hooks.json"), "utf8"));
  assert.match(hooks.hooks.PreToolUse[0].matcher, /\|Artifact\)/);
});
