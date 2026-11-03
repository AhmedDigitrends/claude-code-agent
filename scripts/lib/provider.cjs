// Git hosting provider support for the shipping workflow.
//
// Provider-specific operations sit behind two adapters with the same
// capability names:
//
// - The MCP adapter is the preferred one. MCP tools can only be called by
//   Claude, never by a script, so this adapter has no executor here. It
//   classifies the tools the developer's own GitHub MCP connection exposes
//   (by name, at call time) and checks that a create-pull-request call
//   carries exactly the values the plugin prepared. It never invents tool
//   names: a tool that the connection does not expose is simply unavailable.
// - The GitHub CLI adapter is optional. It runs the official `gh` that the
//   developer already installed and authenticated. It never reads, stores,
//   or logs a token, and it refuses executables that do not look like the
//   official CLI.
//
// Merge operations are deliberately absent from both adapters.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./approval.cjs");
const { redact } = require("./review.cjs");

// -------------------------------------------------------------- remote

// Splits a git remote URL into host, owner, and repository name. Returns
// null for anything that is not a recognisable hosted-repository URL.
function parseRemote(url) {
  const s = String(url || "").trim();
  let m = /^(https?):\/\/([^/@\s]+@)?([^/:\s]+)(?::[0-9]+)?\/([^/\s]+(?:\/[^/\s]+)*?)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (m) return { host: m[3].toLowerCase(), owner: m[4], name: m[5], hasCredentials: !!m[2] };
  m = /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::[0-9]+)?\/([^/\s]+(?:\/[^/\s]+)*?)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (m) return { host: m[1].toLowerCase(), owner: m[2], name: m[3], hasCredentials: false };
  m = /^(?:[^@/\s]+@)?([^/:\s]+):([^/\s][^\s]*?)\/([^/\s]+?)(?:\.git)?$/.exec(s);
  if (m) return { host: m[1].toLowerCase(), owner: m[2], name: m[3], hasCredentials: false };
  return null;
}

// GitHub.com, or a host that the repository's committed mapping lists under
// "git.githubHosts" (for GitHub Enterprise). Nothing else is assumed.
function detectProvider(remote, repoRoot) {
  if (!remote) return null;
  if (remote.host === "github.com") return "github";
  const mapping = L.readJson(path.join(repoRoot, L.MAPPING_FILE));
  const hosts = mapping && mapping.git && Array.isArray(mapping.git.githubHosts) ? mapping.git.githubHosts : [];
  return hosts.map((h) => String(h).toLowerCase()).includes(remote.host) ? "github" : null;
}

function repoSlug(remote) {
  return `${remote.owner}/${remote.name}`;
}

// ------------------------------------------------------------ MCP adapter

// Returns "createPullRequest", "mergePullRequest", "otherMerge", or null for
// an MCP tool name of the form mcp__<server>__<tool>. A plain merge-pull-
// request tool on a GitHub server is "mergePullRequest" (allowed only in a
// merge session). Any other tool with "merge" in its name (auto-merge, merge
// queue, branch merge) is "otherMerge" and is never allowed.
function classifyMcpTool(toolName) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(toolName || ""));
  if (!m) return null;
  const [, server, tool] = m;
  if (/merge/i.test(tool)) {
    return /github/i.test(server) && /^merge[_-]?(pull[_-]?request|pr)$/i.test(tool) ? "mergePullRequest" : "otherMerge";
  }
  if (/github/i.test(server) && !/review|comment|reply|thread|template|list|get|search|read/i.test(tool)
      && (/^(create|open)[_-]?(pull[_-]?request|pr)$/i.test(tool) || /^(pull[_-]?request|pr)[_-]?(create|open)$/i.test(tool))) {
    return "createPullRequest";
  }
  return null;
}

const pick = (input, names) => {
  for (const n of names) if (input[n] !== undefined && input[n] !== null) return { name: n, value: input[n] };
  return null;
};

// Why a create-pull-request call may not proceed, or null. Every field the
// tool exposes under a known name must equal what the plugin prepared; the
// head, base, title, and body fields must all be present.
function mcpCreatePrProblem(state, input) {
  if (!state || state.mode !== "shipping") return "no shipping authorization in this session";
  if (state.stage !== "pushed") return `the branch has not been pushed yet (stage: ${state.stage})`;
  if (!state.prepared) return "the pull request text has not been prepared; run ship-prepare-pr first";
  input = input || {};
  const head = pick(input, ["head", "head_branch", "source_branch", "branch"]);
  const base = pick(input, ["base", "base_branch", "target_branch"]);
  const title = pick(input, ["title"]);
  const body = pick(input, ["body", "description"]);
  if (!head || !base || !title || !body) {
    return "the tool call does not expose head, base, title, and body fields that the plugin can verify; create the pull request with the GitHub CLI adapter or manually";
  }
  const headName = String(head.value).replace(/^[^:]+:/, "");
  if (headName !== state.branch) return `head must be ${state.branch}, not ${head.value}`;
  if (String(base.value) !== state.base) return `base must be ${state.base}, not ${base.value}`;
  if (String(title.value) !== state.prepared.title) return "the title differs from the prepared title";
  if (L.sha256Of(String(body.value)) !== state.prepared.bodySha256) return "the body differs from the prepared body";
  const owner = pick(input, ["owner", "repo_owner"]);
  const repo = pick(input, ["repo", "repository", "repo_name"]);
  if (owner && String(owner.value).toLowerCase() !== state.remote.owner.toLowerCase()) return `owner must be ${state.remote.owner}`;
  if (repo) {
    const r = String(repo.value).toLowerCase();
    if (r !== state.remote.name.toLowerCase() && r !== `${state.remote.owner}/${state.remote.name}`.toLowerCase()) return `repository must be ${state.remote.name}`;
  }
  return null;
}

// Why a merge-pull-request call may not proceed, or null. The tool must
// expose a field that pins the head commit (so the provider itself refuses a
// merge if the head moved), and every value must be what the developer
// authorized.
function mcpMergeProblem(state, input) {
  if (!state || state.mode !== "merging") return "no merge authorization in this session";
  input = input || {};
  const number = pick(input, ["pullNumber", "pull_number", "pr_number", "number"]);
  const sha = pick(input, ["sha", "expected_head_sha", "head_sha", "expectedHeadSha", "match_head_commit"]);
  const method = pick(input, ["merge_method", "mergeMethod", "method"]);
  if (!number || !sha || !method) {
    return "the tool call does not expose pull-request-number, head-SHA, and merge-method fields; without a head-SHA field the provider cannot refuse a merge if the branch moved. Merge with the GitHub CLI adapter or in the provider's UI";
  }
  if (Number(number.value) !== state.pr) return `pull request must be #${state.pr}`;
  if (String(sha.value).toLowerCase() !== state.headSha) return `the head SHA must be ${state.headSha}`;
  if (String(method.value).toLowerCase() !== state.method) return `the merge method must be ${state.method}`;
  const owner = pick(input, ["owner", "repo_owner"]);
  const repo = pick(input, ["repo", "repository", "repo_name"]);
  if (!owner || String(owner.value).toLowerCase() !== state.remote.owner.toLowerCase()) return `owner must be ${state.remote.owner}`;
  if (!repo || String(repo.value).toLowerCase() !== state.remote.name.toLowerCase()) return `repository must be ${state.remote.name}`;
  for (const k of ["auto_merge", "autoMerge", "admin", "bypass", "force", "delete_branch"]) {
    if (input[k]) return `${k} is not allowed`;
  }
  return null;
}

// -------------------------------------------------------- GitHub CLI adapter

const SHIMS = /\.(cmd|bat|ps1|vbs|js)$/i;

// Finds an executable on PATH without ever consulting the current
// directory, which Windows would otherwise search first.
function resolveExecutable(name) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

function under(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const looksOfficial = (versionOutput) => /^gh version \d+\.\d+\.\d+/m.test(versionOutput)
  && /https:\/\/github\.com\/cli\/cli\/releases\/tag\/v\d+/.test(versionOutput);

// Identifies the official GitHub CLI. Heuristic only: a program can print
// anything, so this rejects the obvious impostors (npm shims, scripts,
// executables inside the repository or a temp directory, other tools named
// "gh") and cannot authenticate the binary.
function officialGh(repoRoot, host) {
  const exe = resolveExecutable("gh");
  if (!exe) return { ok: false, reason: "the GitHub CLI (gh) was not found on PATH" };
  if (SHIMS.test(exe)) return { ok: false, reason: `${exe} is a script or shim, not the official gh executable` };
  if ((repoRoot && under(repoRoot, exe)) || under(os.tmpdir(), exe)) {
    return { ok: false, reason: `${exe} is inside the repository or a temporary directory; refusing to run it` };
  }
  const v = spawnSync(exe, ["--version"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 15000, windowsHide: true });
  const out = `${v.stdout || ""}`;
  if (v.status !== 0 || !looksOfficial(out)) {
    return { ok: false, reason: `${exe} does not identify itself as the official GitHub CLI (expected "gh version X.Y.Z" and the cli/cli release URL)` };
  }
  const a = spawnSync(exe, ["auth", "status", "--hostname", host], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30000, windowsHide: true, env: ghEnv() });
  if (a.status !== 0) return { ok: false, reason: `gh is not authenticated for ${host}; run "gh auth login" yourself` };
  return { ok: true, exe, version: out.split(/\r?\n/)[0] };
}

function ghEnv() {
  return { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_PAGER: "cat", GH_SPINNER_DISABLED: "1" };
}

function gh(info, args) {
  const r = spawnSync(info.exe, args, { cwd: os.tmpdir(), encoding: "utf8", timeout: 120000, windowsHide: true, env: ghEnv(), maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: redact(r.stdout || "").trim(), stderr: redact(r.stderr || "").trim() };
}

const ghRepo = (remote) => (remote.host === "github.com" ? repoSlug(remote) : `${remote.host}/${repoSlug(remote)}`);

const GhAdapter = {
  name: "github-cli",
  findPullRequest(info, remote, branch) {
    const r = gh(info, ["pr", "list", "--repo", ghRepo(remote), "--head", branch, "--state", "open", "--json", "url,number,baseRefName"]);
    if (r.status !== 0) throw new L.StoreError(`gh pr list failed: ${r.stderr || r.stdout}`);
    try {
      return JSON.parse(r.stdout || "[]")[0] || null;
    } catch {
      throw new L.StoreError("gh pr list returned output that could not be read");
    }
  },
  createPullRequest(info, remote, { base, head, title, bodyFile }) {
    const r = gh(info, ["pr", "create", "--repo", ghRepo(remote), "--base", base, "--head", head, "--title", title, "--body-file", bodyFile]);
    if (r.status !== 0) throw new L.StoreError(`gh pr create failed: ${r.stderr || r.stdout}`);
    const url = r.stdout.split(/\s+/).reverse().find((x) => /^https:\/\/\S+\/pull\/[0-9]+$/.test(x));
    if (!url) throw new L.StoreError(`gh pr create did not print a pull request URL: ${r.stdout}`);
    return url;
  },
  // Read-only GET calls. Returns raw records for the merge gate. A failing
  // call is an absent record (a 404 on protection is evidence of nothing),
  // never a guess.
  mergeEvidence(info, remote, prNumber, base, headSha) {
    const slug = repoSlug(remote);
    const host = remote.host === "github.com" ? [] : ["--hostname", remote.host];
    const get = (endpoint) => {
      const r = gh(info, ["api", "-H", "Accept: application/vnd.github+json", ...host, endpoint]);
      if (r.status !== 0) return null;
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    };
    const b = encodeURIComponent(base);
    const wanted = [
      ["gh api pulls", `repos/${slug}/pulls/${prNumber}`],
      ["gh api pulls/files", `repos/${slug}/pulls/${prNumber}/files?per_page=100`],
      ["gh api pulls/reviews", `repos/${slug}/pulls/${prNumber}/reviews?per_page=100`],
      ["gh api check-runs", `repos/${slug}/commits/${headSha}/check-runs?per_page=100`],
      ["gh api commit status", `repos/${slug}/commits/${headSha}/status`],
      ["gh api branch protection", `repos/${slug}/branches/${b}/protection`],
      ["gh api rules/branches", `repos/${slug}/rules/branches/${b}`],
      ["gh api repository", `repos/${slug}`],
    ];
    const at = new Date().toISOString();
    return wanted.map(([tool, endpoint]) => ({ tool, input: { endpoint }, at, data: get(endpoint) })).filter((r) => r.data !== null);
  },
  mergePullRequest(info, remote, { number, sha, method }) {
    if (!["squash", "merge", "rebase"].includes(method)) throw new L.StoreError(`invalid merge method ${method}`);
    const r = gh(info, ["pr", "merge", String(number), "--repo", ghRepo(remote), "--match-head-commit", sha, `--${method}`]);
    if (r.status !== 0) throw new L.StoreError(`gh pr merge failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  },
  pullRequestChecks(info, remote, number) {
    const r = gh(info, ["pr", "checks", String(number), "--repo", ghRepo(remote)]);
    return { status: r.status, text: r.stdout || r.stderr };
  },
};

// A reported pull request URL must belong to the repository being shipped.
function prUrlProblem(remote, url) {
  const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)$/.exec(String(url || "").trim());
  if (!m) return `${url} is not a pull request URL`;
  if (m[1].toLowerCase() !== remote.host || m[2].toLowerCase() !== remote.owner.toLowerCase() || m[3].toLowerCase() !== remote.name.toLowerCase()) {
    return `${url} does not belong to ${remote.host}/${repoSlug(remote)}`;
  }
  return null;
}

module.exports = {
  parseRemote, detectProvider, repoSlug, classifyMcpTool, mcpCreatePrProblem, mcpMergeProblem,
  resolveExecutable, looksOfficial, officialGh, ghEnv, GhAdapter, prUrlProblem,
};
