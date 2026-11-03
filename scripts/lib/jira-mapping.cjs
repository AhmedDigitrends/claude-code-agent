// The committed per-repository Jira mapping, extended in Phase 7.
//
// .claude/jira-dev-harness.json (backward compatible; Phases 1-6 read only
// "jira.site" and "jira.projectKeys"):
//
// {
//   "jira": {
//     "site": "your-site.atlassian.net",
//     "projectKeys": ["PROJ"],
//     "board": { "id": 12, "name": "optional label", "verification": "required" },
//     "progress": {
//       "comments": true,
//       "stages": {
//         "implementing": { "toStatuses": ["In Progress"] },
//         "merged":       { "toStatuses": ["Done"], "allowDone": true }
//       }
//     }
//   }
// }
//
// Nothing here names a company, project, board, or status: every value comes
// from the repository's own committed file, and statuses are matched against
// the transitions that Jira itself reports for the ticket.

"use strict";

const path = require("path");
const L = require("./approval.cjs");

// Internal workflow stages. They are the plugin's own stages, not Jira status
// names.
const STAGES = ["planning", "awaiting-plan-approval", "implementing", "in-review", "awaiting-review-approval", "pr-created", "merged"];
const VERIFICATION = ["required", "workflow-only"];

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
}

// Reads and validates the mapping at <root>/.claude/jira-dev-harness.json.
// Returns { errors, mapping }. A mapping with errors must not be used.
function readMapping(root) {
  const errors = [];
  const raw = L.readJson(path.join(root, L.MAPPING_FILE));
  if (!isObj(raw) || !isObj(raw.jira)) return { errors: [`${L.MAPPING_FILE} is missing or has no "jira" object`], mapping: null };
  const j = raw.jira;
  unknownKeys(j, ["site", "projectKeys", "board", "progress"], "jira", errors);
  if (!L.SITE_RE.test(j.site || "")) errors.push(`jira.site "${j.site}" is not a *.atlassian.net site`);
  if (!Array.isArray(j.projectKeys) || !j.projectKeys.length || !j.projectKeys.every((k) => /^[A-Z][A-Z0-9_]+$/.test(k))) {
    errors.push("jira.projectKeys must be a non-empty list of project keys");
  }

  let board = null;
  if (j.board !== undefined) {
    if (!isObj(j.board)) {
      errors.push("jira.board must be an object");
    } else {
      unknownKeys(j.board, ["id", "name", "verification"], "jira.board", errors);
      const id = typeof j.board.id === "number" ? String(j.board.id) : j.board.id;
      if (!/^[1-9][0-9]{0,9}$/.test(String(id))) errors.push("jira.board.id must be a positive integer");
      const verification = j.board.verification === undefined ? "required" : j.board.verification;
      if (!VERIFICATION.includes(verification)) errors.push(`jira.board.verification must be one of ${VERIFICATION.join(", ")}`);
      if (j.board.name !== undefined && (typeof j.board.name !== "string" || j.board.name.length > 200)) errors.push("jira.board.name must be a short string");
      board = { id: String(id), name: j.board.name || null, verification };
    }
  }

  const progress = { comments: true, stages: {} };
  if (j.progress !== undefined) {
    if (!isObj(j.progress)) {
      errors.push("jira.progress must be an object");
    } else {
      unknownKeys(j.progress, ["comments", "stages"], "jira.progress", errors);
      if (j.progress.comments !== undefined) {
        if (typeof j.progress.comments !== "boolean") errors.push("jira.progress.comments must be true or false");
        else progress.comments = j.progress.comments;
      }
      if (j.progress.stages !== undefined) {
        if (!isObj(j.progress.stages)) errors.push("jira.progress.stages must be an object");
        else {
          for (const [stage, cfg] of Object.entries(j.progress.stages)) {
            if (!STAGES.includes(stage)) { errors.push(`jira.progress.stages: "${stage}" is not a workflow stage (${STAGES.join(", ")})`); continue; }
            if (!isObj(cfg)) { errors.push(`jira.progress.stages.${stage} must be an object`); continue; }
            unknownKeys(cfg, ["toStatuses", "allowDone"], `jira.progress.stages.${stage}`, errors);
            if (!Array.isArray(cfg.toStatuses) || !cfg.toStatuses.length || cfg.toStatuses.length > 5
                || !cfg.toStatuses.every((s) => typeof s === "string" && s.trim() && s.length <= 100)) {
              errors.push(`jira.progress.stages.${stage}.toStatuses must list 1 to 5 status names`);
              continue;
            }
            if (cfg.allowDone !== undefined && typeof cfg.allowDone !== "boolean") errors.push(`jira.progress.stages.${stage}.allowDone must be true or false`);
            if (cfg.allowDone && stage !== "merged") errors.push(`jira.progress.stages.${stage}.allowDone is only allowed for "merged"`);
            progress.stages[stage] = { toStatuses: cfg.toStatuses.map((s) => s.trim()), allowDone: cfg.allowDone === true };
          }
        }
      }
    }
  }

  return {
    errors,
    mapping: errors.length ? null : { site: j.site, projectKeys: j.projectKeys, board, progress },
  };
}

module.exports = { STAGES, VERIFICATION, readMapping };
