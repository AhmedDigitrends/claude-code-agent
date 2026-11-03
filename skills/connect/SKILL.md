---
description: Check and guide the developer's own Jira and GitHub connections before ticket work. Reads which account each connection uses, reports blockers, and reports READY only after the developer confirms both account identities. Changes nothing in Jira, GitHub, or the repository.
argument-hint: [--confirm <jira-account> <github-login>]
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" begin *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" facts-path) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" evaluate *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" begin *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" facts-path) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" evaluate *)
---

# Connect: verify this developer's Jira and GitHub connections

The developer ran `/jira-dev-harness:connect $ARGUMENTS`. This is not a
ticket workflow session. Run it in a fresh session, because a session that
already ran a workflow command restricts shell commands.

The developer's confirmation, if they typed one, was recorded for this
session before you were invoked:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" begin "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" $ARGUMENTS`

Plugin root: `${CLAUDE_PLUGIN_ROOT}`. Plugin data: `${CLAUDE_PLUGIN_DATA}`.
If the line above says `ERROR`, show it and stop.

## Hard limits

- **Read-only.** Call only read tools. Never create, edit, transition,
  comment, or otherwise write in Jira or GitHub. Never change files in the
  repository.
- **Never handle credentials.** Do not ask for, read, print, or suggest a
  token, personal access token, API key, or password. Do not run `claude mcp
  add`, `/mcp`, `gh auth login`, or any sign-in yourself: those are for the
  developer, who types them. Do not suggest Docker.
- **Never confirm identities for the developer.** The script reads the
  developer's typed confirmation itself. Never write a confirmation, and never
  say the connections are READY. Only the script's final line decides.
- **Never claim success you did not observe.** Report a missing, unsigned,
  unsupported, or inaccessible connection as a blocker. Do not retry an
  authentication failure.
- **Never use another connection's data.** Use only what this session's own
  connections return.

## Step 1: Find the connections

Use ToolSearch. Never assume a tool name.

- **Jira:** tools whose name ends in `__atlassianUserInfo`,
  `__getAccessibleAtlassianResources`, or `__getJiraIssue`. Record the full
  tool names you find.
- **GitHub MCP:** tools of an MCP server whose name contains `github`, such
  as one that returns the authenticated user (often `get_me`), and one that
  reads a repository (often `get_repository` or a file or search tool).
  Record the full tool names.

If an MCP server is listed as needing authentication, record `needs-auth` and
do not call its tools.

## Step 2: Read the account behind each connection

Jira, if its tools exist and it is not `needs-auth`:

1. Call the user-info tool, if there is one, and record every identifier it
   returns for the account: email, display name, account id.
2. Call `getAccessibleAtlassianResources` and record the site hosts, for
   example `your-site.atlassian.net`.
3. If a call fails, record `authState: "error"` and its message, with any
   token-like text removed.

GitHub MCP, if its tools exist and it is not `needs-auth`:

1. Call the authenticated-user tool and record the login.
2. If `git remote get-url origin` names a GitHub repository, call a
   read-only repository tool for it and record `repoAccess` true or false.
   Skip this if there is no such remote or tool.
3. If a call fails, record `authState: "error"` and its message.

The official GitHub CLI is checked by the script, not by you.

## Step 3: Evaluate

1. Get a facts path: `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" facts-path`
2. Write this JSON to that path with the Write tool (omit what you did not
   find; use empty arrays for no tools):

   ```json
   {
     "jira": { "tools": ["<full tool names>"], "authState": "ok|needs-auth|error|unknown", "identities": ["<email>", "<name>"], "sites": ["<host>"], "error": "" },
     "github": { "mcp": { "tools": ["<full tool names>"], "authState": "ok|needs-auth|error|unknown", "identities": ["<login>"], "repoAccess": true, "error": "" } }
   }
   ```
3. Run it as a single command, with no `cd` and no chaining:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.cjs" evaluate "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" "<facts path>"`

   It also checks the official `gh` the developer signed in to, applies the
   status rules, and prints the report.

## Step 4: Report

Show the script's report as it is. Then add, in plain words:

- **Not ready:** what to do next, from the report's steps. For a missing
  connection, the developer runs the commands themselves, then reloads and
  runs `/jira-dev-harness:connect` again.
- **UNCONFIRMED:** the developer must check that each account is the one they
  intend to use (personal or office), then type the `--confirm` command the
  report prints. You cannot do this for them.
- **READY:** both accounts were read from live connections and the developer
  confirmed them. They may start with `/jira-dev-harness:ticket <url>`. Say
  that READY means this session's connections work, and does not prove that
  credentials are isolated: the report states what is known about each
  connection's credential storage.
- Repeat any WARNING about claude.ai connectors. This plugin is meant for
  per-PC, per-developer connections, and a claude.ai connector follows the
  Claude account instead.

Then stop. Do not start a ticket workflow.
