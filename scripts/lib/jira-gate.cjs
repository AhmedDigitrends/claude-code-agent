// The Jira progress gate. From raw Atlassian MCP responses (recorded by a
// hook, never typed in by an agent) it decides what, if anything, may be
// written to one Jira ticket, and it checks every write call against that
// decision. Anything missing, stale, ambiguous, or about another ticket,
// site, project, or board blocks the write (fails closed). Responses are
// expected in Jira's REST shapes; a connection that returns other shapes
// yields "insufficient evidence", never a guess.

"use strict";

const G = require("./merge-gate.cjs");

const MAX_AGE_MS = 10 * 60 * 1000;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => String(a == null ? "" : a).trim().toLowerCase() === String(b == null ? "" : b).trim().toLowerCase();

// -------------------------------------------------------------- tool calls

const WRITE_VERB = /^(create|edit|update|transition|add|delete|remove|upload|manage|watch|convert|move|assign|link|set|bulk|archive|restore|clone|import|execute(Write|Destructive))/i;
const READ_VERB = /^(get|list|search|lookup|discover|fetch|read|find|query)/i;

function server(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(tool || ""));
  return m && /atlassian|jira|rovo/i.test(m[1]) ? { server: m[1], name: m[2] } : null;
}

// Unwraps the "execute*" meta-tools, whose real operation name and arguments
// are inputs. Returns null if the tool is not an Atlassian tool.
function unwrap(tool, input) {
  const s = server(tool);
  if (!s) return null;
  input = isObj(input) ? input : {};
  const meta = /^execute(Read|Write|Destructive)$/i.exec(s.name);
  if (!meta) return { meta: null, name: s.name, args: input };
  const op = input.operation || input.operationName || input.name || input.action;
  const args = [input.params, input.arguments, input.input, input.payload, input.parameters].find(isObj) || {};
  return { meta: meta[1].toLowerCase(), name: typeof op === "string" ? op : null, args };
}

// "read", "transition", "comment", "write-other", or null (not Atlassian).
// Anything that is not recognisably a read is treated as a write.
function classifyCall(tool, input) {
  const c = unwrap(tool, input);
  if (!c) return null;
  if (!c.meta && /^(complete_)?authenticate$/.test(c.name)) return "read";
  if (c.meta === "destructive") return "write-other";
  if (c.meta === "write" && !c.name) return "write-other";
  if (c.name === "transitionJiraIssue") return "transition";
  if (c.name === "addCommentToJiraIssue" || (c.name === "addOrEditJiraIssueComment" && !c.args.commentId)) return "comment";
  if (c.meta === "write") return "write-other";
  if (c.meta === "read") return "read";
  if (WRITE_VERB.test(c.name)) return "write-other";
  if (READ_VERB.test(c.name)) return "read";
  return "write-other";
}

// A name for the evidence store that includes the real operation.
function labelOf(tool, input) {
  const c = unwrap(tool, input);
  return c && c.meta && c.name ? `${tool}:${c.name}` : tool;
}

const pick = (args, names) => {
  for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n];
  return undefined;
};
const issueRef = (args) => pick(args, ["issueIdOrKey", "issueKey", "issue_key", "issueId", "key", "issue"]);

// ------------------------------------------------------ evidence kinds

function classifyEvidence(label, data, input) {
  const name = String(label || "").toLowerCase();
  const inp = JSON.stringify(input || {}).toLowerCase();
  if (Array.isArray(data)) {
    if (data.length && data.every((r) => isObj(r) && typeof r.url === "string" && "id" in r)) return "resources";
    if (/resource/.test(name)) return "resources";
    return null;
  }
  if (!isObj(data)) return null;
  if (typeof data.key === "string" && isObj(data.fields)) return "issue";
  if (Array.isArray(data.transitions)) return "transitions";
  if (Array.isArray(data.comments)) return "comments";
  if (isObj(data.columnConfig)) return "boardConfig";
  if (Array.isArray(data.issues) && (/board/.test(name) || /board/.test(inp))) return "boardIssues";
  if (Array.isArray(data.values) && /board/.test(name) && /project/.test(name)) return "boardProjects";
  if (("id" in data) && ("name" in data) && ("type" in data) && /board/.test(name) && !/config|issue|project/.test(name)) return "board";
  return null;
}

const text = (v) => (typeof v === "string" ? v : JSON.stringify(v == null ? "" : v));

// Latest record of each kind that is about this ticket.
function pickEvidence(state, records) {
  const out = {};
  const issueId = {};
  for (const r of records) {
    const kind = classifyEvidence(r.tool, r.data, r.input);
    if (!kind) continue;
    const ref = isObj(r.input) ? issueRef(unwrapArgs(r)) : undefined;
    if (kind === "issue") {
      if (r.data.key !== state.issueKey) continue;
      issueId.id = r.data.id;
    } else if (kind === "transitions" || kind === "comments") {
      if (ref === undefined) continue;
      if (!same(ref, state.issueKey) && !(issueId.id !== undefined && same(ref, issueId.id))) continue;
    } else if (kind === "boardIssues" || kind === "boardConfig" || kind === "board" || kind === "boardProjects") {
      const id = pick(unwrapArgs(r), ["boardId", "board_id", "id"]);
      if (id !== undefined && String(id) !== (state.mapping.board && state.mapping.board.id)) continue;
    }
    r.kind = kind;
    out[kind] = r;
  }
  return out;
}

function unwrapArgs(r) {
  const c = unwrap(String(r.tool).replace(/:.*$/, ""), r.input);
  return c ? c.args : (isObj(r.input) ? r.input : {});
}

// -------------------------------------------------------------- the plan

// What may be written, from evidence. `ledger` is the ticket's audit entries
// (used only for duplicate suppression).
function plan(state, records, ledger, now = Date.now()) {
  const reasons = [];
  const skipped = [];
  const warnings = [];
  const best = pickEvidence(state, records);
  const out = { ok: false, reasons, skipped, warnings, actions: {}, cloudId: null, issue: null, board: { configured: !!state.mapping.board, verified: false } };

  for (const [kind, r] of Object.entries(best)) {
    const at = Date.parse(r.at);
    if (!(at >= Date.parse(state.startedAt) - 1000)) reasons.push(`the ${kind} evidence was captured before this sync was authorized`);
    else if (now - at > MAX_AGE_MS) reasons.push(`the ${kind} evidence is older than ${MAX_AGE_MS / 60000} minutes; read it again`);
  }

  // Site: the connection must actually reach the mapped site.
  const res = best.resources && best.resources.data.find((x) => {
    try {
      return new URL(x.url).host.toLowerCase() === state.site;
    } catch {
      return false;
    }
  });
  if (!best.resources) reasons.push("insufficient evidence: the accessible Atlassian sites were not read");
  else if (!res) reasons.push(`the connected Atlassian account cannot access ${state.site}`);
  else out.cloudId = String(res.id);

  // Ticket identity and project.
  const issue = best.issue && best.issue.data;
  if (!issue) {
    reasons.push("insufficient evidence: the ticket was not read");
  } else {
    const f = issue.fields;
    const project = f.project && f.project.key;
    const status = f.status;
    if (!project || !state.mapping.projectKeys.includes(project)) reasons.push(`the ticket's project ${project || "unknown"} is not mapped for this repository (${state.mapping.projectKeys.join(", ")})`);
    if (project && !state.issueKey.startsWith(`${project}-`)) reasons.push(`the ticket key ${state.issueKey} does not belong to project ${project}`);
    if (!status || !status.name || status.id === undefined) reasons.push("insufficient evidence: the ticket's current status is missing");
    out.issue = { key: issue.key, id: issue.id, project, status: status && { id: String(status.id), name: status.name, category: status.statusCategory && status.statusCategory.key } };
  }

  // Board identity and membership.
  const mb = state.mapping.board;
  if (!mb) {
    reasons.push('this repository has no "jira.board" in its committed mapping; the board is never inferred');
  } else if (mb.verification === "workflow-only") {
    warnings.push(`board ${mb.id} is NOT verified (the mapping chose "workflow-only"); only the ticket's own workflow transitions are used`);
  } else {
    const b = best.board && best.board.data;
    if (!b) reasons.push(`insufficient evidence: board ${mb.id} was not read`);
    else if (String(b.id) !== mb.id) reasons.push(`the board read is ${b.id}, not the mapped board ${mb.id}`);
    const members = best.boardIssues && best.boardIssues.data.issues.map((i) => i && i.key);
    if (!members) reasons.push(`insufficient evidence: board ${mb.id}'s issues were not read, so ${state.issueKey}'s membership is unverified`);
    else if (!members.includes(state.issueKey)) reasons.push(`${state.issueKey} is not on board ${mb.id}`);
    if (best.boardProjects) {
      const keys = best.boardProjects.data.values.map((p) => p && p.key);
      if (out.issue && out.issue.project && !keys.includes(out.issue.project)) reasons.push(`board ${mb.id} does not include project ${out.issue.project} (it spans ${keys.join(", ")})`);
    }
    if (b && String(b.id) === mb.id && members && members.includes(state.issueKey)) out.board.verified = true;
  }

  const hard = reasons.length > 0;

  // Transition: only from what Jira reports for this ticket.
  const cfg = state.mapping.progress.stages[state.stage];
  const cur = out.issue && out.issue.status;
  if (!cfg) {
    skipped.push(`no status is mapped for the "${state.stage}" stage; the ticket's status is left unchanged`);
  } else if (!best.transitions) {
    reasons.push("insufficient evidence: the ticket's available transitions were not read");
  } else if (cur) {
    const available = best.transitions.data.transitions.filter((t) => isObj(t) && isObj(t.to));
    const wanted = cfg.toStatuses.map((s) => s.toLowerCase());
    if (cur.category === "done") {
      skipped.push(`the ticket is already in a Done status (${cur.name}); it is never moved out of Done`);
    } else if (wanted.includes(cur.name.toLowerCase())) {
      skipped.push(`the ticket is already in ${cur.name}`);
    } else {
      const hits = available.filter((t) => wanted.includes(String(t.to.name).toLowerCase()));
      const targets = new Set(hits.map((t) => String(t.to.id)));
      if (!hits.length) {
        skipped.push(`Jira offers no transition to ${cfg.toStatuses.join(" / ")} from ${cur.name} (available: ${available.map((t) => `"${t.name}" -> ${t.to.name}`).join(", ") || "none"}); the status is preserved`);
      } else if (targets.size > 1 || hits.length > 1) {
        skipped.push(`more than one transition matches ${cfg.toStatuses.join(" / ")} (${hits.map((t) => `${t.id}:${t.name}`).join(", ")}); the choice is ambiguous, so the status is preserved`);
      } else {
        const t = hits[0];
        const done = t.to.statusCategory && t.to.statusCategory.key === "done";
        if (done && !(state.stage === "merged" && cfg.allowDone && state.allowDone)) {
          skipped.push(`the transition "${t.name}" leads to a Done status (${t.to.name}); it needs the "merged" stage, "allowDone" in the mapping, and --allow-done on the command. The status is preserved`);
        } else if (t.hasScreen === true) {
          skipped.push(`the transition "${t.name}" requires a screen (extra fields); the plugin does not fill those. The status is preserved`);
        } else if (out.board.verified && best.boardConfig) {
          const ids = new Set();
          for (const col of best.boardConfig.data.columnConfig.columns || []) for (const st of col.statuses || []) ids.add(String(st.id));
          if (!ids.has(String(t.to.id))) skipped.push(`${t.to.name} is not a status on board ${mb.id}; the status is preserved`);
          else out.actions.transition = { id: String(t.id), name: t.name, toId: String(t.to.id), toName: t.to.name, from: cur.name };
        } else if (out.board.verified) {
          skipped.push(`board ${mb.id}'s column configuration was not read, so ${t.to.name} can't be checked against it; the status is preserved`);
        } else {
          out.actions.transition = { id: String(t.id), name: t.name, toId: String(t.to.id), toName: t.to.name, from: cur.name };
        }
      }
    }
  }

  // Comment: only the plugin's own text, never twice.
  if (state.mapping.progress.comments === false) {
    skipped.push("comments are disabled in the mapping");
  } else if (!best.comments) {
    skipped.push("the ticket's comments were not read, so a duplicate can't be ruled out; no comment is posted");
  } else if (best.comments.data.comments.some((c) => text(c && (c.body !== undefined ? c.body : c)).includes(state.comment.marker))) {
    skipped.push(`a comment with marker ${state.comment.marker} already exists`);
  } else if (ledger.some((e) => e.kind === "comment" && e.marker === state.comment.marker && e.status === "confirmed")) {
    skipped.push(`the audit trail already confirms a comment with marker ${state.comment.marker}`);
  } else {
    out.actions.comment = { text: state.comment.text, sha256: state.comment.sha256, marker: state.comment.marker };
  }

  if (hard || reasons.length) {
    out.actions = {};
  }
  out.ok = reasons.length === 0;
  return out;
}

// --------------------------------------------------------- write checks

const COMMENT_KEYS = new Set(["cloudId", "cloud_id", "issueIdOrKey", "issueKey", "issue_key", "commentBody", "body", "comment", "contentFormat", "content_format", "responseContentFormat"]);
const TRANSITION_KEYS = new Set(["cloudId", "cloud_id", "issueIdOrKey", "issueKey", "issue_key", "transition", "transitionId", "responseContentFormat"]);

// Why a write call may not proceed, or null. `p` is plan() recomputed from
// current evidence; `executed` is the set of action kinds already done in
// this session (from the audit ledger).
function writeProblem(state, kind, tool, input, p, executed) {
  const c = unwrap(tool, input);
  if (!c) return "not an Atlassian tool";
  const args = c.args;
  if (!p.ok) return `the sync gate is blocked: ${p.reasons.slice(0, 4).join("; ")}`;
  if (executed.has(kind)) return `a ${kind} was already executed for this ticket in this session`;
  const action = p.actions[kind];
  if (!action) return `the plan has no ${kind} to perform now${p.skipped.length ? ` (${p.skipped[0]})` : ""}`;

  const allowed = kind === "transition" ? TRANSITION_KEYS : COMMENT_KEYS;
  const extra = Object.keys(args).filter((k) => !allowed.has(k));
  if (extra.length) return `unexpected parameters: ${extra.join(", ")} (only the planned ${kind} is allowed; no fields, resolutions, assignees, or visibility changes)`;
  const cloud = pick(args, ["cloudId", "cloud_id"]);
  if (cloud === undefined || String(cloud) !== p.cloudId) return `cloudId must be the one for ${state.site}`;
  const ref = issueRef(args);
  if (ref === undefined || !(same(ref, state.issueKey) || (p.issue.id !== undefined && same(ref, p.issue.id)))) return `the call must target ${state.issueKey} and no other ticket`;

  if (kind === "transition") {
    const t = args.transition;
    const id = isObj(t) ? t.id : pick(args, ["transitionId"]);
    if (id === undefined || String(id) !== action.id) return `the transition id must be ${action.id} (${action.name} -> ${action.toName}), as Jira reported it`;
  } else {
    const body = pick(args, ["commentBody", "body", "comment"]);
    if (typeof body !== "string" || require("./approval.cjs").sha256Of(body) !== action.sha256) return "the comment text must be exactly the text the plugin prepared";
  }
  return null;
}

module.exports = {
  MAX_AGE_MS, server, unwrap, classifyCall, labelOf, classifyEvidence, pickEvidence, plan, writeProblem, issueRef, textOf: G.textOf, jsonOf: G.jsonOf,
};
