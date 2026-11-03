// Backs /jira-dev-harness:connect. Dependency-free, cross-platform.
//
//   begin <data-dir> <session-id> [--confirm <jira> <github>]
//       Run by the user-only skill's injected command. Records the developer's
//       typed identity confirmation for this session. Claude's tools can't run
//       it or write the record (the guard protects the plugin data directory).
//   facts-path
//       Prints a temp file path outside the repository for the connection facts.
//   evaluate <data-dir> <session-id> <facts-file>
//       Checks the official gh (read-only), applies the status rules, prints
//       the report. Reads no credential: gh output is limited to the account
//       login and a repository-access check.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const L = require("./lib/approval.cjs");
const P = require("./lib/provider.cjs");
const C = require("./lib/connections.cjs");

const recordFile = (dataDir, sid) => path.join(dataDir, "connect", `${sid}.json`);

function checkSession(sid) {
  if (!L.SESSION_RE.test(sid || "")) L.fail(`invalid session id: ${sid}`);
}

function begin(dataDirArg, sid, ...rest) {
  const dataDir = L.checkDataDir(dataDirArg);
  checkSession(sid);
  const parsed = C.parseArgs(rest);
  if (parsed.error) L.fail(parsed.error);
  fs.mkdirSync(path.join(dataDir, "connect"), { recursive: true });
  fs.writeFileSync(recordFile(dataDir, sid), JSON.stringify({ at: new Date().toISOString(), confirm: parsed.confirm }));
  console.log(parsed.confirm
    ? "CONNECT: developer confirmation recorded. Verify against live connections now."
    : "CONNECT: no confirmation given yet. Report the identities and ask the developer to confirm.");
}

function factsPath() {
  const dir = path.join(L.TEMP_ROOT, "connect");
  fs.mkdirSync(dir, { recursive: true });
  console.log(path.join(dir, `facts-${crypto.randomBytes(6).toString("hex")}.json`));
}

function repoContext() {
  try {
    const root = L.git(["rev-parse", "--show-toplevel"], process.cwd());
    const remote = P.parseRemote(L.git(["remote", "get-url", "origin"], root));
    const mapping = L.readJson(path.join(root, L.MAPPING_FILE));
    const site = mapping && mapping.jira && typeof mapping.jira.site === "string" ? mapping.jira.site : null;
    return { root, remote: remote && P.detectProvider(remote, root) ? remote : null, site };
  } catch {
    return { root: null, remote: null, site: null };
  }
}

// Official gh only (the same checks as the ship adapter). Runs outside the
// repository, never prompts, and never prints a token.
function ghFacts(ctx) {
  const host = ctx.remote ? ctx.remote.host : "github.com";
  const info = P.officialGh(ctx.root, host);
  if (!info.ok) {
    return /not found on PATH/.test(info.reason) ? { status: "missing" } : { status: /not authenticated/.test(info.reason) ? "unauthenticated" : "error", reason: info.reason };
  }
  const run = (args) => spawnSync(info.exe, args, { cwd: os.tmpdir(), encoding: "utf8", timeout: 60000, windowsHide: true, env: P.ghEnv() });
  const hostArgs = host === "github.com" ? [] : ["--hostname", host];
  const who = run(["api", ...hostArgs, "user", "--jq", ".login"]);
  const login = (who.stdout || "").trim();
  if (who.status !== 0 || !/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(login)) {
    return { status: "error", reason: "gh is signed in but could not report the account" };
  }
  const facts = { status: "ok", identities: [login] };
  if (ctx.remote) {
    const r = run(["api", ...hostArgs, `repos/${ctx.remote.owner}/${ctx.remote.name}`, "--jq", ".full_name"]);
    facts.repoAccess = r.status === 0;
  }
  return facts;
}

function evaluate(dataDirArg, sid, factsFile) {
  const dataDir = L.checkDataDir(dataDirArg);
  checkSession(sid);
  const facts = L.readJson(factsFile);
  if (!facts || typeof facts !== "object") L.fail(`facts file is missing or not valid JSON: ${factsFile}`);
  const record = L.readJson(recordFile(dataDir, sid));
  const ctx = repoContext();
  const result = C.evaluate(facts, ghFacts(ctx), record && record.confirm, ctx.site);
  console.log(C.render(result));
  try {
    fs.unlinkSync(factsFile);
  } catch {
    // The facts file is a temp file; leaving it behind is harmless.
  }
}

const [command, ...args] = process.argv.slice(2);
const commands = { begin, "facts-path": factsPath, evaluate };
try {
  if (!commands[command]) L.fail(`unknown command: ${command || "(none)"}`);
  commands[command](...args);
} catch (e) {
  if (!(e instanceof L.StoreError)) throw e;
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
