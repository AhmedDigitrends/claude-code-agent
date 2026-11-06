// Assigned-ticket discovery helpers for /jira-dev-harness:ticket.
//
// Everything here is pure or read-only. Nothing contacts Jira, writes a file,
// or changes git state: the skill makes the Jira calls through the developer's
// own connection, and uses these helpers for the parts that must be exact and
// testable:
//   - the one JQL query it may run (assignee = currentUser(), constant text),
//   - parsing a ticket URL or bare key that the developer types,
//   - cleaning untrusted Jira text before it is shown in the list,
//   - comparing a listed ticket with the repository's Jira mapping.
//
// No site, project, board, or account is named here. They come from the
// developer's connection and from the repository's own mapping file.

"use strict";

const path = require("path");
const L = require("./approval.cjs");
const JM = require("./jira-mapping.cjs");

const MAX_SUMMARY = 100;
// Control characters, zero-width and bidirectional marks, line and paragraph separators.
const UNSAFE_CHARS = new RegExp("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]", "g");

// The only discovery query. It has no inputs, so there is nothing to inject
// into. `statusCategory != Done` hides finished work unless asked for.
function assignedJql({ includeDone = false } = {}) {
  return `assignee = currentUser()${includeDone ? "" : " AND statusCategory != Done"} ORDER BY updated DESC`;
}

// Parses what the developer typed after /jira-dev-harness:ticket.
//   ""                         -> { mode: "discover" }
//   https://<site>/browse/KEY  -> { mode: "ticket", site, key, project }
//   .../?selectedIssue=KEY     -> same
//   KEY                        -> { mode: "ticket", site: defaultSite || null, ... }
// Returns { mode: "invalid", reason } for anything else. Never throws.
function parseRef(input, { defaultSite = null } = {}) {
  const text = String(input == null ? "" : input).trim();
  if (!text) return { mode: "discover" };
  if (/\s/.test(text)) return { mode: "invalid", reason: "give one ticket URL or key, with no extra words" };

  const done = (site, key) => ({ mode: "ticket", site, key, project: key.replace(/-[0-9]+$/, "") });

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return { mode: "invalid", reason: "the URL could not be parsed" };
    }
    if (url.protocol !== "https:") return { mode: "invalid", reason: "the URL must be https" };
    const host = url.hostname.toLowerCase();
    if (!L.SITE_RE.test(host) || url.port || url.username || url.password) {
      return { mode: "invalid", reason: "the URL must be a plain https://<site>.atlassian.net link" };
    }
    const selected = url.searchParams.get("selectedIssue");
    const browse = /^\/browse\/([A-Za-z][A-Za-z0-9_]+-[0-9]+)\/?$/.exec(url.pathname);
    const key = String((selected || (browse && browse[1]) || "")).toUpperCase();
    if (!L.KEY_RE.test(key)) return { mode: "invalid", reason: "the URL has no issue key (expected /browse/KEY-123 or selectedIssue=KEY-123)" };
    return done(host, key);
  }

  const key = text.toUpperCase();
  if (!L.KEY_RE.test(key)) return { mode: "invalid", reason: `"${text.slice(0, 40)}" is not a ticket key like PROJ-123 or a Jira Cloud URL` };
  const site = defaultSite && L.SITE_RE.test(defaultSite) ? defaultSite : null;
  return done(site, key);
}

// Jira text is untrusted: one line, no control characters, no markup that a
// terminal could interpret, and a bounded length.
function cleanText(value, max = MAX_SUMMARY) {
  let s = String(value == null ? "" : value)
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

// Reduces one Jira search hit to the four fields that are listed.
// Returns null for a hit that does not look like an issue.
function toRow(issue, site) {
  if (!issue || typeof issue !== "object") return null;
  const key = String(issue.key || "");
  if (!L.KEY_RE.test(key)) return null;
  const f = issue.fields && typeof issue.fields === "object" ? issue.fields : {};
  const projectKey = key.replace(/-[0-9]+$/, "");
  const projectName = f.project && typeof f.project === "object" && f.project.name ? cleanText(f.project.name, 60) : "";
  const status = f.status && typeof f.status === "object" ? cleanText(f.status.name, 40) : "";
  return {
    site: L.SITE_RE.test(site || "") ? site : null,
    key,
    summary: cleanText(f.summary),
    project: projectName ? `${projectKey} (${projectName})` : projectKey,
    projectKey,
    status: status || "unknown",
  };
}

// Mapping verdict for one ticket, with exactly the rules of the ticket
// workflow's Step 2 (the file must be tracked and unmodified to be trusted):
//   verified   git tracks the file unmodified; site and project key match
//   mismatch   the file is trusted but names another site or project
//   unverified the file is missing, untracked, modified, or malformed
// This never relaxes the gate: only "verified" lets the workflow continue.
function mappingStatus(root, site, key) {
  const projectKey = String(key || "").replace(/-[0-9]+$/, "");
  const { errors, mapping } = JM.readMapping(root);
  if (errors.length) {
    return { state: "unverified", reason: `${L.MAPPING_FILE} is missing or invalid` };
  }
  let tracked = true;
  try {
    L.git(["ls-files", "--error-unmatch", L.MAPPING_FILE], root);
  } catch {
    tracked = false;
  }
  if (!tracked) return { state: "unverified", reason: `${L.MAPPING_FILE} is not tracked by git` };
  let dirty = true;
  try {
    dirty = !!L.git(["status", "--porcelain", "--", L.MAPPING_FILE], root);
  } catch {
    dirty = true;
  }
  if (dirty) return { state: "unverified", reason: `${L.MAPPING_FILE} has uncommitted changes` };
  if (!site) return { state: "unverified", reason: "the ticket's Jira site is not known" };
  if (mapping.site !== site || !mapping.projectKeys.includes(projectKey)) {
    return { state: "mismatch", reason: `${L.MAPPING_FILE} maps ${mapping.site} projects ${mapping.projectKeys.join(", ")}, not ${site} ${projectKey}` };
  }
  return { state: "verified", reason: "the committed mapping covers this site and project" };
}

// The site named by the repository's mapping file, if it is readable. Used
// only to resolve a bare key; the gate itself is mappingStatus().
function mappedSite(root) {
  const raw = L.readJson(path.join(root, L.MAPPING_FILE));
  const site = raw && raw.jira && typeof raw.jira.site === "string" ? raw.jira.site : null;
  return site && L.SITE_RE.test(site) ? site : null;
}

module.exports = { MAX_SUMMARY, assignedJql, parseRef, cleanText, toRow, mappingStatus, mappedSite };
