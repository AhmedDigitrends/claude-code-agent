---
description: Approve one exact, current, passing jira-dev-harness review artifact for the current repository. Only the developer can run this; Claude cannot invoke it. It runs no git command.
argument-hint: <ISSUE-KEY> <review-id> <full-sha256>
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" approve-review *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" approve-review *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" review-status *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" review-status *)
---

# Review approval

The developer ran `/jira-dev-harness:approve-review $ARGUMENTS` in this
repository. The plan store checked the request and printed this verdict
before you were invoked:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-store.cjs" approve-review "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" $ARGUMENTS`

## What to do

Report the verdict above to the developer, word for word, and explain it
briefly:

- **REVIEW APPROVAL: GRANTED.** The approval is signed and bound to:
  - this repository and ticket
  - the approved plan revision and its SHA-256
  - the implementation report and its SHA-256
  - this exact review file and its HTML report
  - the current git HEAD, the diff, and the content hash of every changed
    file listed in the verdict

  Any further change to the code, the plan, the report, or the review
  invalidates it. It does **not** commit, push, or open a pull request. To
  do that, the developer runs the `/jira-dev-harness:ship` command that the
  verdict printed.
- **REVIEW APPROVAL: ALREADY GRANTED.** The same review was approved
  earlier, and nothing changed.
- **REVIEW APPROVAL: REFUSED.** Nothing was approved. Explain each printed
  reason and how to fix it. For example:
  - the review is FAIL or BLOCKED, so the findings go back to a new
    `/jira-dev-harness:implement` and `/jira-dev-harness:review`
  - the review is stale because the code, plan, or report changed, so a new
    review is needed
  - the review is not the latest one, the SHA-256 is wrong or shortened, or
    the review or its report, logs, or bundle were edited
  - the review predates Phase 6 and is unsigned, so it must be re-run

Remind the developer that the HTML report is the artifact they are
approving, and that a summary from Claude is not. If they have not opened
it, the path is in the review step's output; `review-status` shows the
review's SHA-256 and whether an approval is recorded.

Do not take any other action. Do not run git. Do not create, edit, or
delete files, and do not try to approve anything yourself.
