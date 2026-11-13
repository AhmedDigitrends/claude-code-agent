# Privacy Policy: Jira Dev Harness

Effective date: 2026-11-13. Applies to the `jira-dev-harness` Claude Code plugin, version 1.0.0.

Jira Dev Harness runs entirely on the developer's own computer, inside Claude Code. The maintainers do not operate a server, do not receive any data from the plugin, and have no account, analytics or telemetry system. This document describes what the plugin does with data on your machine and which services it can reach through connections you set up yourself.

## Summary

- The plugin makes **no network requests of its own** and has no telemetry, analytics, crash reporting or update check.
- It never asks for, reads, stores or logs passwords, tokens or API keys. You sign in to Jira and GitHub yourself, using your own accounts.
- Workflow records are written **locally**, outside your repository, and are kept until you delete them.
- Sharing a review report to claude.ai is **optional**, needs your explicit approval each time, and uploads only a sanitized copy.

## Personal data the plugin handles

The plugin does not collect personal data for the maintainers. While you use it, the following can exist **on your machine**:

| Data | Where it comes from | Where it is kept |
| :- | :- | :- |
| Ticket content: key, summary, description, acceptance criteria, comments, attachment metadata (these can contain names or email addresses written by other people) | Your own Jira connection (Atlassian Rovo MCP), read by Claude | Plans, reports and reviews in the local plan store |
| The Jira account (email or name) and GitHub login you type into `/jira-dev-harness:connect --confirm` | You | `connect/<session>.json` in the plugin data directory |
| Full Jira and GitHub MCP read responses | Your connections, during a `jira-sync` or `merge` session only | Local evidence records in the plugin data directory |
| Local paths (these usually include your operating-system user name), repository identity and branch names | Your computer | Plans, session state, review bundles, worktree records |
| Source code diffs and the output of checks you run | Your repository | Review bundles (`diff.patch`, check logs). Credential-shaped text is masked, but personal data is not |
| Audit entries of Jira writes you authorized | The plugin | `progress/<site>/<KEY>/ledger.jsonl` |

The plugin does not store your Jira or GitHub passwords or tokens. Credentials for those services stay in Claude Code's own MCP sign-in storage or in the GitHub CLI's own store, which this plugin does not read.

## Local storage

Records are written to the plugin data directory (`~/.claude/plugins/data/<plugin id>/`), never to your repository: plans, approvals, implementation reports, review bundles and reports, connection confirmations, workflow session state, worktree bindings, evidence records and the audit ledger. The directory also holds `keys/approval.key`, a random key the plugin generates on your machine to sign approvals; it is not a credential for any service and is never transmitted.

Temporary files (for example an attachment download directory, or a pull request body) are created in your system temporary directory and removed by the plugin when the step finishes.

## Optional sharing to claude.ai

After a review, Claude may offer to publish a sanitized copy of the review report as a claude.ai **Artifact**, using Claude Code's own `Artifact` tool.

- **Consent:** the plugin's guard always shows a permission prompt, allows only the one file `review-<id>.share.html`, and only from the review session. If you decline, nothing is uploaded.
- **Destination:** claude.ai, which is operated by Anthropic. The plugin only records the claude.ai URL that the Artifact tool returns.
- **What is uploaded:** the ticket key, review id, plan revision, review time, the verdict and reasons, acceptance criteria, test cases and steps, check names and results, findings, and the review SHA-256.
- **What is left out:** raw check logs, check commands, local file paths, the repository location and remote, URLs, email addresses, scripts that send data anywhere, and credential-shaped text.
- **Limitation:** the report's free text comes from the ticket and the reviewer. The plugin masks credentials, paths, URLs and email addresses (shown as `[email removed]`), but it does **not** detect personal names. Do not publish a report if you do not want such text shared.
- **Visibility:** an artifact starts private. Whether anyone else can open it is your choice on claude.ai and may depend on your organization's settings.
- **Manual QA notes** typed into the page are kept only in the viewing browser's local storage and are never sent anywhere by the plugin.
- A recorded artifact link may be added to the description of a pull request you ask the plugin to create. Only the link is added, not the report.

## Third-party services

The plugin never connects to these services itself. They are reached through tools you connect and authorize:

| Service | How it is reached | Purpose |
| :- | :- | :- |
| Atlassian (Jira Cloud) | Your Atlassian Rovo MCP connection | Read tickets assigned to you; write only through `/jira-dev-harness:jira-sync`, which you start |
| GitHub | Your GitHub MCP connection or the official `gh` CLI signed in as you; `git push` over your own git transport (SSH key or credential helper) | Push the ticket branch, create and read pull requests |
| claude.ai (Anthropic) | Claude Code's `Artifact` tool | Optional review-report sharing, described above |
| Jira attachment hosts | `curl` of a single `https://` download link returned by the Jira connection. It runs without a prompt only if the host is exactly `api.media.atlassian.com` or the Jira site named in the repository's committed mapping | Fetch image or text attachments of a ticket you chose, into a temporary directory |

Anthropic's handling of your conversations with Claude Code is governed by Anthropic's own terms and privacy policy (https://www.anthropic.com/legal/privacy), not by this document.

## Credentials

- The plugin contains no credentials and asks you for none. It never asks you to paste a token.
- It does not read SSH keys, `.env` files, `.npmrc` or similar. Filenames of that kind are only matched by name, to warn you or to stop a commit or worktree removal.
- Credential-shaped strings are masked in saved logs and diffs, and a commit is refused if added lines look like credentials or private keys.
- Child processes the plugin starts (`git`, `gh`, and the project checks you approve) inherit your normal environment, as they would in your terminal. The plugin does not read or record that environment.
- Claude's own tools are blocked from reading the plugin's signing key.

## Retention and deletion

- **Local records:** kept until you delete them. The plugin never deletes your plans, reviews or audit records, and offers no automatic expiry. To remove everything, delete the plugin data directory `~/.claude/plugins/data/<plugin id>/` (and the sibling ticket worktrees, using `/jira-dev-harness:worktree-remove`). Deleting a ticket's folder under `plans/<site>/<KEY>/` removes that ticket's plans and reviews.
- **claude.ai artifacts:** stored and retained by Anthropic under its terms. You can delete an artifact you published from claude.ai. The plugin has no command to unpublish.
- **Pull request text and Jira comments** you authorize are stored by GitHub and Atlassian under their policies, and are not removed by this plugin.
- **The maintainers hold no copy** of any of this data.

## Children

The plugin is a developer tool and is not directed at children.

## Changes and contact

Changes to this policy are published in this file, with the version of the plugin they apply to. Questions or concerns: open an issue at https://github.com/AhmedDigitrends/claude-code-agent/issues.
