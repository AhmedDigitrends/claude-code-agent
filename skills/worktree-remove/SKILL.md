---
description: Remove a jira-dev-harness ticket's sibling git worktree after its work is pushed, with git's own unforced removal. Keeps the ticket branch and every record. Only the developer can run this; Claude cannot invoke it, and the plugin never removes a worktree automatically.
argument-hint: <ISSUE-KEY> [--confirm-ignored <count>] [--end-session <session-id>]...
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" worktree-remove *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" worktree-remove *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" worktree-status *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" worktree-status *)
---

# Remove a ticket worktree (Phase 8C)

The developer ran `/jira-dev-harness:worktree-remove $ARGUMENTS` in the main
checkout. The plan store checked the request and printed this verdict
before you were invoked:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" worktree-remove "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" $ARGUMENTS`

## What to do

Report the verdict above to the developer, word for word, and explain it
briefly.

- **WORKTREE REMOVAL: REMOVED.** git removed the worktree without
  `--force`. The ticket branch is kept, nothing was pruned, and a signed
  removal record was written next to the plan. Every earlier record (plan,
  approvals, reviews, ship record) is kept. A merge of the shipped pull
  request can still be verified with `/jira-dev-harness:merge`.
- **WORKTREE REMOVAL: REFUSED.** Nothing was removed. Explain each reason
  and how the developer can resolve it themselves:
  - uncommitted changes (tracked or untracked): commit and ship them, or
    move them out of the worktree
  - commits that are not on origin: push them with `/jira-dev-harness:ship`
  - sensitive ignored files such as `.env` or keys: the developer moves
    them out of the worktree; the plugin never deletes them
  - other ignored files (for example `node_modules/`): review the printed
    list, then run the command again with exactly the printed
    `--confirm-ignored <count>`. If the files change after they were
    listed, the confirmation is refused and a new list is printed.
  - active implementation, review, or shipping sessions of the ticket:
    finish or close them, then name each one with `--end-session <id>`,
    which switches it to the most restrictive (planning) mode
  - a worktree whose binding is missing, edited, or moved: inspect it; the
    plugin does not remove a worktree it cannot verify

Then stop.

## Hard limits

- Never remove, move, or delete the worktree or its files yourself, and
  never run `git worktree`, `git branch -D`, `rm`, or similar commands. The
  guard denies them for plugin-managed worktrees.
- Never re-run this command yourself, and never add `--confirm-ignored` or
  `--end-session` on the developer's behalf. Only the developer types them.
- You may run the read-only
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" worktree-status "${CLAUDE_PLUGIN_DATA}" <ISSUE-KEY>`
  to show the current state. Do nothing else.
