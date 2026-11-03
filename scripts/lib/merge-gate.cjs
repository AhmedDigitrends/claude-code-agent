// The merge gate: decides from raw GitHub responses whether one pull request
// may be merged. It trusts nothing an agent says. Its inputs are provider
// responses captured by a hook (MCP) or fetched by the plugin itself (gh),
// and anything missing, unparseable, stale, or about a different commit,
// pull request, or repository blocks the merge.
//
// Expected response shapes are GitHub's REST shapes. A connection that
// returns another shape yields "insufficient evidence", never a guess.

"use strict";

const MAX_AGE_MS = 10 * 60 * 1000;

// Text of an MCP tool response, whatever wrapper it has.
const isTextBlocks = (v) => Array.isArray(v) && v.length > 0 && v.every((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string");

function textOf(resp) {
  if (resp == null) return "";
  if (typeof resp === "string") return resp;
  // Claude Code's PostToolUse payload gives an MCP result as a bare array of
  // content blocks, verified live; the MCP protocol wraps it in { content }.
  if (isTextBlocks(resp)) return resp.map((c) => c.text).join("");
  if (Array.isArray(resp.content)) return resp.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("");
  if (typeof resp.text === "string") return resp.text;
  if (resp.structuredContent) return JSON.stringify(resp.structuredContent);
  return JSON.stringify(resp);
}

function jsonOf(resp) {
  if (isTextBlocks(resp)) {
    try {
      return JSON.parse(textOf(resp));
    } catch {
      return null;
    }
  }
  if (resp && typeof resp === "object" && !Array.isArray(resp) && !resp.content && !resp.text && !resp.structuredContent) return resp;
  try {
    return JSON.parse(textOf(resp));
  } catch {
    return null;
  }
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// What kind of GitHub object a response is. Empty lists are classified by the
// tool that returned them, everything else by shape.
function classify(tool, data) {
  const name = String(tool || "").toLowerCase();
  if (Array.isArray(data)) {
    if (/review/.test(name) && !/comment/.test(name)) return "reviews";
    if (/file/.test(name)) return "files";
    if (/rule/.test(name)) return "rules";
    if (data.some((x) => isObj(x) && "filename" in x)) return "files";
    if (data.some((x) => isObj(x) && "state" in x && ("commit_id" in x || "user" in x))) return "reviews";
    if (data.some((x) => isObj(x) && "type" in x)) return "rules";
    return null;
  }
  if (!isObj(data)) return null;
  if (typeof data.number === "number" && isObj(data.head) && isObj(data.base)) return "pr";
  if (Array.isArray(data.check_runs)) return "checks";
  if (Array.isArray(data.statuses)) return "status";
  if (isObj(data.permissions) && typeof data.full_name === "string") return "repo";
  if ("required_status_checks" in data || "required_pull_request_reviews" in data || "enforce_admins" in data) return "protection";
  return null;
}

const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

// A record whose tool input names another repository or pull request is not
// evidence about this one.
function relevant(state, r) {
  const i = isObj(r.input) ? r.input : {};
  const owner = i.owner || i.repo_owner;
  const repo = i.repo || i.repository || i.repo_name;
  if (owner && !same(owner, state.remote.owner)) return false;
  if (repo && !same(String(repo).split("/").pop(), state.remote.name)) return false;
  const num = i.pullNumber || i.pull_number || i.pr_number;
  if (num !== undefined && Number(num) !== state.pr) return false;
  return true;
}

// Picks the latest response of each kind from captured records
// ({ tool, at, data }), oldest first.
function latestByKind(state, records) {
  const out = {};
  for (const r of records.filter((x) => relevant(state, x))) {
    const kind = classify(r.tool, r.data);
    if (kind) out[kind] = r;
  }
  return out;
}

// Evaluates the gate. `state` is the merging session; `now` is a timestamp.
function evaluate(state, records, now = Date.now()) {
  const reasons = [];
  const warnings = [];
  const need = (ok, msg) => { if (!ok) reasons.push(msg); return ok; };
  const best = latestByKind(state, records);
  const sha = String(state.headSha || "").toLowerCase();

  for (const kind of ["pr", "files", "reviews", "checks", "repo"]) {
    if (!best[kind]) reasons.push(`insufficient evidence: no provider response for ${kind === "pr" ? "the pull request" : kind === "files" ? "the pull request's files" : kind === "checks" ? "check runs" : kind === "repo" ? "repository permissions" : kind} was captured`);
  }
  if (!best.protection && !best.rules) reasons.push("insufficient evidence: no branch protection or ruleset response was captured, so branch protection cannot be verified");
  for (const [kind, r] of Object.entries(best)) {
    const at = Date.parse(r.at);
    if (!(at >= Date.parse(state.startedAt) - 1000)) reasons.push(`the ${kind} evidence was captured before this merge was authorized`);
    else if (now - at > MAX_AGE_MS) reasons.push(`the ${kind} evidence is older than ${MAX_AGE_MS / 60000} minutes; collect it again`);
  }

  const facts = { headSha: sha, requiredContexts: [], requiredReviews: 0, approvals: 0, files: [] };

  // Pull request identity.
  const pr = best.pr && best.pr.data;
  if (pr) {
    need(pr.number === state.pr, `the pull request is #${pr.number}, not #${state.pr}`);
    need(String(pr.state).toLowerCase() === "open" && pr.merged !== true, `the pull request is ${pr.merged ? "already merged" : pr.state}`);
    need(pr.draft !== true, "the pull request is a draft");
    need(same(pr.head && pr.head.sha, sha), `the pull request head is ${pr.head && pr.head.sha}, not the authorized ${sha} (new commits were pushed or the authorization is for another commit)`);
    need(pr.head && pr.head.ref === state.branch, `the head branch is ${pr.head && pr.head.ref}, not ${state.branch}`);
    need(pr.base && pr.base.ref === state.base, `the base branch is ${pr.base && pr.base.ref}, not ${state.base}`);
    const slug = `${state.remote.owner}/${state.remote.name}`;
    const headRepo = pr.head && pr.head.repo && pr.head.repo.full_name;
    const baseRepo = pr.base && pr.base.repo && pr.base.repo.full_name;
    need(same(baseRepo, slug), `the pull request's base repository is ${baseRepo || "unknown"}, not ${slug}`);
    need(same(headRepo, slug), `the head repository is ${headRepo || "unknown"} (forks are not merged), not ${slug}`);
    if (pr.html_url) need(new RegExp(`^https://${state.remote.host.replace(/\./g, "\\.")}/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/${state.pr}$`, "i").test(pr.html_url), `the pull request URL ${pr.html_url} is not in ${slug}`);
    need(pr.mergeable === true && String(pr.mergeable_state).toLowerCase() === "clean",
      `GitHub reports the pull request as mergeable=${pr.mergeable}, state "${pr.mergeable_state}" (it must be "clean": checks, reviews, protection, and up-to-date requirements met)`);
    if (typeof pr.commits === "number") need(pr.commits === 1, `the pull request has ${pr.commits} commits; only the single reviewed commit is allowed`);
  }

  // Only the approved files changed.
  if (best.files) {
    const files = best.files.data.map((f) => String(f.filename)).sort();
    facts.files = files;
    if (files.length >= 300) reasons.push("the file list may be truncated; refusing to merge on partial evidence");
    const approved = state.approvedFiles.map((f) => f.path).sort();
    if (JSON.stringify(files) !== JSON.stringify(approved)) {
      const extra = files.filter((f) => !approved.includes(f));
      const missing = approved.filter((f) => !files.includes(f));
      reasons.push(`the pull request's files differ from the approved files (unrelated: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`);
    }
  }

  // Permissions.
  if (best.repo) {
    const p = best.repo.data.permissions;
    need(!!(p.push || p.maintain || p.admin), "the signed-in account does not have permission to merge in this repository");
    if (!same(best.repo.data.full_name, `${state.remote.owner}/${state.remote.name}`)) reasons.push(`the repository response is for ${best.repo.data.full_name}`);
  }

  // Required checks and reviews, from protection and rulesets.
  const contexts = new Set();
  let requiredReviews = 0;
  const prot = best.protection && best.protection.data;
  if (prot) {
    const rsc = prot.required_status_checks;
    if (rsc) {
      (rsc.contexts || []).forEach((c) => contexts.add(c));
      (rsc.checks || []).forEach((c) => c && c.context && contexts.add(c.context));
    }
    const rr = prot.required_pull_request_reviews;
    if (rr) requiredReviews = Math.max(requiredReviews, Number(rr.required_approving_review_count) || 0);
    if (prot.enforce_admins && prot.enforce_admins.enabled === false) warnings.push("protection is not enforced for administrators; the plugin still never bypasses it");
  }
  for (const rule of (best.rules && best.rules.data) || []) {
    if (!isObj(rule)) continue;
    if (rule.type === "required_status_checks" && rule.parameters) (rule.parameters.required_status_checks || []).forEach((c) => c && c.context && contexts.add(c.context));
    if (rule.type === "pull_request" && rule.parameters) requiredReviews = Math.max(requiredReviews, Number(rule.parameters.required_approving_review_count) || 0);
  }
  facts.requiredContexts = [...contexts].sort();
  facts.requiredReviews = requiredReviews;
  if ((best.protection || best.rules) && contexts.size === 0) {
    reasons.push(`no required status checks are configured for ${state.base}; the plugin will not merge without verifiable required CI`);
  }

  // CI at the exact head commit.
  const results = new Map();
  if (best.checks) {
    const runs = best.checks.data.check_runs;
    if (typeof best.checks.data.total_count === "number" && best.checks.data.total_count > runs.length) {
      reasons.push("the check run list is truncated; refusing to merge on partial evidence");
    }
    for (const run of runs) {
      if (run.head_sha && !same(run.head_sha, sha)) { reasons.push(`check "${run.name}" is for commit ${run.head_sha}, not ${sha}`); continue; }
      const ok = run.status === "completed" && run.conclusion === "success";
      results.set(run.name, ok);
      if (run.status !== "completed") reasons.push(`check "${run.name}" is ${run.status}`);
      else if (!["success", "skipped", "neutral"].includes(run.conclusion)) reasons.push(`check "${run.name}" concluded ${run.conclusion}`);
    }
  }
  if (best.status) {
    if (best.status.data.sha && !same(best.status.data.sha, sha)) reasons.push(`commit statuses are for ${best.status.data.sha}, not ${sha}`);
    for (const st of best.status.data.statuses) {
      results.set(st.context, st.state === "success");
      if (st.state !== "success") reasons.push(`status "${st.context}" is ${st.state}`);
    }
  }
  for (const c of facts.requiredContexts) {
    if (results.get(c) !== true) reasons.push(`required check "${c}" has no successful result for ${sha}`);
  }

  // Reviews at the exact head commit.
  if (best.reviews && pr) {
    const author = pr.user && pr.user.login;
    const latest = new Map();
    for (const rv of best.reviews.data) {
      const who = rv.user && rv.user.login;
      if (!who || who === author || rv.state === "COMMENTED" || rv.state === "PENDING") continue;
      latest.set(who, rv);
    }
    if (best.reviews.data.length >= 100) reasons.push("the review list may be truncated; refusing to merge on partial evidence");
    for (const [who, rv] of latest) {
      if (rv.state === "CHANGES_REQUESTED") reasons.push(`${who} has requested changes`);
      if (rv.state === "APPROVED" && same(rv.commit_id, sha)) facts.approvals += 1;
    }
    if (facts.approvals < requiredReviews) reasons.push(`${facts.approvals} approving review(s) of the current commit; branch protection requires ${requiredReviews}`);
    if (requiredReviews === 0) warnings.push("branch protection does not require approving reviews; only the plugin's independent review and your approval apply");
  }

  return { ok: reasons.length === 0, reasons, warnings, facts };
}

module.exports = { MAX_AGE_MS, textOf, jsonOf, classify, evaluate };
