# bitbucket-mcp as a Claude Code plugin

This repository is both the MCP server and its own single-entry plugin
marketplace. It is a fork of [MatanYemini/bitbucket-mcp](https://github.com/MatanYemini/bitbucket-mcp);
what the fork adds is pagination metadata, sorting and filtering on list tools,
budget-based limits and retries. Installing the plugin gives you **the MCP
server** — Bitbucket repositories, pull requests, comments and pipelines.

It is the companion of the [mcp-atlassian plugin](https://github.com/AndrewKolpakov/mcp-atlassian)
and **reads the same credentials file**, so one file configures Jira, Confluence
and Bitbucket per directory.

## Requirements

Node.js 18 or newer on `PATH`, with the `npm` it ships. `dist/` is not part of
the repository, so the first start runs `npm ci` and `npm run build` inside the
plugin directory — a few seconds with a warm npm cache, longer on a cold one. A
new plugin version lands in a new directory and builds once again.

On Windows the build script's `chmod` fails, so build once by hand there
(`npm ci`, then `npx tsc`) before the first start.

## Install

```bash
claude plugin marketplace add AndrewKolpakov/bitbucket-mcp
claude plugin install bitbucket-mcp@local-bitbucket
```

Then configure credentials, either way below.

## Credentials

Nothing secret is stored in this repository or in the plugin. Pick one of two
routes; if both are present, **the file wins**.

The server accepts either an account email with an API token
(`BITBUCKET_USERNAME` + `BITBUCKET_PASSWORD`) or a bearer access token
(`BITBUCKET_TOKEN`). Create an Atlassian API token with Bitbucket scopes at
<https://id.atlassian.com/manage-profile/security/api-tokens>.

### Route 1 — the plugin's own options

```
/plugin configure bitbucket-mcp@local-bitbucket
```

Fill the default workspace, the account email and the API token — or the access
token instead of both. Tokens are marked sensitive, so they go to the OS keychain
rather than `settings.json`. Leave the API URL empty for Bitbucket Cloud. An
unfilled option is discarded by the launcher rather than passed on as an empty
setting.

### Route 2 — the shared credentials file

`~/.config/mcp-atlassian/credentials.ini`, or wherever `MCP_ATLASSIAN_CONFIG`
points — the file and the override the mcp-atlassian plugin uses, resolved by the
same rule, so the two plugins never read different files. Add the `BITBUCKET_*`
keys to the sections you already have:

```ini
[~/work/acme]
JIRA_URL = https://acme.atlassian.net
JIRA_USERNAME = you@acme.com
JIRA_API_TOKEN = ...
BITBUCKET_WORKSPACE = acme
BITBUCKET_PASSWORD = ...

[~/work/acme/mobile]
BITBUCKET_WORKSPACE = acme-mobile
```

Each plugin takes only its own keys: this one reads `BITBUCKET_URL`,
`BITBUCKET_WORKSPACE`, `BITBUCKET_USERNAME`, `BITBUCKET_PASSWORD` and
`BITBUCKET_TOKEN`, and mcp-atlassian ignores all of them. One exception: a section
without `BITBUCKET_USERNAME` lends its `JIRA_USERNAME`, since both are the same
Atlassian account email. A password or token never falls back from the Jira keys
— a Jira API token is not a Bitbucket one unless you scoped it so; write it
out under `BITBUCKET_PASSWORD` if it is.

The file format and its rules are the mcp-atlassian ones, described in full in
that plugin's README:

- **INI, not TOML** — values need no quotes; one matching pair is stripped.
- **A section named after a directory** applies when Claude Code was started
  inside it.
- **Sections layer from least to most specific**: `[default]`, each enclosing
  directory, then the directory itself. Above, `~/work/acme/mobile` keeps acme's
  credential and changes only the workspace.
- **Omit `[default]`** and the server starts only inside listed directories —
  elsewhere the launcher stops with `no Bitbucket credential configured` and no
  Bitbucket tools reach the session. This holds only while the plugin's own
  options are empty.

Other server settings — `BITBUCKET_ENABLE_DANGEROUS`, `BITBUCKET_MAX_RETRIES`,
`BITBUCKET_LOG_*` — are read from the environment, not from this file; see the
main [README](../README.md).

## Tool names

Tools arrive under the plugin-scoped prefix:

```
mcp__plugin_bitbucket-mcp_bitbucket__getPullRequest
mcp__plugin_bitbucket-mcp_bitbucket__listPipelineRuns
```

If you also have the server registered directly (`claude mcp add bitbucket …`),
its tools keep the shorter `mcp__bitbucket__…` prefix — and you will have two of
every tool. Remove one:

```bash
claude mcp remove bitbucket -s user
```

## Running your own working tree

By default the server runs the copy the plugin shipped. To serve a clone instead,
either set the *Run from this checkout instead* option, or:

```bash
export BITBUCKET_MCP_DIR=~/src/bitbucket-mcp
```

The launcher builds that tree only if it has never been built. After editing
`src/`, run `npm run build` yourself and restart the server with `/mcp`.

## Troubleshooting

```bash
node plugin/scripts/bitbucket_mcp_launcher.mjs --dry-run
```

Prints the resolved roots, which credentials file and which sections were used,
and which variables are set — never a password or token — then stops without
building or starting the server. Drop `--dry-run` (or set
`BITBUCKET_MCP_DEBUG_ENV=1`) to print the same report and then serve on stdio.

| symptom | cause |
| --- | --- |
| `no Bitbucket credential configured` | neither route supplied `BITBUCKET_TOKEN` or `BITBUCKET_USERNAME` + `BITBUCKET_PASSWORD` for this directory |
| `npm is required` | install Node.js 18+, see Requirements |
| first connect fails right after install | the first-start build outlasted the MCP startup timeout on a cold npm cache; run the launcher by hand once (below, without `--dry-run`) or reconnect with `/mcp` |
| `npm ci failed` / `npm run build failed` | the first-start build failed; its output is in the server's stderr (`claude --debug`, or run the launcher by hand) |
| `no Node project at …` | the *Run from this checkout instead* option points somewhere that is not a clone; clear it |
| two of every Bitbucket tool | the server is registered directly as well as via the plugin, see Tool names |

## Notes for maintainers

- **The server config lives in the repository-root `.mcp.json`**, not in
  `plugin.json`: Claude Code does not honour `mcpServers` in the manifest (measured
  for the mcp-atlassian plugin on 2.1.252).
- **That root file is also read as *project* MCP config** by anyone who opens
  this repository in Claude Code, and `${CLAUDE_PLUGIN_ROOT}` is not expanded in
  that reading. The launcher therefore derives the repository root from its own
  location and treats a value that still looks like `${…}` as absent. Decline the
  project-scope prompt when working in the repo.
- **The launcher is Node with no dependencies**, because it runs before
  `node_modules` exists. Everything it prints goes to stderr: stdout is the MCP
  pipe, and the build's npm output is redirected for the same reason.
- The INI reading mirrors the Python `configparser` behaviour mcp-atlassian relies
  on — `=` or `:` separators, whole-line `#`/`;` comments, case-insensitive keys,
  symlink-resolved section paths. Change one launcher's rules and change the
  other's. One known gap: an uppercase `[DEFAULT]` is special to `configparser`
  (merged into every section) and is a plain section here — the documented
  spelling is lowercase `[default]`, which both read the same way.
- `claude plugin validate --strict` reports one warning, deliberately: the
  repository's `CLAUDE.md` is contributor context and is not loaded for plugin
  users. Non-strict validation is clean.
