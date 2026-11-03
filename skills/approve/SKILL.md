---
description: Approve one exact revision of a jira-dev-harness implementation plan for the current repository. Only the developer can run this; Claude cannot invoke it.
argument-hint: <ISSUE-KEY> <rN> <full-sha256>
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" approve *)
---

# Plan approval

The developer ran `/jira-dev-harness:approve $ARGUMENTS` in this
repository. The plan store checked the request and printed this verdict
before you were invoked:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" approve "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" $ARGUMENTS`

## What to do

Report the verdict above to the developer, word for word, and explain it
briefly:

- **APPROVAL: GRANTED.** The approval is signed and bound to:
  - this exact revision and its full SHA-256
  - this ticket
  - this repository: its path, root commit, and origin

  A new revision, an edit to the plan file, or running from another
  repository invalidates it. To implement the plan, the developer runs the
  `/jira-dev-harness:implement` command that the verdict printed, in
  attended mode. That command re-verifies the approval, and the guard
  re-checks it on every write.
- **APPROVAL: ALREADY GRANTED.** That revision was approved earlier, and
  nothing changed.
- **APPROVAL: REFUSED.** Nothing was approved. Explain the reason that was
  printed and how to fix it. For example:
  - the developer approved an older revision, used a wrong or shortened
    hash, or approved from a different repository
  - the plan is BLOCKED
  - the repository mapping is no longer committed
  - the plan file changed after it was saved

Remind the developer that the plan file itself, at the path the save step
printed, is what they approved. A summary from Claude is not the approved
artifact.

Do not take any other action. Do not create, edit, or delete files, and do
not try to approve anything yourself.
