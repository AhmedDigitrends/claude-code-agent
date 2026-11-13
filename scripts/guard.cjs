#!/usr/bin/env node
// jira-dev-harness PreToolUse guard. Always on: registered in the plugin's
// hooks/hooks.json, so it runs in every session where the plugin is enabled,
// including resumed sessions and subagents (which share the parent's
// session_id and add agent_type). Forked sessions inherit their parent's
// workflow state through a marker in the transcript.
//
// Rules, in order:
// 1. Every session: the plan store (plugin data directory) is off limits to
//    Claude's tools. No file-tool writes into it, no reads of the approval
//    key, and no shell commands that reference it, except allowlisted
//    plan-store.cjs subcommands. Approvals, session state, and
//    implementation authorizations are written only by commands injected
//    into user-only skills.
// 2. The Developer Agent (agent_type "jira-dev-harness:developer") may write
//    only when ALL of these hold, re-checked on every call:
//    - the session is in "implementing" mode (set by /jira-dev-harness:implement)
//    - permission_mode is "default" (attended; no auto-accept or bypass)
//    - the authorized plan is still the latest, intact, approved revision
//      for the same repository, with a valid mapping
//    - the session's ticket worktree (Phase 8C) is still the ticket's signed,
//      verified binding; a session without one (authorized in place by an
//      older version) gets no new writes
//    - the target resolves, after following symlinks, inside that worktree
//      (never the main checkout) and outside .git, .claude/, .mcp.json, the
//      mapping file, and project instruction files (unless the approved
//      plan's "Proposed project-rule updates" section names that file with
//      "Apply in implementation: yes")
//    Allowed writes return "ask", so Claude Code prompts the developer for
//    every edit even if allow rules exist. Its shell commands must start with
//    `cd "<worktree>" &&` and not change directory again; git state changes
//    and hosting CLIs are denied; read-only commands follow the normal
//    permission flow; everything else returns "ask". The prefix only sets
//    where a command starts: it is not a filesystem sandbox, and an approved
//    command can still reach any path the developer's user can.
// 1b. Every session: plugin-managed worktrees (registered paths) cannot be
//    removed, moved, repaired, or recursively deleted by Claude's shell
//    commands, and `git worktree prune` is refused while a registered
//    worktree directory is missing. Other git and worktree use is unaffected.
// 3. All other plugin agents (jira-dev-harness:*) may never write files, run
//    shell commands, or use MCP write tools.
// 4. Workflow sessions (planning or implementing), for the main conversation
//    and all other agents:
//    - no Jira/Atlassian or other MCP write tools
//    - file-tool writes only to drafts under <os temp>/jira-dev-harness/drafts/
//    - shell commands only from a read-only allowlist
// 5. Shipping sessions (/jira-dev-harness:ship) add three things to rule 4:
//    - plan-store ship-commit, ship-push, and ship-pr always return "ask" (and
//      are denied outside the default permission mode); the script itself
//      re-verifies every gate before it touches git or the hosting provider
//    - a GitHub MCP create-pull-request call, from the main conversation only,
//      reaches a permission prompt only when it carries exactly the head,
//      base, title, and body that ship-prepare-pr prepared
//    - MCP merge tools other than a plain merge-pull-request tool are denied in
//      every workflow session
// 6. Merge sessions (/jira-dev-harness:merge, separately authorized): a GitHub
//    MCP merge-pull-request call reaches a permission prompt only if its pull
//    request, head SHA, method, owner, and repository are the authorized
//    ones AND the merge gate passes on provider responses that evidence.cjs
//    recorded. plan-store merge-run always asks. Nothing else can merge.
// Other sessions are otherwise unaffected.
//
// Prints a decision, or nothing to leave the call to the normal permission
// flow. Fails closed on unreadable input. This is a pattern-based guard, not
// a sandbox, and it cannot prove who approved anything: see README
// "Security model".

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lib/approval.cjs");
const AU = require("./lib/attach-url.cjs");
const P = require("./lib/provider.cjs");
const M = require("./lib/merge.cjs");
const JG = require("./lib/jira-gate.cjs");
const JS = require("./lib/jira-sync.cjs");
const PR = require("./lib/progress.cjs");
const W = require("./lib/worktree.cjs");
const S = require("./lib/ship.cjs");

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const DEVELOPER = "jira-dev-harness:developer";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

// Atlassian write operations, plus generic write verbs on any MCP server.
const ATLASSIAN_WRITE = /^mcp__.*([Aa]tlassian|[Jj]ira|[Rr]ovo).*__(create|edit|update|transition|add|delete|upload|manage|watch|convert|move|execute(Write|Destructive))|^mcp__.*__(createJiraIssue|editJiraIssue|transitionJiraIssue|addOrEditJiraIssueComment)$/;
const MCP_WRITE_VERB = /^mcp__.+__(create|edit|update|delete|remove|upload|add|send|post|put|patch|write|set|transition|manage|move|publish|push|merge|execute(Write|Destructive))/i;

// The plan store as it appears in paths or shell commands, in any slash style.
const STORE_REF = /plugins[\\/]+data[\\/]+jira-dev-harness/i;
const PROTECTED_NAMES = /approval-r[0-9]+|plan-r[0-9]+\.(md|json)|impl-r[0-9]+-[0-9]+\.(md|json)|review-rv-[0-9]+|review-approval-rv-[0-9]+|ship-rv-[0-9]+|ship-commit-rv-[0-9]+|merge-rv-[0-9]+|ledger.jsonl|facts\.json|approval\.key|worktree-b[0-9]+|empty-hooks|removal-previews|JDH-WORKFLOW-SESSION/i;
// The only plan-store invocations Claude may run. session-start,
// implement-start, review-start, and approve are reserved for user-only skills.
const PLAN_STORE_SCRIPT = String.raw`node\s+("[^"]*[\\/]scripts[\\/]plan-store\.cjs"|'[^']*[\\/]scripts[\\/]plan-store\.cjs'|\S*[\\/]scripts[\\/]plan-store\.cjs)\s+`;
const PLAN_STORE_CALL = new RegExp(`^${PLAN_STORE_SCRIPT}(draft-path|save|report-save|review-save|review-status|review-share-record|status|verify|attach-dir|clean-attach|ship-prepare-pr|ship-record-pr|ship-status|ship-checks|merge-collect|merge-verify|merge-record|merge-status|mapping-check|ticket-ref|assigned-jql|mapping-status|worktree-status|jira-plan|jira-confirm|jira-status|jira-ledger)\\b`);
// approve-review and ship-start are reserved too: "approve" matches before the hyphen.
const RESERVED_STORE_CMD = /(plan-store(\.cjs)?["']?\s+(approve|session-start|implement-start|review-start|ship-start|merge-start|jira-start|worktree-remove)|scripts[\\/]connect(\.cjs)?["']?\s+(begin|evaluate))\b/;
// The read-only connection report of /jira-dev-harness:connect. It names the
// plugin data directory (to read the developer's confirmation), so it is
// allowed only as a single command with that exact directory. `begin`, which
// writes the confirmation, stays reserved.
const CONNECT_EVAL = /^node\s+("[^"]*[\\/]scripts[\\/]connect\.cjs"|'[^']*[\\/]scripts[\\/]connect\.cjs'|\S*[\\/]scripts[\\/]connect\.cjs)\s+evaluate\s+/;
// Shipping steps that change git state or the hosting provider. Claude runs
// them, but each one needs the developer's permission prompt, and the script
// re-verifies every gate itself.
const SHIP_ACTION = new RegExp(`^${PLAN_STORE_SCRIPT}(ship-commit|ship-push|ship-pr|merge-run)\\s+("[^"]+"|\\S+)\\s+[0-9a-f-]{36}(\\s+"[^"]+")?\\s*$`);
// run-check executes a project command and records the evidence. Its exact
// shape: the command is one single-quoted argument. It always needs the
// developer's interactive approval.
const RUN_CHECK = new RegExp(`^${PLAN_STORE_SCRIPT}run-check\\s+"[^"]+"\\s+[0-9a-f-]{36}\\s+[A-Za-z0-9_.-]{1,40}\\s+(required|optional)\\s+'[^']+'\\s*$`);

// Git commands that change repository, index, or remote state, and
// code-hosting CLIs (PR creation and similar are later phases).
const GIT_MUTATION = /^git(\s+(-C\s+("[^"]*"|'[^']*'|\S+)|-c\s+\S+|--no-pager))*\s+(add|am|apply|branch\s+-[dDmMcC]|checkout|cherry-pick|clean|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|worktree|update-ref|fetch|notes|submodule|config(?!\s+--get))\b/;
const HOSTING_CLI = /^(gh|glab|hub|az\s+repos)\b/;

// Project instruction files. Writable by the Developer only when the approved
// plan proposes a change to that exact file.
const INSTRUCTION_FILE = /(^|\/)(claude\.md|claude\.local\.md|agents\.md|specification\.md|contributing\.md)$/i;

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: `jira-dev-harness: ${reason}`,
    },
  }));
  process.exit(0);
}
const deny = (reason) => decide("deny", reason);
// Claude Code lets a tool call through when a PreToolUse hook crashes (any
// exit code other than 2). An unexpected error here must block instead.
process.on("uncaughtException", (e) => deny(`the guard failed (${String((e && e.message) || e).slice(0, 120)}); blocking the call as a precaution.`));
const ask = (reason) => decide("ask", reason);
function allow() {
  process.exit(0);
}

// Converts Git Bash style paths (/c/..., /tmp/...) to native ones, then
// normalizes separators and, on Windows, case.
function normalize(p) {
  let s = String(p).trim().replace(/^["']|["']$/g, "");
  if (process.platform === "win32") {
    if (/^\/tmp(\/|$)/i.test(s)) s = os.tmpdir() + s.slice(4);
    else if (/^\/[a-z](\/|$)/i.test(s)) s = `${s[1]}:${s.slice(2) || "/"}`;
  }
  let out = path.resolve(s).replace(/\\/g, "/");
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

// A plan-store call must name this plugin's own data directory. Otherwise
// Claude could point a ship or merge step at a store it forged elsewhere,
// with its own key and approval records.
const NO_STORE_ARG = new Set(["draft-path", "attach-dir", "clean-attach", "mapping-check", "ticket-ref", "assigned-jql", "mapping-status"]);
function storeArgPinned(seg) {
  const bare = /^node\s+(?:"[^"]*"|'[^']*'|\S+)\s+([a-z-]+)\s*$/.exec(String(seg).trim());
  if (bare && NO_STORE_ARG.has(bare[1])) return true;
  const m =/^node\s+(?:"[^"]*"|'[^']*'|\S+)\s+([a-z-]+)\s+("[^"]*"|'[^']*'|\S+)/.exec(String(seg).trim());
  if (!m) return false;
  if (NO_STORE_ARG.has(m[1])) return true;
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  return !!dataDir && normalize(m[2]) === normalize(dataDir);
}

function relInside(root, p) {
  const rel = path.posix.relative(normalize(root), normalize(p));
  if (rel === "") return "";
  return !rel.startsWith("..") && !path.posix.isAbsolute(rel) ? rel : null;
}

function inside(root, p) {
  return relInside(root, p) !== null;
}

function inStore(p) {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  return STORE_REF.test(String(p)) || (dataDir ? inside(dataDir, p) : false);
}

function isDraft(p) {
  const rel = relInside(L.DRAFTS_ROOT, p);
  if (!rel) return false;
  const parts = rel.split("/");
  return parts.length === 3
    && /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(parts[0])
    && /^[a-z][a-z0-9_]+-[0-9]+$/i.test(parts[1])
    && /^(draft\.md|report\.md|review\.json|commit\.md|pr\.md)$/i.test(parts[2]);
}

// Resolves a path the way the OS will when writing it: symlinks in the
// existing part of the path are followed. Returns null for a symlink target
// itself (writing through a link is refused).
function realTarget(p) {
  let s = String(p);
  if (process.platform === "win32" && /^\/[a-z](\/|$)/i.test(s)) s = `${s[1]}:${s.slice(2) || "/"}`;
  const abs = path.resolve(s);
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return null;
  } catch {
    // Does not exist yet.
  }
  let existing = abs;
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...rest);
}

// True if the approved plan's "Proposed project-rule updates" section has a
// line naming `rel` and marking it "Apply in implementation: yes".
function ruleUpdateApproved(planFile, rel) {
  let text;
  try {
    text = fs.readFileSync(planFile, "utf8");
  } catch {
    return false;
  }
  const m = /^##\s*Proposed project-rule updates\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text);
  if (!m) return false;
  return m[1].split(/\r?\n/).some((line) => {
    const l = line.replace(/\\/g, "/").replace(/`/g, "").toLowerCase();
    return l.includes(rel) && /apply in implementation:\s*\**\s*yes\b/.test(l);
  });
}

// Why the Developer may not write `target`, or null if it may.
function developerTargetProblem(state, target) {
  if (!target) return "no file path given";
  const real = realTarget(target);
  if (real === null) return `refusing to write through a symbolic link: ${target}`;
  // Phase 8C: the Developer writes only in the session's ticket worktree.
  const workRoot = state.worktree.path;
  let root;
  try {
    root = fs.realpathSync.native(workRoot);
  } catch {
    return "the ticket worktree no longer exists";
  }
  let mainRoot = null;
  try { mainRoot = fs.realpathSync.native(state.repo.root); } catch { mainRoot = null; }
  if (mainRoot && relInside(mainRoot, real) !== null) {
    return `${target} is in the main checkout ${state.repo.root}, which implementation never changes. The Developer works only in the ticket worktree ${workRoot}`;
  }
  const rel = relInside(root, real);
  if (rel === null || rel === "") return `${target} is outside the ticket worktree ${workRoot}`;
  if (relInside(root, path.resolve(String(target))) === null && !/^\/[a-z]\//i.test(String(target))) {
    return `${target} is outside the ticket worktree ${workRoot}`;
  }
  const parts = rel.split("/");
  if (parts.includes(".git")) return "the .git directory may not be modified";
  if (inStore(real)) return "the plan store may not be modified";
  if (rel === L.MAPPING_FILE.toLowerCase()) return "the Jira mapping file may not be modified";
  if (rel === ".mcp.json") return ".mcp.json may not be modified (it configures MCP servers)";
  const isRule = /^\.claude\/rules\/.+\.md$/.test(rel);
  if (parts[0] === ".claude" && !isRule) {
    return `${rel} may not be modified (.claude/ holds settings, hooks, agents, and the mapping)`;
  }
  if ((isRule || INSTRUCTION_FILE.test(rel)) && !ruleUpdateApproved(state.planFile, rel)) {
    return `${rel} is a project instruction file, and the approved plan does not list it under "Proposed project-rule updates" with "Apply in implementation: yes"`;
  }
  return null;
}

// Workflow state for this session: its own state file, or one inherited from
// the session it was forked from. A negative result is cached per session.
function workflowState(input) {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const sid = input.session_id;
  if (!dataDir || !L.SESSION_RE.test(sid || "")) return null;
  const dir = path.join(dataDir, "sessions");
  const own = path.join(dir, `${sid}.json`);
  if (fs.existsSync(own)) return JSON.parse(fs.readFileSync(own, "utf8"));
  const none = path.join(dir, `${sid}.none`);
  if (fs.existsSync(none)) return null;

  let inherited = null;
  try {
    const t = input.transcript_path;
    if (t && fs.statSync(t).size <= MAX_TRANSCRIPT_BYTES) {
      const text = fs.readFileSync(t, "utf8");
      // The latest marker wins: a fork inherits its parent's current state.
      const ids = [...text.matchAll(/JDH-WORKFLOW-SESSION:([0-9a-f-]{36})/g)].map((m) => m[1]).reverse();
      for (const id of ids) {
        const parent = path.join(dir, `${id}.json`);
        if (id !== sid && fs.existsSync(parent)) {
          inherited = { ...JSON.parse(fs.readFileSync(parent, "utf8")), sessionId: sid, inheritedFrom: id };
          break;
        }
      }
    }
  } catch {
    inherited = null;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (inherited) fs.writeFileSync(own, JSON.stringify(inherited, null, 2) + "\n");
    else fs.writeFileSync(none, "");
  } catch {
    // Caching is best effort.
  }
  return inherited;
}

// Splits a shell command into segments on unquoted && || ; and newlines.
// Returns null if it contains unquoted redirection, pipes, background jobs,
// or any command substitution or variable expansion (which bash also
// performs inside double quotes).
function splitShell(command) {
  const segments = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      cur += c;
      continue;
    }
    if (c === "`" || (c === "$" && next && /[({A-Za-z_0-9@*#?!$-]/.test(next))) return null;
    if (quote === '"') {
      if (c === "\\" && next) { cur += c + next; i += 1; continue; }
      if (c === '"') quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) { segments.push(cur); cur = ""; i += 1; continue; }
    if (c === ";" || c === "\n" || c === "\r") { segments.push(cur); cur = ""; continue; }
    if ("<>|&".includes(c)) return null;
    cur += c;
  }
  if (quote) return null;
  segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

// Read-only shell allowlist for workflow sessions. `git -c` is excluded
// because config overrides (core.pager, aliases) can run arbitrary commands.
const READ_ONLY_GIT = /^git(\s+(-C\s+("[^"]*"|'[^']*'|\S+)|--no-pager))*\s+(rev-parse|status|ls-files|log|diff|show|rev-list|describe|blame|cat-file|ls-tree|branch\s+--show-current|branch(\s+(-a|-r|-v|-vv|--list))*$|config\s+--get(-all)?\s|remote(\s+-v)?$|remote\s+get-url\s)/;
const SAFE_SEGMENTS = [
  /^cd(\s+.+)?$/,
  /^(pwd|ls|dir)(\s+.*)?$/,
  /^(cat|head|tail|wc|stat|file)\s+.+$/,
  /^echo(\s+.*)?$/,
  /^cygpath\s+.+$/,
  /^(Get-Content|Get-ChildItem|Test-Path|Select-String|Set-Location|Get-Location|Resolve-Path)(\s+.*)?$/i,
];

// The Jira site of the repository's own mapping file (read only; this guard
// also blocks edits to that file). Walks up from the hook's working
// directory. Null when there is none, and then only the fixed attachment
// hosts of lib/attach-url.cjs are allowed.
let CURL_SITE = null;
function configuredJiraSite(cwd) {
  let dir = cwd ? path.resolve(String(cwd)) : null;
  for (let i = 0; dir && i < 12; i += 1) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, L.MAPPING_FILE), "utf8"));
      return m && m.jira && typeof m.jira.site === "string" ? m.jira.site : null;
    } catch { /* keep looking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// One attachment download: a single https URL on an allowed Jira attachment
// host, an allowlisted set of curl options, and an output file inside the
// attachment directory (see lib/attach-url.cjs).
function curlAllowed(segment) {
  if (!/^curl(\.exe)?\s/.test(segment)) return false;
  return AU.curlProblem(segment, CURL_SITE, (p) => inside(L.ATTACH_ROOT, p)) === null;
}

function readOnlySegment(seg) {
  return (PLAN_STORE_CALL.test(seg) && storeArgPinned(seg))
    || (READ_ONLY_GIT.test(seg) && !/--output\b|\s-o\s/.test(seg))
    || SAFE_SEGMENTS.some((re) => re.test(seg))
    || curlAllowed(seg);
}

function shellAllowedInWorkflow(command) {
  const segments = splitShell(command);
  if (!segments) {
    return "redirection, pipes, background jobs, command substitution, and variable expansion are not allowed during the workflow";
  }
  for (const seg of segments) {
    if (!readOnlySegment(seg)) {
      return `"${seg.slice(0, 80)}" is not on the workflow's read-only command allowlist (read-only git, plan-store.cjs, cd/ls/cat/head/tail, and single attachment downloads). Use the Read, Grep, and Glob tools instead`;
    }
  }
  return null;
}

// Phase 8C: a Developer command must begin by entering the ticket worktree,
// as `cd "<worktree>" && ...` (or `Set-Location` / `;` in PowerShell), and
// must not change directory or point git elsewhere afterwards. The shell
// starts in the session directory (the main checkout) on every call, and the
// hook's `cwd` does not follow a `cd`, so the prefix is what is checked.
// This decides where a command starts; it does not confine what an approved
// command can reach (see README "Security model").
const WORKTREE_PREFIX = /^\s*(?:cd|Set-Location|chdir)(?:\s+-(?:LiteralPath|Path))?\s+("[^"]*"|'[^']*'|[^\s;&|"']+)\s*(&&|;)\s*(\S[\s\S]*)$/i;
const CHANGES_DIRECTORY = /(^|[\s;&|(])(cd|pushd|popd|chdir|Set-Location|Push-Location|Pop-Location)(\s|$|;)/i;
const REDIRECTS_GIT = /--git-dir\b|--work-tree\b|\bGIT_DIR\b|\bGIT_WORK_TREE\b|\bGIT_COMMON_DIR\b|(^|[\s;&|(])git(\s+(-c\s+\S+|--no-pager))*\s+-C\b/i;

function worktreePrefixProblem(command, worktree) {
  const m = WORKTREE_PREFIX.exec(command);
  const example = `cd "${worktree}" && <command>`;
  if (!m || normalize(m[1]) !== normalize(worktree)) {
    return `every Developer shell command must start in the ticket worktree, as: ${example}. The main checkout and other directories are off limits during implementation.`;
  }
  if (CHANGES_DIRECTORY.test(m[3])) return `a Developer command may not change directory again after entering the worktree. Use: ${example}`;
  if (REDIRECTS_GIT.test(m[3])) return "a Developer command may not point git at another directory or repository (-C, --git-dir, --work-tree, GIT_DIR).";
  return null;
}

// Plugin-managed worktrees, protected in every session (rule 1b). A command
// is refused when it removes, moves, or repairs a registered worktree through
// git, or recursively deletes one or a directory containing one. Paths are
// compared after resolving them against the session directory, and by
// directory name, so relative and differently-slashed forms are covered.
function shellWords(text) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function resolveAt(base, word) {
  const w = String(word);
  if (path.isAbsolute(w) || /^\/[a-z](\/|$)/i.test(w) || /^\/tmp(\/|$)/i.test(w)) return normalize(w);
  return normalize(path.join(base || process.cwd(), w));
}

function globRegex(word) {
  const esc = word.replace(/\\/g, "/").toLowerCase().replace(/[.+^${}()|]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`(^|/)${esc}$`);
}

function managedWorktreeProblem(command, cwd) {
  let regs = [];
  try {
    regs = W.registeredPaths(process.env.CLAUDE_PLUGIN_DATA || "");
  } catch {
    regs = [];
  }
  if (!regs.length) return null;
  const managed = regs.map((r) => ({ ...r, norm: normalize(r.path), name: path.posix.basename(normalize(r.path)) }));
  const segments = splitShell(command) || command.split(/&&|\|\||;|\||\r?\n/);
  let base = cwd;
  for (const seg of segments) {
    const words = shellWords(seg.trim());
    if (!words.length) continue;
    const head = words[0].toLowerCase().replace(/\.exe$/, "");
    // Relative paths after a `cd` are resolved against that directory.
    if (["cd", "chdir", "set-location", "pushd", "push-location", "sl"].includes(head)) {
      const dest = words.slice(1).find((w) => !w.startsWith("-"));
      if (dest) base = resolveAt(base, dest);
      continue;
    }
    let targets = null;
    const wi = words.findIndex((w) => w === "worktree");
    if (head === "git" && wi > 0 && /^(remove|move|prune|repair)$/.test(words[wi + 1] || "")) {
      const sub = words[wi + 1];
      if (sub === "prune") {
        const missing = managed.filter((r) => !fs.existsSync(r.path));
        if (missing.length) return `git worktree prune would drop the plugin-managed worktree ${missing[0].path} (its directory is missing). Ask the developer to inspect it.`;
        continue;
      }
      targets = words.slice(wi + 2).filter((w) => !w.startsWith("-"));
    } else if ((head === "rm" && words.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === "--recursive"))
      || (["rmdir", "rd", "del", "erase"].includes(head) && words.some((w) => /^\/s$/i.test(w)))
      || (["remove-item", "ri", "rm", "del", "rmdir"].includes(head) && words.some((w) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(w)))) {
      targets = words.slice(1).filter((w) => !/^-/.test(w) && !/^\/[a-z]$/i.test(w));
    }
    if (!targets) continue;
    for (const w of targets) {
      const resolved = resolveAt(base, w);
      const glob = /[*?]/.test(w) ? globRegex(resolved.replace(/^.*\//, "")) : null;
      for (const r of managed) {
        const hit = resolved === r.norm || r.norm.startsWith(`${resolved.replace(/\/$/, "")}/`)
          || path.posix.basename(normalize(w)) === r.name
          || (glob && glob.test(r.name));
        if (hit) {
          return `${r.path} is the plugin-managed worktree of ${r.issueKey}. It is never removed, moved, or deleted by Claude; ignored files such as .env and dependencies would be lost. Removal will be a separate developer-run command.`;
        }
      }
    }
  }
  return null;
}

// Why an Artifact publish may not proceed in a workflow session, or null.
// Allowed: the review session's main conversation publishing exactly the
// current review's sanitized share view (intact against its signed record),
// as a new artifact, with no extra files, assets, or runtime capabilities.
function artifactPublishProblem(state, input, agentType) {
  const why = "in a jira-dev-harness workflow session, only the review session may publish, and only the review's sanitized share view (review-<id>.share.html) as a new artifact";
  if (agentType) return `${agentType} may not publish artifacts; ${why}`;
  if (state.mode !== "reviewing" || !state.reviewBundle || !state.reviewId) return `nothing may be published in ${state.mode} mode; ${why}`;
  for (const k of ["files", "file_paths", "asset", "asset_ids", "from_url", "type_url", "url", "root"]) {
    if (input[k] !== undefined && input[k] !== null && input[k] !== false) return `the "${k}" option is not allowed; ${why}`;
  }
  if (input.capabilities && Object.keys(input.capabilities).length) return `runtime capabilities are not allowed; ${why}`;
  const dir = path.dirname(state.reviewBundle);
  const expected = path.join(dir, `review-${state.reviewId}.share.html`);
  if (!input.file_path || normalize(input.file_path) !== normalize(expected)) return `only ${expected} may be published; ${why}`;
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const view = L.readJson(path.join(dir, `review-${state.reviewId}.share.json`));
  if (!view || !L.signatureValid(view, L.approvalKey(dataDir, false)) || view.reviewId !== state.reviewId) return "the share view's signed record is missing or invalid; nothing may be published";
  if (!fs.existsSync(expected) || L.sha256(expected) !== view.sha256) return "the share view was modified after it was generated; nothing may be published";
  const reviewFile = path.join(dir, `review-${state.reviewId}.json`);
  if (!fs.existsSync(reviewFile) || L.sha256(reviewFile) !== view.reviewSha256) return "the share view is not for the saved review; nothing may be published";
  return null;
}

// The Developer's shell policy: never git state changes or hosting CLIs;
// read-only commands follow the normal flow; anything else is a project
// command that the developer must authorize interactively.
function developerShell(command, state) {
  const prefix = worktreePrefixProblem(command, state.worktree.path);
  if (prefix) deny(prefix);
  const segments = splitShell(command);
  const parts = segments || command.split(/&&|\|\||;|\||\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of parts) {
    const s = seg.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*$/, "");
    if (GIT_MUTATION.test(s) || HOSTING_CLI.test(s) || /\bgit\s+(commit|push)\b/.test(seg)) {
      deny(`"${seg.slice(0, 80)}" is not allowed: no commits, pushes, branch changes, staging, or pull requests during implementation.`);
    }
  }
  if (segments && segments.every(readOnlySegment)) allow();
  ask(`the Developer Agent wants to run a project command in the ticket worktree ${state.worktree.path}. The command can still reach files outside it, so approve only if you trust this command and it is an appropriate check for the approved plan: ${command.slice(0, 200)}`);
}

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny("could not read the tool call; blocking it as a precaution.");
  }
  const tool = String(input.tool_name || "");
  const toolInput = input.tool_input || {};
  const agentType = String(input.agent_type || "");
  const isMcp = tool.startsWith("mcp__");
  const isMcpWrite = isMcp && (ATLASSIAN_WRITE.test(tool) || MCP_WRITE_VERB.test(tool));
  const command = SHELL_TOOLS.has(tool) ? String(toolInput.command || "") : "";
  const isRunCheck = !!command && RUN_CHECK.test(command.trim());
  const isShipAction = !!command && SHIP_ACTION.test(command.trim()) && storeArgPinned(command) && !/[;&|<>`]|\$\(/.test(command);
  const isConnectEval = !!command && CONNECT_EVAL.test(command.trim()) && storeArgPinned(command) && !/[;&|<>`]|\$\(/.test(command);
  const mcpKind = isMcp ? P.classifyMcpTool(tool) : null;
  const target = toolInput.file_path || toolInput.notebook_path || "";

  // 1. The plan store is off limits in every session, to every agent.
  if (WRITE_TOOLS.has(tool) && target && inStore(target)) {
    deny("the plan store can only be changed by the plan store script; approvals only by the developer running /jira-dev-harness:approve.");
  }
  if (READ_TOOLS.has(tool)) {
    const refs = [toolInput.file_path, toolInput.path, toolInput.pattern, toolInput.glob].filter(Boolean).map(String);
    if (refs.some((r) => /approval\.key/i.test(r) || (/[\\/]keys([\\/]|$)/i.test(r) && inStore(r)))) {
      deny("the approval signing key may not be read.");
    }
  }
  if (command && !isRunCheck && !isShipAction && !isConnectEval && (STORE_REF.test(command) || PROTECTED_NAMES.test(command) || RESERVED_STORE_CMD.test(command))) {
    const single = command.trim();
    if (!(PLAN_STORE_CALL.test(single) && storeArgPinned(single) && !/[;&|<>`]|\$\(/.test(single) && !PROTECTED_NAMES.test(single))) {
      deny("shell commands may not touch the plan store, approval records, or the approval key. Approvals are recorded only by the developer running /jira-dev-harness:approve.");
    }
  }

  // 1b. Plugin-managed worktrees are protected in every session.
  if (command) {
    const managed = managedWorktreeProblem(command, input.cwd);
    if (managed) deny(managed);
  }

  CURL_SITE = configuredJiraSite(input.cwd);
  let state = null;
  try {
    state = workflowState(input);
  } catch {
    state = { mode: "unknown" };
  }

  // 1c. Claude Code's Artifact tool uploads a page to claude.ai. In a
  // workflow session the only thing it may publish is the current review's
  // sanitized share view, from the review session's main conversation, and
  // the developer is always asked first (that prompt is the consent).
  if (tool === "Artifact" && state && (toolInput.action === undefined || toolInput.action === "publish")) {
    const problem = artifactPublishProblem(state, toolInput, agentType);
    if (problem) deny(problem);
    if (input.permission_mode !== "default") {
      deny(`publishing a review report needs attended mode with a permission prompt; this session's permission mode is "${input.permission_mode}".`);
    }
    ask(`publish the sanitized review report of ${state.issueKey} ${state.reviewId} to claude.ai as an artifact? It contains the verdict, acceptance criteria, test cases, check results, findings, and the review SHA-256. It omits raw logs, check commands, local paths, the repository location and remote, links, and credentials. It starts private; anyone you share it with, or anyone with the link if you make it public, can read it. Allow only if you want it uploaded.`);
  }

  // 2. The Developer Agent.
  if (agentType === DEVELOPER && (WRITE_TOOLS.has(tool) || SHELL_TOOLS.has(tool) || isMcpWrite)) {
    if (isMcpWrite) deny("the Developer Agent may not use Jira or other MCP write tools.");
    if (!state || state.mode !== "implementing") {
      deny("the Developer Agent may modify files only after the developer runs /jira-dev-harness:implement for an approved plan in this session.");
    }
    if (input.permission_mode !== "default") {
      deny(`implementation requires attended mode with a permission prompt for every edit; this session's permission mode is "${input.permission_mode}". Switch to the default mode.`);
    }
    const problem = L.implementationProblem(process.env.CLAUDE_PLUGIN_DATA, state);
    if (problem) deny(`implementation is no longer authorized: ${problem}`);
    const wtProblem = W.sessionWorktreeProblem(process.env.CLAUDE_PLUGIN_DATA, state);
    if (wtProblem) deny(`implementation is not authorized: ${wtProblem}`);
    if (command) developerShell(command, state);
    const targetProblem = developerTargetProblem(state, target);
    if (targetProblem) deny(targetProblem);
    ask(`Developer Agent edit for ${state.issueKey} r${state.revision} (approved plan). Review the change before allowing it: ${target}`);
  }

  // 3. Every other plugin agent is read-only.
  if (agentType.startsWith("jira-dev-harness:") && (WRITE_TOOLS.has(tool) || SHELL_TOOLS.has(tool) || isMcpWrite)) {
    deny(`${agentType} is read-only and may not modify anything.`);
  }

  // Recorded review checks run project code: always ask the developer. The
  // script itself refuses unless this session is reviewing.
  if (isRunCheck) {
    if (input.permission_mode !== "default") {
      deny(`review checks run project code and need attended mode; this session's permission mode is "${input.permission_mode}".`);
    }
    ask(`jira-dev-harness wants to run a project check for the review and record its output as evidence. Approve only if you trust this command: ${command.slice(0, 300)}`);
  }

  // Shipping steps change git state or the hosting provider: always a prompt.
  if (isShipAction) {
    if (input.permission_mode !== "default") {
      deny(`shipping steps need attended mode with a permission prompt; this session's permission mode is "${input.permission_mode}".`);
    }
    if (!state || (state.mode !== "shipping" && !/\bmerge-run\b/.test(command))) {
      deny("nothing is authorized to ship in this session; the developer must run /jira-dev-harness:ship first.");
    }
    if (/\bmerge-run\b/.test(command)) {
      if (state.mode !== "merging") deny("nothing is authorized to merge in this session; the developer must run /jira-dev-harness:merge first.");
      ask(`jira-dev-harness wants to MERGE pull request #${state.pr} of ${state.issueKey} into ${state.base} (${state.method}) with the GitHub CLI, pinned to head ${state.headSha}. The provider must confirm every check, review, and protection first. Allow only if you want to merge now.`);
    }
    const what = /\bship-commit\b/.test(command) ? `commit the approved files of ${state.issueKey} on branch ${state.branch}`
      : /\bship-push\b/.test(command) ? `push branch ${state.branch} to origin (no force)`
        : `create the pull request for ${state.issueKey} with the GitHub CLI (head ${state.branch}, base ${state.base}; it will not be merged)`;
    ask(`jira-dev-harness wants to ${what}. Allow only if you approved the review and want this step now.`);
  }

  // 3b. Outside a workflow session no Jira write is ever silently allowed.
  // Atlassian reads pass untouched; every Atlassian write (comment,
  // transition, edit, create, any execute* meta-tool, or an operation that is
  // not recognisably a read) needs the developer's explicit permission
  // prompt. Without a prompt (bypass or don't-ask mode) it is refused.
  if (!state) {
    const kind = JG.classifyCall(tool, toolInput);
    if (kind && kind !== "read") {
      if (input.permission_mode === "bypassPermissions" || input.permission_mode === "dontAsk") {
        deny(`Jira and other Atlassian writes need a permission prompt; this session's permission mode is "${input.permission_mode}". Use /jira-dev-harness:jira-sync for planned, audited Jira updates.`);
      }
      ask("write to Jira or another Atlassian product (" + kind + ", " + tool + "). jira-dev-harness never writes to Jira on its own: allow only if you intended this exact action now.");
    }
  }

  // 4. Workflow sessions: everyone except an authorized Developer.
  if (!state) allow();
  if (mcpKind === "otherMerge") {
    deny("auto-merge, merge queues, and other merge tools are never used by this plugin.");
  }
  if (mcpKind === "mergePullRequest") {
    if (state.mode !== "merging") {
      deny("merging needs its own authorization: the developer must run /jira-dev-harness:merge for this pull request and head commit.");
    }
    if (input.permission_mode !== "default") {
      deny(`merging needs attended mode with a permission prompt; this session's permission mode is "${input.permission_mode}".`);
    }
    const bad = P.mcpMergeProblem(state, toolInput);
    if (bad) deny(`merge refused: ${bad}.`);
    const gate = M.gate(process.env.CLAUDE_PLUGIN_DATA, state, undefined, (/^mcp__(.+?)__/.exec(tool) || [])[1]);
    if (!gate.ok) deny(`merge blocked by the merge gate: ${gate.reasons.slice(0, 5).join("; ")}`);
    ask(`MERGE pull request #${state.pr} of ${state.issueKey} into ${state.base} (${state.method}), pinned to head ${state.headSha}. The provider responses recorded for this session pass the gate. Allow only if you want to merge now.`);
  }
  if (mcpKind === "createPullRequest" && state.mode === "shipping") {
    if (input.permission_mode !== "default") {
      deny(`creating a pull request needs attended mode with a permission prompt; this session's permission mode is "${input.permission_mode}".`);
    }
    const bad = P.mcpCreatePrProblem(state, toolInput);
    if (bad) deny(`pull request creation refused: ${bad}.`);
    // The whole chain again, right before the provider write: plan, review,
    // the developer's review approval, the signed worktree binding, branch,
    // the shipping commit's content, and the authorized remote.
    const chain = S.committedProblem(process.env.CLAUDE_PLUGIN_DATA, state);
    if (chain) deny(`pull request creation refused: ${chain}.`);
    ask(`create a pull request for ${state.issueKey}: ${state.branch} into ${state.base} on ${state.remote.owner}/${state.remote.name}, with the prepared title and body. It will not be merged.`);
  }
  const jiraKind = JG.classifyCall(tool, toolInput);
  if (jiraKind && jiraKind !== "read" && state.mode === "jira-syncing") {
    if (jiraKind === "write-other") {
      deny("in a Jira sync session only the one planned transition and the one planned comment on the authorized ticket can be written; this Jira call is neither.");
    }
    if (input.permission_mode !== "default") {
      deny(`Jira writes need attended mode with a permission prompt; this session's permission mode is "${input.permission_mode}".`);
    }
    if (state.phase !== "planned") deny("run jira-plan first: Jira writes are allowed only for a plan built from recorded Jira responses.");
    const dd = process.env.CLAUDE_PLUGIN_DATA;
    let bad;
    try {
      const ledger = PR.readLedger(dd, state.site, state.issueKey);
      bad = PR.ledgerProblem(dd, state.site, state.issueKey)
        ? "the audit ledger is not trustworthy"
        : JG.writeProblem(state, jiraKind, tool, toolInput, JS.planNow(dd, state), JS.executedKinds(ledger, state.sessionId));
      if (!bad) {
        PR.appendLedger(dd, state.site, state.issueKey, { sessionId: state.sessionId, stage: state.stage, kind: jiraKind, status: "requested", marker: state.comment.marker, detail: "permission prompt shown to the developer" });
      }
    } catch (e) {
      bad = e.message;
    }
    if (bad) {
      try {
        PR.appendLedger(dd, state.site, state.issueKey, { sessionId: state.sessionId, stage: state.stage, kind: jiraKind, status: "blocked", detail: String(bad).slice(0, 300) });
      } catch {
        // The refusal stands even if it can't be logged.
      }
      deny(`Jira ${jiraKind} refused: ${bad}.`);
    }
    ask(`write to Jira ticket ${state.issueKey} on ${state.site} (${jiraKind}) exactly as planned from Jira's own responses. A Done status is never set unless you authorized it. Allow only if you want this update now.`);
  }
  if (isMcpWrite) {
    deny("this is a jira-dev-harness workflow session, so Jira and other MCP write operations are blocked for the whole session.");
  }
  if (WRITE_TOOLS.has(tool) && !isDraft(target)) {
    deny(`this is a jira-dev-harness workflow session in ${state.mode} mode: only the authorized Developer Agent may change the repository, and others may write only drafts under ${L.DRAFTS_ROOT}. Blocked: ${target || "(no path)"}`);
  }
  if (command) {
    const problem = shellAllowedInWorkflow(command);
    if (problem) deny(problem);
  }
  allow();
});
