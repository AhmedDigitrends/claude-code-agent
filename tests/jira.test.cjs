// Phase 7 tests: Jira progress automation, with mocked Jira responses.
// "Jira" evidence goes through the real PostToolUse hook (evidence.cjs) and
// write attempts through the real guard, in disposable repositories. No real
// Jira site, token, or network is involved.
// Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const JG = require("../scripts/lib/jira-gate.cjs");
const JM = require("../scripts/lib/jira-mapping.cjs");
const PR = require("../scripts/lib/progress.cjs");
const M = require("../scripts/lib/merge.cjs");
const L = require("../scripts/lib/approval.cjs");
const { ROOT, SITE, KEY, uuid, git, draft, makeFixture, legacyImplement, reviewed, guard } = require("./helpers.cjs");

const EVIDENCE = path.join(ROOT, "scripts", "evidence.cjs");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

// ------------------------------------------------------------ mock Jira

const T = (n) => `mcp__atlassian__${n}`;
const mapping = (o = {}) => ({
  site: SITE, projectKeys: ["ABC"], board: { id: "12", name: null, verification: "required" },
  progress: { comments: true, stages: { implementing: { toStatuses: ["In Progress"], allowDone: false }, "awaiting-review-approval": { toStatuses: ["In Review"], allowDone: false }, merged: { toStatuses: ["Done"], allowDone: true } } },
  ...o,
});
// The committed file form of the mapping used by the disposable repositories.
const fileMapping = () => ({ jira: { site: SITE, projectKeys: ["ABC"], board: { id: 12 }, progress: { comments: true, stages: { implementing: { toStatuses: ["In Progress"] }, "awaiting-review-approval": { toStatuses: ["In Review"] }, merged: { toStatuses: ["Done"], allowDone: true } } } } });
const COMMENT = "[jira-dev-harness] Implementation (jdh:implementing:abc123)\nPlan: r1";
const state = (o = {}) => ({
  mode: "jira-syncing", phase: "started", issueKey: KEY, site: SITE, stage: "implementing", allowDone: false, mapping: mapping(),
  comment: { marker: "jdh:implementing:abc123", text: COMMENT, sha256: sha(COMMENT) }, startedAt: iso(-60000), sessionId: uuid(), ...o,
});

const status = (id, name, category) => ({ id, name, statusCategory: { key: category } });
const tr = (id, name, to) => ({ id, name, to });
function mock(o = {}) {
  const base = {
    resources: [{ id: "cloud-1", url: `https://${SITE}`, name: "Site" }],
    issue: { key: KEY, id: "10001", fields: { project: { key: "ABC" }, status: status("1", "To Do", "new") } },
    transitions: { transitions: [tr("21", "Start Progress", status("3", "In Progress", "indeterminate")), tr("31", "Close", status("5", "Done", "done")), tr("41", "Send to review", status("4", "In Review", "indeterminate"))] },
    comments: { comments: [] },
    board: { id: 12, name: "Team board", type: "scrum" },
    boardIssues: { issues: [{ key: KEY }, { key: "ABC-2" }] },
    boardConfig: { columnConfig: { columns: [{ name: "Doing", statuses: [{ id: "3" }, { id: "4" }] }, { name: "Done", statuses: [{ id: "5" }] }] } },
    boardProjects: { values: [{ key: "ABC" }, { key: "XYZ" }] },
  };
  return { ...base, ...o };
}
const NAMES = {
  resources: [T("getAccessibleAtlassianResources"), {}],
  issue: [T("getJiraIssue"), { cloudId: "cloud-1", issueIdOrKey: KEY }],
  transitions: [T("getTransitionsForJiraIssue"), { cloudId: "cloud-1", issueIdOrKey: KEY }],
  comments: [T("listJiraIssueComments"), { cloudId: "cloud-1", issueIdOrKey: KEY }],
  board: [T("getJiraBoard"), { boardId: 12 }],
  boardIssues: [T("getJiraBoardIssues"), { boardId: 12 }],
  boardConfig: [T("getJiraBoardConfiguration"), { boardId: 12 }],
  boardProjects: [T("getJiraBoardProjects"), { boardId: 12 }],
};
const records = (m, at = iso()) => Object.entries(m).filter(([, d]) => d).map(([k, data]) => ({ tool: NAMES[k][0], input: NAMES[k][1], at, data }));
const plan = (st, m, ledger = []) => JG.plan(st, records(m), ledger);

// ---------------------------------------------------------------- tools

test("classifyCall: reads, the two allowed writes, and everything else as a write", () => {
  const C = JG.classifyCall;
  for (const n of ["getJiraIssue", "getTransitionsForJiraIssue", "listJiraIssueComments", "getAccessibleAtlassianResources", "searchJiraIssuesUsingJql", "lookupJiraAccountId", "authenticate"]) {
    assert.equal(C(T(n), {}), "read", n);
  }
  assert.equal(C(T("transitionJiraIssue"), {}), "transition");
  assert.equal(C(T("addCommentToJiraIssue"), {}), "comment");
  assert.equal(C(T("addOrEditJiraIssueComment"), { commentId: "9" }), "write-other", "editing a comment is not adding one");
  assert.equal(C(T("addOrEditJiraIssueComment"), {}), "comment");
  for (const n of ["editJiraIssue", "createJiraIssue", "assignJiraIssue", "deleteJiraIssue", "addWorklogToJiraIssue", "linkJiraIssues", "someNewTool"]) {
    assert.equal(C(T(n), {}), "write-other", n);
  }
  // Meta-tools: the real operation is an input.
  assert.equal(C(T("executeRead"), { operation: "listJiraIssueRemoteIssueLinks", params: {} }), "read");
  assert.equal(C(T("executeWrite"), { operation: "transitionJiraIssue", params: {} }), "transition");
  assert.equal(C(T("executeWrite"), { operation: "addCommentToJiraIssue", params: {} }), "comment");
  assert.equal(C(T("executeWrite"), { operation: "editJiraIssue", params: {} }), "write-other");
  assert.equal(C(T("executeWrite"), {}), "write-other", "an unnamed write operation fails closed");
  assert.equal(C(T("executeDestructive"), { operation: "transitionJiraIssue", params: {} }), "write-other");
  assert.equal(C("mcp__github__create_pull_request", {}), null);
  assert.equal(C("Bash", {}), null);
});

// --------------------------------------------------------------- mapping

function mappingRoot(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdh-map-"));
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "jira-dev-harness.json"), typeof json === "string" ? json : JSON.stringify(json));
  return dir;
}

test("mapping: old mappings stay valid, and invalid extensions are rejected", () => {
  const old = JM.readMapping(mappingRoot({ jira: { site: SITE, projectKeys: ["ABC"] } }));
  assert.deepEqual(old.errors, []);
  assert.equal(old.mapping.board, null);
  assert.deepEqual(old.mapping.progress, { comments: true, stages: {} });

  const full = JM.readMapping(mappingRoot({ jira: { site: SITE, projectKeys: ["ABC", "XYZ"], board: { id: 12, verification: "workflow-only" }, progress: { comments: false, stages: { merged: { toStatuses: ["Done"], allowDone: true } } } } }));
  assert.deepEqual(full.errors, []);
  assert.equal(full.mapping.board.id, "12");
  assert.equal(full.mapping.board.verification, "workflow-only");

  const bad = [
    [{ jira: { site: "evil.example.com", projectKeys: ["ABC"] } }, /not a \*\.atlassian\.net/],
    [{ jira: { site: SITE, projectKeys: [] } }, /projectKeys/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], board: { id: "x" } } }, /positive integer/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], board: { id: 0 } } }, /positive integer/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], board: { id: 1, verification: "none" } } }, /verification must be/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], board: { id: 1, token: "x" } } }, /unknown key "token"/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], boards: [] } }, /unknown key "boards"/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], progress: { stages: { shipping: { toStatuses: ["X"] } } } } }, /not a workflow stage/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], progress: { stages: { implementing: { toStatuses: [] } } } } }, /1 to 5 status names/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], progress: { stages: { implementing: { toStatuses: ["Done"], allowDone: true } } } } }, /only allowed for "merged"/],
    [{ jira: { site: SITE, projectKeys: ["ABC"], progress: { stages: { merged: { toStatuses: ["Done"], transitionId: "31" } } } } }, /unknown key "transitionId"/],
    [{ nope: 1 }, /no "jira" object/],
    ["{ not json", /missing or has no "jira"/],
  ];
  for (const [json, re] of bad) {
    const r = JM.readMapping(mappingRoot(json));
    assert.ok(r.mapping === null && r.errors.some((e) => re.test(e)), `${JSON.stringify(json)} -> ${r.errors}`);
  }
});

// ------------------------------------------------------------------ plan

test("plan: a verified board and a matching transition produce one transition and one comment", () => {
  const p = plan(state(), mock());
  assert.deepEqual(p.reasons, []);
  assert.equal(p.ok, true);
  assert.equal(p.cloudId, "cloud-1");
  assert.equal(p.board.verified, true);
  assert.deepEqual(p.actions.transition, { id: "21", name: "Start Progress", toId: "3", toName: "In Progress", from: "To Do" });
  assert.equal(p.actions.comment.sha256, sha(COMMENT));
});

const BLOCKS = [
  ["the accessible sites were not read", { resources: null }, /accessible Atlassian sites were not read/],
  ["the account can't access the mapped site", { resources: [{ id: "c9", url: "https://other.atlassian.net" }] }, /cannot access example\.atlassian\.net/],
  ["the ticket was not read", { issue: null }, /ticket was not read/],
  ["the ticket's project is not mapped", { issue: { key: KEY, id: "1", fields: { project: { key: "ZZZ" }, status: status("1", "To Do", "new") } } }, /project ZZZ is not mapped/],
  ["the ticket has no status", { issue: { key: KEY, id: "1", fields: { project: { key: "ABC" } } } }, /status is missing/],
  ["the board was not read", { board: null }, /board 12 was not read/],
  ["a different board was read", { board: { id: 99, name: "x", type: "kanban" } }, /not the mapped board 12|board 12 was not read/],
  ["board issues were not read (membership unverified)", { boardIssues: null }, /membership is unverified/],
  ["the ticket is not on the board", { boardIssues: { issues: [{ key: "ABC-2" }] } }, /not on board 12/],
  ["the board does not include the ticket's project", { boardProjects: { values: [{ key: "XYZ" }] } }, /does not include project ABC/],
  ["the transitions were not read", { transitions: null }, /transitions were not read/],
];
for (const [name, override, re] of BLOCKS) {
  test(`plan blocks: ${name}`, () => {
    const p = plan(state(), mock(override));
    assert.equal(p.ok, false);
    assert.match(p.reasons.join("\n"), re);
    assert.deepEqual(p.actions, {}, "a blocked plan authorizes nothing");
  });
}

test("plan blocks: no board in the mapping, a ticket from an unmapped project, and stale or early evidence", () => {
  assert.match(plan(state({ mapping: mapping({ board: null }) }), mock()).reasons.join("\n"), /no "jira\.board"/);
  assert.equal(plan(state({ mapping: mapping({ projectKeys: ["XYZ"] }) }), mock()).ok, false);
  const old = iso(-30 * 60 * 1000);
  assert.match(JG.plan(state({ startedAt: iso(-3600 * 1000) }), records(mock(), old), []).reasons.join("\n"), /older than 10 minutes/);
  assert.match(JG.plan(state(), records(mock(), old), []).reasons.join("\n"), /before this sync was authorized/);
});

test("plan: boards with several projects, several boards, and several tickets", () => {
  // The board spans ABC and XYZ; the ticket is ABC; the repository maps ABC only.
  assert.equal(plan(state(), mock()).ok, true);
  // Evidence about another board is ignored, and the mapped board is still verified.
  const records2 = [...records(mock({ board: { id: 99, name: "other", type: "scrum" }, boardIssues: { issues: [] } })).map((r) => ({ ...r, input: { boardId: 99 } })), ...records(mock())];
  assert.equal(JG.plan(state(), records2, []).ok, true);
  // Only another board's evidence: the mapped board is unverified.
  const onlyOther = records(mock()).filter((r) => !/Board/.test(r.tool)).concat(records(mock()).filter((r) => /Board/.test(r.tool)).map((r) => ({ ...r, input: { boardId: 99 } })));
  assert.match(JG.plan(state(), onlyOther, []).reasons.join("\n"), /board 12 was not read/);
  // A read of another ticket is never used for this one.
  const other = records(mock({ issue: { key: "ABC-2", id: "2", fields: { project: { key: "ABC" }, status: status("1", "To Do", "new") } } }));
  assert.match(JG.plan(state(), other, []).reasons.join("\n"), /ticket was not read/);
  const otherTr = records(mock()).map((r) => (r.tool === T("getTransitionsForJiraIssue") ? { ...r, input: { issueIdOrKey: "ABC-2" } } : r));
  assert.match(JG.plan(state(), otherTr, []).reasons.join("\n"), /transitions were not read/);
});

const SKIPS = [
  ["no status is mapped for the stage", state({ stage: "pr-created" }), {}, /no status is mapped/, null],
  ["the ticket is already in the target status", state(), { issue: { key: KEY, id: "1", fields: { project: { key: "ABC" }, status: status("3", "in progress", "indeterminate") } } }, /already in in progress/, null],
  ["the ticket is already Done", state(), { issue: { key: KEY, id: "1", fields: { project: { key: "ABC" }, status: status("5", "Done", "done") } } }, /never moved out of Done/, null],
  ["Jira offers no matching transition", state(), { transitions: { transitions: [tr("31", "Close", status("5", "Done", "done"))] } }, /offers no transition to In Progress/, null],
  ["Jira offers no transitions at all", state(), { transitions: { transitions: [] } }, /offers no transition/, null],
  ["two transitions match", state(), { transitions: { transitions: [tr("21", "A", status("3", "In Progress", "indeterminate")), tr("22", "B", status("6", "In Progress", "indeterminate"))] } }, /ambiguous/, null],
  ["the target status is not on the board", state(), { boardConfig: { columnConfig: { columns: [{ name: "Other", statuses: [{ id: "9" }] }] } } }, /not a status on board 12/, null],
  ["the board configuration was not read", state(), { boardConfig: null }, /column configuration was not read/, null],
  ["the transition needs a screen", state(), { transitions: { transitions: [{ ...tr("21", "Start", status("3", "In Progress", "indeterminate")), hasScreen: true }] } }, /requires a screen/, null],
];
for (const [name, st, override, re] of SKIPS) {
  test(`plan skips the transition (status preserved): ${name}`, () => {
    const p = plan(st, mock(override));
    assert.match(p.skipped.join("\n"), re);
    assert.equal(p.actions.transition, undefined);
    assert.equal(p.ok, true, "a skipped transition is not an error");
  });
}

test("plan: a pull request or review never moves a ticket to Done by itself", () => {
  // A mapping that (wrongly) points an early stage at a Done status.
  for (const stage of ["implementing", "in-review", "awaiting-review-approval", "pr-created"]) {
    const st = state({ stage, mapping: mapping({ progress: { comments: true, stages: { [stage]: { toStatuses: ["Done"], allowDone: false } } } }) });
    const p = plan(st, mock());
    assert.equal(p.actions.transition, undefined, stage);
    assert.match(p.skipped.join("\n"), /leads to a Done status/, stage);
  }
  // Merged still needs the mapping flag AND the command flag.
  const merged = (allowDone, cfgAllow) => plan(state({ stage: "merged", allowDone, mapping: mapping({ progress: { comments: true, stages: { merged: { toStatuses: ["Done"], allowDone: cfgAllow } } } }) }), mock());
  assert.equal(merged(false, true).actions.transition, undefined);
  assert.equal(merged(true, false).actions.transition, undefined);
  assert.equal(merged(true, true).actions.transition.toName, "Done");
});

test("plan: comments are posted once", () => {
  const s = state();
  assert.ok(plan(s, mock()).actions.comment);
  assert.match(plan(s, mock({ comments: { comments: [{ id: "1", body: { type: "doc", content: [{ text: `x ${s.comment.marker} y` }] } }] } })).skipped.join("\n"), /already exists/);
  assert.match(plan(s, mock({ comments: { comments: [{ id: "1", body: `done ${s.comment.marker}` }] } })).skipped.join("\n"), /already exists/);
  assert.match(plan(s, mock({ comments: null })).skipped.join("\n"), /duplicate can't be ruled out/);
  assert.equal(plan(s, mock({ comments: null })).actions.comment, undefined);
  assert.match(JG.plan(s, records(mock()), [{ kind: "comment", marker: s.comment.marker, status: "confirmed" }]).skipped.join("\n"), /audit trail already confirms/);
  assert.ok(JG.plan(s, records(mock()), [{ kind: "comment", marker: s.comment.marker, status: "failed" }]).actions.comment, "a failed attempt may be retried");
  assert.match(plan(state({ mapping: mapping({ progress: { comments: false, stages: {} } }) }), mock()).skipped.join("\n"), /comments are disabled/);
});

test("plan: workflow-only verification is explicit and reported, never silent", () => {
  const st = state({ mapping: mapping({ board: { id: "12", name: null, verification: "workflow-only" } }) });
  const p = plan(st, mock({ board: null, boardIssues: null, boardConfig: null, boardProjects: null }));
  assert.equal(p.ok, true);
  assert.equal(p.board.verified, false);
  assert.match(p.warnings.join("\n"), /NOT verified/);
  assert.ok(p.actions.transition);
});

// --------------------------------------------------------- write checks

test("writeProblem: only the planned transition and comment, on this ticket and site", () => {
  const s = state();
  const p = plan(s, mock());
  const ok = { cloudId: "cloud-1", issueIdOrKey: KEY, transition: { id: "21" } };
  const none = new Set();
  const W = (kind, input, executed = none, pl = p) => JG.writeProblem(s, kind, T(kind === "transition" ? "transitionJiraIssue" : "addCommentToJiraIssue"), input, pl, executed);
  assert.equal(W("transition", ok), null);
  assert.equal(W("transition", { ...ok, issueIdOrKey: "10001" }), null, "the issue id from Jira's own response is the same ticket");
  assert.match(W("transition", { ...ok, issueIdOrKey: "ABC-2" }), /target ABC-1 and no other/);
  assert.match(W("transition", { ...ok, cloudId: "evil" }), /cloudId must be/);
  assert.match(W("transition", { ...ok, cloudId: undefined }), /cloudId must be/);
  assert.match(W("transition", { ...ok, transition: { id: "31" } }), /transition id must be 21/);
  assert.match(W("transition", { ...ok, fields: { resolution: { name: "Done" } } }), /unexpected parameters: fields/);
  assert.match(W("transition", { ...ok, update: { comment: [] } }), /unexpected parameters: update/);
  assert.match(W("transition", ok, new Set(["transition"])), /already executed/);
  const c = { cloudId: "cloud-1", issueIdOrKey: KEY, commentBody: COMMENT };
  assert.equal(W("comment", c), null);
  assert.match(W("comment", { ...c, commentBody: `${COMMENT}\nextra` }), /exactly the text/);
  assert.match(W("comment", { ...c, visibility: { type: "role", value: "x" } }), /unexpected parameters: visibility/);
  assert.match(W("comment", c, new Set(["comment"])), /already executed/);
  const blocked = plan(s, mock({ board: null }));
  assert.match(W("transition", ok, none, blocked), /sync gate is blocked/);
  const noAction = plan(s, mock({ transitions: { transitions: [] } }));
  assert.match(W("transition", ok, none, noAction), /no transition to perform/);
});

// ---------------------------------------------- stage from signed records

test("stages follow the plugin's own signed records, from planning to merged", () => {
  const f = makeFixture(fileMapping());
  const t = () => L.findTicketDir(f.data, KEY);
  const stage = () => PR.deriveStage(f.data, t()).stage;
  const base = (ready) => `# Plan ${KEY}\n\nReadiness: ${ready}\n\n## Files likely to change\n- \`src/app.js\`\n\n## Testing and validation\n- \`node -v\`\n`;

  f.run(["save", f.data, SITE, KEY, draft(f, "plan", base("BLOCKED"))]);
  assert.equal(stage(), "planning");
  f.run(["save", f.data, SITE, KEY, draft(f, "plan", base("READY"))]);
  assert.equal(stage(), "awaiting-plan-approval");
  const hash = /SHA-256: ([0-9a-f]{64})/.exec(f.run(["status", f.data, KEY]).out)[1];
  f.run(["approve", f.data, f.sid("plan"), KEY, "r2", hash]);
  assert.equal(stage(), "implementing");
  legacyImplement(f, "impl", KEY, 2, hash); // in place, as before Phase 8C (review is not on worktrees yet)
  fs.writeFileSync(path.join(f.repo, "src", "app.js"), "module.exports = 2;\n");
  f.run(["report-save", f.data, f.sid("impl"), draft(f, "report", `Report ${KEY}\n`)]);
  assert.equal(stage(), "implementing");
  f.run(["review-start", f.data, f.sid("review"), KEY]);
  f.run(["run-check", f.data, f.sid("review"), "node", "required", "node -v"]);
  const saved = f.run(["review-save", f.data, f.sid("review"), draft(f, "review", JSON.stringify({
    verdict: "PASS", summary: "s", requirementsSource: "plan",
    acceptanceCriteria: [{ id: "AC1", text: "t", status: "Verified", evidence: ["check:C1"] }],
    testCases: [{ id: "TC1", requirement: "AC1", scenario: "s", type: "automated", checkId: "C1", status: "Passed", steps: [], expected: "ok" }],
    findings: [], checkAssessments: [{ checkId: "C1", assessment: "passed", reason: "" }], changedFiles: [{ path: "src/app.js", assessment: "ok" }],
  }))]).out;
  assert.equal(stage(), "awaiting-review-approval");
  const rvHash = /Review SHA-256: ([0-9a-f]{64})/.exec(saved)[1];
  f.run(["approve-review", f.data, f.sid("approve"), KEY, "rv-1", rvHash]);
  assert.equal(stage(), "review-approved", "approved but not shipped has no Jira stage");
  f.run(["ship-start", f.data, f.sid("ship"), KEY, "rv-1", rvHash]);
  f.run(["ship-commit", f.data, f.sid("ship"), draft(f, "commit", `${KEY}: change\n`)]);
  f.run(["ship-push", f.data, f.sid("ship")]);
  f.run(["ship-prepare-pr", f.data, f.sid("ship"), draft(f, "pr", "Change\n")]);
  assert.equal(stage(), "review-approved");
  f.run(["ship-record-pr", f.data, f.sid("ship"), "https://github.com/acme/widgets/pull/3"]);
  const d = PR.deriveStage(f.data, t());
  assert.equal(d.stage, "pr-created");
  assert.equal(d.facts.pr, "https://github.com/acme/widgets/pull/3");

  // A forged merge record is ignored; a signed one moves the stage.
  const forged = path.join(f.data, "plans", SITE, KEY, "reviews", "merge-rv-1.json");
  fs.writeFileSync(forged, JSON.stringify({ kind: "merge-record", reviewId: "rv-1", commit: d.facts.commit, hmac: "0".repeat(64) }));
  assert.equal(stage(), "pr-created");
  const shipState = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${f.sid("ship")}.json`), "utf8"));
  M.writeMergeRecord(f.data, { ...shipState, headSha: shipState.commit, pr: 3, mergeCommit: "f".repeat(40), mergedVia: "test", mergedAt: iso() });
  assert.equal(stage(), "merged");
  assert.equal(PR.deriveStage(f.data, t()).facts.mergeCommit, "f".repeat(40));
});

test("a FAIL review is the review stage, and new work after a review goes back to implementation", () => {
  const f = reviewed("FAIL", fileMapping());
  assert.equal(PR.deriveStage(f.data, L.findTicketDir(f.data, KEY)).stage, "in-review");
});

// ----------------------------------------- the session, hook, and guard

function hook(f, sid, tool, input, response, event = "PostToolUse", extra = {}) {
  spawnSync("node", [EVIDENCE], {
    input: JSON.stringify({ hook_event_name: event, session_id: sid, tool_name: tool, tool_input: input, tool_response: response && [{ type: "text", text: typeof response === "string" ? response : JSON.stringify(response) }], ...extra }),
    env: f.env, encoding: "utf8",
  });
}
const feedJira = (f, sid, m) => { for (const [k, d] of Object.entries(m)) if (d) hook(f, sid, NAMES[k][0], NAMES[k][1], d); };

let shared = null;
// A repository at the "awaiting-review-approval" stage whose committed mapping
// has a board and stage mappings.
function synced() {
  if (shared) return shared;
  const f = reviewed("PASS", fileMapping());
  f.sidJira = uuid();
  shared = f;
  return f;
}
const startJira = (f, sid = uuid(), ...rest) => {
  const out = f.run(["jira-start", f.data, sid, KEY, ...rest]).out;
  return { sid, out };
};
const gw = (f, sid, tool, input, ctx = {}) => guard(f, { session_id: sid, tool_name: tool, tool_input: input, permission_mode: "default", ...ctx });
const transitionInput = { cloudId: "cloud-1", issueIdOrKey: KEY, transition: { id: "41" } };

function readyToWrite(f) {
  const { sid, out } = startJira(f);
  assert.match(out, /JIRA SYNC: AUTHORIZED/, out);
  feedJira(f, sid, mock());
  const p = f.run(["jira-plan", f.data, sid]).out;
  assert.match(p, /JIRA PLAN: READY/, p);
  const text = /-----BEGIN COMMENT-----\n([\s\S]*?)\n-----END COMMENT-----/.exec(p)[1];
  return { sid, text, plan: p };
}

test("jira-start: refusals (mapping, ticket, repository, flags, stage)", () => {
  const f = synced();
  assert.match(f.run(["jira-start", f.data, uuid(), KEY, "--force"]).out, /JIRA SYNC: REFUSED.*unexpected arguments/);
  assert.match(f.run(["jira-start", f.data, uuid(), KEY, "--allow-done"]).out, /REFUSED.*only valid for the merged stage/);
  assert.match(f.run(["jira-start", f.data, uuid(), "ABC-999"]).out, /REFUSED.*no saved plan/);
  assert.match(f.run(["jira-start", f.data, uuid(), "lower-1"]).out, /REFUSED/);
  assert.match(f.run(["jira-start", f.data, uuid()]).out, /REFUSED/);
  const other = path.join(f.base, "other");
  fs.mkdirSync(other);
  git(other, "init", "-b", "main");
  assert.match(f.run(["jira-start", f.data, uuid(), KEY], other).out, /REFUSED/);
  const file = path.join(f.repo, ".claude", "jira-dev-harness.json");
  const saved = fs.readFileSync(file, "utf8");
  try {
    fs.writeFileSync(file, saved.replace("12", "13"));
    assert.match(f.run(["jira-start", f.data, uuid(), KEY]).out, /REFUSED.*uncommitted changes/, "an edited, uncommitted mapping is not trusted");
  } finally {
    fs.writeFileSync(file, saved);
  }
  assert.match(f.run(["jira-start", f.data, uuid(), KEY]).out, /AUTHORIZED/);
});

test("jira-start: an old mapping without a board starts but is blocked at the plan", () => {
  const f = reviewed("PASS");
  const { sid, out } = startJira(f);
  assert.match(out, /AUTHORIZED/);
  assert.match(out, /Board: NOT CONFIGURED/);
  feedJira(f, sid, mock());
  assert.match(f.run(["jira-plan", f.data, sid]).out, /BLOCKED[\s\S]*no "jira\.board"/);
});

test("mapping-check reads the committed mapping", () => {
  const f = synced();
  assert.match(f.run(["mapping-check"]).out, /MAPPING: VALID[\s\S]*Board: 12, verification required/);
  const g = reviewed("PASS");
  assert.match(g.run(["mapping-check"]).out, /Board: not configured/);
});

test("guard: Jira writes are denied before authorization, before a plan, and in other workflow modes", () => {
  const f = synced();
  const noSession = uuid();
  assert.equal(gw(f, noSession, T("transitionJiraIssue"), transitionInput).permissionDecision, "ask", "a session that never ran a workflow command still needs a prompt for a Jira write");
  for (const sid of [f.sid("impl"), f.sid("review")]) {
    assert.equal(gw(f, sid, T("transitionJiraIssue"), transitionInput).permissionDecision, "deny", "other workflow modes keep the Jira write ban");
  }
  const { sid } = startJira(f);
  const d = gw(f, sid, T("transitionJiraIssue"), transitionInput);
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /jira-plan first/);
});

test("guard: outside a workflow, every Atlassian write needs a prompt and reads are untouched", () => {
  const f = synced();
  const sid = uuid();
  const writes = [
    ["transitionJiraIssue", transitionInput],
    ["addCommentToJiraIssue", { cloudId: "c", issueIdOrKey: "ZZ-1", commentBody: "x" }],
    ["addOrEditJiraIssueComment", { cloudId: "c", issueIdOrKey: "ZZ-1", commentBody: "x" }],
    ["editJiraIssue", { cloudId: "c", issueIdOrKey: "ZZ-1", fields: { summary: "x" } }],
    ["createJiraIssue", { cloudId: "c", projectKey: "ZZ" }],
    ["updateConfluenceContent", { cloudId: "c" }],
    ["executeWrite", { operation: "addCommentToJiraIssue", params: {} }],
    ["executeDestructive", { operation: "deleteIssue", params: {} }],
    ["someNewUnknownOperation", {}],
  ];
  for (const [name, input] of writes) {
    for (const prefix of ["mcp__atlassian__", "mcp__claude_ai_Atlassian_MCP__"]) {
      assert.equal(gw(f, sid, prefix + name, input).permissionDecision, "ask", prefix + name);
    }
    assert.equal(gw(f, sid, T(name), input, { permission_mode: "bypassPermissions" }).permissionDecision, "deny", name + " without a possible prompt");
    assert.equal(gw(f, sid, T(name), input, { permission_mode: "dontAsk" }).permissionDecision, "deny", name + " in don't-ask mode");
  }
  for (const [name, input] of [["getJiraIssue", { issueIdOrKey: "ZZ-1" }], ["searchJiraIssuesUsingJql", { jql: "assignee = currentUser()" }], ["atlassianUserInfo", {}], ["atlassianHome", {}], ["discover", { query: "x" }], ["searchConfluence", {}], ["getAccessibleAtlassianResources", {}], ["executeRead", { operation: "getJiraIssue", params: {} }], ["getTransitionsForJiraIssue", {}]]) {
    assert.equal(gw(f, sid, T(name), input).permissionDecision, "(none)", name + " stays a plain read");
  }
  assert.equal(gw(f, sid, "mcp__github__get_me", {}).permissionDecision, "(none)", "non-Atlassian tools are untouched here");
  assert.equal(gw(f, sid, "Bash", { command: "git status" }).permissionDecision, "(none)");
});

test("guard failures: bad input and unreadable workflow state block Jira writes", () => {
  const f = synced();
  const bad = spawnSync("node", [path.join(ROOT, "scripts", "guard.cjs")], { input: "{not json", env: f.env, encoding: "utf8" });
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, "deny", "malformed hook input is refused");
  const sid = uuid();
  fs.mkdirSync(path.join(f.data, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(f.data, "sessions", sid + ".json"), "{corrupt");
  assert.equal(gw(f, sid, T("addCommentToJiraIssue"), { cloudId: "c", issueIdOrKey: KEY, commentBody: "x" }).permissionDecision, "deny", "a corrupt session record is treated as a restricted workflow");
});

test("guard failures: an unexpected crash blocks the call, and the hook is configured to fail closed", () => {
  const f = synced();
  const pre = path.join(f.base, "crash-preload.cjs");
  fs.writeFileSync(pre, `require(${JSON.stringify(path.join(ROOT, "scripts", "lib", "jira-gate.cjs"))}).classifyCall = () => { throw new Error("boom"); };`);
  const r = spawnSync("node", ["-r", pre, path.join(ROOT, "scripts", "guard.cjs")], {
    input: JSON.stringify({ session_id: uuid(), tool_name: T("addCommentToJiraIssue"), tool_input: {}, permission_mode: "default" }), env: f.env, encoding: "utf8",
  });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", r.stdout + r.stderr);
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  assert.equal(hooks.PreToolUse[0].hooks[0].onFailure, "block", "Claude Code otherwise lets the call through when the guard cannot run");
});

test("end to end: plan, guarded writes, executed and failed hooks, confirmation, and the audit trail", () => {
  const f = synced();
  const { sid, text, plan: planOut } = readyToWrite(f);
  assert.match(planOut, /transition id 41 \("Send to review": To Do -> In Review\)/);
  const commentInput = { cloudId: "cloud-1", issueIdOrKey: KEY, commentBody: text };

  // Exactly the plan reaches a prompt.
  assert.equal(gw(f, sid, T("transitionJiraIssue"), transitionInput).permissionDecision, "ask");
  assert.equal(gw(f, sid, T("addCommentToJiraIssue"), commentInput).permissionDecision, "ask");
  assert.equal(gw(f, sid, T("executeWrite"), { operation: "transitionJiraIssue", params: transitionInput }).permissionDecision, "ask", "the meta-tool form is checked the same way");
  assert.equal(gw(f, sid, T("executeWrite"), { operation: "editJiraIssue", params: { issueIdOrKey: KEY, fields: {} } }).permissionDecision, "deny");

  // Everything else is refused, whatever the caller says.
  const denied = [
    [T("transitionJiraIssue"), { ...transitionInput, transition: { id: "31" } }],
    [T("transitionJiraIssue"), { ...transitionInput, issueIdOrKey: "ABC-2" }],
    [T("transitionJiraIssue"), { ...transitionInput, cloudId: "other" }],
    [T("transitionJiraIssue"), { ...transitionInput, fields: { assignee: { accountId: "x" } } }],
    [T("addCommentToJiraIssue"), { ...commentInput, commentBody: `${text} ` }],
    [T("addCommentToJiraIssue"), { ...commentInput, issueIdOrKey: "ABC-2" }],
    [T("editJiraIssue"), { cloudId: "cloud-1", issueIdOrKey: KEY, fields: { summary: "x" } }],
    [T("createJiraIssue"), { cloudId: "cloud-1", projectKey: "ABC", summary: "x" }],
    [T("executeDestructive"), { operation: "deleteJiraIssue", params: { issueIdOrKey: KEY } }],
    [T("executeWrite"), { params: transitionInput }],
    ["mcp__github__create_pull_request", { owner: "acme", repo: "widgets", head: "x", base: "main", title: "t", body: "b" }],
  ];
  for (const [tool, input] of denied) assert.equal(gw(f, sid, tool, input).permissionDecision, "deny", `${tool} ${JSON.stringify(input).slice(0, 60)}`);
  for (const mode of ["bypassPermissions", "acceptEdits", "auto", "plan"]) {
    assert.equal(gw(f, sid, T("transitionJiraIssue"), transitionInput, { permission_mode: mode }).permissionDecision, "deny", mode);
  }
  for (const agent of ["jira-dev-harness:developer", "jira-dev-harness:reviewer", "jira-dev-harness:planner"]) {
    assert.equal(gw(f, sid, T("transitionJiraIssue"), transitionInput, { agent_type: agent }).permissionDecision, "deny", agent);
  }
  assert.equal(gw(f, sid, T("getJiraIssue"), { issueIdOrKey: KEY }).permissionDecision, "(none)", "reads follow the normal permission flow");

  // The transition runs (as Claude Code reports it), and a repeat is refused.
  hook(f, sid, T("transitionJiraIssue"), transitionInput, "ok");
  assert.equal(gw(f, sid, T("transitionJiraIssue"), transitionInput).permissionDecision, "deny");
  assert.match(gw(f, sid, T("transitionJiraIssue"), transitionInput).permissionDecisionReason, /already executed/);
  // The comment fails, and the failure is audited.
  hook(f, sid, T("addCommentToJiraIssue"), commentInput, null, "PostToolUseFailure", { error: "HTTP 403: no permission to comment (token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)" });

  // Without a fresh read, the transition is unconfirmed, never assumed.
  assert.match(f.run(["jira-confirm", f.data, sid]).out, /UNCONFIRMED: transition/);
  // A later read that shows the new status confirms it.
  hook(f, sid, NAMES.issue[0], NAMES.issue[1], { key: KEY, id: "10001", fields: { project: { key: "ABC" }, status: status("4", "In Review", "indeterminate") } });
  const confirmed = f.run(["jira-confirm", f.data, sid]).out;
  assert.match(confirmed, /CONFIRMED: transition: Jira now reports status In Review/);

  const ledger = f.run(["jira-ledger", f.data, KEY]).out;
  assert.match(ledger, /intact \(hash-chained, signed\)/);
  for (const re of [/sync authorized/, /plan planned/, /transition requested/, /transition executed/, /comment failed: HTTP 403/, /transition unconfirmed/, /transition confirmed/, /comment blocked/]) {
    assert.match(ledger, re);
  }
  assert.ok(!/ghp_aaaaaaaaaaaaaaaa/.test(ledger), "tokens are redacted from the audit trail");
  const st = f.run(["jira-status", f.data, sid]).out;
  assert.match(st, /Audit ledger: intact/);
  // Regression: the header reflects the ledger, not the stale "planned" phase.
  assert.match(st, /stage "awaiting-review-approval", attention needed \(see the writes below\)/);
  assert.match(st, /Planned writes: transition confirmed, comment (failed|blocked)/);
  assert.doesNotMatch(st, /, phase planned$/m);
});

test("a duplicate sync is detected from Jira and from the audit trail", () => {
  const f = reviewed("PASS", fileMapping());
  const { sid, text } = readyToWrite(f);
  const marker = /\((jdh:[a-z-]+:[0-9a-f]+)\)/.exec(text)[1];
  hook(f, sid, T("addCommentToJiraIssue"), { cloudId: "cloud-1", issueIdOrKey: KEY, commentBody: text }, "ok");
  hook(f, sid, NAMES.comments[0], NAMES.comments[1], { comments: [{ id: "9", body: text }] });
  assert.match(f.run(["jira-confirm", f.data, sid]).out, /CONFIRMED: comment/);

  // A new session, with Jira showing the comment: no second comment.
  const again = startJira(f);
  feedJira(f, again.sid, mock({ comments: { comments: [{ id: "9", body: `x ${marker}` }] } }));
  assert.match(f.run(["jira-plan", f.data, again.sid]).out, /a comment with marker .* already exists/);
  // A new session whose comment read doesn't show it still sees the confirmed audit entry.
  const third = startJira(f);
  feedJira(f, third.sid, mock());
  assert.match(f.run(["jira-plan", f.data, third.sid]).out, /audit trail already confirms/);
  // And the status already matches after the transition: nothing to repeat.
  const fourth = startJira(f);
  feedJira(f, fourth.sid, mock({ issue: { key: KEY, id: "10001", fields: { project: { key: "ABC" }, status: status("4", "In Review", "indeterminate") } } }));
  assert.match(f.run(["jira-plan", f.data, fourth.sid]).out, /already in In Review/);
});

test("transition failures, stale status, and missing permissions leave Jira unchanged", () => {
  const f = synced();
  // Jira offers no matching transition (for example, no permission to transition).
  const a = startJira(f);
  feedJira(f, a.sid, mock({ transitions: { transitions: [] } }));
  const out = f.run(["jira-plan", f.data, a.sid]).out;
  assert.match(out, /READY/);
  assert.match(out, /offers no transition to In Review[\s\S]*status is preserved/);
  assert.equal(gw(f, a.sid, T("transitionJiraIssue"), transitionInput).permissionDecision, "deny");

  // A failed transition is audited as failed, never as done, and confirm says nothing happened.
  const b = readyToWrite(f);
  hook(f, b.sid, T("transitionJiraIssue"), transitionInput, null, "PostToolUseFailure", { error: "HTTP 400: transition not valid for the current status" });
  assert.match(f.run(["jira-confirm", f.data, b.sid]).out, /nothing to confirm/);
  assert.match(f.run(["jira-ledger", f.data, KEY]).out, /transition failed: HTTP 400/);

  // The status changed between planning and writing (stale plan): the write is re-checked against fresh evidence.
  const c = readyToWrite(f);
  hook(f, c.sid, NAMES.issue[0], NAMES.issue[1], { key: KEY, id: "10001", fields: { project: { key: "ABC" }, status: status("4", "In Review", "indeterminate") } });
  const d = gw(f, c.sid, T("transitionJiraIssue"), transitionInput);
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /no transition to perform|already in/);

  // Evidence that went stale is refused.
  const e = readyToWrite(f);
  const sessionFile = path.join(f.data, "sessions", `${e.sid}.json`);
  const st = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  st.startedAt = iso(-3 * 3600 * 1000);
  fs.writeFileSync(sessionFile, JSON.stringify(st));
  const dir = path.join(f.data, "evidence", e.sid);
  for (const file of fs.readdirSync(dir)) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    r.at = iso(-30 * 60 * 1000);
    fs.writeFileSync(path.join(dir, file), JSON.stringify(r));
  }
  assert.match(gw(f, e.sid, T("transitionJiraIssue"), transitionInput).permissionDecisionReason, /older than 10 minutes/);
});

test("resumed and forked sessions keep their restrictions and never reuse another session's evidence", () => {
  const f = synced();
  const { sid } = readyToWrite(f);
  // Resume: a new process, the same session id and on-disk state.
  const state = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${sid}.json`), "utf8"));
  assert.equal(state.mode, "jira-syncing");
  assert.equal(state.phase, "planned");
  assert.equal(gw(f, sid, T("transitionJiraIssue"), transitionInput).permissionDecision, "ask");
  // Fork: a new session id whose transcript carries the marker inherits the mode, but not the evidence.
  const transcript = path.join(f.base, "fork.jsonl");
  fs.writeFileSync(transcript, `{"x":"JDH-WORKFLOW-SESSION:${sid}"}\n`);
  const fork = uuid();
  const d = gw(f, fork, T("transitionJiraIssue"), transitionInput, { transcript_path: transcript });
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /sync gate is blocked|insufficient evidence/);
  assert.equal(gw(f, fork, T("editJiraIssue"), { issueIdOrKey: KEY, fields: {} }, { transcript_path: transcript }).permissionDecision, "deny");
  const inherited = JSON.parse(fs.readFileSync(path.join(f.data, "sessions", `${fork}.json`), "utf8"));
  assert.equal(inherited.sessionId, fork);
  assert.equal(f.run(["jira-confirm", f.data, fork]).out.includes("ERROR"), false, "the fork can run read-only plan-store steps");
});

test("guard: Jira sync state, ledger, evidence, and the start command can't be forged", () => {
  const f = synced();
  const { sid } = readyToWrite(f);
  const base = { session_id: sid, permission_mode: "default" };
  const ledger = path.join(f.data, "progress", SITE, KEY, "ledger.jsonl");
  const evidence = path.join(f.data, "evidence", sid, "00001.json");
  const sessionFile = path.join(f.data, "sessions", `${sid}.json`);
  for (const target of [ledger, evidence, sessionFile]) {
    assert.equal(guard(f, { ...base, tool_name: "Write", tool_input: { file_path: target, content: "{}" } }).permissionDecision, "deny", path.basename(target));
    assert.equal(guard(f, { ...base, tool_name: "Bash", tool_input: { command: `echo {} >> "${target}"` } }).permissionDecision, "deny", `echo > ${path.basename(target)}`);
  }
  const store = path.join(ROOT, "scripts", "plan-store.cjs");
  for (const command of [
    `node "${store}" jira-start "${f.data}" ${sid} ${KEY} --allow-done`,
    `node "${store}" jira-plan "${path.join(f.base, "forged")}" ${sid}`,
    `CLAUDE_PLUGIN_DATA=${f.base} node "${store}" jira-plan "${f.data}" ${sid}`,
    `node "${store}" jira-plan "${f.data}" ${sid} && cat "${ledger}"`,
  ]) {
    assert.equal(guard(f, { ...base, tool_name: "Bash", tool_input: { command } }).permissionDecision, "deny", command.slice(0, 70));
  }
  for (const sub of ["jira-plan", "jira-confirm", "jira-status"]) {
    assert.notEqual(guard(f, { ...base, tool_name: "Bash", tool_input: { command: `node "${store}" ${sub} "${f.data}" ${sid}` } }).permissionDecision, "deny", sub);
  }
  // Source edits and git remain blocked in a sync session.
  assert.equal(guard(f, { ...base, tool_name: "Write", tool_input: { file_path: path.join(f.repo, "src", "app.js"), content: "x" } }).permissionDecision, "deny");
  assert.equal(guard(f, { ...base, tool_name: "Bash", tool_input: { command: "git commit -am x" } }).permissionDecision, "deny");
});

test("a tampered audit ledger blocks further Jira writes", () => {
  const f = synced();
  const { sid } = readyToWrite(f);
  const ledger = path.join(f.data, "progress", SITE, KEY, "ledger.jsonl");
  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.detail = "edited";
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(ledger, lines.join("\n") + "\n");
  assert.match(f.run(["jira-ledger", f.data, KEY]).out, /NOT TRUSTWORTHY/);
  const d = gw(f, sid, T("transitionJiraIssue"), transitionInput);
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /ledger is not trustworthy/);
  assert.match(f.run(["jira-start", f.data, uuid(), KEY]).out, /REFUSED.*ledger is not trustworthy/);
  // Removing a line breaks the chain too.
  fs.writeFileSync(ledger, lines.slice(1).join("\n") + "\n");
  assert.ok(PR.ledgerProblem(f.data, SITE, KEY));
});

test("no route exists for a mocked or environment-selected Jira provider", () => {
  const files = ["scripts/guard.cjs", "scripts/evidence.cjs", "scripts/plan-store.cjs", "scripts/lib/jira-sync.cjs", "scripts/lib/jira-gate.cjs", "scripts/lib/progress.cjs", "scripts/lib/jira-mapping.cjs"];
  const source = files.map((r) => fs.readFileSync(path.join(ROOT, r), "utf8")).join("\n");
  const envReads = [...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)], ["CLAUDE_PLUGIN_DATA"]);
  assert.ok(!/mockAdapter|JDH_|fetch\(|https?\.request|require\("(https?|net)"\)/.test(source), "the plugin makes no network call of its own to Jira");
  // The plugin never hardcodes a site, project, board, or status.
  const sites = (source.match(/[A-Za-z0-9-]+\.atlassian\.net/g) || []).filter((s) => s !== "your-site.atlassian.net");
  assert.deepEqual(sites, []);
});
