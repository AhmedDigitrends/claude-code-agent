# jira-dev-harness roadmap

This file tracks how `jira-dev-harness` is built, phase by phase. A phase
moves to **Completed** only when its acceptance criteria have been checked
and the actual results are written down in its completion notes.

## Architecture requirements

These apply to every phase:

- The plugin is a reusable, publicly installable Claude Code plugin with no
  project-specific content. It contains no client names, repository paths,
  component names, technology assumptions, or project rules.
- It supports arbitrary git repositories in any language, framework, or
  build system. Stacks, tooling, and commands are discovered from each
  repository, never assumed.
- Each user connects their own authorized Jira account. Later, GitHub or
  other services follow the same model. The plugin stores no credentials.
- The workflow is driven by a Jira Cloud ticket assigned to the developer.
- The workflow reads the current repository's instruction files and the
  rules that apply. Today these are `CLAUDE.md`, `.claude/rules/`,
  `AGENTS.md`, and `CONTRIBUTING.md`. First-class `AGENTS.md` and
  `SPECIFICATION.md` support is planned, and the guard already treats
  `SPECIFICATION.md` as a protected instruction file. Project rules stay in
  each project.
- Implementation starts only after the developer explicitly approves the plan.
- Review happens in a fresh context. The reviewer inspects the actual
  changes and does not rely on the Developer Agent's conclusions.
- Commit, push, and PR creation need both a passing independent review and
  final developer approval.
- The plugin never merges a pull request automatically.
- Jira is updated only through the transitions the board's workflow allows.
- Phase 3 sets up the first plan-approval gate. Phase 4 cannot implement
  anything until that gate exists.
- Phase 6 hardens and validates the approval and Git controls.

## Future product requirements

These are recorded during Phase 5 and **not implemented yet**. Later
phases must meet them:

1. **Public installation, with each user's own connections.** The plugin
   will be installable from a public marketplace. Each user connects their
   own authorized Jira, GitHub, or other services. The plugin stores no
   shared credentials and never uses another user's connection.
2. **Explicit per-repository Jira project and board mapping.** The mapping
   grows beyond `site` and `projectKeys` to name the Jira board used for
   transitions (built in Phase 7, as `jira.board`). It stays committed in
   each repository and is never inferred.
3. **Tool-neutral `AGENTS.md` and `SPECIFICATION.md` support.** These
   become first-class sources of project instructions and specifications
   alongside the optional `CLAUDE.md` and `.claude/rules/`. Today they are
   read where present and protected from unapproved edits, but the
   precedence and merging rules are not defined yet.
4. **Developer approval before PR creation.** The developer approves the
   current, PASS review artifact explicitly, in a separate user-only step.
   That approval is bound to the review id and tree identity, like plan
   approval.
5. **Separate, explicit user authorization before merging.** It is distinct
   from PR-creation approval and is never implied by it.
6. **Repository-required CI and branch protection must pass before merge.**
   The plugin checks the hosting provider's required status checks and
   branch-protection rules, and never bypasses them.
7. **No automatic merge, ever.**

## Model allocation

| Role | Model alias | Defined in |
| :- | :- | :- |
| Analyzer | `sonnet` | `agents/analyzer.md` |
| Planner | `sonnet` | `agents/planner.md` |
| Developer | `sonnet` | `agents/developer.md` |
| Independent Reviewer | `opus` | `agents/reviewer.md` |

Some operations deliberately have no dedicated AI agent:

- **Builds, lint, type checks, and tests** run with the commands the
  project itself declares, such as manifest scripts, task runner targets,
  or CI steps. Each one is authorized interactively by the developer.
- **Commit, push, and PR creation** use Git and the Git hosting provider's
  tools, behind explicit approval controls.

## Phase summary

| # | Phase | Status |
| :- | :- | :- |
| 1 | Plugin Foundation | Completed |
| 2 | Jira Cloud Integration | Completed |
| 3 | Analyzer + Planner Agents | Completed |
| 4 | Developer Agent | Completed |
| 5 | Independent Reviewer Agent | Completed |
| 6 | Approval Gates + Git/PR | Completed |
| 7 | Jira Progress Automation | Completed |
| 8A | Per-developer connection onboarding | Implemented (offline-tested; live checks pending) |
| 8B | Assigned-ticket discovery | Implemented (offline-tested; live Jira check pending) |
| 8C | Git worktree isolation | Implemented in v0.8.0; offline-tested and live-tested with mocked GitHub and Jira; real services pending |
| 8 | End-to-End Testing + Team Rollout | Pending |

---

## Phase 1: Plugin Foundation

**Status:** Completed

**Objective:** Create a minimal, valid, project-independent Claude Code
plugin that later phases can build on.

**Implementation scope:**

- Manifest at `.claude-plugin/plugin.json`.
- Entry skill `skills/ticket/SKILL.md`, invoked as
  `/jira-dev-harness:ticket <jira-url>`. Only the user can invoke it
  (`disable-model-invocation: true`). It runs a read-only preflight: it
  parses the URL, identifies the repository, detects the project type,
  lists the project instruction files, reports, and stops.
- Placeholder agents `analyzer`, `planner`, `developer`, and `reviewer`.
  Their tools are limited to `Read, Grep, Glob`, and each one replies only
  "not implemented".
- `README.md` and this `ROADMAP.md`.
- No hooks, MCP servers, scripts, executables, dependencies, or external
  connections.

**Acceptance criteria and validation:**

- `claude plugin validate <plugin> --strict` passes.
- The plugin loads with `--plugin-dir`, and the skill runs.
- The skill rejects invalid ticket URLs and changes no files or git state.
- All four agents register under the `jira-dev-harness:` namespace.

**Completion notes (recorded results, Claude Code 2.1.312):**

- **Initial build (2026-10-29)**
  - `claude plugin validate ./jira-dev-harness --strict` returned
    `√ Validation passed` with exit code 0.
  - The validator's separate plugin-directory submission checks reported
    three items. None of them changed the verdict:
    - Missing licence (`LICENSE_MISSING`, a submission blocker).
    - Missing icon (`ICON_MISSING`, a warning).
    - Advice to add a marketplace install line to the README.

    These matter only for submitting to Anthropic's plugin directory and
    are still open. The licence choice is pending with the maintainers.
  - `claude plugin details` accepts only installed plugins and cannot load
    a plugin from `--plugin-dir`, so it was not used.
  - Headless load test: the skill was run with `claude --plugin-dir ... -p`
    in a throwaway git repository containing a minimal React Native
    `package.json` and a `CLAUDE.md`. The repository was created in a
    temporary directory, and no real project was used.
    - With `https://example.atlassian.net/browse/ABC-123`, the skill
      reported:
      - site `example.atlassian.net` and key `ABC-123`
      - branch `master` with a clean working tree
      - project type React Native
      - only `CLAUDE.md` among the instruction files

      It then stopped without contacting Jira.
    - With `http://evil.example.com/browse/ABC-123`, the skill rejected
      the URL because it was not `https` and not an `atlassian.net` host.
      It stopped before the repository checks and contacted nothing.
  - Agent registration: a session loaded with the plugin listed
    `jira-dev-harness:analyzer`, `jira-dev-harness:developer`,
    `jira-dev-harness:planner`, and `jira-dev-harness:reviewer`.
- **Model allocation update (2026-10-30)**
  - Added `model` frontmatter to all four agents, as shown in
    [Model allocation](#model-allocation).
  - The validation results are recorded in the
    [Validation log](#validation-log) at the end of this file.

---

## Phase 2: Jira Cloud Integration

**Status:** Completed (2026-10-30, plugin version 0.2.0)

**Objective:** Read the assigned ticket from Jira Cloud through a supported,
authenticated connection, and validate the ticket's identity and its
association with the open repository. This phase is read-only.

**Implementation scope:**

- **Connection.** The plugin uses the official Atlassian Rovo MCP server
  through the developer's own connection. That is either the claude.ai
  Atlassian connector, or
  `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp`
  followed by OAuth 2.1 through `/mcp`. The plugin bundles no MCP server
  and contains no credentials, tokens, sites, or user settings.
  - The skill finds the server by the suffix of its tool names, so any
    server prefix works.
- **Operations.** It uses only documented read operations:
  - `getAccessibleAtlassianResources`
  - `getJiraIssue` (with `view: "evidence"`)
  - `listJiraIssueComments`
  - `listJiraIssueRemoteIssueLinks`, called through `executeRead`
  - `downloadJiraIssueAttachment`, called through `executeRead`
  - `discover`, to look up operation inputs
- **Data read:**
  - key, summary, and description
  - type, status, priority, assignee, and reporter
  - acceptance criteria, taken from a custom field or a description
    section, and never invented
  - other custom fields that are set
  - issue links and remote links
  - comments, with visibility restrictions noted
  - attachment metadata, plus the content of `image/*` and `text/*`
    attachments up to 5 MB, at most 5. These are downloaded to a temporary
    directory outside the repository and deleted afterwards.
- **Identity checks:**
  - The ticket's site must be among the account's accessible sites.
  - If the key returned by Jira differs from the requested key, the skill
    reports the issue as moved or renamed.
- **Project association.** It is checked only against an optional
  `.claude/jira-dev-harness.json` that is committed to the project. The
  result is verified, mismatch, or unverified. It is never inferred from
  repository or folder names.
- **Read-only enforcement:**
  - The skill's instructions forbid writes.
  - A skill-scoped `PreToolUse` hook denies Atlassian write tools for the
    rest of the session, including `executeWrite` and `executeDestructive`.
- **Untrusted content.** Ticket content is shown in labelled "untrusted"
  blocks and never followed as instructions. Secrets in it are redacted.
- **Errors.** These each produce a clear message:
  - not connected
  - authentication expired
  - site not accessible
  - a 404 (not found or no permission)
  - a 403 on individual fields
  - a 429 or 5xx (retried once)
  - an attachment that can't be downloaded

**Acceptance criteria and validation:**

- Strict plugin validation passes.
- Valid URLs are parsed correctly, and invalid URLs are rejected before any
  service is contacted.
- An authenticated, accessible ticket is read.
- Unauthorized, nonexistent, and inaccessible tickets fail safely.
- No Jira write happens, and the write-block hook denies write tools.
- No files in the application repository change.
- Without a trusted mapping, the association is reported as unverified.
  With a committed, matching mapping, it is reported as verified.
- The skill's earlier behaviour and the four agent placeholders and their
  models are unchanged.

**Completion notes (recorded results, Claude Code 2.1.312):**

- **Research.** The current Atlassian documentation names
  `https://mcp.atlassian.com/v2/mcp` as the endpoint for new setups. It
  lists the operations used here as read operations, and says that OAuth
  2.1 enforces the user's existing Jira permissions.
- **Validation.** `claude plugin validate . --strict` returned
  `✔ Validation passed` with exit code 0. The same three plugin-directory
  submission items as in Phase 1 remain open: the licence, the icon, and
  the README install line.
- **Hook checked offline:**
  - The hook command prints valid deny JSON.
  - The matcher denied all 13 write tool names tried, and allowed all 10
    read or unrelated tools tried. The write tools tried included
    `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`,
    `createJiraIssue`, `executeWrite`, and `executeDestructive`, under the
    `claude_ai_Atlassian_MCP`, `atlassian`, and plugin-style prefixes. The
    read tools allowed included `getJiraIssue`, `executeRead`, and
    `discover`.
- **Live tests.** Each test ran headlessly (`claude --plugin-dir ... -p`)
  in throwaway git repositories under the session's temporary directory.
  The connection was the authenticated claude.ai Atlassian connector,
  against the site `your-site.atlassian.net`.

  | Test | Result |
  | :- | :- |
  | `PROJ-1292`, assigned to the tester, with 2 image attachments and 1 comment | Read in full: summary, description, type Bug, status QA Verified, priority, assignee, reporter, sprint, fix version, labels, and time tracking. Acceptance criteria were correctly reported as "not found". No issue links or remote links. 1 comment. Both PNG attachments (204 KB and 258 KB) were downloaded to a temporary directory and read. Tools called: Atlassian read tools only. |
  | `PROJ-99999999`, which doesn't exist | Jira returned 404. Reported as "not found or no permission", and the run stopped safely. |
  | `zzq-no-such-site-4417.atlassian.net` | Reported as not accessible with the connected account. No other site was tried. |
  | `http://evil.example.com/...` | Rejected at Step 1. No tools were called. |
  | No MCP servers (`--strict-mcp-config`) | Reported "not connected" and printed the setup instructions. No Jira tools were called. |
  | Write attempt after running the skill | `editJiraIssue` was explicitly allowed in permissions and called on the nonexistent key `ZZQX-999999`. The hook denied it with its own message, so the call never reached Jira. |
  | Committed mapping (`your-site.atlassian.net`, `PROJ`) with `PROJ-1207` | Reported as verified. The repositories without a mapping were reported as unverified. |

- **No writes.** In every transcript, the only Atlassian tools called were
  `getAccessibleAtlassianResources`, `getJiraIssue`,
  `listJiraIssueComments`, `discover`, and `executeRead`. The one exception
  is the deliberate write attempt, which the hook denied.
- **Repositories unchanged.** After the tests, the sample repositories had
  clean working trees and the same commits as before. The four agent files
  are unchanged: `sonnet`, `sonnet`, `sonnet`, `opus`, each with
  `Read, Grep, Glob`.
- **Known limitations and open items:**
  - **Expired authentication was not tested live.** Testing it would mean
    revoking the tester's Atlassian connection. The handling exists only as
    instructions in the skill.
  - **Some attachment limits were not exercised.** No test ticket had an
    attachment over 5 MB or of a type other than image or text.
  - **Temporary directory cleanup needs approval.** The `rm -rf` cleanup is
    a permission-prompted command. In the first live run it wasn't
    pre-approved, so the temporary directory was left behind. The skill
    reported it, and the tester deleted it manually.
  - **The hook lasts for the whole session.** Once the skill has run,
    Atlassian writes stay blocked until the session ends. This is
    documented in the README. Phase 7 has to redesign the hook when Jira
    writes become intended.
    - *Correction, found in Phase 3 (2026-10-30):* the hook does not
      survive `--resume`, and it does not fire inside subagents. Skill
      hooks exist only in the process that invoked the skill. The planning
      agents have no MCP tools, so they cannot call Jira at all. A resumed
      session, however, has no Jira write block.
  - **Signed download URLs appear in the transcript.** They are
    short-lived and read-only.

---

## Phase 3: Analyzer + Planner Agents

**Status:** Completed (2026-10-30, plugin version 0.3.0)

**Objective:** Understand the project and the ticket, produce a
ticket-specific implementation plan, and require the developer to approve
one exact plan revision.

**Implementation scope:**

- **Workflow in `/jira-dev-harness:ticket`:**
  1. Parse the URL.
  2. Check the repository and its trusted mapping. **Stop** if the mapping
     is unverified or mismatched, before contacting Jira.
  3. Read the project instructions:
     - `CLAUDE.md` and `.claude/CLAUDE.md`
     - `CLAUDE.local.md`
     - `.claude/rules/**/*.md`, including their `paths:` scope
     - `AGENTS.md` and `CONTRIBUTING.md`

     Record missing and conflicting instructions.
  4. Build the project profile: scripts, dependencies, layout, configs,
     and libraries by category.
  5. Read the Jira ticket, using the Phase 2 read-only steps, now in
     `skills/ticket/jira-read.md`. Then re-check the returned project key
     against the mapping.
  6. Run the Analyzer.
  7. Run the Planner.
  8. Save the plan as a new revision.
  9. Present the plan and stop at the approval gate.
- **Analyzer Agent:** `model: sonnet`, tools `Read, Grep, Glob`.
  - It reports: instructions applied, missing instructions, conflicting
    instructions (with a proposed rule change), requirements R1 to Rn with
    their source and clarity, existing implementation with `path:line`
    evidence, affected files, dependencies, risks, missing information and
    contradictions, and READY or BLOCKED.
- **Planner Agent:** `model: sonnet`, tools `Read, Grep, Glob`.
  - It checks the Analyzer's findings against the code.
  - It returns a plan with: summary, acceptance criteria, existing
    behaviour, proposed changes, files likely to change, steps, testing,
    risks, proposed project-rule updates, open questions and blockers, and
    a `Readiness: READY|BLOCKED` line.
  - A plan with any blocking question must be BLOCKED.
- **Plan store (`scripts/plan-store.cjs`):** Node, no dependencies.
  - Revisions are kept in
    `${CLAUDE_PLUGIN_DATA}/plans/<site>/<ISSUE-KEY>/plan-rN.md`, outside
    the repository, with `plan-rN.json` holding the SHA-256 and readiness.
  - Saving claims each revision with an exclusive create, so a revision
    is never overwritten.
  - Drafts go through `<os temp>/jira-dev-harness/drafts/`, because Claude
    Code treats `~/.claude` as sensitive and refuses tool writes there.
  - Attachment downloads use `attach-dir` and `clean-attach`, which can
    only delete directories that the store created.
- **Approval gate (`/jira-dev-harness:approve <KEY> rN <hash-prefix>`):**
  - The skill has `disable-model-invocation: true`, and it records the
    approval with an injected `!` command, so the store script runs only
    when the developer types the command.
  - Approval requires the **latest** revision, a SHA-256 prefix of at
    least 12 characters, an intact file (re-hashed and compared with the
    metadata), and `Readiness: READY`.
  - A new revision, or any edit to the file, invalidates the approval.
  - `plan-store.cjs verify` gives Phase 4 a single check.
- **Guards (`scripts/guard.cjs`):**
  - **`approvals` mode** is always on, in the plugin's `hooks/hooks.json`.
    It covers resumed sessions and subagents. It denies file-tool writes
    into the plan store, and shell commands that run the store's
    `approve` command or touch `approval-rN` or `plan-rN` files.
  - **`planning` mode** runs from the ticket skill's hooks while the skill
    is active. It additionally denies every file-tool write except plan
    drafts, and every git state change.
- **Jira** stays read-only, and the Phase 2 write-block hook is kept.
- **Rule changes:** `CLAUDE.md` and the rules are never edited. Rule
  changes are proposed in the plan, and approving the plan does not apply
  them.

**Acceptance criteria and validation:**

- Project instructions are read before the ticket is analyzed.
- Applicable rules are respected, and inapplicable rules are recognized.
- Missing and contradictory instructions are reported.
- The repository mapping is enforced, so an unverified or mismatched
  mapping stops the run before Jira is contacted.
- The Analyzer and Planner run on Sonnet and stay read-only.
- The plan reflects the real ticket requirements and the real repository
  code.
- No application code is modified, and no Jira writes happen.
- A plan approval cannot be forged by Claude, and cannot be reused after
  the plan changes.
- A BLOCKED plan cannot be approved.
- Strict plugin validation passes.

**Completion notes (recorded results, Claude Code 2.1.312):**

- **Test setup:** these tests used a synthetic React Web repository
  (`email-app-fixture`, 14 tracked files) that renders emails with
  `@react-email`, and the real ticket `PROJ-1292`. The fixture was created
  for the test in a temporary directory and is not a real project. It
  contains:
  - `CLAUDE.md`
  - an always-applying `branding.md` rule
  - a path-scoped `emails.md` rule, "plain text, no logos or colored
    blocks (ADR-7)", which conflicts with the ticket on purpose
  - an `ios/` and `android/` scoped `native.md` rule, which does not apply
  - a reusable `BrandedLayout`, and a committed `PROJ` mapping
- **Probes before building:**
  - `$ARGUMENTS`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_SKILL_DIR}` are
    substituted inside `!` commands.
  - Subagent messages carry their model.
  - A plugin skill's hook gets `${CLAUDE_PLUGIN_ROOT}` but not
    `CLAUDE_PLUGIN_DATA`.
  - Skill hooks do not fire inside subagents.

| Check | Evidence |
| :- | :- |
| Strict validation | `claude plugin validate . --strict` returned `✔ Validation passed`. The same directory-submission items as Phase 1 remain: licence, icon, and README install line |
| Plan store unit tests | Revisions are saved, a draft outside the drafts directory is rejected, and a wrong or short hash is refused. The correct hash is granted, and approving twice gives "already granted". After r2 is saved, reusing the r1 approval is refused. A file edited after approval fails `verify`, a BLOCKED plan is refused, and invalid keys or extra arguments are refused. `clean-attach` refuses paths outside its root |
| Guard unit tests | Every case behaved as expected, including Windows backslash paths, path traversal, writes into the plan store, shell forgery of approvals or revisions, git mutations, and fail-closed handling of a missing mode or malformed input |
| Mapping enforcement | Mismatch (`projectKeys: ["ABC"]`): stopped after one git command. No mapping: stopped as unverified. Jira was not contacted in either case |
| Order of work | Path-scoped rule files were read before the first Jira call. `CLAUDE.md` and the always-applying rule were already loaded into the session at startup |
| Rules respected and reported | The Planner flagged the `emails.md:7` / ADR-7 conflict as **blocking** and proposed wording for a rule change, without editing the rule. It reported `native.md` as not applicable. It reported gaps: ADR-7 missing from the repository, no email-client support policy, no snapshot policy, no ESLint config |
| Plan matches the ticket and the code | It reused `BrandedLayout`, noticed the unused `accountType` prop and the placeholder `logoUrl`, and flagged the contradiction that the ticket is "QA Verified" while the repository has no branded code |
| Models | `jira-dev-harness:analyzer` and `jira-dev-harness:planner` ran on `claude-sonnet-5-5` in every run, read from the model field of each subagent message |
| Read-only agents | The only tools called inside subagents were `Read`, `Grep`, and `Glob` |
| Revisions | r1 was BLOCKED, with no approval command offered. After the developer answered the blockers, r2 was READY. A developer change request produced r3 |
| Developer approval | `/jira-dev-harness:approve PROJ-1292 r2 83664a40f73a` was granted. The superseded r1 and a wrong hash were refused |
| Approval invalidated by change | After r3 was saved, `verify` returned INVALID (exit 1), `status` reported "Superseded approvals: r2", and re-approving r2 was refused |
| Forgery after a fix | In a resumed session, Claude tried to approve three ways: running `approve`, writing `approval-r2.json`, and invoking the approve skill. The always-on guard denied the first two, and Claude Code refused the third because of `disable-model-invocation` |
| No application changes | `git ls-files -s` was identical before and after all runs, and the working tree stayed clean |
| No Jira writes | 16 Atlassian tool calls across all Phase 3 transcripts, all of them reads. Zero write attempts |

- **Defects found and fixed during validation:**
  1. **Saving plans failed.** Claude Code refuses tool writes under
     `~/.claude` (the plugin data directory) as sensitive. Drafts now go
     through the temp directory, and the store script moves them into
     place.
  2. **Cleanup and session problems:**
     - Deleting temp attachment folders with `rm` outside the working
       directory was refused, so cleanup now goes through `clean-attach`.
     - **Approval forgery after `--resume`:** skill-scoped hooks are not
       restored in a resumed session. Claude could run the store's
       `approve` command and create `approval-r2.json`. That forged record
       was deleted.

       The fix moved approval protection into the always-on plugin hook,
       and the re-test confirmed every forgery path is blocked.
- **Known limitations and open items:**
  - **The planning guard does not survive `--resume`.** It covers
    repository writes and git changes, is skill-scoped, and lapses in a
    resumed session. So does the Phase 2 Jira write block. In a resumed
    session, normal Claude Code permission prompts apply. Approval
    integrity does not depend on these hooks.
    - *Resolved in the
      [security hardening checkpoint](#security-hardening-checkpoint-before-phase-4):*
      all protections moved to the always-on hook, driven by on-disk session
      state.
  - **Guards are pattern-based, not a sandbox.** Shell commands are
    matched by pattern, so a deliberately obfuscated command could slip
    past them. The approval record is not cryptographically bound to a
    human. Phase 6 hardens this.
  - **Attachment downloads depend on the model.** In one run, Claude
    chained two `curl` downloads into a single command. That didn't match
    the test's permission list, so the screenshots were not read, and the
    Planner correctly listed that as a blocker.
  - **Approving needs Node and a shell.** The approve skill runs its
    injected command with bash by default, so on Windows it needs Git Bash.
    The scripts need Node.js, which React projects already have.
  - **The always-on hook adds a small cost.** It starts a short Node
    process on every Write, Edit, and shell call while the plugin is
    enabled.
  - **Headless runs can end early.** A headless run can end its turn while
    a resumed Planner is still working, as happened once during the
    tests. The interactive flow is not affected.

---

## Security hardening checkpoint (before Phase 4)

**Status:** Completed (2026-10-30, plugin version 0.3.1). Phase 4 may begin
only under the conditions in [Phase 4 entry conditions](#phase-4-entry-conditions).

**Objective:** Make the pre-approval protections hold after a resume and
inside subagents. Make sure nothing Claude can produce counts as human
approval, and bind approvals to the repository, issue, latest revision, and
full hash. State plainly what hooks cannot guarantee.

**Findings that motivated it** (from Phase 3 testing):

- **Skill-frontmatter hooks are lost.** The Jira write block and the
  repository-write guard were skill-scoped. They disappeared on `--resume`
  and never fired inside subagents.
- **Approvals could be forged.** An approval could be created by Claude
  running the store script after a resume. Approvals were bound only to the
  revision and hash, unsigned, and accepted a 12-character hash prefix.

**Platform facts established by probes** (Claude Code 2.1.312, test
plugins in a temporary directory):

| Question | Result |
| :- | :- |
| Do plugin `hooks/hooks.json` hooks fire inside subagents? | Yes, with the parent's `session_id` plus `agent_id` and `agent_type` (for example `probe2:w`) |
| Does `--resume` keep the `session_id`? | Yes, and plugin hooks keep firing |
| Does `--fork-session` keep it? | No, it gets a new `session_id` |
| Is `CLAUDE_PLUGIN_DATA` exported to plugin hook processes? | Yes |
| Does the hook input include `permission_mode`? | Yes |
| Do commands injected into skills (`` !`…` ``) go through PreToolUse hooks? | No. The developer's `/jira-dev-harness:approve` worked while the always-on guard was active |

**Changes:**

- **One always-on guard.** `hooks/hooks.json` runs `scripts/guard.cjs`
  for Write, Edit, MultiEdit, NotebookEdit, Bash, PowerShell, Read, Grep,
  Glob, and all `mcp__*` tools. The skill-frontmatter hooks were removed.
  The guard's rules:
  1. **Plugin agents** (`agent_type` `jira-dev-harness:*`) can never write
     files, run shell commands, or call MCP write tools.
  2. **In every session**, Claude's tools cannot:
     - write into the plan store
     - read the approval key
     - reference the store, approval or revision files, or the key in a
       shell command
     - run the store's `approve` or `session-start` commands

     Only exact, chain-free calls to `draft-path`, `save`, `status`,
     `verify`, `attach-dir`, and `clean-attach` are allowed.
  3. **In workflow sessions:**
     - no Jira or other MCP write tools
     - no file writes except plan drafts
     - shell limited to a quote-aware, read-only allowlist: read-only git
       without `-c` or `--output`, the plan-store subcommands, cd, ls,
       cat, head, and tail, and single https `curl` downloads into the
       attachments directory

     Redirection, pipes, background `&`, `$` expansion, and backticks are
     refused.
- **Workflow state on disk.** `/jira-dev-harness:ticket` runs
  `plan-store.cjs session-start` through an injected command. It records
  `sessions/<session_id>.json` and prints a `JDH-WORKFLOW-SESSION:<id>`
  marker.
  - A resumed session keeps its id, so it keeps the state.
  - A forked session gets a new id. The guard finds the marker in its
    transcript once and inherits the parent's state; otherwise it caches a
    negative result.
  - Sessions that never ran the skill keep their normal behaviour.
- **Approval binding and signature.** `plan-store.cjs approve` (run only
  from the user-only approve skill) requires:
  - the **full** 64-character SHA-256 of the **latest** revision
  - an intact plan file, and `Readiness: READY`
  - a repository identity equal to the one recorded at save time: the root
    path, root commit(s), and origin URL
  - a still-committed, unmodified, matching mapping file
  - the approving session id

  The record is HMAC-SHA256 signed with `keys/approval.key`.
- **`verify`** re-checks the signature, ticket, latest revision, hash,
  file integrity, the current repository identity, and the mapping.
  Unsigned records from before this checkpoint are invalid.
- **The model's word is not accepted.** The skills tell Claude to report
  approval only when the approve command printed `APPROVAL: GRANTED`, and
  to tell the developer to read the plan file rather than Claude's
  summary. The authoritative state is always `status` or `verify`, never a
  chat message.

**Cleanup:**

- There was one disposable Phase 3 test approval. Its exact path was
  `…/plugins/data/jira-dev-harness-inline/plans/your-site.atlassian.net/PROJ-1292/approval-r2.json`.
  Its identity was confirmed before deletion: PROJ-1292, revision 2, SHA-256
  `83664a40…cd97`, approved at 10:41:14.965Z. It was the only approval
  record under `~/.claude/plugins/data`.
- This checkpoint's own test approvals were removed the same way after
  identity checks: `approval-r5.json`, and two deliberately forged
  `approval-r6.json` files.
- No plan revisions or other user data were deleted.

**Validation evidence:**

| Test | Result |
| :- | :- |
| Strict validation | `✔ Validation passed` (exit 0). The directory-submission items are unchanged: licence, icon, and README install line |
| Guard unit tests | 60 of 60 as expected. They covered store protection in ordinary sessions, normal behaviour in ordinary sessions (edits, commits, pipes, Jira writes allowed), the plugin-agent lock, every workflow-session rule (including `&`, `$( )`, backticks, `git -c`, `git diff --output`, `curl -d`, and traversal), fork inheritance, a negative result for an unknown marker, and fail-closed handling. One defect was found and fixed: the plan-store allowlist rejected plugin paths that contain spaces |
| Plan store unit tests | Throwaway repos A and B. Refused: short hash, a different repository, a missing session id, a stale revision, the wrong revision's hash, BLOCKED, and a re-initialised repository (new root commit). `verify` failed for a tampered approval field, a fabricated record with a zero HMAC, an uncommitted mapping edit, a plan edited after approval, another repository, and old unsigned records |
| Workflow regression | The full `/jira-dev-harness:ticket` run on `email-app-fixture` with PROJ-1292 succeeded with **zero guard denials**: ordering, attachments, Analyzer and Planner on `claude-sonnet-5-5` with only Read in subagents, and r4 saved as BLOCKED with the repository identity |
| Resumed and forked workflow sessions, real model and real plugin | Claude declined every write, git, and Jira request on its own (3 runs), citing planning mode. Because no tool call happened, the hook layer was then tested through a harness plugin |
| Hook layer, with the instruction layer removed | The harness plugin carried byte-identical `hooks.json`, `guard.cjs`, and `plan-store.cjs`, plus a skill that only runs `session-start`. In both the **resumed** and the **forked** session, all 6 attempts were denied by the guard: Write, `echo >`, `git commit`, `npm --version`, a **general-purpose subagent's** Write, and a Jira `addOrEditJiraIssueComment`. The fork's state recorded `inheritedFrom` the parent. The repository stayed at its initial commit |
| Plugin agent with a Write tool (ordinary session) | `jira-dev-harness:developer` Write was denied: "not permitted to modify anything; no approved implementation mode exists" |
| Direct script invocation by Claude | `plan-store.cjs approve` through Bash was denied in an ordinary session |
| Ordinary session scoping | Normal Write succeeded and `npm --version` ran. Writing an approval file and reading `approval.key` were denied |
| Developer approval (real plugin, `-p "/jira-dev-harness:approve …"`) | From a different repository: refused (identity mismatch). With a 12-character hash: refused. Full hash from the planned repository: **granted**. `verify` was valid there and invalid from the other repository |
| Stale approval | After r6 was saved, `verify` was INVALID, and re-approving r5 was refused |
| Fabricated approval without the key | A copied r5 record with edited fields failed `verify` (bad signature) |
| **Forgery with the key** | A process outside Claude's guarded tools read `approval.key` and signed an r6 record, and `verify` accepted it. **This is the documented limitation.** The record was then removed |
| Application repository | `email-app-fixture` was byte-identical (`git ls-files -s`) with a clean working tree after every run |
| Jira | No write reached Jira. In the workflow regression, all Atlassian calls were reads. Attempted writes went to the nonexistent key `ZZQX-999999` and were denied by the guard |

**Remaining security limitations:**

1. **Hooks cannot authenticate a human.** Approvals are tamper-evident
   intent records. They are bound to a repository, issue, revision, and
   hash, but anyone or anything that can read the HMAC key can forge one.
   That includes a shell command that evades the pattern-based guard. The
   key is a file readable by the operating system user; on Windows, the
   requested mode `0600` is not enforced.
2. **The guard is pattern-based, not a sandbox.** A disguised command, or a
   script started by an allowed command, could get past it. The allowlist
   permits `cat` and `git log`, which an untrusted repository's git config
   could abuse (for example external diff drivers). Disabling the plugin
   removes the guard.
3. **Some session paths aren't covered.**
   - Fork inheritance depends on the marker in the transcript (up to 64 MB).
   - `/clear`, or a brand-new session, starts unrestricted. That is
     intended, but plan context could be re-entered by hand.
4. **Approvals belong to the plugin data directory.** Re-installing under a
   different plugin id gives a new data directory, a new key, and no
   approvals. That fails safe.
5. **Usability costs.** Workflow sessions stay restricted until you start a
   new session. Every Read, Edit, shell, and MCP call starts a short Node
   process.

**Is Phase 4 safe to begin?** Yes, for attended, interactive
implementation under the
[entry conditions](#phase-4-entry-conditions). No, for any unattended or
auto-accepted writes: those need a trusted external approval mechanism,
which does not exist yet.

---

## Phase 4: Developer Agent

**Status:** Completed (2026-10-30, plugin version 0.4.0)

**Objective:** Implement an approved plan with the Sonnet Developer Agent,
only in the authorized repository and session, in attended mode, in any
technology stack. Produce a durable implementation report for the
independent reviewer.

### Phase 4 entry conditions

These are set by the security hardening checkpoint. Phase 4 must meet all
of them:

1. **Entering implementation mode.** A new **user-only** skill
   (`disable-model-invocation`) switches the session state from `planning`
   to `implementing`, through an injected command. That command runs
   `verify` for the current repository, and switches only if the result is
   VALID. The state file records the approved issue, revision, SHA-256,
   and repository identity.
2. **The guard is the only gate.** Its plugin-agent lock (rule 1) is
   relaxed only for `jira-dev-harness:developer`, and only when:
   - the session state is `implementing`
   - its approval still verifies, re-checked on every write so that a new
     revision revokes it at once
   - the write target is inside the approved repository, and outside
     `.git/` and the plan store

   Approval must never be inferred from conversation text.
3. **Attended mode only.** The guard denies developer writes unless the
   hook's `permission_mode` is `default`, so that Claude Code asks the
   developer before each edit. `acceptEdits`, `auto`, and
   `bypassPermissions` are refused. Claude Code's per-edit prompt is the
   human-presence check here, because the approval record is not proof of
   a human.
4. **Unattended writes stay disabled** until a trusted external approval
   mechanism exists. That means one the agent cannot satisfy on its own,
   such as a hardware-backed signature that needs physical presence, or an
   approval in a system acting under a separate identity.
5. **Still forbidden:** no commit, push, PR, or Jira write (Phase 6 and
   Phase 7).

All five conditions are met. See the implementation scope and evidence
below.

**Implementation scope:**

- **`/jira-dev-harness:implement <KEY> rN <sha256>`** (`skills/implement/`)
  is user-only (`disable-model-invocation`). Its injected
  `plan-store.cjs implement-start` re-verifies:
  - the repository identity and the committed mapping
  - the issue key and the latest READY revision
  - the full SHA-256 and the HMAC-signed approval

  It then switches the session to `implementing`, recording the approved
  ticket, revision, hash, plan path, repository identity, and a baseline:
  HEAD plus `git status` of pre-existing changes. Every refusal is
  reported as `IMPLEMENTATION: REFUSED`, and the session is not changed.
- **Developer Agent** (`agents/developer.md`): `model: sonnet`, tools Read,
  Grep, Glob, Write, Edit, Bash, and PowerShell. It:
  - reads the plan and the applicable instruction files
  - discovers the repository's own tooling from manifests, task runners,
    CI, and the plan
  - implements only the plan, preserving pre-existing changes
  - runs the project's declared checks
  - stops with **STOPPED** on plan errors, changed requirements, rule
    conflicts, or blocked required changes
  - reports every check as PASSED, FAILED, NOT RUN, or DENIED
- **Shared verification** (`scripts/lib/approval.cjs`): `plan-store.cjs`
  and `guard.cjs` use the same functions. The guard therefore re-verifies
  an authorization with exactly the checks that granted it, on every
  Developer write. A new plan revision revokes it immediately, with the
  message "the plan changed: rN replaced the authorized rM".
- **Guard Developer policy** (`scripts/guard.cjs`, rule 2): the Developer
  may write only when all of these hold:
  - the session is `implementing`
  - `permission_mode` is `default`
  - the authorization re-verifies
  - the target resolves (with `realpath`, following symlinks and
    junctions) inside the approved repository
  - the target is not a symlink itself, and not in `.git/`, the plan
    store, `.mcp.json`, the mapping file, or `.claude/` (other than
    approved rule files)
  - for instruction files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
    `SPECIFICATION.md`, `CONTRIBUTING.md`, `.claude/rules/*.md`), the
    approved plan has a line naming that file with
    `Apply in implementation: yes`

  Allowed writes return **`ask`**, which forces Claude Code's permission
  prompt even over allow rules. For the Developer's shell commands:
  - git state changes (including `add`, `stash`, `checkout`, `reset`,
    `push`) and hosting CLIs (`gh`, `glab`, `hub`) are denied
  - read-only commands follow the normal permission flow
  - every other command returns **`ask`**
- **Other agents:** the main conversation, other subagents, and the
  Analyzer, Planner, and Reviewer stay read-only in workflow sessions.
- **Implementation report:** `plan-store.cjs report-save` stores
  `impl-rN-k.md` immutably, next to the plan. It also stores a git-computed
  record:
  - the baseline and current HEAD
  - the pre-existing changes, and the changes since authorization
  - a SHA-256 of `git diff HEAD --binary`, and of each untracked file
  - the report's own SHA-256
- **Generalized from React-only:**
  - The ticket skill no longer detects only React or React Native, or stops
    for "unsupported" stacks. It identifies the stack from whatever
    manifests are present, and profiles declared build, lint, and test
    commands.
  - The Analyzer's scope and the Planner's testing section are
    stack-neutral.
  - The Planner's rule-update section uses the
    `- File: <path> | Apply in implementation: yes|no` format.
  - The manifest description and keywords no longer mention React.
  - The security behaviour validated in Phases 1–3 is unchanged.
- **Plan-store commands on Windows:** the ticket and implement skills now
  also pre-approve their plan-store commands for the PowerShell tool. On
  Windows, Claude sometimes chooses PowerShell, and the commands then hit
  an unexpected prompt.

**Acceptance criteria and validation:**

- A valid approval enables attended implementation.
- Invalid, stale, tampered, and cross-repository approvals are rejected.
- Writes before authorization, and writes by other agents, are blocked.
- Writes outside the approved repository are blocked, including through
  path traversal and symlinks.
- Resume and fork do not bypass protections.
- Interactive permission prompts are required for every edit and every
  project command, and attended mode is enforced.
- Project-specific build and test commands are discovered from the
  repository, across at least two stacks.
- Unknown or unsafe commands are not executed automatically.
- Test results and failures are reported accurately.
- No Jira writes, commits, pushes, or PRs happen.
- Strict plugin validation passes.

**Completion notes (recorded results, Claude Code 2.1.312, Node v24.14.0,
Windows; Python is not installed on the test machine):**

- **Probes before building:** these used the SDK permission protocol
  (`--input-format stream-json --permission-prompt-tool stdio`) with a
  small host that answers and logs every `can_use_tool` request.
  - A PreToolUse hook returning `ask` **forced a prompt even for a file
    with an explicit allow rule**.
  - Permission prompts from **subagents** reach the host.
  - This host, `driver.cjs` in the test scratch area, plays the developer
    in the attended tests. It allows only what a careful developer would.
- **Test fixtures.** All were disposable repositories created for the
  tests in a temporary directory. The plans are **synthetic**, written in
  the Planner's format for the fake keys `PYT-1` and `NODE-1` on
  `example.atlassian.net`, and never sent to Jira.
  - **Python (`py-fixture`):**
    - `pyproject.toml`, `src/calc/`, and unittest tests
    - a `Makefile` with `test` and a publishing `release` target
    - a README that declares the test command
    - a path-scoped `.claude/rules/python.md`
    - a pre-existing untracked `NOTES.local.txt`
    - the plan approves one rule update (`yes`) and declines a
      `CLAUDE.md` change (`no`)
  - **Node.js (`node-fixture`):**
    - `package.json` with a `test` script and a production `deploy` script
    - a known failing `test/legacy.test.js` (LEGACY-9)
    - a pre-existing uncommitted `README.md` edit

| Test | Result |
| :- | :- |
| Strict validation | `✔ Validation passed` (exit 0). The directory-submission items are unchanged: licence, icon, and README install line |
| Phase 4 unit tests (`phase4-tests.cjs`, real git repos) | **74 of 74**, plus 1 skipped. `implement-start` refused: no approval, short hash, wrong hash, cross-repository, wrong revision, modified mapping, tampered approval, BLOCKED latest. It authorized a valid request and recorded the baseline. The guard covered every Developer boundary in the list below. The skipped case is a Windows *file* symlink, which needs Developer Mode; a directory junction escape was tested and denied |
| Earlier guard suite (`guard-tests.cjs`) | 60 of 60, no regressions |
| Live: implement before approval, and cross-repository, wrong-hash, and short-hash implement | All `IMPLEMENTATION: REFUSED`. Repositories unchanged |
| Live: writes before authorization | In an ordinary session, `jira-dev-harness:developer` Write was denied: "may modify files only after the developer runs /jira-dev-harness:implement". No file was created |
| Live: `acceptEdits` mode (Node) | Implementation was authorized, but both Developer edits were denied ("requires attended mode"). The Developer reported STOPPED. The fixture was unchanged and no deploy ran |
| Live: attended Python implementation (driver as developer) | 8 permission prompts: **5 edits, 2 test-command attempts, and 1 report draft**. All four planned files changed, and nothing else. `.claude/rules/python.md` was changed as approved (`yes`), and `CLAUDE.md` was untouched (`no`). `NOTES.local.txt` was preserved. The Developer discovered `python -m unittest discover -s tests -v` from the README and Makefile. It **accurately reported the tests as not run** ("Python was not found", exit 49) rather than claiming success. It did not run `make release`. The report `impl-r1-1` was saved, and its git record matches |
| Live: attended Node implementation | 5 prompts: 2 edits, 2 test commands, and 1 report draft. The Developer reported that the declared `npm test` (`node --test test/`) **fails to start on Node 24 with `MODULE_NOT_FOUND`**. That is a genuine fixture defect, and it was reproduced independently. It then ran the test files directly: **4 passed and 1 failed**, the failure being the known LEGACY-9, which was reproduced independently and left unchanged. `npm run deploy` was never run (no `DEPLOYED.marker`). The README edit was preserved. The `impl-r1-1` record was saved |
| Live: resumed implementing session after a plan change | After NODE-1 r2 was saved, the session was resumed with a driver that approves **everything**. The Developer's Edit was denied ("implementation is no longer authorized"), and so was the main conversation's direct Edit ("only the authorized Developer Agent may change the repository"). There were 0 prompts and no changes |
| Forks | The unit tests show that a fork inherits the latest state, with the same per-write checks. A fork is denied outside the repository and revoked by a new revision. The fork mechanism itself was validated live in the security checkpoint |
| Audit of all Phase 4 transcripts | 0 Atlassian calls. 22 shell commands, with no git mutation, `gh`, install, deploy, or publish. Both fixtures still have one commit and an unchanged HEAD |

- **Defects found and fixed during validation:**
  1. **Plan-store commands run through PowerShell were prompted.** The
     coordinator ran a plan-store command through PowerShell, which the
     skills pre-approved only for Bash. The skills now pre-approve the
     PowerShell variants too, and tell Claude to prefer Bash.
  2. **Status lines lost their leading space.** `git status --porcelain`
     lines were trimmed, dropping the significant leading space of the
     first line. That could misclassify pre-existing changes. A new
     `gitStatus()` keeps them intact, and a regression assertion was
     added.
  3. **The revocation message was unclear.** After a plan change it said
     "no approval record". It now names the replacing revision.
- **The first attended Python run was discarded** because my test driver's
  policy was too narrow: it didn't allow PowerShell-style test commands.
  The fixture was reset to its committed baseline, keeping the user's
  untracked file, and the run repeated.
- **Known limitations and open items:**
  1. **Approved shell commands are not sandboxed.** A project command the
     developer approves runs with the user's full rights and can write
     outside the repository. The guard's write boundary covers Claude's
     file tools only. Untrusted repositories can also execute code through
     git configuration, for example diff drivers.
  2. **Some boundaries are untested or unchecked.**
     - Windows *file* symlinks were not tested live, because that needs
       Developer Mode. The guard refuses any symlink target via `lstat`,
       and directory junctions are covered.
     - Hard links cannot be detected.
  3. **Testing was not full end to end.**
     - The live implementation runs used synthetic plans, not
       Planner-generated ones for real tickets. Real-ticket planning was
       validated in Phase 3.
     - No stack was tested where the declared test command fully works:
       Python was missing, and `npm test` was broken in the fixture.
       Passing checks were shown with the directly run Node test files.
  4. **Instruction-file rules have gaps.**
     - The approved-rule check is a line match in the plan's rule section.
       A plan saying "yes" for a file is honoured as the developer's
       approval.
     - Nested instruction files such as `docs/AGENTS.md` are protected,
       but other documentation conventions are not.
  5. **Writes cost more.** Every Developer write runs several git commands
     to re-verify.
  6. **The approval is still not proof of identity.** Per-edit prompts are
     the human-presence check (see the security model).

**Is Phase 5 safe to begin?** Yes. Implementation reports and their
git-computed records are in place, and every Developer write is gated.
Phase 5 must keep the Reviewer read-only, which the guard already
enforces. It must also review the actual diff, not the report's claims:
the stored `trackedDiffSha256` and untracked hashes let it confirm that the
working tree is the one that was reported.

---

## Phase 5: Independent Reviewer Agent

**Status:** Completed (2026-10-30, plugin version 0.5.0)

**Objective:** A fresh-context, read-only Opus Reviewer independently
validates the completed implementation. It checks the approved plan, the
Jira requirements, the actual repository changes, the project rules, and
recorded test evidence. It produces a developer-readable test artifact.

**Implementation scope:**

- **`/jira-dev-harness:review <KEY>`** (`skills/review/`) is user-only.
  Its injected `plan-store.cjs review-start`:
  - verifies that the latest revision is approved, for this repository,
    with a valid mapping, and has an implementation report
  - computes **`facts.json` from git**, never from an agent:
    - changed files, excluding pre-existing changes
    - files outside the plan's "Files likely to change"
    - instruction-file changes, and whether the plan approved each one
    - integrity: HEAD, the tracked-diff SHA-256, and untracked-file hashes,
      compared with the implementation report's record and the report
      file's own hash
  - writes `diff.patch`, with credentials redacted
  - switches the session to **`reviewing`** mode. In that mode nobody,
    including the Developer, may change the repository.
- **Recorded check evidence** (`plan-store.cjs run-check`):
  - It runs one project command in the repository root and stores immutable
    `checks/C<n>.json` and `.log` files. They record the exit code,
    duration, timeout, a "tool unavailable" flag (exit 127 or 9009, or
    "not found"), whether the command changed the working tree, and the log
    with credentials redacted and truncated at 200 KB.
  - The guard accepts only the exact single-quoted form, always returns
    `ask` (and denies it in non-default permission modes), and refuses it
    from plugin agents. The script refuses outside a reviewing session.
  - The coordinator may choose only commands the plan or the project
    declares.
- **Reviewer Agent** (`agents/reviewer.md`): `model: opus`, tools Read,
  Grep, and Glob.
  - **Fresh context:** its task message contains **only paths**: the
    bundle, the plan, the implementation report labelled "claims to
    verify", the repository, and the instruction files. It also gets the
    Jira data, or a note that Jira is unavailable.
  - It verifies acceptance criteria, scope, rules, correctness, security,
    compatibility, regressions, integrity, and checks.
  - It cites evidence as `file:`, `diff:`, `check:`, `plan:`, or `jira:`.
  - It returns strict JSON: verdict, findings with severity, criteria
    coverage, check assessments, traceable test cases, and changed files.
- **Mechanical review rules** (`scripts/lib/review.cjs`, applied by
  `review-save`):
  - **Test results come only from recorded checks.** An automated
    `Passed`/`Failed` must cite a recorded check, and `Passed` needs exit 0.
    Otherwise it is corrected to `Not Run`, `Failed`, or `Blocked`.
  - **Manual cases always stay `Not Run`.**
  - **`Verified` needs evidence.** A criterion without evidence, or citing a
    check that did not pass, becomes `Not verified`.
  - **Every check is accounted for.** Unassessed or mis-assessed checks are
    corrected from the exit code.
  - **The system adds its own findings:** integrity mismatch (blocker),
    unapproved instruction-file change (blocker), a check that changed the
    tree, and a tree that changed during the review.
  - **Verdict:**
    - A Reviewer **PASS** stays PASS only with no fail or block conditions.
    - A Reviewer **BLOCKED** becomes FAIL only on system-detected defects or
      Failed criteria.
    - A Reviewer **FAIL** stays FAIL.
    - **Block conditions** are: a required check that is unavailable,
      pre-existing failing, or not relevant; no required check recorded; a
      criterion that is not verified or has no test case; and an unreliable
      tree.
    - **Fail conditions** are: a required check that failed because of the
      change; a Failed criterion; a system blocker; and the Reviewer's open
      blocker or major findings, when the Reviewer said PASS.
  - Every correction and condition is stored and shown.
- **Artifacts:** stored outside the repository, immutable (exclusive
  create), in `plans/<site>/<KEY>/reviews/`:
  - `review-rv-<n>.json`: the source record, with identity, facts, checks,
    enforced verdict, and corrections
  - `review-rv-<n>.html`: the standalone report
  - `review-rv-<n>.md`: the summary
- **Review validity:** `plan-store.cjs review-status <KEY>` reports
  **CURRENT** or **STALE**. A review becomes stale on any change to the
  tree (HEAD, tracked-diff hash, or untracked hashes), a new plan revision,
  a new implementation report, or a different repository.
- **Guard additions:**
  - `review-start` is reserved for the user-only skill.
  - `review-save` and `review-status` are allowed.
  - The review draft (`review.json`) is a permitted draft.
  - Shell commands touching `review-rv-*` or `facts.json` are denied.

**HTML report format:**

- **One self-contained file:**
  - no external requests (`default-src 'none'`, `img-src 'none'`)
  - `<meta name="referrer" content="no-referrer">`
  - light and dark styles
- **Sections:**
  - ticket and repository identity: plan revision and SHA-256,
    implementation report, root commit, origin, HEAD, tracked-diff SHA-256,
    untracked hashes, and whether the tree matches the report
  - verdict, and why: fail and block conditions, open blocker or major
    findings, and corrections
  - acceptance-criteria coverage, with evidence and linked test cases
  - a test-case table with **status filters** (Passed, Failed, Blocked,
    Not Run, with counts)
  - executed checks, with expandable redacted logs
  - unresolved findings by severity
  - changed files, in plan or outside plan, with the Reviewer's assessment
  - notes
- **Safe rendering.** Every value is redacted for credentials, then
  HTML-escaped, and rows are rendered on the server. The only script is the
  filter, allowed by a CSP `sha256` hash, and it uses no `innerHTML`.
- **Opening it.** It can be opened from the path that `review-save`
  prints: `start "" <file>` on Windows, `open` on macOS, and `xdg-open` on
  Linux. Opening it performs no git or Jira action. Developer approval of
  the artifact is a future step.

**Acceptance criteria and validation:**

- The Reviewer runs on Opus, in a fresh context, with no Developer
  conclusions in its input.
- PASS, FAIL, and BLOCKED are decided correctly.
- Missing criteria, unrelated or unauthorized changes, and overclaiming
  reports are detected.
- Failed, skipped, and unavailable tests stay visible.
- Test cases trace to the criteria.
- The HTML renders, filters, and escapes malicious content.
- A code change after review invalidates the review.
- The Reviewer and others cannot write.
- Resume and fork protections hold.
- Strict validation passes.
- Fixtures include a fully passing suite and a known failure.

**Completion notes (recorded results, Claude Code 2.1.312, Node v24.14.0,
Windows; Python not installed):**

- **Test fixtures.** These are disposable repositories in a temporary
  directory. Their **plans are synthetic** (fake keys on
  `example.atlassian.net`), so every live review recorded "Jira
  unavailable: the connected account cannot access example.atlassian.net"
  and used the approved plan's criteria. **No review used a real Jira
  ticket.**
  - **`rv-pass` (`PASS-1`):** a Node library with a fully passing
    `npm test` (`node --test`). It was implemented by the **real Developer
    Agent** through the permission driver: 2 edit prompts, `npm test`
    passed, and a report was saved.
  - **`rv-fail` (`FAIL-1`):** the same base, plus a **known failing**
    `test/legacy.test.js` (LEGACY-2) and a pre-existing README edit. The
    implementation was **simulated by the tester** through the real
    `implement-start` and `report-save` path, to plant defects:
    - AC3 (`RangeError` when min > max) omitted
    - an unrelated `src/telemetry.js` added, which posts to an external
      host
    - a report that overclaims: "covering AC1, AC2 and AC3", "npm test:
      PASSED"
  - **`py-fixture` (`PYT-1`):** the Phase 4 output of the real Developer.
    Python is unavailable.

| Test | Result |
| :- | :- |
| Strict validation | `✔ Validation passed` (exit 0). The directory-submission items are unchanged: licence, icon, and README install line |
| Phase 5 unit tests (`phase5-tests.cjs`, real git and scripts) | **68 of 68**. They cover: review refused before a report and outside the repository; facts excluding pre-existing changes; `run-check` exit 0, failing, unavailable, tree-changing, credential redaction, and refusal outside reviewing; every enforcement rule (manual and fabricated passes corrected, `Verified` without evidence, mis-assessed checks); PASS kept; integrity mismatch → FAIL; Reviewer BLOCKED kept for an environment problem but → FAIL on a system defect; unapproved `CLAUDE.md` → blocker; untraced criterion → blocked; immutable outputs; stale after a code change; 21 guard cases for the review rules, including reviewer and developer writes in reviewing mode and in a fork |
| HTML safety (unit) | Payloads included `<script>alert()</script>`, `<img src=x onerror=…>`, `</script><script>…` breakout, and a `token=` secret, in criteria, summaries, notes, and logs. All were rendered escaped, with no injected element. There is exactly one `<script>`, and the CSP hash matches it. The token was redacted in both the log and the HTML |
| HTML filtering (unit, DOM shim running the embedded script) | Only checked statuses are shown, and the "n of m shown" counter is correct |
| Phase 4 suite and guard suite | 74 of 74 and 60 of 60, no regressions |
| **Live: Opus model** | `jira-dev-harness:reviewer` ran as `claude-opus-5-5` in all 4 live reviews (from the subagent message model field) |
| **Live: fresh-context independence** (FAIL-1) | The Reviewer's whole task message was 977 characters of paths plus the Jira note. It contained none of the report's claims ("PASSED", "all tests green", "covering AC1, AC2 and AC3", "telemetry", "clamp"). The Reviewer made 15 read-only calls on its own: plan, report, `facts.json`, `diff.patch`, both check logs, and the source and test files, plus a grep for `telemetry` usages |
| **Live PASS** (PASS-1) | Reviewer PASS, enforced **PASS**, 0 corrections. AC1–AC3 Verified. 4 automated test cases Passed from C1 (`npm test`, exit 0), and 2 manual cases Not Run |
| **Live FAIL** (FAIL-1) | Reviewer FAIL, enforced **FAIL**. It found: a **blocker**, the unrequested `telemetry.js` outside the plan; a **major**, AC3 not implemented; a major, no AC3 test; a major, **the report claims `npm test` PASSED but recorded C1 exited 1**; and an info that the README change was pre-existing. C1 `npm test` (required) failed only on the known LEGACY-2 and was assessed `pre-existing-failure`. C2 `node --test test/math.test.js` passed (3 of 3) |
| **Live BLOCKED** (PYT-1 rv-2) | Reviewer BLOCKED, enforced **BLOCKED**. C1 `python -m unittest …` exited 9009 and was flagged unavailable, so automated cases were Blocked and manual ones Not Run. AC1–AC3 Verified by reading the code, and AC4 Not verified |
| Live: review invalidation (PASS-1) | `review-status` gave CURRENT, then **STALE** after a one-line code edit (diff hash mismatch), then CURRENT again when the exact content was restored |
| Live: resumed and forked reviewing sessions | With a driver that approves everything, these were all **denied by the guard**, with 0 prompts: the main conversation's Edit, the `jira-dev-harness:developer` Edit, a general-purpose subagent's Write, and a Jira comment. The repository was unchanged and the review stayed CURRENT |
| Audit of all Phase 5 transcripts | Atlassian: reads only (2 attempted writes, both mine, both denied). `run-check` ran only declared commands: `npm test`, `node --test test/math.test.js`, and `python -m unittest discover -s tests -v`. No git mutation, `gh`, install, deploy, or release. All fixtures still have 1 commit |

- **Defects found and fixed during validation:**
  1. **A tree-changing check counted as a code defect.** A check that
     changed the working tree was a *major* finding, so it caused FAIL.
     It is evidence unreliability, not a code defect, so it now blocks.
  2. **Verdict override.** The first PYT-1 review (`rv-1`) went from the
     Reviewer's correct **BLOCKED** to FAIL, because its own major "Python
     missing" finding triggered the fail rule. The Reviewer's own findings
     now never turn BLOCKED into FAIL; only system-detected defects and
     Failed criteria do. Open Reviewer findings are listed separately.
     `rv-1` is kept as an immutable record, and `rv-2` is the corrected
     review.
- **Known limitations and open items:**
  1. **No real Jira ticket was reviewed.** Real-ticket planning was
     validated in Phase 3, but end-to-end real-ticket coverage, from plan
     through review, has not been tested.
  2. **Pre-existing failures still prevent a clean PASS.** The baseline
     isn't re-run, because that would need a git checkout.
  3. **Checks are not sandboxed.** `run-check` runs approved project
     commands with the user's rights. Commands run in `cmd.exe` on Windows
     and `/bin/sh` elsewhere, which may differ from the developer's shell.
  4. **The Reviewer's JSON is copied by the coordinator.** That copy is
     the same model, not a deterministic channel. Enforcement limits what
     an altered copy could claim, but it can't prove the copy is
     verbatim.
  5. **Redaction is pattern-based.** Unusual secret formats in logs may
     survive.
  6. **The HTML was not viewed in a real browser here.** The structure,
     escaping, CSP, and filter logic were tested in Node. Viewing it is a
     manual step.

**Is Phase 6 safe to begin?** Yes, for designing the approval and Git
gates. These are in place: a CURRENT, PASS review that `review-status` can
verify; review records bound to the plan revision, implementation report,
and tree identity; and FAIL or BLOCKED, which never authorize anything.
Phase 6 must add developer approval of the review artifact as a separate
step, and must keep all the [future product requirements](#future-product-requirements).

---

## Phase 6: Approval Gates + Git/PR

**Status:** Completed

**Objective:** Harden and validate every approval and Git control, then
commit, push, and open a pull request.

**Implementation scope:**

- Re-check every gate: plan approval, a passing review, and final developer
  approval.
  - The review gate means `review-status` is CURRENT, and the stored review
    verdict is **PASS**. FAIL and BLOCKED never authorize a PR.
  - Final developer approval of the review artifact is a **separate**,
    user-only step, bound to the review id and tree identity, like the plan
    approval.
  - Viewing or approving the artifact must never trigger git actions by
    itself.
- Use Git for commit and push on a ticket branch, never the default branch.
- Use the Git hosting provider's tools to create the pull request. The
  pull request description links the Jira ticket.
- Never merge automatically.

Built (version 0.6.0):

- `/jira-dev-harness:approve-review <KEY> <review-id> <full-sha256>`
  (user-only). Reviews are now HMAC-signed when saved, and bind their HTML
  report, markdown summary, bundle files, and implementation-report hash.
  The approval record binds repository, ticket, plan revision and hash,
  implementation report, review id and hash, HTML hash, git tree identity,
  and the SHA-256 of every changed file.
- `/jira-dev-harness:ship <KEY> <review-id> <full-sha256> [--branch <name>]`
  (user-only). It re-verifies the chain and opens a "shipping" workflow
  session. `ship-commit`, `ship-push`, and `ship-pr` are then run by
  Claude, each behind a guard-enforced permission prompt (attended mode
  only), and each re-verifies every gate in the script.
- `scripts/lib/provider.cjs`: a provider adapter boundary. GitHub MCP is
  the preferred route (tools are discovered at run time, a create-pull-
  request call is checked against the prepared values, and merge tools are
  denied). The official `gh` is an optional adapter and impostors are
  rejected. No credentials are read, stored, or logged.
- Guard: ship steps, MCP create-pull-request verification, merge denial,
  and protection of the approval records.
- Tests: `tests/phase6.test.cjs` (`node --test`).

Decisions made while building:

- The request for this phase was cut off after `/jira-dev-harness:ship`.
  The command's contract was taken from this section and the requirements
  above.
- The later, approved requirements add `/jira-dev-harness:merge`, a
  separately authorized merge. It supersedes this section's earlier
  criterion "No merge path exists anywhere in the plugin": the criterion is
  now "No merge happens without the separate `merge` command and a passing
  provider-evidence gate, and nothing merges automatically". Merge is built
  (`scripts/lib/merge.cjs`, `merge-gate.cjs`, `scripts/evidence.cjs`).
- Reviews saved before 0.6.0 are unsigned and cannot be approved; they must
  be re-run.
- Repository identity no longer stores credentials embedded in an https
  `origin` URL, and shipping refuses such a remote.

**Acceptance criteria and validation:**

- Commit, push, and PR creation are blocked when any gate is missing.
- Pushes to protected or default branches are refused.
- No merge happens without the separate `merge` command and a passing
  provider-evidence gate; auto-merge and bypasses are denied.
- Each gate is tested with approve, reject, and no-answer cases.

**Completion notes (recorded results, Claude Code 2.1.316, Node 24.14, git 2.53, Windows 11):**

- **Automated tests (2026-11-02, re-run at the verification checkpoint)**:
  `node --test` ran 70 tests, 70 passed (20 in `tests/phase6.test.cjs`,
  50 in `tests/merge.test.cjs`). The earlier suites are standalone scripts
  in `tests/legacy/` and are run one by one:
  `node tests/legacy/guard-tests.cjs` (60 of 60),
  `node tests/legacy/phase4-tests.cjs` (74 of 74, 1 skipped: a Windows
  file symlink needs Developer Mode), and
  `node tests/legacy/phase5-tests.cjs` (68 of 68). All exited 0 against the
  Phase 6 code, so Phases 1 to 5 have no regressions in those suites.
- **Correction.** The first Phase 6 notes said no earlier suites existed.
  That was wrong: they existed, but only as scratch files of an earlier
  working session (never committed, with the old `jira-dev-harness/` path
  hardcoded), and the first Phase 6 pass looked only inside the repository.
  They were recovered unchanged apart from making their repository path
  relative, and are now tracked in `tests/legacy/`. They write to a
  `jira-dev-harness-unittest` directory under the plugin data root, not to
  the real store.
- Everything uses disposable repositories, a local bare `origin` reached
  through `url.insteadOf`, and mocked providers. No network, token, or
  GitHub account was involved, and nothing was committed, pushed, opened,
  or merged outside those temporary repositories.
- Approval and ship tests cover approve, reject, and no-answer cases:
  approve-review (hash, id, FAIL, stale, edited review/report/log, other
  repository); ship-start (no approval, protected and default branches,
  bad names, wrong hash, credentials in `origin`); the ordered
  commit, push, and prepared-PR steps (including unrelated or changed
  files, message checks, and HEAD moving); and the guard's ask/deny
  results.
- Merge tests cover:
  - the pure gate: a passing case, 26 blocking cases (head SHA moved,
    failing, pending, missing, wrong-commit, or truncated checks, no
    protection, no required checks, review counts, stale and self
    approvals, requested changes, unrelated or missing files, draft,
    non-clean mergeable states, merged or closed, wrong number, branch,
    repository, or fork, extra commits, missing permission), every missing
    evidence kind, stale and pre-authorization evidence, evidence about
    another pull request or owner, and prose that merely claims success
  - authorization: no ship record, wrong or short SHA, no or invalid
    method, tampered ship record or review approval
  - the MCP route through the real `evidence.cjs` hook: recorded only in
    merge sessions and only for reads; PASS and BLOCKED outcomes;
    `merge-record` accepts only a recorded provider response that says
    merged; the guard's ask/deny for the merge call (wrong number, SHA,
    method, owner, repository, auto-merge or admin flags, no head-SHA
    field, unattended modes, subagents, shipping and reviewing sessions,
    auto-merge and other merge tools)
  - the `gh` route in-process with a mock adapter: the merge is made with
    the head SHA and method pinned and confirmed from the provider; nothing
    is merged on a failing gate, a moved head, missing protection, a
    non-official `gh`, or a lost approval; an unconfirmed merge is
    reported as unconfirmed
  - mutation check: weakening the gate (mergeable state, review count)
    made 8 of these tests fail, then the gate was restored.
- `claude plugin validate . --strict` returned `Validation passed`. It
  still reports the existing missing-icon warning, the README marketplace
  advice, and the missing LICENSE that only matters for directory
  submission.
- The `gh` on the test machine is an npm shim (`gh.cmd`, `gh 2.8.9`).
  The adapter rejected it as a script/shim.
- **Verified live at the checkpoint** (Claude Code 2.1.316, a local mock
  MCP server named `github`, a throwaway session, no network):
  - `/jira-dev-harness:approve-review`, `:ship`, and `:merge` are
    registered, user-only, and run their injected plan-store command. This
    found and fixed a defect the mocked tests could not see: the three
    skills lacked their injected command in `allowed-tools`, so Claude Code
    blocked it ("This command requires approval") and a headless run did
    nothing. Each now returns the plan store's real verdict
    (`... REFUSED. no saved plan found`) in an empty directory.
  - The real `PostToolUse` payload for an MCP tool was captured. Its
    `tool_response` is a bare array of content blocks
    (`[{"type":"text","text":"..."}]`), not `{content:[...]}`. The first
    parser stored the wrapper instead of the pull request, so every real MCP
    merge would have been blocked. It is fixed, and a live re-run recorded
    the pull request (kind `pr`, number 3, head SHA) through the real
    `evidence.cjs`. Other payload fields seen: `tool_use_id`,
    `duration_ms`, `permission_mode`, `mcp_server.name`.
- **Hardening found by the checkpoint audit:**
  - guard now requires the plan-store `<dataDir>` argument to be this
    plugin's own data directory, so a store forged elsewhere can't be used
    for ship or merge steps
  - merge evidence must come from the same MCP server that performs the
    merge call
- **Only mocked, never run for real:**
  - A real GitHub MCP server's tools, response shapes, and its create and
    merge calls. The gate expects GitHub's REST shapes.
  - `gh pr create`, `gh api`, and `gh pr merge` against GitHub. Only the
    official-`gh` rejection logic ran for real.
  - The interactive permission prompts: the guard's `ask` and `deny`
    results were checked, but no slash command was typed in a live
    interactive session. Whether a PostToolUse hook fires for every MCP
    tool error or timeout is untested.
- **Phase 8 integration tests still needed** (against a real test
  repository and a real GitHub account, never the mocks):
  - a real GitHub MCP server: the real shapes of pull request, files,
    reviews, check runs, branch protection and rulesets, and repository
    responses, and whether its merge tool exposes a head-SHA field
  - `gh pr create`, `gh api`, and `gh pr merge --match-head-commit`
  - the full approve-review, ship, and merge sequence typed in an
    interactive session, observing every permission prompt
  - branch protection that the account can't read, a ruleset-only
    repository, and GitHub Enterprise hosts
  - PostToolUse behavior on MCP errors and timeouts
- **Limitations:** the MCP merge path needs a merge tool with a head-SHA
  field; if the official server's tool lacks one, the `gh` route (which pins
  `--match-head-commit`) or a manual merge is the only way. Branch
  protection that the account can't read is treated as unverifiable. A
  repository whose `.mcp.json` defines a rogue server named like GitHub
  could feed forged evidence for that server's own merge tool; the human
  permission prompt and the provider's own server-side protections remain
  the last line. The guard recognises GitHub MCP tools by server and tool
  name patterns, so a tool with an unusual name is simply unrecognized and
  blocked, not discovered.

---

## Phase 7: Jira Progress Automation

**Status:** Completed

**Objective:** Keep the ticket's progress up to date in Jira as the work
moves forward.

**Implementation scope:**

- Discover the transitions the board's workflow allows. Status names are
  never hardcoded.
- Move the ticket only through transitions that are allowed.
- Add progress comments, such as the plan approved, the review result, and
  the pull request link.
- If a transition is not allowed or fails, report it and continue safely.

Built (version 0.7.0):

- **Per-repository mapping** (`scripts/lib/jira-mapping.cjs`). The committed
  `.claude/jira-dev-harness.json` gains an optional `jira.board`
  (`id`, `name`, `verification`: `required` or `workflow-only`) and
  `jira.progress` (`comments`, and per-stage `toStatuses`, `allowDone`).
  It is strictly validated (unknown keys, bad ids, unknown stages, `allowDone`
  outside `merged` are errors). Old mappings keep working for Phases 1 to 6;
  they just can't sync, because the board is never inferred.
  `plan-store.cjs mapping-check` prints the result.
- **`/jira-dev-harness:jira-sync <KEY> [--allow-done]`** (user-only skill).
  `jira-start` verifies the repository, the committed and unmodified mapping,
  the ticket, and the audit ledger, and derives the stage from signed
  records (`progress.cjs`): `planning`, `awaiting-plan-approval`,
  `implementing`, `in-review`, `awaiting-review-approval`, `pr-created`,
  `merged`. These are internal stages, not Jira statuses. A signed merge
  record (`merge-rv-N.json`) is now written when a merge is confirmed.
- **Evidence, not summaries.** The PostToolUse and PostToolUseFailure hook
  (`evidence.cjs`) records the connection's real Atlassian read responses in
  a `jira-syncing` session. `jira-gate.cjs` plans from them only:
  accessible-site reachability and `cloudId`, ticket identity and mapped
  project, current status, board identity, ticket membership of the board,
  the board's projects (multi-project boards) and columns, and the
  transitions Jira reports for the ticket. Missing, stale (over 10 minutes),
  pre-authorization, or other-ticket/board evidence blocks.
- **Mapping to real transitions.** Mapped status *names* are matched against
  the `to.name` of Jira's own transitions. A transition id comes only from
  Jira's response. Ambiguous matches, screens, a target not on the board, an
  already-reached status, or a Done status leave the status preserved, with
  the reason reported.
- **Guarded writes** (`guard.cjs`). In a sync session only the one planned
  transition and one planned comment are allowed, recomputed from fresh
  evidence at the call: `cloudId`, ticket, transition id, and exact comment
  text must match, extra parameters are refused, a repeat is refused, and
  each write is a prompt in attended mode only. The `execute*` meta-tools are
  unwrapped; unknown writes fail closed. Other workflow modes keep the Jira
  write ban.
- **Audit ledger** (`progress/<site>/<KEY>/ledger.jsonl`): signed,
  hash-chained entries for authorized, planned, requested, blocked,
  executed, failed, confirmed, and unconfirmed. Hooks write the execution
  entries, not the agent. A broken ledger blocks writes. `jira-confirm`
  checks a fresh read and never assumes a returned tool call changed Jira.
- **No automatic Done.** Done needs the `merged` stage, `allowDone` in the
  mapping, and `--allow-done`.

**Acceptance criteria and validation:**

- Transitions match the board's workflow on at least two different board
  configurations.
- A transition that is not allowed is never forced.
- If a Jira write fails, no code or Git state is lost.

**Completion notes (recorded results, Claude Code 2.1.316, Node 24.14, git 2.53, Windows 11, 2026-11-02):**

- **Automated tests:** `node --test` ran 112 tests, 112 passed (20 in
  `phase6.test.cjs`, 50 in `merge.test.cjs`, 42 in the new `jira.test.cjs`).
  The recovered legacy suites, run one by one, still pass: guard 60 of 60,
  Phase 4 74 of 74 (1 skipped), Phase 5 68 of 68. `claude plugin validate .
  --strict` returned `Validation passed` (with the existing licence and icon
  items).
- **Phase 7 tests cover:** the mapping (old and new forms, 13 invalid
  shapes); tool classification, including `execute*` meta-tools; the plan
  (a passing case, 11 blocking cases, 9 skip cases); several projects and
  boards (a board spanning two projects, another board's evidence ignored,
  another ticket's evidence ignored); Done protection for every stage; a
  stale status, stale evidence, and a missing-permission case where Jira
  offers no transition; write checks for site, ticket, transition id, extra
  fields, comment text, and repeats; all seven stages from signed records
  (and a forged merge record ignored); the real hook and guard end to end
  (executed, failed, unconfirmed, confirmed, with token redaction in the
  ledger); duplicate suppression from Jira and from the ledger; resumed and
  forked sessions; forged stores, environment prefixes, and writes to the
  ledger, evidence, or session file; a tampered or truncated ledger; and the
  absence of any mock, environment, network, or hardcoded-site route.
- **Defects found and fixed by those tests:** the ledger signed unset fields
  as the text "undefined" (every entry with an unset field failed
  verification); the duplicate-comment check matched a confirmed
  *transition* entry; and an "unconfirmed" result could not be retried after
  a fresh read.
- **Mutation check:** disabling the board-membership check, the Done guard,
  and the extra-parameter check made 4 tests fail. Disabling the guard's
  explicit unknown-write denial changed nothing, because the plan check
  independently refuses the same call (defence in depth, not a gap).
- **Live (real Claude Code, local mock server named `atlassian`, no real
  Jira):**
  - `/jira-dev-harness:jira-sync` is registered, user-only, and its injected
    command runs through the real harness (it refused in an empty directory:
    "no saved plan found").
  - Seven Atlassian reads went through the real PostToolUse hook and were
    recorded and classified correctly (`resources`, `issue`,
    `transitions`, `comments`, `board`, `boardIssues`, `boardConfig`).
  - From that recorded evidence the guard allowed only the exact planned
    transition to reach a permission prompt (in a headless run that prompt
    is not approved, so it did not run), and refused a Done transition id
    and an `editJiraIssue` call. The mock server's write log stayed empty.
    The ledger recorded the request and the block, and its chain verified.
- **Tool availability on this machine:** the claude.ai Atlassian connector
  is installed but unauthenticated, so the only Atlassian tools present are
  `authenticate` and `complete_authentication`. No real Jira tool name,
  transition, or board response could be discovered, and no OAuth flow was
  started. Nothing in Jira was read or changed.
- **Only mocked, never run for real:**
  - The real Atlassian Rovo MCP tool names (`getJiraIssue`,
    `getTransitionsForJiraIssue`, `transitionJiraIssue`,
    `addCommentToJiraIssue`, the `execute*` meta-tools) and their
    argument and response shapes. The recognised names come from the
    existing read documentation and Atlassian's published naming, not from a
    live listing.
  - Whether the Rovo server offers board identity, board issues, board
    configuration, and board projects at all. If it does not, a
    `"verification": "required"` mapping can never sync (it fails closed),
    and a repository must choose `"workflow-only"`.
  - A real approved prompt: the write path after the developer says yes.
- **Limitations:** responses must be in Jira's REST shapes. A transition
  that needs a screen is skipped, not filled. `jira-confirm` can report
  `UNCONFIRMED` when the connection is eventually consistent; it is not
  retried automatically. Jira admin automation rules, validators, and
  post-functions run server-side and can still refuse or alter a transition
  that the plugin planned correctly. A rogue `.mcp.json` server named like
  Atlassian could feed forged evidence (prompt and Jira permissions are the
  last line). Nothing here reads comment visibility restrictions.
- **Phase 8 integration tests still needed** (real test site and board,
  never real tickets of record): the real tool list and shapes; two real
  boards with different workflows (scrum and kanban) and a board spanning
  two projects; a user without transition permission; an approved write
  followed by a confirmed read; a stale status changed by someone else
  between plan and write; comment dedupe with Atlassian Document Format
  bodies; a workflow with transition screens or validators; and a resumed
  and a forked interactive session.

---

## Phase 8A: Per-developer connection onboarding

**Status:** Implemented (offline-tested; live checks pending)

**Scope delivered:**

- `/jira-dev-harness:connect`: read-only check of the developer's own
  Atlassian and GitHub connections (MCP first, optional official `gh` browser
  sign-in), with `VERIFIED`, `UNCONFIRMED`, `NOT_CONNECTED`, `NEEDS_AUTH`,
  `INACCESSIBLE`, `MISMATCH`, and `BLOCKED` statuses and explicit next steps.
- READY only after the developer types both account identities
  (`--confirm`), recorded by the user-only injected `connect.cjs begin`, which
  the guard reserves; `evaluate` is allowed to Claude only with the plugin's
  own data directory.
- Warning for claude.ai connectors (Claude-account-level). Isolation is
  described per connection source and never claimed beyond what it supports.
- Lightweight tool-presence preflight in `ticket` and `ship`.
- No bundled MCP servers, no credential storage, no Docker, no PAT prompts.

**Limitations:**

- Identity comes from the connection's own responses, so a lying server is
  not caught. Whether a claude.ai connector holds the developer's own
  credentials cannot be verified.
- The confirmation is per session and is not persisted.
- GitHub's remote MCP server may not support browser sign-in from Claude Code;
  then `gh auth login --web` is the supported route. Not live-tested.
- Preflights look for tools only. The plugin cannot sign anyone in: the
  developer runs `/mcp` or `gh auth login --web`.
- Tool names used for identity (`atlassianUserInfo`, `get_me`) are discovered
  at run time, never assumed. If a connection has none, it is `BLOCKED`.

**Remaining (Phase 8A):** live runs against real Atlassian and GitHub
connections (both OAuth-capable and not), a claude.ai connector, a `gh`-only
developer, two developers on separate PCs, expired-token and revoked-access
cases, and PostToolUse behavior on the identity reads.

---

## Phase 8B: Assigned-ticket discovery

**Status:** Implemented (offline-tested; live Jira check pending)

**Scope delivered:**

- `/jira-dev-harness:ticket` accepts a ticket URL, a bare key (`PROJ-123`),
  or no argument. Parsing is done by `plan-store.cjs ticket-ref`
  (`scripts/lib/discover.cjs`), which never contacts Jira. A URL must be
  `https`, a plain `<site>.atlassian.net` host (no port or user info), and
  carry `/browse/KEY-123` or `selectedIssue=KEY-123`. A bare key takes the
  site from the repository's mapping file; with no site there, the workflow
  uses the one accessible site or asks, and never guesses.
- **No argument** lists the developer's own tickets. The only query is the
  constant `assignee = currentUser() AND statusCategory != Done ORDER BY
  updated DESC`, printed by `plan-store.cjs assigned-jql`. `--include-done`
  drops the Done clause, and only when the developer asks. It has no other
  input. The list shows key, summary, project, status, and a mapping verdict
  per ticket (`plan-store.cjs mapping-status`: `verified`, `mismatch`, or
  `unverified`, with the same rules as the workflow's mapping gate). Jira
  text is shown as one cleaned line.
- **Explicit selection.** The skill stops after the list. Only the
  developer's own reply selects a ticket, never automatically, even with one
  result. After selection, every existing gate runs unchanged: the mapping is
  verified before the ticket body, comments, or attachments are read.
- The guard allows `ticket-ref`, `assigned-jql`, and `mapping-status` in
  workflow sessions (no store argument needed) and keeps every Jira write
  denied.

**Validation (2026-11-05, Node 24.14, git 2.53, Windows 11):**

- `tests/discover.test.cjs`: 25 of 25. It covers the query and its
  injection resistance, URL and key parsing (15 invalid shapes), text
  cleaning, row reduction, the mapping verdict (verified, mismatch,
  uncommitted, untracked, missing, malformed), the plan-store commands and
  that they change nothing, the guard (discovery commands allowed, 6 Jira
  write shapes denied, approvals and chaining denied), and the skill's
  wording.
- An offline probe through the real guard in a planning session: quoted
  `selectedIssue` URLs that contain `&` are allowed, and the same URL
  unquoted is denied (fail-safe; the skill says to quote it).

**Not validated live:** no real Atlassian connection was available (the
connector is unauthenticated on the test machine), so `searchJiraIssuesUsingJql`,
`atlassianUserInfo`, and the real response shapes were not exercised, and
nothing was read from or written to Jira.

**Limitations:**

- That the search uses exactly the `assigned-jql` text is enforced by the
  skill's instructions, not by the guard. The search tool is read-only and
  Jira enforces the user's permissions, but the guard does not compare the
  JQL.
- `ticket-ref` reads the site for a bare key from the mapping file even when
  that file is uncommitted. This only picks the site; the mapping gate still
  refuses an uncommitted or mismatched mapping before the ticket is read.

---

## Phase 8C: Git worktree isolation

**Status:** Implemented in v0.8.0. Offline-tested (steps 1-6), and
live-tested with the plugin loaded in Claude Code (Stage 1 and the LIVE-3
end-to-end run, see the validation log) using a disposable repository and
mocked GitHub and Atlassian servers. Real GitHub and Jira validation is
pending. Step 6 (`tests/worktree-remove.test.cjs`,
`tests/e2e-offline.test.cjs`): user-only `/jira-dev-harness:worktree-remove`
(unforced `git worktree remove`, branch kept, no prune, signed removal
record, exact-set `--confirm-ignored`, refusals for dirty, unpushed,
sensitive, active, tampered, and moved worktrees), merge verification after
an authorized removal, append-only signed ship record revisions, and
re-planning that must account for existing worktree changes. Step 1 of the
implementation is done and offline-tested: `scripts/lib/worktree.cjs`
(path rules, creation, signed binding, registry, verification, dependency
and filter reports) with `tests/worktree.test.cjs`. Step 2 is done and
offline-tested: `save` records `baseHead` and `dirtyPaths`, `approve`
checks the base (a full commit in this repository's history, still HEAD)
and signs it into the approval, worktree creation takes its base only from
the signed approval, and the read-only `worktree-status` command reports it
(`tests/plan-base.test.cjs`). Step 3 is done and offline-tested
(`tests/implement-worktree.test.cjs`, migrated `tests/legacy/phase4-tests.cjs`):
`/implement` creates the worktree, stops for `/add-dir`, and authorizes on
the next run with the signed binding recorded in the session; the guard
confines Developer writes to the verified worktree and requires the
`cd "<worktree>" &&` prefix on its commands (documented as not a sandbox);
registered worktrees are protected in every session; `worktree-status` is
allowed; git status parsing is NUL-delimited; replaced approval records are
kept. Step 4 is done and offline-tested (`tests/review-worktree.test.cjs`):
reports state their layout (`worktree` with the binding number and
signature, or `legacy-in-place`); `review-start`, `run-check`, `review-save`,
`review-status`, and `approve-review` resolve the primary identity and the
worktree separately and re-verify the signed binding; review records, the
HTML and Markdown reports, and review approvals bind the workspace; a
worktree review never falls back to the main checkout; replaced review
approvals are kept; `review-status` ignores unsigned records. Step 5 is
done and offline-tested (`tests/ship-worktree.test.cjs`, local bare origin,
pull requests recorded through the MCP route, no provider called):
shipping runs in the verified worktree on `jira/<KEY>` (`--branch` refused,
no branch created or switched); every step re-verifies the chain, the
signed binding, the developer's exact review approval (by SHA-256), the
shipping commit's parent, files, and blobs, and the remote including
`remote.origin.pushurl`; the guard re-runs the same check before an MCP
pull request call; the shipping commit is recorded (signed) so a later
re-review accepts it and refuses any other commit; ship and merge records
bind the workspace and the approval. Next step: worktree removal. It must land before
Phase 8, so that the end-to-end runs validate the final architecture.

Interactive check (2026-11-05, done by the developer): `/add-dir` authorized
the sibling worktree, and a subagent could `cd` into it; after
`claude --resume` a new subagent could still `cd` into it. Headless runs
showed the opposite on resume (access was lost without `--add-dir`). The
plugin therefore treats directory access as environment-dependent and
never relies on it persisting.

**Objective:** Every approved ticket is implemented in its own plugin-managed
**sibling** git worktree on its own ticket branch, so that the developer's
main checkout is never changed by ticket work. All later steps (report,
review, checks, review approval, commit, push, pull request) act on that
worktree. Every existing gate, signature, immutable record, and protection
stays as it is.

**Requirements (confirmed):**

1. `/jira-dev-harness:implement` creates the worktree and branch after the
   approval is re-verified and before any Developer write.
2. Location: a sibling of the main checkout, `<parent>/<project>-<ISSUE-KEY>`.
   For example, `web/app` gives `web/app-PROJ-101` and
   `web/app-PROJ-102`. There is no central worktrees directory.
3. The main checkout is not changed by implementation.
4. One worktree per active ticket; a resumed or repeated `implement` reuses
   the ticket's verified worktree.
5. Based on the exact committed HEAD recorded with the approved plan. A
   mismatch is reported and refused, never rebased.
6. `sameRepo()` and the signed plan approval are unchanged. The worktree gets
   its own signed, separately verified binding.
7. Developer writes, project commands, review facts, checks, review-approval
   hashes, commit, push, and pull request all target the authorized worktree.
8. Claude never runs `git worktree` itself. Only fixed-argument plan-store
   steps inside user-only commands create or remove worktrees.
9. A worktree is never deleted automatically, uncommitted work is never
   discarded, and ignored files are never removed silently.
10. Missing dependencies in a fresh worktree are detected and reported.
    Nothing is installed without explicit permission.
11. Windows paths, spaces, symlink and junction escapes, name collisions, and
    concurrent tickets are handled. No new dependencies.

**Decisions (approved):**

1. A plan without a recorded base HEAD (saved before this phase) needs a new
   revision and a new approval before `implement`.
2. `implement` is refused if uncommitted main-checkout changes recorded at
   plan time touch the plan's files (they would be missing from the
   worktree). Other uncommitted changes give a warning.
3. Missing dependencies are reported. An install runs only with the
   developer's explicit permission.
4. Repository hooks are disabled for the worktree creation step
   (`core.hooksPath` pointed at an empty directory the plugin creates).
   Checkout filters are investigated separately (see the probes).
5. The branch is fixed: `jira/<KEY>`. `/ship --branch` is refused for
   worktree tickets.
6. Ignored files are never removed silently. Removal lists them and needs an
   explicit confirmation. Sensitive files (the ship step's secret-file
   patterns, such as `.env` and key files) block removal until the developer
   has moved them.
7. The guard protects plugin-managed worktrees (paths in the plugin's
   registry) and does not restrict other `git worktree` use in ordinary
   sessions.
8. When Claude Code needs access to the sibling directory, `implement`
   tells the developer to type `/add-dir "<worktree path>"`. Permissions are
   never bypassed.

**Feasibility checks (2026-11-05, read-only for this repository, throwaway
repositories under the session scratchpad with spaces in the path; Claude
Code 2.1.318, git 2.53, Node 24.14, Windows 11):**

| Check | Result |
| :- | :- |
| `git worktree add -b jira/PROJ-101 "<parent>/app-PROJ-101" <base>` with spaces in the path | Works. Same root commit, origin, and `--git-common-dir` (`<main>/.git`) as the main checkout; its own `--git-dir` (`<main>/.git/worktrees/app-PROJ-101`); the worktree's `.git` is a file; `refs/remotes/origin/HEAD` is shared |
| The plugin's `repoIdentity` / `sameRepo` on a worktree | Different root, so `sameRepo(main, worktree)` is false: the separate binding is required, and `sameRepo` need not change |
| `git worktree list --porcelain` | Absolute forward-slash paths, `HEAD <sha>`, `branch refs/heads/<name>`: parseable for verification |
| Existing branch, existing directory, junction at the sibling path | Each refused by git (`already exists`); `lstat` reports a junction as a symbolic link |
| Name collision differing only in case | On Windows `APP-proj-101` resolves to the existing `app-PROJ-101`: the check must be case-insensitive on Windows |
| `post-checkout` hook during `worktree add` | Runs by default. With `-c core.hooksPath=<empty dir>` it does not run |
| Checkout (smudge) filter during `worktree add` | Runs even with hooks disabled. `--no-checkout` runs none, and a command-line `-c filter.<name>.smudge=cat` suppresses one. Filter commands come only from the user's own git config (the global LFS filter is present here), never from repository content, unlike `core.hooksPath`, which can point into the repository |
| `git worktree remove` without `--force` | Refuses tracked or untracked changes, but **silently deleted ignored files, including `.env` and `node_modules`**. The plugin must check ignored files itself before calling it |
| `git worktree remove` with an ignored junction in the worktree (pre-release audit, 2026-11-06) | git lists the junction target's files as ignored files of the worktree, and removal **deleted the target's files outside the worktree**. Removal now refuses any untracked symbolic link or junction in the worktree |
| Claude Code without `--add-dir`: Read, Write, Bash `cd` into the sibling | Read and Write ask for permission. A subagent's `cd` is **hard-blocked** ("may only change directories to the allowed working directories") |
| Claude Code with `--add-dir <worktree>` | Read works; a subagent's `cd` works; Write still prompts (as intended) |
| Shell working directory | Resets to the session directory after every Bash call. The hook input's `cwd` stays the session directory, also in subagents and after a `cd`, so the guard cannot rely on `cwd` |
| `cd "<wt>" && git ...` and `git -C "<wt>" ...` | Both need approval (Claude Code's own check for git in another directory). Git facts in the worktree must therefore come from plan-store commands, not from Claude's git calls |
| `cd "<wt>" && <project command>` | A normal approval prompt for the project command |

Not checked yet: the interactive `/add-dir` command (only the `--add-dir`
flag could be tested headless) and Windows long paths over 260 characters
(`core.longpaths` is unset on this machine).

**Planned design:**

- New `scripts/lib/worktree.cjs` (no dependencies):
  - **Path:** `<realpath(parent of the main root)>/<basename(main root)>-<KEY>`.
    It refuses a main checkout at a filesystem root, a target inside the main
    checkout, and a target whose path already exists in any letter case
    unless it is this ticket's verified worktree.
  - **Create:** under an exclusive per-ticket lock, run
    `git -C <main> -c core.hooksPath=<empty dir> worktree add -b jira/<KEY> <path> <baseHead>`
    with `spawnSync` and fixed arguments. Then check with `lstat` that the
    result is a real directory, and that its `realpath` equals the expected
    path.
  - **Binding:** HMAC-signed `plans/<site>/<KEY>/worktree-b<N>.json`
    (exclusive create, never overwritten; a later removal adds
    `worktree-b<N>-removed.json`), holding the primary repository identity
    (unchanged format), the worktree real path, `git-common-dir`, branch,
    base commit, the plan revision and SHA-256 it was created for, and when
    it was created.
  - **Registry:** one file per ticket, `worktrees/registry/<site>__<KEY>.json`
    in the plugin data directory, used by the guard to recognise managed
    paths. It only adds protection, so it is not trusted for authorization.
  - **Verify:** signature; `realpath` and no link; listed in
    `git worktree list --porcelain` of the main checkout; same common
    directory; branch `jira/<KEY>` checked out.
  - **Dependency report:** ignored top-level entries of the main checkout
    (`git status --ignored --porcelain`) that are missing in the worktree.
    Report only; nothing is copied or linked.
  - **Removal:** see below.
- **Plan base:** `save` records the full HEAD and the dirty paths;
  `approve` signs the base commit into the approval (an additive field).
- **Resolver:** one function maps the current directory (the main checkout,
  or a managed worktree with a valid binding) to the primary identity plus
  the work root. Every command that now calls `repoIdentity(process.cwd())`
  uses it.
- **Git facts:** they come only from plan-store commands (`report-save`,
  `review-start`, a new read-only `worktree-status`), never from Claude's own
  git calls in the worktree.
- **Guard:**
  - Developer writes must be inside the bound worktree; the main checkout is
    off limits during implementation.
  - Developer commands must start with `cd "<worktree>"` and must not leave
    it; they still always ask.
  - Developer writes need a worktree binding.
  - The binding, registry, and lock join the protected store names.
  - In every session, Claude's `git worktree remove|move|prune|repair` and
    recursive deletes that name a registered path are denied. Other
    worktree use is unaffected.
- **Pre-existing changes:** a managed worktree starts clean at the base, so
  everything in it is ticket work. This also fixes today's refusal by `ship`
  after a repeated `implement`.
- **Removal:** a new user-only `/jira-dev-harness:worktree-remove <KEY>`.
  It refuses on:
  - an unverified binding
  - tracked or untracked changes
  - an unpushed branch (unless `--unpushed`)
  - an active session for that ticket
  - sensitive ignored files

  It lists the other ignored files and needs
  `--confirm-ignored <count>`. It runs `git worktree remove` without
  `--force`, never deletes the branch, never prunes, and writes a removal
  record.
- **Legacy:** in-flight in-place implementations (reports without a binding)
  can still be reviewed, approved, shipped, and merged, labelled as legacy.
  New Developer writes need a worktree.

**Acceptance criteria:**

- `implement` creates exactly one worktree at `<parent>/<project>-<KEY>`, on
  `jira/<KEY>`, at the plan's base commit, before the first Developer write,
  and reuses it on resume and repeat.
- The main checkout's `git status`, HEAD, index, and files are byte-identical
  before and after implement, review, approve-review, and ship.
- Every Developer write outside the worktree, including into the main
  checkout, is denied: traversal, symlinks, junctions, a junctioned sibling
  path, and a case-variant path.
- A base mismatch, a missing base, an existing directory, a foreign or
  unregistered worktree, an existing branch, and a relevant dirty main
  checkout are each refused, with nothing changed.
- No repository hook runs during worktree creation.
- Review facts, check logs, review-approval file hashes, and the commit come
  from the worktree; the approval chain still binds the unchanged primary
  identity.
- Removal refuses each unsafe case above, never deletes an ignored file
  without the typed confirmation or a sensitive file at all, never uses
  `--force`, and never deletes the branch.
- Two tickets run concurrently in separate sibling worktrees. Two concurrent
  `implement` runs for the same ticket give one worktree and one clear
  refusal.
- A fresh worktree reports missing dependency directories, and nothing is
  installed.
- When Claude Code lacks access, `implement` prints the `/add-dir` line, and
  nothing bypasses a permission.
- Paths with spaces work on Windows. All earlier suites pass, updated only
  where the location of the work moves into the worktree.
  `claude plugin validate . --strict` passes.

---

## Phase 8: End-to-End Testing + Team Rollout

**Status:** Pending

**Objective:** Prove the full workflow works across supported project types
and distribute the plugin to the team.

**Implementation scope:**

- Run end-to-end, including real Jira planning, on repositories from at
  least three different stacks, for example a React or React Native app,
  a Python service, and a JVM or .NET project. Include at least one where
  the project's checks actually run and pass.
- Package the plugin in a marketplace and document the install line.
- Resolve the open plugin-directory items from Phase 1, the licence and
  the icon, if the plugin will be distributed through the directory.
- Write onboarding documentation for developers and project maintainers.

**Acceptance criteria and validation:**

- A full ticket-to-PR run succeeds on both project types, with every gate
  enforced.
- A team member installs the plugin from the marketplace and runs it.
- Strict validation passes on the release version.

**Completion notes:** None yet.

---

## Validation log

| Date | Change | Check | Result |
| :- | :- | :- | :- |
| 2026-10-29 | Phase 1 build | `claude plugin validate --strict` | Passed (exit 0) |
| 2026-10-29 | Phase 1 build | Skill run with a valid URL in a sample repository | Preflight reported correctly and stopped |
| 2026-10-29 | Phase 1 build | Skill run with an invalid URL | Rejected and stopped |
| 2026-10-29 | Phase 1 build | Agent registration | All four registered |
| 2026-10-30 | Agent models | `claude plugin validate --strict` | Passed (exit 0) |
| 2026-10-30 | Agent models | Each agent run with `--agent jira-dev-harness:<name> --output-format json -p "status"`, model read from `modelUsage` | analyzer, planner, developer: `claude-sonnet-5-5`. reviewer: `claude-opus-5-5`. Each returned only its placeholder reply in 1 turn |
| 2026-10-30 | Agent models | Delegation guard: a `haiku` main session asked to delegate to each agent, both through an instruction to use the Agent tool and through `@agent-jira-dev-harness:<name>` | The session refused to delegate in all 8 runs, citing the "Do not delegate" placeholder description |
| 2026-10-30 | Agent models | Skill re-run with a valid URL and an invalid URL in the sample repository | Same behaviour as on 2026-10-29. The sample repository was unchanged afterwards (clean, one commit) |
| 2026-10-30 | Phase 2 | `claude plugin validate . --strict` | Passed (exit 0) |
| 2026-10-30 | Phase 2 | Hook JSON and matcher, checked offline | Valid JSON. 13 of 13 write tools denied, 10 of 10 read or other tools allowed |
| 2026-10-30 | Phase 2 | Authenticated read of `PROJ-1292` | Fields, comment, and both image attachments read. Atlassian read tools only |
| 2026-10-30 | Phase 2 | Nonexistent issue `PROJ-99999999` | 404, reported safely |
| 2026-10-30 | Phase 2 | Site that isn't accessible | Reported, and no other site tried |
| 2026-10-30 | Phase 2 | Invalid URL | Rejected with no tool calls |
| 2026-10-30 | Phase 2 | No MCP connection | "Not connected" and the setup instructions |
| 2026-10-30 | Phase 2 | Write attempt (`editJiraIssue`) after the skill ran | Denied by the hook. Never reached Jira |
| 2026-10-30 | Phase 2 | Committed mapping, and no mapping | Verified, and unverified |
| 2026-10-30 | Phase 2 | Repository and agent integrity | Sample repositories unchanged. Agent models and tools unchanged |
| 2026-10-30 | Phase 3 | `claude plugin validate . --strict` | Passed (exit 0) |
| 2026-10-30 | Phase 3 | Plan store and guard unit tests | All cases as expected |
| 2026-10-30 | Phase 3 | Mapping mismatch, and no mapping | Both stopped before Jira |
| 2026-10-30 | Phase 3 | Full workflow on `email-app-fixture` with `PROJ-1292` | Instructions read before Jira. Analyzer and Planner on `claude-sonnet-5-5`, read-only tools only. r1 saved as BLOCKED, with the rule conflict flagged |
| 2026-10-30 | Phase 3 | Revisions and approval | r2 READY and approved by the developer. r1 and a wrong hash refused. r3 invalidated the r2 approval, and reusing it was refused |
| 2026-10-30 | Phase 3 | Claude forging an approval (resumed session) | First attempt succeeded (defect). After the fix, all 3 methods were blocked |
| 2026-10-30 | Phase 3 | Repository and Jira integrity | Fixture byte-identical. 16 Atlassian calls, all reads |
| 2026-10-30 | Security checkpoint | `claude plugin validate . --strict` | Passed (exit 0) |
| 2026-10-30 | Security checkpoint | Guard unit tests | 60 of 60 |
| 2026-11-03 | Phase 8A | `node --test` (incl. `tests/connect.test.cjs`, 9 cases), legacy guard, phase4, phase5 suites | 121 of 121; all legacy suites passed |
| 2026-11-03 | Phase 8A | `claude plugin validate . --strict` | Passed (only the existing marketplace-install-line advice) |
| 2026-10-30 | Security checkpoint | Plan store unit tests (identity, full hash, HMAC, stale, mapping, tamper) | All as expected |
| 2026-10-30 | Security checkpoint | Workflow regression on the fixture | Succeeded, 0 guard denials, r4 BLOCKED with the repository identity |
| 2026-10-30 | Security checkpoint | Resumed and forked sessions, plus subagent writes (hook layer) | 12 of 12 attempts denied. Fork inherited the workflow state |
| 2026-10-30 | Security checkpoint | Plugin developer agent write, direct `approve` by Claude | Both denied |
| 2026-10-30 | Security checkpoint | Developer approval: wrong repository, short hash, correct | Refused, refused, granted |
| 2026-10-30 | Security checkpoint | Stale approval, keyless forgery | Invalid, invalid |
| 2026-10-30 | Security checkpoint | Forgery with the key | Accepted, as expected. Documented limitation |
| 2026-10-30 | Phase 4 | `claude plugin validate . --strict` | Passed (exit 0) |
| 2026-10-30 | Phase 4 | Phase 4 unit tests | 74 of 74, 1 skipped (Windows file symlink needs Developer Mode) |
| 2026-10-30 | Phase 4 | Earlier guard suite | 60 of 60 |
| 2026-10-30 | Phase 4 | Implement refusals: before approval, cross-repository, wrong hash, short hash | All refused, no changes |
| 2026-10-30 | Phase 4 | Developer write before authorization, and in `acceptEdits` mode | Denied, and denied |
| 2026-10-30 | Phase 4 | Attended Python implementation | 5 edit prompts. Approved rule applied, `CLAUDE.md` untouched, tests accurately reported NOT RUN (no Python), report saved |
| 2026-10-30 | Phase 4 | Attended Node implementation | 2 edit prompts. Broken `npm test` detected, tests 4 passed and 1 known failure, deploy never ran, report saved |
| 2026-10-30 | Phase 4 | Resumed session after a plan change | Developer and main-thread edits denied, 0 prompts |
| 2026-10-30 | Phase 4 | Transcript audit | 0 Jira calls, no git mutations, commits, pushes, PRs, installs, or deploys |
| 2026-10-30 | Phase 5 | `claude plugin validate . --strict` | Passed (exit 0) |
| 2026-10-30 | Phase 5 | Phase 5 unit tests | 68 of 68 (enforcement, evidence, HTML escaping and filter, staleness, guard) |
| 2026-10-30 | Phase 5 | Phase 4 and guard suites | 74 of 74, and 60 of 60 |
| 2026-10-30 | Phase 5 | Live reviews, Opus (4) | PASS-1 **PASS**. FAIL-1 **FAIL** (telemetry blocker, AC3 missing, report overclaims). PYT-1 rv-2 **BLOCKED** (Python unavailable). PYT-1 rv-1 FAIL from a rule defect, fixed |
| 2026-10-30 | Phase 5 | Fresh-context independence | Reviewer input was paths only, with no report claims. All evidence read by the Reviewer |
| 2026-10-30 | Phase 5 | Invalidation | CURRENT, then STALE after a code edit, then CURRENT after the exact restore |
| 2026-10-30 | Phase 5 | Resumed and forked reviewing sessions | Main, developer, general-purpose, and Jira writes all denied |
| 2026-11-02 | Phase 7 | `node --test` | 112 of 112 (Phase 6 and merge: 70, Jira: 42) |
| 2026-11-02 | Phase 7 | Recovered legacy suites | guard 60 of 60, Phase 4 74 of 74 (1 skipped), Phase 5 68 of 68 |
| 2026-11-02 | Phase 7 | `claude plugin validate . --strict` | Passed |
| 2026-11-02 | Phase 7 | Live, mock `atlassian` MCP server | 7 reads recorded by the real hook; the exact planned transition reached a prompt; a Done transition and an edit were refused; 0 writes reached the server |
| 2026-11-02 | Phase 7 | Real Atlassian connector | Unauthenticated: only authenticate tools present, so no real tool discovery was possible |
| 2026-11-05 | Phase 8B | `node --test` (incl. `tests/discover.test.cjs`, 25 cases) | 148 of 148 |
| 2026-11-05 | Phase 8B | Legacy guard, Phase 4, Phase 5 suites | 60 of 60, 74 of 74 (1 skipped), 68 of 68 |
| 2026-11-05 | Phase 8B | `claude plugin validate . --strict` | Passed (existing licence, icon, and marketplace-install-line items) |
| 2026-11-05 | Phase 8B | Live Jira discovery | Not run: no authenticated Atlassian connection |
| 2026-11-06 | Phase 8C | `node --test`; legacy guard, Phase 4, Phase 5 suites; `claude plugin validate . --strict` | 250 of 250; 60 of 60, 99 of 99 (1 symlink case skipped without Developer Mode), 68 of 68; passed |
| 2026-11-06 | Phase 8C | Live Stage 1 (developer-run, isolated `CLAUDE_CONFIG_DIR` and `TEMP`, `--plugin-dir`, `--strict-mcp-config`, disposable repository, test site `jdh-livetest.atlassian.net`): approve, `/implement` worktree creation and ACCESS NEEDED, interactive `/add-dir`, re-run, Developer implementation in the worktree, three guard denials (main-conversation write to the main checkout, Developer write to the main checkout, Developer write to another ticket's worktree) | Passed. Main checkout byte-identical to its baseline; LIVE-1 holds only the two planned changes; LIVE-2 untouched; no stray files; records verify with the isolated key; real plugin data byte-identical |
| 2026-11-06 | Phase 8C | Live LIVE-3 end-to-end (developer-run, isolated profile, disposable repository, local bare remote with network transports blocked, mocked GitHub and Atlassian MCP servers): approve, implement, independent review, review approval, ship (commit, push, pull request), merge, Jira sync with `--allow-done` | Passed. Main checkout byte-identical to its baseline; local `main` has exactly one squash commit with the two reviewed files; stage `merged`; mock ticket Done with one comment; all signed records valid; ledger intact; real plugin data byte-identical |
| 2026-11-06 | v0.8.0 release prep | `jira-status` header showed the stale session phase "planned" after confirmed writes | Fixed (reporting only: progress derived from the signed ledger); regression assertion added to `tests/jira.test.cjs` |
