// The Jira progress sync workflow (/jira-dev-harness:jira-sync).
//
// The developer's command authorizes one synchronisation of one ticket's
// current workflow stage. Claude then reads Jira through the developer's own
// Atlassian MCP connection (a hook records the real responses), `plan` turns
// that evidence into the only writes allowed, the guard checks each write
// call and asks the developer, and `confirm` checks the result against a
// fresh read. Every step lands in the signed audit ledger.

"use strict";

const L = require("./approval.cjs");
const P = require("./progress.cjs");
const JM = require("./jira-mapping.cjs");
const JG = require("./jira-gate.cjs");
const Mrg = require("./merge.cjs");

const { fail } = L;

function requireSyncing(state, ...stages) {
  if (!state || state.mode !== "jira-syncing") fail("this session has no Jira sync authorization; the developer must run /jira-dev-harness:jira-sync");
  if (stages.length && !stages.includes(state.phase)) fail(`this step needs phase ${stages.join(" or ")}, but the session is at "${state.phase}"`);
}

function start(dataDir, sessionId, ref, options, cwd) {
  if (!L.SESSION_RE.test(sessionId || "")) fail("the session could not be identified");
  const t = L.findTicketDir(dataDir, ref);
  const repo = L.repoIdentity(cwd);
  const s = L.latestState(t);
  if (!s || !s.meta || !s.meta.repo) fail(`no saved plan for ${t.key} that records its repository`);
  if (!L.sameRepo(s.meta.repo, repo)) fail(`${t.key} was planned for ${L.describeRepo(s.meta.repo)}, not ${L.describeRepo(repo)}`);
  L.checkMapping(repo.root, t.site, t.key);
  const { errors, mapping } = JM.readMapping(repo.root);
  if (errors.length) fail(`the Jira mapping is invalid: ${errors.join("; ")}`);
  if (mapping.site !== t.site) fail(`the mapping's site ${mapping.site} is not ${t.site}`);
  if (!mapping.projectKeys.includes(t.key.replace(/-[0-9]+$/, ""))) fail(`${t.key}'s project is not mapped`);

  const bad = P.ledgerProblem(dataDir, t.site, t.key);
  if (bad) fail(`the audit ledger is not trustworthy: ${bad}`);
  const derived = P.deriveStage(dataDir, t);
  if (!derived) fail(`${t.key} has no plan`);
  if (!JM.STAGES.includes(derived.stage)) {
    fail(`${t.key} is at "${derived.stage}", which has no Jira stage; nothing to synchronise. Ship the work first`);
  }
  if (options.allowDone && derived.stage !== "merged") fail("--allow-done is only valid for the merged stage");

  const comment = P.commentFor(t.key, derived.stage, derived.facts);
  const state = {
    mode: "jira-syncing",
    phase: "started",
    issueKey: t.key,
    site: t.site,
    repo,
    stage: derived.stage,
    facts: derived.facts,
    mapping,
    allowDone: options.allowDone === true,
    comment,
    startedAt: new Date().toISOString(),
  };
  P.appendLedger(dataDir, t.site, t.key, { sessionId, stage: state.stage, kind: "sync", status: "authorized", marker: comment.marker, detail: `board ${mapping.board ? mapping.board.id : "none"}, allowDone ${state.allowDone}` });
  return state;
}

function records(dataDir, state) {
  return Mrg.loadEvidence(dataDir, state.sessionId).map((r) => ({ ...r, data: r.data !== undefined ? r.data : JG.jsonOf(r.response) }))
    .filter((r) => r.data !== null && r.data !== undefined);
}

const executedKinds = (ledger, sessionId) => new Set(ledger.filter((e) => e.sessionId === sessionId && e.status === "executed").map((e) => e.kind));

// Evidence to plan. Re-run by the guard before every write.
function planNow(dataDir, state, now) {
  const ledger = P.readLedger(dataDir, state.site, state.issueKey);
  return JG.plan(state, records(dataDir, state), ledger, now);
}

function makePlan(dataDir, state, now) {
  requireSyncing(state);
  const p = planNow(dataDir, state, now);
  P.appendLedger(dataDir, state.site, state.issueKey, {
    sessionId: state.sessionId, stage: state.stage, kind: "plan", status: p.ok ? "planned" : "blocked",
    detail: p.ok ? `actions: ${Object.keys(p.actions).join(", ") || "none"}` : p.reasons.slice(0, 5).join("; "),
  });
  return { plan: p, state: p.ok ? { ...state, phase: "planned", plannedAt: new Date().toISOString(), planned: p.actions } : state };
}

// Checks the result of executed writes against fresh reads.
function confirm(dataDir, state) {
  requireSyncing(state);
  const ledger = P.readLedger(dataDir, state.site, state.issueKey);
  const recs = records(dataDir, state);
  const best = JG.pickEvidence(state, recs);
  const results = [];
  const mine = ledger.filter((e) => e.sessionId === state.sessionId);
  for (const kind of ["transition", "comment"]) {
    const ex = [...mine].reverse().find((e) => e.kind === kind && e.status === "executed");
    if (!ex) continue;
    if (mine.some((e) => e.kind === kind && e.status === "confirmed" && e.seq > ex.seq)) continue;
    let ok = false;
    let detail;
    if (kind === "transition") {
      const issue = best.issue;
      ok = !!issue && Date.parse(issue.at) > Date.parse(ex.at) && String(issue.data.fields.status && issue.data.fields.status.id) === ex.toId;
      detail = ok ? `Jira now reports status ${issue.data.fields.status.name}` : "no read after the write shows the target status";
    } else {
      const c = best.comments;
      ok = !!c && Date.parse(c.at) > Date.parse(ex.at) && c.data.comments.some((x) => JSON.stringify(x).includes(ex.marker));
      detail = ok ? "the comment is visible in a later read" : "no read after the write shows the comment";
    }
    P.appendLedger(dataDir, state.site, state.issueKey, { sessionId: state.sessionId, stage: state.stage, kind, status: ok ? "confirmed" : "unconfirmed", marker: ex.marker, toId: ex.toId, detail });
    results.push({ kind, ok, detail });
  }
  return results;
}

module.exports = { requireSyncing, start, planNow, makePlan, confirm, executedKinds, records };
