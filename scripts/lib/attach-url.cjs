// Strict check of the one `curl` command a workflow session may run without a
// prompt: downloading a single Jira attachment into the plugin's attachment
// directory (see skills/ticket/jira-read.md).
//
// Pure: no I/O and no network. The guard supplies the attachment directory
// test and the Jira site configured for the repository.
//
// What it enforces:
//   - exactly one https:// URL and no other positional argument (curl would
//     fetch a bare "host/path" word as a second URL),
//   - the URL's host is exactly one of ATTACHMENT_HOSTS or the repository's
//     configured Jira site: no wildcard, no sub-domain, no IP address, no
//     credentials in the URL, no explicit port,
//   - only an allowlist of curl options. Anything that could upload data,
//     redirect traffic (proxies, --resolve, --connect-to), read a config file
//     or add a second request is refused,
//   - the output file is inside the attachment directory.

"use strict";

// Hosts, besides the configured Jira site, that serve Jira attachment
// downloads. api.media.atlassian.com is the Atlassian Media API that the
// Jira attachment download URL points to; it is taken from the plugin's own
// guard fixtures and has NOT been confirmed against a live Jira in this
// release. Add a host here only after confirming it from a real
// downloadJiraIssueAttachment result, and add a test for it.
const ATTACHMENT_HOSTS = Object.freeze(["api.media.atlassian.com"]);

const SITE_RE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;

// Short options that take no value and cannot change where data goes.
const SHORT_FLAGS = /^-[sSLfv]+$/;
const LONG_FLAGS = new Set(["--silent", "--show-error", "--location", "--fail", "--compressed", "--http1.1", "--verbose"]);
// Options that take one value. `output` is the destination file.
const VALUE_OPTS = new Map([
  ["-o", "output"], ["--output", "output"],
  ["-H", "header"], ["--header", "header"],
  ["-m", "limit"], ["--max-time", "limit"], ["--connect-timeout", "limit"], ["--retry", "limit"], ["--retry-delay", "limit"], ["--max-redirs", "limit"],
  ["-A", "agent"], ["--user-agent", "agent"],
]);

// Splits one shell segment into words, honouring single and double quotes.
// Returns null on an unbalanced quote.
function words(segment) {
  const out = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (const c of String(segment)) {
    if (quote) {
      if (c === quote) quote = null; else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (quote) return null;
  if (has) out.push(cur);
  return out;
}

// Why `urlText` may not be fetched, or null. `jiraSite` is the repository's
// configured Jira site (for example "example.atlassian.net") or null.
function attachmentUrlProblem(urlText, jiraSite) {
  let u;
  try { u = new URL(urlText); } catch { return "the download address is not a valid URL"; }
  if (u.protocol !== "https:") return "the download address is not https";
  if (u.username || u.password) return "the download address contains credentials";
  if (u.port) return "the download address names a port";
  const host = u.hostname.toLowerCase();
  const site = jiraSite && SITE_RE.test(String(jiraSite).toLowerCase()) ? String(jiraSite).toLowerCase() : null;
  if (!ATTACHMENT_HOSTS.includes(host) && host !== site) {
    return `${host} is not an allowed Jira attachment host (${[...ATTACHMENT_HOSTS, ...(site ? [site] : [])].join(", ")})`;
  }
  return null;
}

// Parses a `curl` segment. Returns { problem } or { url, output }.
function parseCurl(segment) {
  const w = words(segment);
  if (!w || !/^curl(\.exe)?$/i.test(w[0] || "")) return { problem: "not a curl command" };
  let url = null;
  let output = null;
  for (let i = 1; i < w.length; i += 1) {
    let a = w[i];
    let inline = null;
    const eq = /^(--[a-z0-9.-]+)=(.*)$/s.exec(a);
    if (eq) { a = eq[1]; inline = eq[2]; }
    if (SHORT_FLAGS.test(a) || LONG_FLAGS.has(a)) {
      if (inline !== null) return { problem: `${a} takes no value` };
      continue;
    }
    if (VALUE_OPTS.has(a)) {
      const value = inline !== null ? inline : w[++i];
      if (value === undefined) return { problem: `${a} needs a value` };
      if (VALUE_OPTS.get(a) === "output") {
        if (output !== null) return { problem: "more than one output file" };
        output = value;
      }
      continue;
    }
    if (a.startsWith("-")) return { problem: `curl option ${a} is not allowed` };
    if (url !== null) return { problem: "more than one download address" };
    url = a;
  }
  if (url === null) return { problem: "no download address" };
  if (output === null) return { problem: "no output file" };
  return { url, output };
}

// Why the segment may not run unprompted, or null. `insideAttachDir(path)`
// is supplied by the guard.
function curlProblem(segment, jiraSite, insideAttachDir) {
  const p = parseCurl(segment);
  if (p.problem) return p.problem;
  const bad = attachmentUrlProblem(p.url, jiraSite);
  if (bad) return bad;
  if (!insideAttachDir(p.output)) return "the output file is not inside the attachment directory";
  return null;
}

module.exports = { ATTACHMENT_HOSTS, attachmentUrlProblem, parseCurl, curlProblem, words };
