#!/usr/bin/env node
// jira-dev-harness PostToolUse / PostToolUseFailure hook. It records what the
// developer's MCP connections actually returned while a merge or Jira sync
// session is active, so that gates decide from provider responses and the
// audit ledger shows what really ran:
//
// - merge session:  GitHub MCP read responses are stored as merge evidence
// - jira-syncing:   Atlassian MCP read responses are stored as sync evidence,
//                   and each executed or failed Jira write is appended to the
//                   signed audit ledger
//
// The data comes from the hook payload that Claude Code itself builds, not
// from anything an agent wrote, so an agent's summary can't stand in for it.
// The hook never blocks and never prints: a failure just means less
// evidence, which blocks the action that needed it.

"use strict";

const path = require("path");
const L = require("./lib/approval.cjs");
const G = require("./lib/merge-gate.cjs");
const M = require("./lib/merge.cjs");
const JG = require("./lib/jira-gate.cjs");
const P = require("./lib/progress.cjs");
const { redact } = require("./lib/review.cjs");

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw);
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    const sid = input.session_id;
    const tool = String(input.tool_name || "");
    const m = /^mcp__(.+?)__(.+)$/.exec(tool);
    if (!dataDir || !L.SESSION_RE.test(sid || "") || !m) return;
    const state = L.readJson(path.join(dataDir, "sessions", `${sid}.json`));
    if (!state) return;
    const failed = input.hook_event_name === "PostToolUseFailure";

    if (/github/i.test(m[1]) && state.mode === "merging") {
      // Writes and merges are never evidence.
      if (failed || /^(create|update|merge|add|delete|push|enable|disable)/i.test(m[2])) return;
      const data = G.jsonOf(input.tool_response);
      M.saveEvidence(dataDir, sid, {
        tool,
        input: input.tool_input || {},
        at: new Date().toISOString(),
        data: data === undefined ? null : data,
      }, "mcp");
      return;
    }

    if (JG.server(tool) && state.mode === "jira-syncing") {
      const kind = JG.classifyCall(tool, input.tool_input);
      if (kind === "read") {
        if (failed) return;
        const data = G.jsonOf(input.tool_response);
        M.saveEvidence(dataDir, sid, {
          tool: JG.labelOf(tool, input.tool_input),
          input: input.tool_input || {},
          at: new Date().toISOString(),
          data: data === undefined ? null : data,
        }, "mcp");
        return;
      }
      if (kind === "transition" || kind === "comment") {
        const planned = (state.planned || {})[kind] || {};
        const reply = failed ? String(input.error || "") : G.textOf(input.tool_response);
        P.appendLedger(dataDir, state.site, state.issueKey, {
          sessionId: sid,
          stage: state.stage,
          kind,
          status: failed ? "failed" : "executed",
          marker: state.comment && state.comment.marker,
          toId: planned.toId,
          transitionId: planned.id,
          detail: redact(reply).replace(/\s+/g, " ").slice(0, 300),
        });
      }
    }
  } catch {
    // Less evidence only.
  }
});
