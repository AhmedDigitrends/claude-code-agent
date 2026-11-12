# jira-dev-harness

A reusable, project-independent Claude Code plugin that takes an assigned
Jira Cloud ticket from analysis to a reviewed pull request, in whichever git
repository is currently open. It works with any language, framework, or
build system.

The plugin has no client names, repository paths, component names,
technology assumptions, or project-specific rules built in. Each project
keeps its own rules in its own repository, and the plugin adapts to them at
run time. Rules can live in `CLAUDE.md`, `.claude/rules/`, `AGENTS.md`, and
similar files. Each user connects their own authorized Jira account.

> **Status: v1.0.** The workflow has eight
> steps:
>
> - The ticket skill reads your project's rules and the Jira ticket, runs
>   the Analyzer and Planner agents, and saves a versioned plan.
> - You approve one exact revision with `/jira-dev-harness:approve`.
> - You start implementation with `/jira-dev-harness:implement`. The Sonnet
>   Developer Agent then changes the code in attended mode, with a
>   permission prompt for every edit and every project command.
> - `/jira-dev-harness:review` runs the read-only Opus Reviewer in a fresh
>   context. It records your approved project checks as evidence and
>   produces an HTML test report with a PASS, FAIL, or BLOCKED verdict.
> - You approve that exact, current PASS report with
>   `/jira-dev-harness:approve-review`.
> - `/jira-dev-harness:ship` commits the approved files on a ticket
>   branch, pushes it, and opens a pull request linked to the Jira ticket,
>   through your own GitHub MCP connection (or an optional official `gh`).
>   Each git or provider step needs your permission prompt.
>
> - `/jira-dev-harness:merge` is a separate authorization. It merges only
>   if the GitHub provider itself verifies the pull request, its exact head
>   commit, required CI, reviews, branch protection, and your permissions.
>
> - `/jira-dev-harness:jira-sync` is a separate authorization. It writes at
>   most one verified transition and one comment to the ticket, from the
>   plugin's own signed records and Jira's own responses, through your
>   Atlassian MCP connection, and never moves a ticket to Done unless you
>   explicitly allow it.
>
> The plugin never merges automatically, never bypasses protections, and
> writes to Jira only through `jira-sync`. Read the [Security
> model](#security-model) before relying on approvals.

## Requirements

- Claude Code 2.1.295 or later (CLI, or the VS Code extension). Earlier versions ignore the guard hook's fail-closed setting, so a crashed guard would let a tool call through
- Git, and a git repository with at least one commit and a committed
  [project mapping](#project-mapping). Any language or framework works.
- A connection to the official Atlassian Rovo MCP server, for reading Jira.
  See [Jira connection setup](#jira-connection-setup).
- Node.js, which runs the plugin's dependency-free scripts.
- On Windows, Git Bash, for the approve, implement, and review commands.
- Your project's own toolchain, if you want the project's checks to run
  (for example Python, a JDK, or Node). Without it, the checks are recorded
  as unavailable, and a review cannot PASS.
- A web browser, to view the HTML test report.
- To open pull requests: your own authenticated GitHub MCP connection (the
  preferred route), or the official GitHub CLI (`gh`) signed in by you.
  Pushing needs a Git transport that is already authorized on your machine,
  such as an SSH key or a credential helper. The plugin never handles
  credentials.

## Installation

The plugin is distributed from the public GitHub repository
`AhmedDigitrends/claude-code-agent`, which is also a Claude Code
marketplace. You need Git installed. The plugin never handles credentials.

```text
/plugin marketplace add AhmedDigitrends/claude-code-agent
/plugin install jira-dev-harness@jira-dev-harness-marketplace
/reload-plugins
```

On Claude Code 2.1.275 or later, one step also works:
`/plugin install jira-dev-harness --marketplace AhmedDigitrends/claude-code-agent`.

Then connect your own accounts (see [Jira connection setup](#jira-connection-setup)
and [GitHub integration](#github-integration)) and verify them with
`/jira-dev-harness:connect`.

**Update.** Run `/plugin marketplace update jira-dev-harness-marketplace`, then
`/plugin update jira-dev-harness@jira-dev-harness-marketplace` and `/reload-plugins`.
A new release bumps `version` in `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`.

**Each project repository** needs its own committed mapping file (see
[Project mapping](#project-mapping)). Project rules in `CLAUDE.md` and
`.claude/rules/` are read automatically when planning and implementing; if
there are none, the workflow continues normally.

To try the plugin from a local checkout instead, see [Local testing](#local-testing).

## Quick start

1. Install the plugin (see [Installation](#installation)).
2. In a fresh session, run `/jira-dev-harness:connect` and confirm your own Jira and GitHub accounts.
3. Open your project's repository and run `/jira-dev-harness:ticket`. Enter a ticket ID, or pick one from your assigned tickets.
4. Open the saved plan file (a clickable link, stored outside your repository), then approve it with the `/jira-dev-harness:approve` command it prints.
5. Run `/jira-dev-harness:implement`, then `review`, `approve-review` and `ship` (each prints the next command). Merging is always a separate, manual `/jira-dev-harness:merge`.

## Usage

```text
/jira-dev-harness:connect                                                     # once: verify your own Jira and GitHub connections
/jira-dev-harness:ticket https://<your-site>.atlassian.net/browse/PROJ-123   # analyse and plan
/jira-dev-harness:ticket                                                      # or: list the tickets assigned to you, then pick one
/jira-dev-harness:ticket PROJ-123                                             # or: a bare key (site from the repository mapping)
/jira-dev-harness:approve PROJ-123 r1 <full SHA-256>                          # approve one revision
/jira-dev-harness:implement PROJ-123 r1 <full SHA-256>                        # attended implementation
/jira-dev-harness:review PROJ-123                                             # independent review + test report
/jira-dev-harness:approve-review PROJ-123 rv-1 <full SHA-256>                 # approve the PASS review artifact
/jira-dev-harness:ship PROJ-123 rv-1 <full SHA-256>                           # commit, push, open a pull request
/jira-dev-harness:merge PROJ-123 <pr-number> <full head SHA> --method squash  # separately authorized, provider-verified merge
/jira-dev-harness:jira-sync PROJ-123 [--allow-done]                           # sync the current stage to Jira (verified, audited)
```

Only you can start these commands. Claude cannot invoke any of them.

### 1. Plan: `/jira-dev-harness:ticket`

**Choosing the ticket.** Give a ticket URL or key, or give nothing to list
your own tickets. With no argument, the workflow searches every Jira site
your connection can reach with the single fixed query
`assignee = currentUser() AND statusCategory != Done` (ask for finished
tickets too to drop the second clause). It shows a numbered list of key,
summary, project, status, and whether the repository's mapping covers the
ticket (`verified`, `mismatch`, or `unverified`), then stops. Only your own
reply selects a ticket: a number from the list, or any URL or key. It never
picks for you, even when one ticket is listed, and nothing in a ticket's text
can select one. Listing reads only those four fields; the description,
comments, and attachments are read after the mapping is verified. Selecting
a ticket then runs the steps below with every gate unchanged. Discovery is
read-only and cannot create, edit, or delete anything in Jira.

1. **Checks the ticket reference.** A URL must be an
   `https://<site>.atlassian.net` ticket URL. A bare key takes its site from
   the repository's mapping; if that names no site, the workflow uses the one
   accessible Jira site or asks you which one, and never guesses.
2. **Checks the repository and its mapping.** It finds the git root, the
   branch, the HEAD commit, and whether the working tree is clean. It
   identifies the technology stack from the manifests that are actually
   present, but never requires a particular one. It also requires a
   committed, matching [project mapping](#project-mapping). **If the
   mapping is unverified or mismatched, the run stops** before Jira is
   contacted.
3. **Reads the project instructions before the ticket.** These are:
   - `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md`
   - every `.claude/rules/**/*.md`, including its `paths:` scope
   - `AGENTS.md` and `CONTRIBUTING.md`

   It reports missing and conflicting instructions.
4. **Profiles the project.** It records:
   - manifests, dependencies, and task runners
   - layout, configs, and CI
   - the project's *declared* build, lint, and test commands, or "not
     determined"

   Nothing is assumed.
5. **Reads the Jira ticket, read-only:**
   - key, summary, and description
   - type, status, priority, assignee, and reporter
   - acceptance criteria and other custom fields that are set
   - issue links and web links
   - comments
   - attachment metadata, plus the content of small image and text
     attachments
6. **Runs the Analyzer Agent (Sonnet, read-only).** It compares the
   requirements with the project rules and the existing code, citing
   `path:line` evidence. It lists affected files, dependencies, risks,
   missing information, and contradictions.
7. **Runs the Planner Agent (Sonnet, read-only).** It writes the
   ticket-specific plan: summary, acceptance criteria, existing and
   proposed behaviour, files likely to change, steps, testing with the
   project's declared commands, risks, proposed rule updates, and open
   questions. The plan ends with `Readiness: READY` or
   `Readiness: BLOCKED`.
8. **Saves the plan as a new revision** in the plugin's plan store. The
   repository is not touched.
9. **Shows you the plan and stops.**

### 2. Approve: `/jira-dev-harness:approve`

A READY plan comes with an approval command for its exact revision and
full SHA-256. **Open and read the saved plan file itself** before approving.
Claude's summary of it is not what you approve. Then run the command from
the repository the plan was made for.

- **Only you can approve.** Claude cannot run the approve skill
  (`disable-model-invocation`). An always-on hook stops Claude from writing
  approval records, reading the signing key, or running the approve step
  itself.
- **Approval is bound to everything it covers.** The approval record is
  HMAC-signed and binds:
  - the Jira site and issue key
  - the **latest** revision number
  - the plan's **full** SHA-256
  - the repository identity: its root path, root commit, and origin URL

  The committed project mapping must still be valid. A shortened hash, an
  older revision, a different repository, or an uncommitted mapping is
  refused.
- **Any change invalidates it.** Asking for plan changes creates a new
  revision, which needs its own approval. An older approval stops applying,
  and so does an approval of a plan file that was edited later.
- **It is a record of intent, not proof of identity.** See
  [Security model](#security-model).
- **BLOCKED plans can't be approved.** Answer the open questions in the
  same session, and the Planner produces a new revision.
- **Rule updates need an explicit "yes".** Each proposed change to an
  instruction file is a line of the form
  `- File: <path> | Apply in implementation: yes|no`. Instruction files
  include `CLAUDE.md`, `.claude/rules/*.md`, `AGENTS.md`,
  `SPECIFICATION.md`, and `CONTRIBUTING.md`. Only "yes" lines in the
  approved plan may be applied, and the guard enforces this.

### 3. Implement: `/jira-dev-harness:implement`

Run this from your main checkout in an **attended** Claude Code session,
in the default permission mode, not auto-accept or bypass. An injected
command first re-verifies:

- the repository identity and the mapping
- the issue key and the latest READY revision
- the full SHA-256 and the signed approval, including its base commit

**Each ticket gets its own sibling git worktree (Phase 8C).** For a main
checkout at `web/app`, ticket `PROJ-101` is implemented in
`web/app-PROJ-101` on branch `jira/PROJ-101`, created from the approved
base commit. Your main checkout is never changed. There is no central
worktrees folder.

- **First run:** the plugin creates the worktree and stops. Repository
  hooks don't run during creation; your own configured checkout filters
  (for example Git LFS) do, and are reported. Uncommitted changes in your
  main checkout that touch the plan's files block creation (commit or stash
  them first); other changes are listed and stay where they are. Ignored
  files such as `node_modules/` or `.env` are reported as missing in the
  worktree and are never copied or installed by the plugin.
- **Give Claude Code access:** type the printed `/add-dir "<worktree>"`
  line, then run the same `/jira-dev-harness:implement` command again. If
  `/add-dir` isn't available, restart with `claude --add-dir "<worktree>"
  --resume`. The plugin never changes Claude Code's permissions itself, and
  directory access may not persist across sessions.
- **Second run:** the verified worktree is reused, and the session is
  switched to *implementing*, recording the worktree, its signed binding,
  and a baseline of its HEAD and existing changes. Running `/implement`
  again later (for example after a resume) reuses the same worktree, as
  long as the approved plan has the same base commit.

Then:

- **Only the Developer Agent writes, only in the worktree.** That is
  `jira-dev-harness:developer`, on Sonnet. Its writes into your main
  checkout, another ticket's worktree, or anywhere else are denied. Its
  shell commands must start with `cd "<worktree>" &&`. The main
  conversation and every other agent stay read-only.
- **Every Developer edit prompts you,** even if you have saved allow rules.
  **Every project command that isn't read-only prompts you too**, such as
  a test run, a build, or an install.
- **The authorization is re-checked on every write.** If a new plan
  revision is saved, the approval becomes invalid, the repository changes,
  or the worktree's signed binding no longer verifies, the next write is
  denied. Sessions authorized in place by an older plugin version get no
  new writes; run `/implement` again.
- **Writes are limited to the ticket worktree,** after symlinks and
  junctions are followed. These are always off limits:
  - `.git` and `.claude/` (except approved rule files)
  - `.mcp.json` and the mapping file
  - the plan store

  Instruction files are writable only with an "Apply in implementation:
  yes" line.
- **Never allowed:** commits, staging, branch changes, stashes, pushes,
  `gh`, and other hosting CLIs, along with Jira writes (the Developer
  never has a Jira sync session).
- **The Developer discovers the project's own tooling.** That means its
  manifests, task runners, CI, and the plan's testing section. It runs only
  the project's declared checks, each with your approval. It does not
  install dependencies or run deploy or publish scripts unless the plan
  says so. If it can't determine a safe check, it asks.
- **It stops on major conflicts.** If the plan is wrong, the requirements
  changed, or a project rule conflicts with the plan, it stops and asks for
  a revised plan and fresh approval.
- **The result is a durable implementation report,** stored next to the
  plan. It records the Developer's report, a coordinator check against
  git, and what git itself reports: the changed files, the tracked-diff
  hash, untracked file hashes, and whether HEAD moved, all read from the
  worktree. The Phase 5 Reviewer will use it. Changes stay uncommitted in
  the worktree. The worktree is never removed automatically.
- **Check a ticket's worktree** at any time (read-only):
  `node "<plugin>/scripts/plan-store.cjs" worktree-status "<plugin data>" <KEY>`.
- **Plugin-managed worktrees are protected in every session.** Claude's
  shell commands can't run `git worktree remove`, `move`, or `repair` on
  them, or delete them recursively, and `git worktree prune` is refused
  while one of their directories is missing. Other git and worktree use is
  not affected.

> **Ticket worktrees (Phase 8C, v0.8.0):** review and review approval work on the ticket
> worktree. The review facts, recorded checks, review record, HTML report,
> and the developer's review approval all name the worktree (path, branch,
> base commit, and signed binding) and are computed from it, never from the
> main checkout. A missing, moved, or changed worktree binding stops the
> review instead of falling back. **Shipping** (`/jira-dev-harness:ship`)
> commits, pushes, and opens the pull request from the worktree, on its
> fixed branch `jira/<KEY>`; `--branch` is refused, and no branch is created
> or switched. Before every push and pull request it re-verifies the
> approval chain, the worktree binding and branch, the shipping commit's
> exact content, and the authorized remote (including any push URL). The
> signed ship record binds the worktree, the plan revision, the review, and
> the developer's review approval, and `/jira-dev-harness:merge` checks
> them again. Tickets that were implemented in place before this version
> keep their existing review, approval, and shipping path, including
> `--branch`.

### 4. Review: `/jira-dev-harness:review`

Run this after implementing, ideally in a new session. The steps are:

1. **Gather facts from git, not from any agent.** An injected command
   verifies that the latest revision is approved and implemented in this
   repository. It then writes a review bundle with:
   - the changed files, excluding your pre-existing changes
   - files changed outside the plan
   - instruction-file changes, and whether the plan approved them
   - whether the working tree still matches the implementation report:
     HEAD, the diff hash, and untracked-file hashes
   - the redacted `git diff`

   The session enters **reviewing** mode, in which nobody may change the
   repository.
2. **Re-read the Jira ticket (read-only).** If Jira can't be read, the
   approved plan's acceptance criteria are used, and the report says so.
3. **Run checks as recorded evidence.** Claude chooses checks only from
   what the plan and the project declare, and asks you before running each
   one. The plugin itself runs the command and stores the exit code, the
   redacted log, tool availability, and whether the working tree changed.
4. **Independent Reviewer (Opus, read-only, fresh context).** It gets file
   paths only, never anyone's conclusions. It treats the Developer's report
   as claims to verify. It checks every acceptance criterion against the
   code, plus scope, rules, security, compatibility, regressions,
   integrity, and the check logs. It cites evidence and writes test cases
   traceable to each criterion.
5. **Mechanical rules.** The plugin checks the Reviewer's output before
   saving it, and corrects anything that claims more than the evidence
   shows:
   - automated results must come from recorded checks
   - manual test cases are always **Not Run**
   - "Verified" needs evidence
   - these prevent a PASS: integrity mismatches, unapproved rule changes,
     failed required checks, unavailable or pre-existing-failing checks,
     and untraced criteria

   Every correction is shown in the report.

**Verdicts:**

- **PASS** means every criterion was verified with evidence, there are no
  open blocker or major findings, and the required checks passed.
- **FAIL** means defects were found. They go back for a later fix, a new
  `/jira-dev-harness:implement`, and a new review; nothing is fixed
  automatically.
- **BLOCKED** means the review cannot conclude, for example because a tool
  is missing or tests already fail.

None of them authorize a pull request or merge.

**The test report.** `review-save` prints the path of a standalone HTML
file. Open it in a browser, for example
`start "" "<path>.html"` on Windows, `open` on macOS, or `xdg-open` on
Linux. It shows:

- the ticket and repository identity, including the commit and diff hashes
- the verdict and why
- acceptance-criteria coverage
- a filterable test-case table: Passed, Failed, Blocked, Not Run
- the executed checks, with logs
- unresolved findings
- the changed files

All content is escaped, the page loads nothing external, and its only
script, the filter, is locked by a CSP hash. A JSON record and a Markdown
summary sit next to it. Opening the report does nothing to git or Jira.

**Staleness.** Any change to the code, the plan revision, or the
implementation report makes the review **STALE**:

```bash
node <plugin>/scripts/plan-store.cjs review-status <plugin-data-dir> <ISSUE-KEY>   # CURRENT or STALE
```

Plans, reports, and reviews are stored outside the repository, under the
plugin's data directory, and are never overwritten:

```text
~/.claude/plugins/data/<plugin id>/plans/<site>/<ISSUE-KEY>/
├── plan-r1.md, plan-r1.json        # revision text; .json has SHA-256, readiness, repository identity
├── approval-r1.json                # HMAC-signed; written only by /jira-dev-harness:approve
├── impl-r1-1.md, impl-r1-1.json    # implementation report and its git-computed record
└── reviews/
    ├── rv-1/                       # review bundle: facts.json, diff.patch, checks/C1.json + C1.log
    ├── review-rv-1.html, .json, .md   # the test report, its source record (HMAC-signed), and a summary
    └── review-approval-rv-1.json   # HMAC-signed; written only by /jira-dev-harness:approve-review
~/.claude/plugins/data/<plugin id>/sessions/<session-id>.json   # workflow session state
~/.claude/plugins/data/<plugin id>/keys/approval.key            # HMAC signing key
```

To check a plan from a terminal:

```bash
node <plugin>/scripts/plan-store.cjs status <plugin-data-dir> <ISSUE-KEY>
```

**Shareable review report (optional).** `review-save` also writes a
sanitized, script-free share view (`review-<id>.share.html`): verdict,
acceptance criteria, test cases grouped as Passed, Failed, Blocked, and Not
Run, check results, findings, and the review SHA-256. It omits raw check
logs (including quoted log lines), check commands, local paths, the
repository location and remote, links, and credentials. After the review,
Claude asks whether to publish it with Claude Code's `Artifact` tool; the
guard allows only that exact file, only from the review session, and always
shows a permission prompt. The returned claude.ai URL is recorded (signed)
and linked automatically in the pull request description; no URL is ever
invented. Artifacts start private; making one public is your choice on
claude.ai and may require your organization to allow external sharing.
Publishing needs a claude.ai login and an eligible plan; otherwise the local
HTML report remains the record. The share view is never what you approve.

### 5. Approve the review: `/jira-dev-harness:approve-review`

Run this after `/jira-dev-harness:review` produced a **PASS**. Open the HTML
report first: it is the artifact you are approving. The review step prints
the exact command, including the review's full SHA-256.

```text
/jira-dev-harness:approve-review PROJ-123 rv-1 <full SHA-256 of the review file>
```

The plan store approves only a review that is **current** and **PASS** with
verified evidence, and refuses everything else. It checks that:

- the review is the latest one, is signed by the plugin, and its JSON,
  HTML report, bundle, and check logs are exactly as saved
- the verdict is PASS, with no fail or block reasons, no open blocker or
  major finding, every acceptance criterion verified with evidence, and at
  least one required check that exited 0 and did not change the tree
- the approved plan revision and hash, the implementation report, the
  repository, and the git HEAD, diff, and untracked files are unchanged
  since the review

It then writes a signed approval record that binds the repository, the
ticket, the plan revision and hash, the implementation report, the exact
review id and SHA-256, the HTML report, the git tree identity, and the
SHA-256 of every changed file. It prints those file hashes. It runs no git
command. A FAIL, BLOCKED, stale, edited, or mismatched review is refused,
and so is a missing or shortened hash.

An agent saying "approved" proves nothing: only this command's record
counts, and only you can start it. See the [Security model](#security-model)
for what that does and doesn't prove.

### 6. Ship: `/jira-dev-harness:ship`

```text
/jira-dev-harness:ship PROJ-123 rv-1 <full SHA-256 of the review file> [--branch <name>]
```

This re-verifies the whole chain (approved plan, current PASS review, your
review approval, unchanged tree) and starts a **shipping session**. Then
the steps run one at a time, and each of the three that change something
needs your permission prompt. They are refused in `acceptEdits`, `auto`,
and `bypassPermissions` mode:

1. **Commit** (`ship-commit`). On a ticket branch (the checked-out branch
   if it contains the issue key and isn't protected, otherwise
   `jira/<KEY>`, or `--branch`), it stages exactly the approved files,
   refuses if anything else is staged or if added lines look like
   credentials or private keys, commits with the message Claude drafted
   (project hooks run), and verifies that the commit holds exactly the
   approved content.
2. **Push** (`ship-push`). It pushes only that branch to `origin`, without
   force. It refuses the repository's default branch and conventional
   protected names (`main`, `master`, `develop`, `release/*`, and similar).
   It uses the Git transport already authorized on your machine and never
   asks for credentials. Branch-protection rules that the hosting provider
   enforces on the server still apply.
3. **Pull request.** The plugin fixes the exact title and body first
   (`ship-prepare-pr`): the draft, plus the Jira link, plan hash, and
   review id. Then it is created through your GitHub MCP connection, or the
   optional GitHub CLI adapter. See [GitHub integration](#github-integration).

Nothing in `ship` merges. Merging is the separate command described next.
The ship step reports CI status read-only, when a tool can provide it.

### 7. Merge: `/jira-dev-harness:merge`

Merging is a **separate authorization**. Approving the review and shipping
never imply it, and nothing ever merges automatically.

```text
/jira-dev-harness:merge PROJ-123 <pull-request-number> <full 40-character head SHA> --method <squash|merge|rebase>
```

Typing it authorizes one attempt, for that pull request, that exact head
commit, and that method (there is no default method). The plan store first
checks that the commit is the one `ship` recorded and that the review
approval chain still holds. Then the **merge gate** decides, from raw
responses of the GitHub provider only. It blocks unless they show all of
this for the exact head SHA:

- **Identity:** the pull request is that number, open, not a draft, in this
  repository (not a fork), from the shipped branch into the shipped base.
  GitHub reports it mergeable with state `clean`, and it has only the one
  reviewed commit.
- **Unrelated files:** its changed files are exactly the approved files.
- **CI:** branch protection or a ruleset names at least one required status
  check, each succeeded on that commit, and no check is pending or failing.
- **Reviews:** the number of approving reviews that protection requires
  approved that commit (stale approvals and the author's own don't count),
  and nobody's latest review requests changes.
- **Protection and permissions:** protection could be read, and the
  signed-in account can merge. Nothing is bypassed: no admin override, no
  auto-merge, no merge queue, no branch deletion.
- **Freshness:** the evidence is under 10 minutes old and was captured after
  you authorized the merge.

Anything missing, unparseable, truncated, stale, or about another commit,
pull request, or repository **blocks** the merge ("insufficient evidence").
An agent's summary is never evidence:

- **MCP route (preferred).** Claude calls your connection's read tools. A
  `PostToolUse` hook (`scripts/evidence.cjs`) records their real responses,
  as Claude Code reports them, during a merge session. Claude can't write
  to that store. The guard evaluates the gate before a merge-pull-request
  call may reach your permission prompt, and the call must carry the
  authorized pull request number, head SHA, merge method, owner, and
  repository. A merge tool with no head-SHA field is refused, because the
  provider then couldn't reject a merge if the branch moved. Afterwards,
  `merge-record` counts the merge only if a recorded provider response says
  `merged` with a merge commit for that head.
- **GitHub CLI route (optional).** `merge-collect` and `merge-run` fetch the
  same evidence with read-only `gh api` calls, re-run the gate right before
  merging, merge with `--match-head-commit`, and read the pull request back.
  `merge-run` always shows a permission prompt.

Evidence must be in GitHub's REST shape (a pull request with `head.sha`,
`mergeable_state`, and so on). A connection that returns another shape gives
"insufficient evidence", and you can use the GitHub CLI route or merge in
the provider.

### Removing a ticket worktree: `/jira-dev-harness:worktree-remove`

The plugin never removes a worktree by itself. When you are done with a
ticket's worktree, type `/jira-dev-harness:worktree-remove <KEY>` in the main
checkout. It verifies the signed binding, the repository, the branch, and
the path, and refuses while:

- the worktree has tracked or untracked changes
- the ticket branch has commits that are not on origin
- a sensitive ignored file is there (`.env`, keys, credentials); move it
  yourself, the plugin never deletes one
- the worktree contains a symbolic link or junction (other than a tracked
  symlink): git's removal follows an ignored junction and deletes the files
  of its target, outside the worktree. Remove the link itself first.
- an implementation, review, or (not yet finished) shipping session of the
  ticket is active; finish it, then end it with `--end-session <id>`, which
  switches it to planning mode and keeps its previous state in the plugin's
  session history. A shipping session whose pull request is not recorded
  yet can't be ended this way; finish shipping first.

Other ignored files (for example `node_modules/`) are listed first. Run the
command again with `--confirm-ignored <count>`; it removes them only if the
exact listed set is still there (each file's name, size, and modification
time), and re-checks everything immediately before removal. A re-plan must
decide keep, revise, or revert for every path the earlier worktree work
touched (`worktree-status` lists them). The removal itself is git's own `git worktree remove`,
without `--force`. The ticket branch is kept, nothing is pruned, and a
signed removal record is added; every earlier record stays. A merge of the
shipped pull request can still be verified afterwards, only if the removal
record, the immutable ship record, the shipped commit, and the pull request
number all agree, and the merge still needs its own `/jira-dev-harness:merge`.
Because the branch is kept, a new worktree for the same ticket is refused
until you deal with the old branch yourself.

**Immutable ship records.** The signed ship record of a review is never
overwritten. If the pull request details need a correction, recording the
pull request again in the same shipping session appends a signed revision
that names the previous one; a broken chain makes the record invalid
(fail closed).

**Re-planning with an existing worktree.** When `/jira-dev-harness:ticket`
re-plans a ticket whose worktree already holds work (for example after a
FAIL review), the Analyzer and Planner get that work, and the plan must
include an `## Existing worktree changes` section saying, per file, keep,
revise, or revert; saving a plan without it is refused. The worktree is
reused only when the new plan has the same base commit.

### 8. Jira progress: `/jira-dev-harness:jira-sync`

```text
/jira-dev-harness:jira-sync PROJ-123 [--allow-done]
```

This synchronizes the ticket's **current workflow stage** to Jira, through
your own Atlassian MCP connection. Typing it is the authorization, and it
is separate from every other command. Nothing in Jira changes automatically
as the other commands run.

**Stages are the plugin's own, not Jira statuses.** The stage is derived
from the plugin's signed records, never from what an agent says:

| Stage | When |
| :- | :- |
| `planning` | a plan exists but is BLOCKED |
| `awaiting-plan-approval` | the latest plan is READY and not approved |
| `implementing` | the plan is approved, up to and including the implementation report |
| `in-review` | a review exists and is FAIL or BLOCKED |
| `awaiting-review-approval` | the latest review is PASS and not yet approved |
| `pr-created` | a ship record shows the pull request |
| `merged` | the provider confirmed the merge (a signed merge record) |

Between review approval and the pull request there is no Jira stage, and
the command says so.

**Mapping to Jira is per repository and explicit.** Stages map to the
status *names* that you list in the committed mapping. They are matched
against the transitions that Jira itself offers for the ticket right now,
never to a transition id from the file. See [Project
mapping](#project-mapping).

What a sync does, in order:

1. **Authorize and verify.** The plan store checks the repository, the
   committed and unmodified mapping, the ticket, and the audit ledger.
2. **Read Jira.** Claude finds the Atlassian tools with ToolSearch (it
   never assumes a name) and reads the accessible sites, the ticket, its
   transitions and comments, and the board, its issues, columns, and
   projects. A hook records the real responses.
3. **Plan.** `jira-plan` decides, from those responses only, whether
   anything may be written. It blocks on missing, stale (over 10 minutes),
   or mismatched evidence: another site, project, board, or ticket. It
   verifies that the connection reaches the mapped site, that the ticket's
   project is mapped, and that the board is the mapped one and the ticket
   is on it. A board that spans several projects is fine when it includes
   the ticket's project.
4. **Write exactly the plan.** At most one transition and one comment, on
   this ticket, each behind your permission prompt, in attended mode only.
   The guard compares every call to the plan: the site's `cloudId`, the
   ticket, the transition id that Jira reported, and the exact comment
   text. Extra parameters (fields, resolution, assignee, visibility), other
   tickets, other tools, subagents, and a second attempt are refused.
5. **Confirm.** After a fresh read, `jira-confirm` records whether Jira now
   shows the new status and the comment. Nothing is assumed from a tool
   having returned.

**The ticket's status is preserved, and the reason reported,** when no
status is mapped for the stage, the ticket is already in the target status
or in any Done status, Jira offers no matching transition (for example,
because of permissions), several transitions match, the transition needs a
screen with extra fields, or the target status is not on the verified
board. A comment is posted once: a marker in the comment text, Jira's own
comment list, and the audit ledger all prevent a repeat.

**Never Done by accident.** Finishing implementation, review, or the pull
request never moves a ticket to a Done status. That needs the `merged`
stage (a provider-confirmed merge), `"allowDone": true` for `merged` in the
mapping, and `--allow-done` on the command, and the guard still shows a
prompt.

**Audit trail.** Every authorization, plan, requested write, executed or
failed write, and confirmation is appended to a signed, hash-chained
ledger outside the repository (`progress/<site>/<KEY>/ledger.jsonl`).
Claude can't write to it; the hook and the plan store do. Show it with
`plan-store.cjs jira-ledger <plugin-data-dir> <ISSUE-KEY>`. A tampered or
truncated ledger blocks further Jira writes.

## GitHub integration

Provider operations sit behind a small adapter interface
(`scripts/lib/provider.cjs`). Local Git stays responsible for repository
state, branches, staging, and commits. Nothing about an account,
organization, repository, or board is hardcoded: the repository comes from
`origin`, and the Jira link from the ticket's site.

**MCP first.** The preferred integration is your own authenticated GitHub
MCP connection (for example GitHub's official MCP server). MCP tools can
only be called by Claude, so the ship skill has Claude discover which tools
your connection actually exposes with ToolSearch and read their schemas. It
never assumes a tool name. The guard recognises a create-pull-request tool
only on a server whose name contains "github", and lets the call reach your
permission prompt only if its head, base, title, body, owner, and
repository match what the plugin prepared. If the connection has no such
tool, or its schema doesn't expose those fields, the operation is blocked
with an explanation.

**Optional GitHub CLI adapter.** `ship-pr` uses the official `gh` only if
you installed and signed in to it yourself. The plugin never requires it.
It rejects:

- a `gh` that is a script or shim (`.cmd`, `.bat`, `.ps1`, `.js`)
- one inside the repository or a temporary directory
- one that doesn't print `gh version X.Y.Z` and the `cli/cli` release URL

It never searches the current directory, and it runs `gh` outside the
repository. This is a heuristic: a program can print anything, so it
rejects impostors and cannot authenticate the binary.

**Credentials.** The plugin doesn't read, store, or log tokens. It sets no
token variables, redacts token shapes from captured output, strips
credentials from the remembered `origin` URL, and refuses to ship a
repository whose `origin` URL embeds credentials. GitHub Enterprise hosts
work if the committed mapping lists them:

```json
{ "jira": { "site": "...", "projectKeys": ["PROJ"] }, "git": { "githubHosts": ["github.example.com"] } }
```

| Operation | MCP | GitHub CLI | Otherwise |
| :- | :- | :- | :- |
| Create the pull request | if a suitable tool exists | `ship-pr` | blocked; the prepared title and body are shown |
| Read pull request, CI, checks | if a read tool exists | `ship-checks` | reported as unavailable |
| Read merge evidence | read tools, recorded by a hook | read-only `gh api` | merge blocked |
| Merge | only in a merge session, gate passing, head SHA pinned | `merge-run`, head SHA pinned | blocked; merge in the provider |

### Workflow sessions

Running `/jira-dev-harness:ticket`, `/jira-dev-harness:implement`,
`/jira-dev-harness:review`, `/jira-dev-harness:ship`,
`/jira-dev-harness:merge`, or `/jira-dev-harness:jira-sync` marks the Claude
Code session as a **workflow session**, in planning, implementing,
reviewing, shipping, merging, or Jira-syncing mode. The marking is recorded
on disk, so it survives `--resume` and is inherited by `--fork-session`
copies. For the rest of that session, the always-on guard enforces the
following, in the main conversation and in every subagent. To do unrelated
work, start a new session.

- **No Jira writes, except in a Jira sync session.** Planning,
  implementing, reviewing, shipping, and merging sessions can't edit the
  issue, change its status, add comments, or touch attachments or
  assignments, and Jira and other MCP write tools are denied. A
  `jira-sync` session may write only its one planned, verified transition
  and one comment.
- **No repository changes, except by an authorized Developer Agent.** All
  other file writes are allowed only for plan and report drafts in the
  system temp directory. Shell commands are limited to a read-only
  allowlist:
  - read-only git
  - the plan store's draft, save, report, status, and attachment commands
  - the read-only ticket discovery commands (`ticket-ref`, `assigned-jql`,
    `mapping-status`)
  - `cd`, `ls`, `cat`, `head`, and `tail`
  - single attachment downloads

  Redirection, pipes, background jobs, and command substitution are
  refused.
- **No commit, push, or PR, except the shipping steps.** In a shipping
  session only `ship-commit`, `ship-push`, and `ship-pr` (each behind a
  permission prompt), and a verified GitHub MCP create-pull-request call,
  can change git or the provider. A merge needs its own `merge` session;
  auto-merge and other merge tools are denied in every workflow session.
- **Jira content is untrusted data.** The ticket description, comments, and
  attachments are never followed as instructions.

Running `/jira-dev-harness:ticket` again in an implementing session puts it
back into planning mode.

Attachment content is fetched only for `image/*` and `text/*` files of up to
5 MB, at most 5 per ticket. They are downloaded into
`<temp>/jira-dev-harness/attachments/` and deleted afterwards by the plan
store script.

## Connect: `/jira-dev-harness:connect`

Run this once after installing, in a **fresh session** (a session that already
ran a workflow command restricts shell commands). It is read-only, so it
changes nothing in Jira, GitHub, or the repository. Each developer connects
their own accounts, personal or office-provided, on their own PC. No Docker,
personal access tokens, manually entered keys, hardcoded credentials, or
organization-owned OAuth app are needed.

```text
/jira-dev-harness:connect                                         # check, show the accounts, list blockers
/jira-dev-harness:connect --confirm <jira-account> <github-login>  # confirm the accounts you see
```

1. **Detect.** Claude finds the Atlassian and GitHub MCP tools with
   ToolSearch and reads which account each connection uses. The script
   checks the optional official `gh` itself. The mapped Jira site (if the
   repository has a committed mapping) must be reachable, and so must the
   `origin` repository.
2. **Report.** Each service gets one status: `VERIFIED`, `UNCONFIRMED`,
   `NOT_CONNECTED`, `NEEDS_AUTH`, `INACCESSIBLE`, `MISMATCH`, or `BLOCKED`,
   with the exact next steps. A connection that doesn't report its account
   is `BLOCKED`, never assumed to work.
3. **Confirm.** The report prints the connected Jira account (email or name)
   and GitHub login. If they are the ones you intend to use, type the
   `--confirm` command with those exact values. Only your typed command
   records the confirmation, for that session only, and the plugin's guard
   keeps Claude from recording it. `CONNECTIONS: READY` is printed only when
   both live accounts match what you typed. When both a GitHub MCP connection
   and `gh` are signed in, they must be the same account.

**GitHub routes.** MCP first: `claude mcp add --transport http github
https://api.githubcopilot.com/mcp/`, then `/mcp` to sign in. GitHub's
documented setup for that server in Claude Code uses a personal access token,
and browser sign-in may not be supported, in which case `/mcp` reports an
incompatible auth server. The plugin never asks for a token. The fallback is
the official GitHub CLI with browser sign-in: `gh auth login --web`. The
plugin works with either.

**Credential isolation is not guaranteed by READY.** The report states what
is known about each connection:

- A **claude.ai connector** belongs to the Claude account, not the PC. A
  shared Claude account shares it, and the plugin cannot see whose
  credentials it holds. `connect` warns about it. For per-PC connections,
  add the server with `claude mcp add` and sign in through `/mcp`.
- A server added with `claude mcp add`, and the official `gh`, keep their
  sign-in on the PC, per operating-system user. Developers sharing one OS
  user share them (and the plan store and approval key).
- A connection whose source can't be identified gets no isolation claim.

`ticket` and `ship` run a lightweight preflight that only looks for the tools
(`ticket` stops without a Jira connection, `ship` stops before committing
without a GitHub route). It does not identify accounts and replaces none of
the approval gates.

## Jira connection setup

The plugin contains no Jira credentials, sites, or connection settings. It
uses your own authenticated connection to the official
[Atlassian Rovo MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/),
and Jira enforces your normal permissions.

Set up one of these, once:

- **claude.ai connector:** in claude.ai, go to Settings, then Connectors, and
  connect Atlassian. Claude Code sessions signed in with that claude.ai
  account can then use it.
- **Claude Code MCP server:**

  ```bash
  claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp
  ```

  Then, in an interactive Claude Code session, run `/mcp`, select
  `atlassian`, and sign in through the browser (OAuth 2.1). Claude Code
  stores the token, not the plugin.

If your Atlassian organization restricts the Rovo MCP server, ask an
Atlassian admin to allow it for your account. If authentication expires,
sign in again through `/mcp` or the claude.ai connector settings.

## Project mapping

The workflow never assumes that a Jira project belongs to the open
repository. It runs only when the association is **verified**, so a project
maintainer must commit this file to the project repository, not to the
plugin:

```json
// <repo>/.claude/jira-dev-harness.json
{
  "jira": {
    "site": "your-site.atlassian.net",
    "projectKeys": ["PROJ"]
  }
}
```

The workflow reports the association as:

- **Verified** when git tracks the file unmodified and its site and project
  key match the ticket. The workflow continues.
- **Mismatch** when the file is trusted but the site or project key
  differs. The workflow stops.
- **Unverified** when the file is missing, untracked, modified, or
  malformed. The workflow stops.

### Board and progress mapping (Phase 7)

To use [`jira-sync`](#8-jira-progress-jira-dev-harnessjira-sync), the same
committed file also names the repository's board and how stages map to
statuses. There is no global board: each repository states its own, and
the plugin ships no project, board, or status names.

```json
// <repo>/.claude/jira-dev-harness.json
{
  "jira": {
    "site": "your-site.atlassian.net",
    "projectKeys": ["PROJ"],
    "board": { "id": 12, "name": "optional label", "verification": "required" },
    "progress": {
      "comments": true,
      "stages": {
        "implementing": { "toStatuses": ["In Progress"] },
        "awaiting-review-approval": { "toStatuses": ["In Review"] },
        "merged": { "toStatuses": ["Done"], "allowDone": true }
      }
    }
  }
}
```

- **Backward compatible.** A file with only `site` and `projectKeys` still
  works for planning, implementation, review, shipping, and merging. It
  just can't sync progress, because the board is never inferred.
- **The board is verified, not trusted.** The file's board id is checked
  against what Jira returns: the board's identity, that the ticket is on
  it, that its projects include the ticket's project, and that a target
  status is on one of its columns. If the connection can't show this, the
  sync is blocked. `"verification": "workflow-only"` is an explicit,
  committed choice to skip the board and use only the ticket's own
  workflow transitions; every sync then reports that the board was not
  verified.
- **Stages** are `planning`, `awaiting-plan-approval`, `implementing`,
  `in-review`, `awaiting-review-approval`, `pr-created`, and `merged`.
  `toStatuses` lists 1 to 5 status names, tried against Jira's available
  transitions. A stage with no entry only gets a comment. `allowDone` is
  valid only for `merged`.
- **Strict.** Unknown keys, a non-numeric board id, or an unknown stage make
  the mapping invalid, and the sync stops. Check it with
  `plan-store.cjs mapping-check`.
- A mapping that is untracked or modified in the working tree is
  unverified, as before.


## Local testing

Load the plugin for a single session with `--plugin-dir`. Nothing is installed:

```bash
# From inside the project you want to test against
claude --plugin-dir /path/to/jira-dev-harness
```

Then inside the session:

- `/jira-dev-harness:ticket <jira-url | KEY>` runs the analysis and planning
  workflow; with no argument it lists your assigned tickets and waits for
  your choice
- `/jira-dev-harness:approve <ISSUE-KEY> rN <sha256>` approves a plan
  revision
- `/jira-dev-harness:implement <ISSUE-KEY> rN <sha256>` implements an
  approved revision, in attended mode
- `/jira-dev-harness:review <ISSUE-KEY>` reviews the implementation and
  writes the HTML test report
- `/jira-dev-harness:approve-review <ISSUE-KEY> rv-N <sha256>` approves a
  current PASS review
- `/jira-dev-harness:ship <ISSUE-KEY> rv-N <sha256>` commits, pushes, and
  opens the pull request
- `/agents` lists the four agents under `jira-dev-harness:`: Analyzer,
  Planner, Developer, and Reviewer
- `/reload-plugins` picks up edits without restarting

Validate the manifest, skill, and agents from your shell:

```bash
claude plugin validate /path/to/jira-dev-harness
claude plugin validate /path/to/jira-dev-harness --strict   # warnings fail, for CI
```

`claude plugin details <name>` (component inventory) only works for
installed plugins, not for a `--plugin-dir` path.

Run the automated tests (Node 18 or later; they use throwaway repositories
and a local bare "origin", with no network or account):

```bash
node --test                              # Phases 6-8: approval, ship, merge, providers, Jira sync, connect, ticket discovery, guard
node tests/legacy/guard-tests.cjs        # guard rules (60)
node tests/legacy/phase4-tests.cjs       # implement authorization and Developer boundaries (74)
node tests/legacy/phase5-tests.cjs       # review facts, checks, enforcement, staleness (68)
```

The legacy suites write to a `jira-dev-harness-unittest` directory under
the plugin data root, never to your real store. Nothing in the tests uses a
real GitHub account or token.

Non-interactive smoke test:

```bash
claude --plugin-dir /path/to/jira-dev-harness -p "/jira-dev-harness:ticket https://example.atlassian.net/browse/ABC-123"
```

Headless `-p` runs cannot answer permission prompts, so the Developer Agent
cannot change files in `-p` mode. That is intentional. To automate the
plugin's own tests, a test host can answer prompts through Claude Code's
`--permission-prompt-tool stdio` protocol. See the ROADMAP Phase 4 notes.

## Architecture

```text
jira-dev-harness/
├── .claude-plugin/
│   └── plugin.json          # Manifest: name, version, metadata
├── skills/
│   ├── ticket/
│   │   ├── SKILL.md         # /jira-dev-harness:ticket: mapping, rules, profile, Analyzer, Planner, save, gate
│   │   └── jira-read.md     # Read-only Jira retrieval steps, errors, and setup
│   ├── approve/
│   │   └── SKILL.md         # /jira-dev-harness:approve: developer-only plan approval
│   ├── implement/
│   │   └── SKILL.md         # /jira-dev-harness:implement: authorize, delegate to Developer, save report
│   ├── review/
│   │   └── SKILL.md         # /jira-dev-harness:review: facts, recorded checks, Reviewer, HTML test report
│   ├── approve-review/
│   │   └── SKILL.md         # /jira-dev-harness:approve-review: developer-only approval of a PASS review
│   ├── ship/
│   │   └── SKILL.md         # /jira-dev-harness:ship: commit, push, pull request
│   ├── connect/
│   │   └── SKILL.md         # /jira-dev-harness:connect: per-developer connection check, identity confirmation
│   ├── jira-sync/
│   │   └── SKILL.md         # /jira-dev-harness:jira-sync: verified, audited Jira progress update
│   └── merge/
│       └── SKILL.md         # /jira-dev-harness:merge: separately authorized, provider-verified merge
├── agents/
│   ├── analyzer.md          # Sonnet, read-only: requirements against rules and code
│   ├── planner.md           # Sonnet, read-only: returns the ticket-specific plan
│   ├── developer.md         # Sonnet: implements one authorized plan, attended
│   └── reviewer.md          # Opus, read-only, fresh context: independent review as JSON
├── hooks/
│   └── hooks.json           # Always-on PreToolUse guard (all sessions, subagents, resume, fork) + merge-evidence recorder
├── scripts/
│   ├── plan-store.cjs       # Revisions, sessions, approvals, implementation, reviews (Node, no deps)
│   ├── guard.cjs            # Store protection, Developer policy, read-only agents, workflow rules
│   ├── evidence.cjs         # PostToolUse: records GitHub MCP read responses in merge sessions
│   ├── connect.cjs          # connect: records the typed confirmation, checks official gh, prints the report
│   └── lib/
│       ├── connections.cjs  # connection status rules, source and isolation claims, READY rule
│       ├── approval.cjs     # Shared verification used by plan-store and guard
│       ├── review.cjs       # Review facts, run-check evidence, verdict rules, staleness
│       ├── render-review.cjs # Safe standalone HTML and Markdown test report
│       ├── review-approval.cjs # Signed review approval and its binding checks
│       ├── ship.cjs         # Gated commit, push, and pull request steps
│       ├── jira-mapping.cjs # Per-repository board and stage mapping, strictly validated
│       ├── jira-gate.cjs    # Jira evidence gate: board, workflow, and write checks
│       ├── jira-sync.cjs    # Jira sync session: start, plan, confirm
│       ├── progress.cjs     # Stage from signed records, comment text, audit ledger
│       ├── discover.cjs     # Assigned-ticket discovery: fixed JQL, ticket-reference parsing, mapping verdict (read-only)
│       ├── merge.cjs        # Merge authorization, evidence store, gh and MCP routes
│       ├── merge-gate.cjs   # Pure gate over raw provider responses; fails closed
│       └── provider.cjs     # GitHub adapters: MCP tool classification, official-gh CLI
├── tests/
│   ├── helpers.cjs          # Disposable repositories, bare origin, guard runner
│   ├── legacy/              # Phase 1-5 standalone suites: guard, phase4, phase5
│   ├── phase6.test.cjs      # approval, ship, provider, and guard cases
│   ├── merge.test.cjs       # merge gate, evidence hook, guard, mocked providers
│   ├── jira.test.cjs        # Jira mapping, gate, stages, ledger, hook, guard; mocked Jira
│   ├── connect.test.cjs     # connection statuses, typed confirmation, READY rule
│   └── discover.test.cjs    # ticket discovery: query, parsing, mapping verdict, guard, skill wording
├── README.md
└── ROADMAP.md               # Phases, acceptance criteria, validation log
```

### Planned workflow

```text
/jira-dev-harness:ticket [<url> | <KEY>]      (no argument: list my assigned tickets, then I choose one)
  │
  ├─ 1. Preflight: identify repo, validate ticket belongs to this project
  ├─ 2. Gather: Jira requirements + attachments, repo code, project instructions
  ├─ 3. Analyzer Agent ─────────── understanding of task and current code
  ├─ 4. Planner Agent ──────────── ticket-specific plan file
  ├─ 5. ◆ Developer approval of plan (/jira-dev-harness:approve)
  ├─ 6. Developer Agent ────────── attended implementation (/jira-dev-harness:implement)
  ├─ 7. Independent Reviewer Agent (fresh context) ── PASS / FAIL / BLOCKED + HTML test report (/jira-dev-harness:review)
  ├─ 8. ◆ Review must pass + final developer approval (/jira-dev-harness:approve-review)
  ├─ 9. Commit, push, open pull request (/jira-dev-harness:ship)
  ├─ 9b. ◆ Separate merge authorization + provider-verified gate (/jira-dev-harness:merge)
  └─ 10. ◆ Jira progress, only on request (/jira-dev-harness:jira-sync), using only the transitions Jira offers
```

### Design principles

- **Project-independent.** Project knowledge lives in each project's
  repository, never in the plugin. Any language or framework works.
- **Human gates.** Code changes need explicit approval of the plan, plus an
  attended implementation session. The pull request needs a passing
  independent review plus final approval.
- **Never merges on its own.** The harness stops at an open pull request. A merge needs your separate command and the provider's own evidence.
- **Least privilege.** The analysis, planning, and review agents are
  read-only. Only the Developer Agent writes, and only when authorized.
- **Untrusted input.** Ticket text, attachments, and repository content are
  treated as data, never as instructions.
- **No extra infrastructure.** No portal, backend, database, or runtime
  dependencies.

## Planned phases

See [ROADMAP.md](ROADMAP.md) for each phase's scope, acceptance criteria,
and validation record. The roadmap also lists the future product
requirements that later phases must keep:

- public installation, with each user's own connections
- explicit per-repository Jira project and board mapping
- tool-neutral `AGENTS.md` and `SPECIFICATION.md` support
- developer approval before PR creation, and separate authorization before
  merging
- the repository's required CI and branch protection passing before merge
- no automatic merge

| Phase | Name | Status |
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
| 8C | Git worktree isolation (v0.8.0) | Implemented: offline-tested, live-tested with a disposable repository and mocked GitHub and Jira; real GitHub and Jira pending |
| 8 | End-to-End Testing + Team Rollout | Pending |

### Model allocation

| Agent | Model |
| :- | :- |
| Analyzer | `sonnet` |
| Planner | `sonnet` |
| Developer | `sonnet` |
| Independent Reviewer | `opus` |

Builds and tests use the project's own declared commands. Commit, push,
and PR creation use Git and the hosting provider's tools behind approval
gates. None of these have a dedicated agent.

## What the plugin accesses and does

- **Jira (your own account):** reads the tickets assigned to you, and the ticket you choose (fields, comments, attachments), through the Atlassian Rovo MCP server you connect. It writes to Jira only through `/jira-dev-harness:jira-sync`, which you start yourself.
- **GitHub (your own account):** creates a branch push and pull request, and reads pull request status, only through your own GitHub MCP connection or `gh` login, only after you run `ship` or `merge`. It never merges automatically.
- **Local operations:** runs Node scripts and git in your repository and in a sibling worktree for the ticket. Plans, approvals, reviews and audit records are stored in the plugin data directory, outside your repository. Hooks (`hooks/hooks.json`) check every file, shell and MCP action against the approved plan.
- **Credentials:** the plugin never asks for, reads, stores or logs tokens or passwords. You sign in to Jira and GitHub yourself.
- **Claude Artifact publishing (optional, consent-based):** after a review, Claude may offer to publish a sanitized, script-free copy of the review report to claude.ai with the `Artifact` tool. It happens only if you approve the permission prompt. The artifact starts private, contains no local paths, logs or credentials, and is never what you approve. Nothing else is uploaded.
- **Jira writes:** outside a `jira-sync` session, any Atlassian write (comment, transition, edit, create) still needs your explicit permission prompt, and is refused when no prompt is possible (bypass or don't-ask mode). Reads are unaffected. If the guard itself fails, the call is blocked.
- **No other network calls:** the plugin makes no calls of its own to any other service.

## Security notes

- Jira is read and written only through your own authenticated Atlassian
  Rovo MCP connection, and written to only by `jira-sync`. The plugin stores
  no credentials, tokens, or site names.
- The plugin has two kinds of hook, in `hooks/hooks.json`. The
  `PostToolUse` and `PostToolUseFailure` hook, `scripts/evidence.cjs`, only
  records GitHub MCP reads during a merge session, and Atlassian MCP reads
  plus the audit entries of Jira writes during a `jira-sync` session. The `PreToolUse` hook runs `scripts/guard.cjs`
  before every Write, Edit, Read, Grep, Glob, shell, and MCP tool call,
  while the plugin is enabled. It applies in the main conversation,
  subagents, resumed sessions, and forked sessions, and costs one short
  Node process per call. Each Developer write also runs a few git commands
  to re-verify the authorization. It enforces:
  - **In every session:** Claude's tools cannot write to the plan store,
    read the approval key, or run the store's `approve`, `session-start`,
    or `implement-start` commands.
  - **The Developer Agent** writes only in an implementing session, in
    the default permission mode, with a re-verified authorization, inside
    the approved repository, and with a prompt for every edit.
  - **The other plugin agents**, including the Reviewer, can never write,
    run shell commands, or use MCP write tools.
  - **Shipping steps** (`ship-commit`, `ship-push`, `ship-pr`) always
    need a permission prompt and attended mode, and re-verify every gate
    themselves. `approve-review` and `ship-start` can't be run by Claude.
    A GitHub MCP create-pull-request call must match the prepared values.
    A GitHub MCP merge-pull-request call must match the authorized pull
    request, head SHA, and method, and pass the merge gate. Auto-merge and
    other merge tools are denied in every workflow session.
  - **Jira writes** happen only in a `jira-sync` session, only as the one
    planned transition and one planned comment on the authorized ticket,
    only in attended mode with a permission prompt, only when the plan
    still passes on fresh recorded Jira responses, and never twice.
    `jira-start` can't be run by Claude, and the audit ledger can't be
    written by Claude's tools.
  - **Review checks** run only through `plan-store.cjs run-check`, always
    with a permission prompt, and only in attended mode.
  - **In workflow sessions:** no Jira or other MCP writes, no repository
    writes by anyone else, and only the read-only shell allowlist.

  Sessions where you never ran a workflow command are otherwise
  unaffected.
- Ticket content is treated as untrusted. Secrets that appear in tickets are
  redacted in the report.
- Signed attachment download URLs are short-lived and read-only, but they
  appear in the session transcript.
- GitHub is reached only through your own GitHub MCP connection or your own
  signed-in official `gh`, and Git uses your own transport. The plugin
  stores no credentials and refuses an `origin` URL that embeds them.
- The scripts in `scripts/` use only Node's standard library. The plugin
  ships no executables, MCP servers, or dependencies.

## Security model

What the plugin can and cannot guarantee:

**What it enforces:**

- **Only your keystrokes start approvals and implementation.** The ticket,
  approve, and implement skills use `disable-model-invocation`, so Claude
  Code refuses to let Claude invoke them. Their injected commands record
  sessions, approvals, and implementation authorizations. They run only
  when you type the slash command, and the guard denies Claude's own tools
  any route to the same commands or files.
- **Approvals are tamper-evident.** Editing an approval, a plan, or the
  binding fields, or writing a record by hand without the key, makes
  verification fail. So does copying an approval to another revision or
  repository.
- **Every Developer edit is a human decision.** The guard returns `ask`,
  which makes Claude Code show you a permission prompt even when allow
  rules exist. It refuses Developer writes outright in `acceptEdits`,
  `auto`, and `bypassPermissions` mode. These per-edit prompts are the
  human-presence check; the approval record is not.
- **Restrictions don't depend on the conversation.** The workflow state is
  on disk and is checked by an always-on hook, so it survives resume and
  fork and applies inside subagents.

**What it cannot guarantee:**

- **Hooks do not prove human identity.** Everything runs as your operating
  system user. Any process that can read the HMAC key, which is a file in
  the plugin data directory, can forge a valid approval. That includes a
  shell command that slips past the pattern-based guard. This was
  demonstrated during testing, from outside Claude's guarded tools. So an
  approval record shows that the approve command ran, not who ran it.
- **The guard is pattern-based, not a sandbox.** A deliberately disguised
  command, a tool the guard doesn't know about, or a script run by an
  allowed command could get past it. Disabling the plugin, or using
  `--plugin-dir` without it, removes the guard entirely.
- **Project commands you approve run with your full rights.** A test,
  build, or script that you allow at a prompt can read or write anything
  your user can, including outside the repository. The write boundary
  applies only to Claude's file tools. Read the command in each prompt
  before allowing it.
- **The worktree is an isolation of the work, not a sandbox.** The
  Developer's shell commands must start with `cd "<worktree>" &&`, and the
  guard refuses a later directory change or git pointed elsewhere. That
  only decides where a command starts. A command can still name absolute
  paths, `..`, or the main checkout in its arguments, and a script it runs
  can do anything, so the per-command prompt remains the real control.
  Likewise, the protection of managed worktrees matches command patterns
  and can be bypassed by a disguised command. Untrusted repositories can also run code through git
  configuration, for example diff drivers.
- **A review verdict is only as good as its evidence.**
  - Only checks you approved are executed.
  - Missing tools or pre-existing failures prevent a PASS instead of being
    hidden.
  - The Reviewer's JSON passes through the coordinating model before the
    plugin enforces the rules on it. The rules limit what it can claim, but
    can't prove it was copied verbatim.
  - Log redaction is pattern-based.
- **Merge evidence is only as trustworthy as its source.** On the MCP
  route it is what your own GitHub MCP connection returned, recorded by a
  hook; a connection or server that lies defeats it. The gate also cannot
  see rules the provider doesn't expose to your account, and the head-SHA
  pin on the MCP route depends on the tool exposing one. The merge itself
  is done by the provider, which enforces its own protections again.
- **Jira evidence is only as trustworthy as the connection.** A hook
  records what your Atlassian MCP connection returned. A server that
  lies, or a rogue MCP server defined by an untrusted repository's
  `.mcp.json` and named like Atlassian, could feed forged responses; the
  permission prompt and Jira's own permission checks are the last line.
  A tool returning is not proof that Jira changed: `jira-confirm` checks
  a later read, and reports `UNCONFIRMED` otherwise.
- **A review approval is a record, not an identity.** It is signed with
  the same local key as plan approvals, so everything above applies to it
  too. What it adds is binding: it covers the exact review, report, tree,
  and file contents, so a later edit, a rerun, or another repository can't
  reuse it. The permission prompts on commit, push, and pull request
  creation are what check that a human is present. They don't exist in
  `acceptEdits`, `auto`, or `bypassPermissions` mode, so the guard
  refuses those steps there. A prompt that you click through without reading
  is not a control.
- **Push protection is partial.** The plugin refuses the default branch and
  conventional protected names. It can't read the server's branch-protection
  rules without a provider call, so the server's rules remain the real
  enforcement. Hooks that your project runs on commit and push run with your
  rights.
- **Credential detection is pattern-based.** The commit step refuses added
  lines that look like private keys or common token shapes, and file names
  that usually hold secrets. It isn't a secret scanner.
- **The MCP route is as trustworthy as the connection.** A pull request
  URL that Claude reports after an MCP call is recorded as "reported", and
  the plugin can only check that it belongs to the repository. The optional
  `gh` check rejects impostors and can't authenticate the binary.
- **No unattended writes.** Implementation must happen in an attended
  session with per-edit prompts until a trusted external approval
  mechanism exists. An external mechanism would be, for example, a
  signature that needs a hardware key and the user's physical presence, or
  an approval given in a system the agent cannot act as. Phase 6 did not
  add one; see ROADMAP.

## License

[MIT](LICENSE)
