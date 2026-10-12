#!/usr/bin/env node
/**
 * Launcher for the bitbucket-mcp Claude Code plugin.
 *
 * Resolves where the server lives and which credentials it gets, builds it when
 * needed, then runs it. Four things make this a script rather than a plain
 * command in `.mcp.json`:
 *
 * 1. `dist/` is not in the repository, so a plugin installed from GitHub has no
 *    server to run until it is built. The first start builds it.
 * 2. An unfilled optional `userConfig` field does not always arrive as an unset
 *    variable, so empty and un-substituted values are cleared here. Passing
 *    `BITBUCKET_TOKEN=""` would otherwise look to the server like a configured
 *    credential.
 * 3. Credentials can come from a file instead of the plugin's settings — the
 *    same file the mcp-atlassian plugin reads, so one file serves both — which
 *    is what lets one machine serve several workspaces by directory.
 * 4. A missing `npm` has to say so rather than fail as "command not found".
 *
 * Node stdlib only: it runs before `node_modules` exists.
 *
 * Everything this prints goes to stderr. stdout belongs to the MCP stdio
 * protocol, and one stray line there breaks the handshake.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every variable the server reads for its site and authentication. Cleared when
// the value is unusable, and settable from the credentials file.
const CREDENTIAL_VARS = [
  "BITBUCKET_URL",
  "BITBUCKET_WORKSPACE",
  "BITBUCKET_USERNAME",
  "BITBUCKET_PASSWORD",
  "BITBUCKET_TOKEN",
];
// Values that must never be echoed by --dry-run.
const SECRET_VARS = new Set(["BITBUCKET_PASSWORD", "BITBUCKET_TOKEN"]);

const DEFAULT_SECTION = "default";
const IS_WINDOWS = process.platform === "win32";

function die(message) {
  process.stderr.write(`bitbucket-mcp: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`bitbucket-mcp: ${message}\n`);
}

/**
 * Whether a value is a real value.
 *
 * An option the user left empty can arrive as "" or as the literal
 * `${user_config.x}` when substitution did not fire. Neither is a value.
 */
function usable(value) {
  return Boolean(value) && !value.trimStart().startsWith("${");
}

/**
 * Strip one matching pair of surrounding quotes from a config value.
 *
 * The file is INI, where a value is literal to end of line, so quotes would be
 * part of it. Its `[section]` + `key = value` shape reads as TOML, where quoting
 * is required, so writing them is the natural mistake. Same rule as the
 * mcp-atlassian launcher, which reads the same file.
 */
function unquote(value) {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === "'" || value[0] === '"')
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Absolute and with symlinks resolved where the path exists, like Python's
 * `Path.resolve()` in the mcp-atlassian launcher — otherwise `[/tmp/x]` would
 * match there and not here on macOS, where /tmp links to /private/tmp.
 */
function resolvePath(p) {
  const absolute = path.resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function expandUser(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * The repository root, derived from this file's location.
 *
 * This file sits at `<root>/plugin/scripts/`. Deriving the root beats reading
 * `${CLAUDE_PLUGIN_ROOT}`: that variable is expanded only when Claude Code
 * launches this as a plugin server, the same `.mcp.json` read as *project*
 * config hands over the literal string, and running this by hand sets nothing.
 */
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Which tree to run the server from.
 *
 * The plugin ships the whole repository, so its own root is a usable checkout
 * once built. An explicit override points at a working tree instead.
 */
function resolveSource(root) {
  for (const name of ["BITBUCKET_MCP_DIR", "CLAUDE_PLUGIN_OPTION_SERVER_SOURCE"]) {
    const value = process.env[name];
    if (usable(value)) return resolvePath(expandUser(value));
  }
  return root;
}

function clearUnusable(env) {
  for (const name of CREDENTIAL_VARS) {
    if (name in env && !usable(env[name])) delete env[name];
  }
}

/**
 * Where the credentials file lives: the mcp-atlassian plugin's file, resolved
 * by the same rule, so the two plugins can never read different files.
 */
function configPath() {
  const override = process.env.MCP_ATLASSIAN_CONFIG;
  if (usable(override)) return expandUser(override);
  return path.join(homedir(), ".config", "mcp-atlassian", "credentials.ini");
}

/**
 * Parse the subset of INI that Python's configparser accepts and the
 * mcp-atlassian launcher relies on: `[section]` headers, `key = value` or
 * `key : value`, whole-line `#` / `;` comments, keys case-insensitive. Returns
 * Map<section, Map<KEY, value>>, sections in file order.
 */
function parseIni(text) {
  const sections = new Map();
  let current = null;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) return;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1].trim();
      if (!sections.has(current)) sections.set(current, new Map());
      return;
    }
    const match = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!match) throw new Error(`line ${index + 1}: expected "key = value"`);
    if (current === null) throw new Error(`line ${index + 1}: key outside any [section]`);
    sections.get(current).set(match[1].trim().toUpperCase(), match[2]);
  });
  return sections;
}

/**
 * Every directory section containing `cwd`, least specific first.
 *
 * Sections compose along the path rather than only the closest one applying: a
 * nested section inherits the enclosing one and overrides just the keys it
 * names. Applying only the closest match would pair a nested section's
 * workspace with the *default* credential.
 */
function sectionsFor(sections, cwd) {
  const matches = [];
  for (const name of sections.keys()) {
    if (name === DEFAULT_SECTION) continue;
    const candidate = resolvePath(expandUser(name));
    const rel = path.relative(candidate, cwd);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      matches.push([candidate.split(path.sep).filter(Boolean).length, name]);
    }
  }
  return matches.sort((a, b) => a[0] - b[0]).map(([, name]) => name);
}

/**
 * Apply the credentials file, and report which sections were used.
 *
 * Only BITBUCKET_* keys are taken; the JIRA_* / CONFLUENCE_* keys in the same
 * sections belong to mcp-atlassian. The one exception: a section that names no
 * BITBUCKET_USERNAME lends its JIRA_USERNAME, because both are the same
 * Atlassian account email. A password or token never falls back.
 *
 * The file has the last word over the plugin's own options, which is what makes
 * it a usable escape hatch.
 */
function applyConfig(env, file, cwd) {
  if (!existsSync(file) || !statSync(file).isFile()) return "absent";
  let sections;
  try {
    sections = parseIni(readFileSync(file, "utf8"));
  } catch (error) {
    die(
      `cannot read the credentials file ${file}: ${error.message}\n` +
        "    Fix the file or remove it; the plugin's own options work without it.",
    );
  }
  const used = [];
  for (const name of [DEFAULT_SECTION, ...sectionsFor(sections, cwd)]) {
    const values = sections.get(name);
    if (!values) continue;
    used.push(name);
    for (const [key, raw] of values) {
      const value = unquote(raw.trim());
      if (CREDENTIAL_VARS.includes(key) && usable(value)) env[key] = value;
    }
    const jiraUser = unquote((values.get("JIRA_USERNAME") ?? "").trim());
    if (!values.has("BITBUCKET_USERNAME") && usable(jiraUser)) {
      env.BITBUCKET_USERNAME = jiraUser;
    }
  }
  return used.length ? used.join(" + ") : "no matching section";
}

function debugDump(root, src, file, section, env) {
  const lines = [
    `plugin root = ${root}`,
    `server source = ${src}`,
    `credentials file = ${file} (${section})`,
    `cwd = ${process.cwd()}`,
  ];
  for (const name of CREDENTIAL_VARS) {
    if (SECRET_VARS.has(name)) {
      lines.push(`${name} = ${env[name] ? "<set, value hidden>" : "<unset>"}`);
    } else {
      lines.push(`${name} = ${env[name] ?? "<unset>"}`);
    }
  }
  for (const line of lines) log(line);
}

function npmCommand() {
  return IS_WINDOWS ? "npm.cmd" : "npm";
}

function hasNpm() {
  const probe = spawnSync(npmCommand(), ["--version"], { stdio: "ignore", shell: IS_WINDOWS });
  return !probe.error && probe.status === 0;
}

/**
 * Run a build step with its stdout sent to our stderr: npm prints progress on
 * stdout, and stdout is the MCP pipe.
 */
function runStep(src, args) {
  const result = spawnSync(npmCommand(), args, {
    cwd: src,
    stdio: ["ignore", 2, 2],
    shell: IS_WINDOWS,
  });
  if (result.error) die(`could not run npm ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) die(`npm ${args.join(" ")} failed in ${src} (exit ${result.status})`);
}

/**
 * Build `dist/` when it is missing.
 *
 * A plugin version lands in its own cache directory, so a new version starts
 * without `dist/` and builds once; there is no staleness to track. A working
 * tree named by BITBUCKET_MCP_DIR is built only when it has never been built —
 * after editing it, rebuild it yourself.
 */
function ensureBuilt(src, entry) {
  if (existsSync(entry)) return;
  if (!hasNpm()) {
    die(
      "npm is required to build the server on first start and was not found on PATH.\n" +
        "    Install Node.js 18 or newer (it ships npm): https://nodejs.org/\n" +
        "    or:  brew install node",
    );
  }
  log(`first start: building the server in ${src}`);
  const lockfile = existsSync(path.join(src, "package-lock.json"));
  runStep(src, [lockfile ? "ci" : "install", "--no-audit", "--no-fund", "--loglevel=error"]);
  runStep(src, ["run", "build"]);
  if (!existsSync(entry)) die(`the build finished but ${entry} is still missing`);
  log("build done");
}

function main(argv) {
  // --dry-run resolves everything, reports it, and stops short of building or
  // serving. Without it the only way to see what was resolved is to start a
  // server that then waits on stdin forever.
  const dryRun = argv.includes("--dry-run");
  argv = argv.filter((arg) => arg !== "--dry-run");

  const root = pluginRoot();
  const src = resolveSource(root);
  const env = { ...process.env };
  clearUnusable(env);
  const file = configPath();
  const section = applyConfig(env, file, resolvePath(process.cwd()));

  if (dryRun || process.env.BITBUCKET_MCP_DEBUG_ENV) debugDump(root, src, file, section, env);

  if (!existsSync(path.join(src, "package.json"))) {
    die(
      `no Node project at ${src} (looked for package.json).\n` +
        "    Point BITBUCKET_MCP_DIR at a clone of the repository, or clear the\n" +
        "    'Run from this checkout instead' plugin option to use the bundled copy.",
    );
  }
  const hasPassword = env.BITBUCKET_USERNAME && env.BITBUCKET_PASSWORD;
  if (!env.BITBUCKET_TOKEN && !hasPassword) {
    die(
      "no Bitbucket credential configured — set BITBUCKET_TOKEN, or\n" +
        "    BITBUCKET_USERNAME and BITBUCKET_PASSWORD.\n" +
        "    Either fill the plugin's options (/plugin, then configure bitbucket-mcp),\n" +
        `    or add them to ${file}. plugin/README.md has both recipes.`,
    );
  }

  if (dryRun) {
    log("--dry-run, not starting the server");
    return 0;
  }

  const entry = path.join(src, "dist", "index.js");
  ensureBuilt(src, entry);

  // spawn rather than replacing the process: Node cannot exec in place, and the
  // server speaks MCP over inherited stdio, which inheriting leaves untouched.
  const result = spawnSync(process.execPath, [entry, ...argv], { stdio: "inherit", env });
  if (result.error) die(`could not start the server: ${result.error.message}`);
  return result.status ?? 1;
}

process.exit(main(process.argv.slice(2)));
