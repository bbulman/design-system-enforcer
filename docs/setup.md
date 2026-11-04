# Setup

This page takes you from nothing to an enforcer that checks every edit, every commit and every pull request. Each step works on its own, so stop wherever you have what you need.

You need Node 20.11 or later, and git for the commit gate and pull-request checks.

1. [Install it](#1-install-it)
2. [Connect a project](#2-connect-a-project)
3. [Register the MCP server](#3-register-the-mcp-server) in Claude Code, Claude Desktop, Codex CLI, Cursor or Gemini CLI
4. [Turn on the edit hook](#4-turn-on-the-edit-hook) (Claude Code)
5. [Add the pre-commit gate](#5-add-the-pre-commit-gate)
6. [Add the GitHub Action](#6-add-the-github-action)
7. [Check it works](#7-check-it-works)
8. [Troubleshooting](#8-troubleshooting)

## 1. Install it

There are two ways. A clone serves every project on your machine. An npm install from GitHub pins a version inside one project, so everyone who clones it gets the same one.

### From a clone

```bash
git clone https://github.com/bbulman/design-system-enforcer.git ~/tools/design-system-enforcer
cd ~/tools/design-system-enforcer
npm install
npm link          # puts ds-enforcer on your PATH
```

Any folder works in place of `~/tools/`. The rest of this page calls it `/path/to/design-system-enforcer`.

### From npm, straight from GitHub

```bash
cd ~/code/your-app
npm install --save-dev github:bbulman/design-system-enforcer
npx ds-enforcer help
```

The package lands in `node_modules/design-system-enforcer/`, and `npx ds-enforcer` runs it. Wherever this page says `ds-enforcer`, use `npx ds-enforcer` instead. To pin a release once it's tagged, add the tag: `github:bbulman/design-system-enforcer#v1.4.0`.

**Don't run `npm install design-system-enforcer`.** That name on the npm registry belongs to a different package. Always install with the `github:` prefix.

While the repository is private, both ways need read access to it, through SSH or a GitHub token.

## 2. Connect a project

From your project's root folder:

```bash
ds-enforcer init
```

It scans the project and lists what it found as a numbered menu, with its picks ticked: CSS variable files, W3C or Style Dictionary token files, Figma variable exports, React, Vue and Svelte component folders, and SwiftUI theme files. Then it asks:

1. Which sources to connect. Press Enter for the ticked ones, or type numbers like `1,3` or `1-4`.
2. Any path the scan missed, such as a tokens file or a components folder.
3. What `1rem` equals in pixels on your pages. Press Enter for 16.
4. Whether to flag pure black (`#000`) as a house rule.
5. Whether to flag pure white backgrounds as a house rule.
6. Whether to add the Claude Code hooks (see [step 4](#4-turn-on-the-edit-hook)).
7. Whether to write the files.

It writes `enforcer.config.json` with `"configVersion": 3`, and generates `.ds-enforcer/` beside it. At the end it prints the exact `claude mcp add` command for your machine, with the full path to the server.

Options:

- `--yes` takes every default without asking. The hooks question defaults to no.
- `--root <dir>` connects a project in another folder.
- Answers can be piped in, one per line, for scripts.
- On a project you already connected, running `init` again keeps your other settings and asks the questions again.

On an existing codebase, record what's already there so only new findings count, then commit the baseline:

```bash
ds-enforcer check --baseline
git add enforcer.config.json .ds-enforcer/baseline.json
```

`.ds-enforcer/catalog.json` and `.ds-enforcer/tokens.css` are generated from your sources. Commit them, or add them to `.gitignore` and run `ds-enforcer sync` after each clone.

You can also connect from inside Claude: on a project that isn't connected, every tool tells the agent to call `init`, and the agent asks you the same questions in chat.

## 3. Register the MCP server

The server finds its project in this order: the `ENFORCER_PROJECT_ROOT` environment variable, then `CLAUDE_PROJECT_DIR` (which Claude Code sets), then the folder it was started in. From there it looks for the nearest `enforcer.config.json`, the way git looks for `.git`. Claude Code sets the project for you. For the other clients, set `ENFORCER_PROJECT_ROOT` to your project's absolute path, or the server may start somewhere else and report the project as not connected.

The command that starts the server is `node /path/to/design-system-enforcer/index.js`. With an npm install, the path is `/path/to/your-app/node_modules/design-system-enforcer/index.js`. `index.js` needs the `npm install` from step 1. `bin/ds-enforcer.mjs` with no arguments starts the same server, and installs that dependency first if it's missing.

### Claude Code

From your project's folder:

```bash
claude mcp add design-system-enforcer -- node /path/to/design-system-enforcer/index.js
```

Everything after `--` is the command that starts the server. The server is added for you, in this project only. `--scope user` adds it for every project on your machine, and `--scope project` writes it to `.mcp.json` in the project so teammates get it too. Claude Code asks each of them to approve a project-scoped server the first time.

Check it with `claude mcp list` in your shell, or `/mcp` in a session.

### Claude Code plugin

The repository is also a Claude Code plugin. It registers the MCP server and both hooks through `${CLAUDE_PLUGIN_ROOT}`, so nothing machine-specific goes into your project. To load it for a session, start Claude Code with:

```bash
claude --plugin-dir /path/to/design-system-enforcer
```

To load it in every session without the flag, list the folder in the `CLAUDE_CODE_PLUGIN_DIRS` environment variable (Claude Code v2.1.280 or later). The plugin starts `index.js` directly, so run `npm install` in the folder first.

Use the plugin or `claude mcp add` and the `init` hooks, not both. With both, the server runs twice and every edit is checked twice.

Installing it by name with `/plugin install` needs a marketplace file, `.claude-plugin/marketplace.json`, which this repository doesn't have yet.

### Claude Desktop

Open **Settings**, then **Developer**, then **Edit Config**. That opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add the server under `mcpServers`, with your project's path:

```json
{
  "mcpServers": {
    "design-system-enforcer": {
      "command": "node",
      "args": ["/path/to/design-system-enforcer/index.js"],
      "env": { "ENFORCER_PROJECT_ROOT": "/path/to/your-app" }
    }
  }
}
```

Quit Claude Desktop completely and open it again. Claude Desktop has no project folder of its own, so each entry serves one project. Add a second entry with another name for a second project. A chat in Claude Desktop doesn't run the hooks in step 4, so there the checks happen when you ask for them, and at commit.

### Codex CLI

From your shell:

```bash
codex mcp add design-system-enforcer --env ENFORCER_PROJECT_ROOT=/path/to/your-app -- node /path/to/design-system-enforcer/index.js
```

Or add it to `~/.codex/config.toml` yourself:

```toml
[mcp_servers.design-system-enforcer]
command = "node"
args = ["/path/to/design-system-enforcer/index.js"]
env = { ENFORCER_PROJECT_ROOT = "/path/to/your-app" }
```

To keep it with one project, put the same table in that project's `.codex/config.toml`. Codex reads a project's config only once you've marked the project as trusted. Check it with `codex mcp list` in your shell, or `/mcp` in the Codex TUI.

### Cursor

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "design-system-enforcer": {
      "command": "node",
      "args": ["/path/to/design-system-enforcer/index.js"],
      "env": { "ENFORCER_PROJECT_ROOT": "${workspaceFolder}" }
    }
  }
}
```

Cursor fills in `${workspaceFolder}` with the folder that holds `.cursor/mcp.json`, so the file can be committed as it is if everyone keeps the enforcer at the same path. With an npm install, use `"${workspaceFolder}/node_modules/design-system-enforcer/index.js"` in `args` and it's the same on every machine. `~/.cursor/mcp.json` registers it for every project, with an absolute `ENFORCER_PROJECT_ROOT` in place of `${workspaceFolder}`. Turn it on or off with its toggle under **Customize** in Cursor's sidebar. If it won't start, open the **Output** panel and choose **MCP Logs**.

### Gemini CLI

Add it to `.gemini/settings.json` in your project, or `~/.gemini/settings.json` for every project:

```json
{
  "mcpServers": {
    "design-system-enforcer": {
      "command": "node",
      "args": ["/path/to/design-system-enforcer/index.js"],
      "env": { "ENFORCER_PROJECT_ROOT": "/path/to/your-app" }
    }
  }
}
```

Or from your shell, which writes the project file by default (`-s user` writes your own):

```bash
gemini mcp add -e ENFORCER_PROJECT_ROOT=/path/to/your-app design-system-enforcer node /path/to/design-system-enforcer/index.js
```

Gemini CLI expands `$VAR` and `${VAR}` in the `env` block only. Check it with `gemini mcp list`, or `/mcp` in a session. A server in a folder you haven't trusted shows as disconnected.

Gemini's documentation says Gemini CLI was replaced by Antigravity CLI on 18 June 2026. These steps follow the Gemini CLI documentation and haven't been tried with Antigravity CLI.

## 4. Turn on the edit hook

The edit hook is for Claude Code. After Claude edits or writes a file, the enforcer checks it, and new findings at `medium` or above go straight back to Claude, which fixes them in its next step. A second hook runs when Claude finishes a turn: it refreshes `design-system-report.md` for the files edited that session and shows the list if anything is left.

There are three ways to turn them on:

- **`init`:** answer yes to the hooks question.
- **The plugin:** its `hooks/hooks.json` brings both hooks.
- **By hand:** add this to `.claude/settings.local.json` in your project, with your path:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "node \"/path/to/design-system-enforcer/bin/ds-enforcer.mjs\" hook", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/path/to/design-system-enforcer/bin/ds-enforcer.mjs\" stop-hook", "timeout": 60 }
        ]
      }
    ]
  }
}
```

`init` writes exactly this. It goes in `settings.local.json`, your personal settings, because the command holds this machine's path to the enforcer.

In `enforcer.config.json`, `hookMin` sets the lowest severity the hook reports (`high`, `medium` or `low`), and `"autoReport": false` turns off the end-of-turn report.

The hook never blocks work it can't judge. An unconnected project, a file type it doesn't check, a file outside the project or an error of its own all let the edit through without a word.

## 5. Add the pre-commit gate

`ds-enforcer staged` checks exactly what you're committing. It exports the staged copy of each file to a temporary folder, runs the enforcer's rules there against your baseline, runs any checks of your own listed under `staged.checks` in `enforcer.config.json`, and removes the folder. It fails on new findings at `medium` or above.

Save this as `.git/hooks/pre-commit` and make it executable with `chmod +x .git/hooks/pre-commit`:

```sh
#!/bin/sh
exec ds-enforcer staged
```

With an npm install, use `exec npx --no-install ds-enforcer staged`. Git runs hooks from the root of the working tree, so `npx` finds the project's copy.

Its own rules cover staged `.php`, `.css`, `.js`, `.html` and `.swift` files. For React, Vue and Svelte files, add a `check` on the staged paths after it:

```sh
#!/bin/sh
ds-enforcer staged || exit $?
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.jsx' '*.tsx' '*.ts' '*.vue' '*.svelte')
[ -z "$files" ] || exec ds-enforcer check --commit --fail-on medium $files
```

That second check reads the working-tree copy of each file, not the staged one, and a path with a space in it breaks the list.

What it exits with:

| Exit | Meaning |
|---|---|
| `0` | Passed, or nothing staged that it checks |
| `1` | A check failed. Each failure prints its file, line and fix |
| `2` | It couldn't run the checks: not a git repository, no `enforcer.config.json`, a config that won't parse, or a config older than `"configVersion": 3` |

A finding that's genuinely right in that spot can carry `ds-lint-disable-line`, with the reason in the commit message. `git commit --no-verify` skips the gate for one commit, and the GitHub Action still catches it on the pull request.

## 6. Add the GitHub Action

The Action checks only the files a pull request changed, and posts each finding as an annotation on the diff. Add `.github/workflows/design-system.yml` to your project:

```yaml
name: Design system
on: pull_request
jobs:
  enforce:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # the base commit is needed to see what changed
      - uses: bbulman/design-system-enforcer@v1
        with:
          fail-on: high
```

| Input | Default | What it does |
|---|---|---|
| `fail-on` | `high` | Fail the job on a new finding at or above this: `low`, `medium`, `high` or `never` |
| `paths` | the whole project | Folders or files to check, space-separated |
| `working-directory` | `.` | The folder that holds `enforcer.config.json` |
| `summary` | `'true'` | When anything is found, add the [checklist report](../README.md#the-checklist-report) for the changed files to the job summary. `'false'` leaves it out |

Commit `enforcer.config.json` and `.ds-enforcer/baseline.json`, or the Action has no config and no baseline to read. Outside a pull request, such as on a push, it checks every file under `paths`.

`@v1` needs a `v1` tag on this repository. While the repository is private, another repository can use the Action only after **Settings**, **Actions**, **General**, **Access** on this one is set to share it with repositories you own.

The Action has been run locally, not yet on GitHub itself. With an npm install, you can run the same check as a plain step instead:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx ds-enforcer check --since "${{ github.event.pull_request.base.sha }}" --format github --fail-on high
```

## 7. Check it works

**The command line.** `ds-enforcer help` prints the usage line and exits 0. In your project, `ds-enforcer check` ends with one summary line:

```text
✔ 35 files checked: 0 findings (0 high, 0 medium, 0 low) in 0 files
```

With a baseline, it counts new findings only and adds a line for the ones the baseline holds.

**A planted finding.** Take one of your colour tokens, say `--color-brand` with the value `#7c3aed`, and write its value by hand in a scratch file:

```bash
printf '.probe { color: #7c3aed; }\n' > probe.css
ds-enforcer check probe.css; echo "exit $?"
rm probe.css
```

You should see the finding, the token to use instead, a failing summary and exit code 1:

```text
probe.css
     1  high    Hardcoded color #7c3aed
                → Use var(--color-brand) instead

✖ 1 files checked: 1 finding (1 high, 0 medium, 0 low) in 1 file
exit 1
```

A value no token holds exactly gets the nearest token instead, and how close it is.

**The MCP server.** In your client's server list (`/mcp` in Claude Code, Codex and Gemini CLI; **Customize** in Cursor; **Manage connectors** in Claude Desktop), `design-system-enforcer` should show as connected. Then ask the agent: "Which design-system token should I use for the brand colour?" It should call `list_tokens` and answer with one of yours.

**The edit hook.** Ask Claude Code to add `color: #7c3aed;` to a stylesheet. Straight after the edit, Claude should be told something like:

```text
Design system check on src/styles/card.css: 1 new finding to fix.
- line 4: Hardcoded color #7c3aed. Use var(--color-brand) instead
```

and fix it in its next step. `/hooks` in the session lists the two hooks under `PostToolUse` and `Stop`.

**The commit gate.** Stage a file with a planted finding and run `git commit`. The commit should stop with "Commit blocked by the design-system check: design-system rules." and the finding above it.

## 8. Troubleshooting

### "This project is not connected to a design system yet"

The tools say this, and `check` exits 2 with it, when there's no `enforcer.config.json` at or above the project folder.

- Run `ds-enforcer init` in the project.
- If the project is connected, the server started somewhere else. Set `ENFORCER_PROJECT_ROOT` to the project's absolute path in the client's config ([step 3](#3-register-the-mcp-server)), or pass `--root` to the command.
- A stray `ENFORCER_CONFIG` in your environment points every command at that one file. Unset it.

### "has no "configVersion": 3" or "older than this enforcer's 3"

The config was written for an older version of the format, when some settings came from the enforcer's code instead of the file. Version 3 also switched the small-icon rule off unless `iconSize` turns it on. Reading the file as it is would run with some rules off or different, so `check --commit` and `ds-enforcer staged` stop with exit 2, and `check`, the MCP server and the edit hook carry on with the warning on stderr. The message lists what moved since the file's own version.

- **`init` wrote it:** run `ds-enforcer init` again and connect the same sources. It sets `"configVersion": 3` and keeps your other settings. Your answers set the sources, `rootPx` and the house rules again.
- **You wrote it by hand:** set the settings that moved into the file (the message lists them, and [configuration.md](configuration.md#the-config-version) explains each), then set `"configVersion": 3`.

### The edit hook doesn't fire

- Run `/hooks` in the session. Both hooks should be listed, under `PostToolUse` and `Stop`.
- Claude Code's file watcher normally picks up a change to a settings file on its own. If `/hooks` doesn't list the new hooks, start a new session.
- Check that the path in the hook's command exists. If you moved the enforcer folder, run `init` again or fix the path in `.claude/settings.local.json`.
- The hook checks `.css`, `.php`, `.js`, `.jsx`, `.tsx`, `.ts`, `.vue`, `.svelte`, `.swift` and `.html` files inside the project, and stays silent below `hookMin`.
- To see what ran, start Claude Code with `claude --debug` and read the log in `~/.claude/debug/`.

### The server won't start in a client

- Run the command from the client's config in your shell: `node /path/to/design-system-enforcer/index.js`. If it says `Cannot find package '@modelcontextprotocol/sdk'`, run `npm install` in the enforcer's folder, or point the client at `bin/ds-enforcer.mjs`, which installs it.
- Started by hand, the server prints nothing and waits for a client. That's normal. Press Ctrl+C.
- "Design system not loaded" on stderr means a connected source couldn't be read. Fix the file or run `ds-enforcer sync`.
- Claude Desktop writes each server's stderr to `mcp-server-design-system-enforcer.log`, in `~/Library/Logs/Claude` on macOS and `%APPDATA%\Claude\logs` on Windows.

### A commit is blocked by a finding that's right

Put `ds-lint-disable-line` on the line, or `ds-lint-disable-next-line` on the line above, and say why in the commit message. For a batch of existing findings, run `ds-enforcer check --baseline` and commit the baseline.

---

The client steps above were checked against each client's own documentation on 3 November 2026. Client config formats change, so if a step doesn't match what you see, the client's documentation wins.
