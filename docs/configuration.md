# Configuration

Everything the enforcer knows about a project lives in that project's `enforcer.config.json`. `init` writes one for you. This page lists every setting. For complete configs written by hand, see [examples/](examples/): Workshopr's real one, and the smaller one the tests use.

## Where the file is found

`enforcer.config.json` is looked for in this order:

1. the file named by `ENFORCER_CONFIG`;
2. the nearest `enforcer.config.json` at or above the project directory (`ENFORCER_PROJECT_ROOT`, `CLAUDE_PROJECT_DIR` or the folder you're in), the way git finds `.git`;
3. `enforcer.config.json` beside the enforcer's own code, only when the project directory is inside the folder that file's `projectRoot` names, and that folder holds the file's `tokensCss`. This is for a project that keeps the enforcer inside its own repository. Any other project, or a folder that merely sits above a copy of the enforcer, is never graded by it.

With no config anywhere, the project isn't connected yet. The server still starts, and every tool but `init` says to run `init`.

Paths in the file are relative to `projectRoot`, which is relative to the file. A key you leave out keeps its default, and the defaults carry no house rules, so those are opt-in per project.

## What init writes

On a project with one CSS token file and a shadcn `components/ui` folder, `init` writes this:

```json
{
  "configVersion": 3,
  "projectRoot": ".",
  "framework": "react",
  "sources": [
    { "type": "css", "path": "styles/globals.css" },
    { "type": "react", "path": "components/ui" }
  ],
  "tokensCss": ".ds-enforcer/tokens.css",
  "catalog": ".ds-enforcer/catalog.json",
  "synonyms": ".ds-enforcer/synonyms.json",
  "rootPx": 16,
  "exemptFiles": ["globals.css"],
  "rules": {
    "pureBlack": { "enabled": false, "severity": "high", "message": "Pure black (#000) is not allowed in this design system", "suggestion": "Use the darkest ink token" },
    "pureWhite": { "enabled": false, "severity": "medium", "message": "Pure white backgrounds are not allowed in this design system", "suggestion": "Use a surface or page background token" }
  }
}
```

Running `init` again rewrites the keys above and keeps any others you added. A config you wrote by hand (one with no `sources`) is replaced only when you say so.

## The config version

`configVersion` says which config format a file was written for. `init` writes `3`. Each version moved settings out of the enforcer's code and into the file, where the code used to supply Workshopr's values itself:

- **Version 2:** `components`, `colorTokenChoice`, `homepage`, `rules.pureBlack.native`, `text`, `staged`, and `componentGate`'s `skip`, `reviewUrl`, `shellParser` and `reviewer`.
- **Version 3:** `iconSize` (and the small-icon rule is now off unless it's enabled), `tokenNames`, `componentGate`'s `files`, `pages` and `scanSkip`, and the examples in the gate tools' descriptions (`text.tools`).

A config below version 3 would run with some of those rules off or different, so:

- `check --commit` and `ds-enforcer staged` stop with exit 2 and list what moved since the file's own version;
- `check`, the MCP server and the edit hook carry on, with a warning on stderr.

To bring a file up to date:

- **`init` wrote it:** run `init` again and connect the same sources. That sets `"configVersion": 3` and keeps the file's other settings. Your answers set the sources, `rootPx` and the house rules again.
- **You wrote it by hand:** set the moved settings your project needs from the tables below, then set `"configVersion": 3`.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `configVersion` | none | The config format the file is written for; `init` writes `3`. A file below `3` predates settings that moved from the code into the config below: version 2 moved `components`, `colorTokenChoice`, `homepage`, `rules.pureBlack.native`, `text`, `staged` and four `componentGate` keys; version 3 moved `iconSize` (and switched the small-icon rule off unless it is enabled), `tokenNames`, `componentGate.files`, `componentGate.pages`, `componentGate.scanSkip` and the examples in the gate tools' descriptions (`text.tools`). `check --commit` and `staged` stop with exit 2 and list what moved since the file's version, and `check`, the MCP server and the edit hook warn once on stderr |
| `name` | none | Shown in tool output and the server name |
| `framework` | `css` | `react`, `vue` or `svelte` turns on the markup checks for those files (`init` sets it) |
| `sources` | `[]` | What `init` connected: `{ "type": "css" \| "dtcg" \| "figma" \| "react" \| "vue" \| "svelte" \| "swift", "path": "..." }` |
| `tailwind` | detected | `"v3"`, `"v4"` or `false` |
| `rootPx` | `16` | What `1rem` equals, for matching rem values to tokens |
| `rules.pureBlack`, `rules.pureWhite` | off | `{ "enabled", "severity", "message", "suggestion" }` |
| `rules.pureBlack.native` | follows `enabled` | The Swift pure-black check's own switch: `true` or `false` sets it apart from the web rule. Workshopr: `true` |
| `iconSize` | off | The small-icon rule: `{ "enabled", "min", "token", "retired", "glyphClasses", "inlineGlyphClasses", "doc" }`. `min` (default `24`) is the smallest an icon may be drawn, in px; `token` the size token the suggestion names (without one it names `min` in px); `retired` size tokens an icon may no longer use; `glyphClasses` the icon font's class names as a stylesheet selector names them (a selector containing one sizes a glyph); `inlineGlyphClasses` the classes markup carries with an inline `font-size` (default: `glyphClasses`); `doc` where the rule comes from, cited in each message. Inline SVGs on the 24-unit grids and `.icon`/`svg` selectors are checked whenever the rule is on. Workshopr: `24`, `--icon-lg`, `--icon-xs`/`--icon-sm`/`--icon-md`, `material-symbols` and `material-icons` (inline: `material-symbols-outlined`, `material-symbols-rounded`), `DESIGN.md §8` |
| `a11y` | `false` | Make the accessibility review part of every `check` and the hook |
| `hookMin` | `medium` | The lowest severity the edit hook reports |
| `baseline` | `.ds-enforcer/baseline.json` | Where the baseline lives |
| `exemptFiles` | your token files | File names never checked |
| `exemptDirs` | `node_modules`, `vendor`, `.git`, `.ds-enforcer` | Paths never checked |
| `checkJsx` | `false` | Run the markup checks without a component framework |
| `nativeExtras` | none | For SwiftUI apps: `brandFonts`, `iconFonts`, and per-app `sanctionedScopes` |
| `tokensCss`, `catalog`, `synonyms`, `nativeManifest`, `searchModule` | `.ds-enforcer/...` | For projects that generate their own catalog |
| `projectRoot` | `.` | The project, relative to the config file |
| `homepage` | none | The `informationUri` in SARIF output. Workshopr: `https://workshopr.io` |
| `colorTokenChoice` | `plainest` | Of several colour tokens with one value, which the nearest-colour advice and a Tailwind class name: `plainest` (`--foreground` before `--card-foreground`; for a Tailwind class, the one that reads right for the utility) or `semantic` (the token parser's order, `tokenNames.colorOrder`). Workshopr: `semantic` |
| `tokenNames.colorOrder` | `[]` | The token parser's order for several colour tokens with one value, which an exact-match suggestion always names: regular expressions over the name, the first token the earliest pattern matches winning, else the first token. Empty: the plainest name. Workshopr: `^--brand(-\|$)`, then `--color-`, `--text-`, `--bg-`, `--button-`, `--card-`, `--input-`, then its per-app prefixes, `--phase-`, `--gray-` |
| `tokenNames.colorWords` | `[]` | Regular expressions for token names `list_tokens` files under colours besides the generic words (`color`, `primary`, `dark`, `light`, `gray`, `bg-`, `text-`, `ink`, `success`, `warning`, `error`, `info`). Workshopr: `phase-`, `navy`, `-cat-\d` |
| `tokenNames.appScoped` | `[]` | Regular expressions for tokens one app owns: a native app's nearest-token suggestion never names one, and of tokens sharing a value they rank after the rest. Workshopr: its per-app prefixes (`--coach`, `--tips`, `--planner`, `--phase` and the rest) |
| `components.functionPrefix` | none | The prefix of the project's component functions (Workshopr: `ws_`). With it, raw `<button>`, `<select>`, `<textarea>` and `<input>` in PHP name the helper to call, the raw-HTML rules name `prefix + button`, `prefix + modal_start` and so on where the catalog has them, and option checks read `prefix_name(...)` calls |
| `components.classPrefix` | none | The prefix of the components' own classes (Workshopr: `ws-`): never a lookalike, and a hand-written root class (`ws-btn`) maps back to its helper |
| `components.extraClassPrefixes` | `[]` | More class prefixes that are a component's own markup, never a legacy lookalike (Workshopr: `wl-`) |
| `components.helperFile` | none | The file that defines the component functions, read to map each root class to its helper (Workshopr: `includes/components/helpers.php`) |
| `components.sourceDirs` | `[]` | Folders that are the components themselves, so never lookalikes (Workshopr: `includes/components/`) |
| `components.js` | none | The components' JavaScript twin: `{ "file", "namespace", "sourceFiles" }` (Workshopr: `js/ws.js`, `ws`, and `js/ws.js` with `js/ws-agent.js`) |
| `text.instructions` | the generic text | What the MCP server tells every session, after its name: a string or a list of sentences. The contract line from `docs` follows it |
| `text.tools` | `{}` | A tool's description in the project's words, by tool name (`"list_tokens"`), or one input's (`"check_snippet.file_path"`) |
| `text.componentsFooter` | `From <catalog>.` | The lines under `list_components` for PHP components |
| `text.noComponent` | the generic advice | What `suggest_component` says when nothing matches |
| `text.noColorToken`, `text.spacingOffScale` | the nearest token | The suggestion for a colour no token holds, and for spacing off the scale, in place of the nearest-token advice |
| `text.native` | the house rules' text | Swift wording: `pureBlack` (message), `pureBlackFix` (`{ink}` is the theme constant with the value `inkHex`), `font` and `systemFont` (`{brandFonts}`, `{iconFonts}` from the manifest) |
| `staged` | no checks | The pre-commit gate's own checks, `hint` and `noPhp`: see [The commit gate's own checks](#the-commit-gates-own-checks) |

Text settings may use `{name}` placeholders where the table says so. An unknown one is left as written.

Some advice is worded from the project's own tokens rather than set: the radius scale an off-scale radius is measured against (the `--radius-*` steps in px), the shadow tokens a hand-written `box-shadow` should use (`--shadow-*`), the font-family tokens by the generic family their stack ends in, and, when `rootPx` is not 16, the note that rem tokens paint at a fraction of their nominal size.

To silence one finding, put `ds-lint-disable-line` on the line, or `ds-lint-disable-next-line` on the line above.

### More settings

These are read by the code as well:

| Key | Default | Meaning |
|---|---|---|
| `framework` | `css` | Also takes `php`, for a project whose components are PHP functions: `list_components` then describes PHP function signatures |
| `docs.web`, `docs.native` | none | Paths to the project's own design-system docs. The MCP server's instructions end with "The contract:" and these paths |
| `rawControlSkip` | `^vendor/`, `^node_modules/`, `^\.git/` | Regular expressions over the project-relative path. A matching PHP file is never checked for raw controls |
| `autoReport` | `true` | `false` turns off the report the Stop hook shows at the end of a turn |
| `reportMin` | `low` | The lowest severity that report lists |
| `openReport` | `false` | `true` also opens `design-system-report.md` in the default app when the report has something new |
| `commitGate.jsComponents` | none | `"block"` makes a new hand-copied component in JavaScript fail the commit gate when its helper has a JavaScript twin (`components.js`). Otherwise it's shown for information |

## The commit gate's own checks

`ds-enforcer staged` runs the enforcer's rules on the staged copy of each file, then the project's own checks listed in `staged.checks`, each one when a staged path matches it. Each entry:

| Key | Meaning |
|---|---|
| `name` | The step's printed name |
| `failure` | Its name in "Commit blocked by the design-system check: ..." (default: `name`) |
| `when` | A regular expression over the staged paths (project-relative); the check runs when one matches |
| `command` | The program and its arguments. An argument that is exactly `{files}` becomes the matching paths, one argument each (it is not filled in inside a longer argument); `{snapshot}` anywhere in the program or an argument becomes the snapshot folder; the program `node` is the Node running the gate |
| `batch`, `unit` | Run `{files}` in batches of this size, each step labelled with its range (`, pages 1-400`; `unit` defaults to `files`) |
| `needsPhp` | Skipped, with a note, when `php` is not on the path |
| `requires` | A path that must be in the snapshot, else the check is skipped |
| `sources` | It checks design-system sources: the opening line says "plus the design-system sources" |
| `export` | Extra git pathspecs to export into the snapshot (Workshopr's icon check adds `images/icons/*.svg`) |
| `baselines` | Baseline files keyed by path that follow a staged rename: `{ "file": ... }`, or `{ "file": ..., "key": "files" }` for one keyed under `files` |

Beside the list, `staged.hint` is a sentence added to the blocked message (Workshopr's points at its component search), and `staged.noPhp` replaces the note printed when `php` is missing (`{checks}` is the checks it skipped).

### Which config a commit is checked against

One config serves the whole run, the enforcer's rules and your own checks alike. It's the project's `enforcer.config.json`, found from the repository root the way every command finds it, and read from what's being committed where it can be:

- The staged copy is used when it has `"configVersion": 3`.
- When the config isn't staged or committed, or the staged copy predates version 3, the working-tree copy is used and a note says so.
- A staged copy that won't parse stops the commit with exit 2, whatever else is staged.
- A working-tree copy that won't parse, or that lacks version 3 as well, stops the commit with exit 2 only when the commit has something to check, never a docs-only one.
- With no config at all, a commit with something to check stops with exit 2 and says to run `init`.

A project that keeps the enforcer inside its own repository, with its config beside the enforcer's code, has one more rule. There the working-tree fallback for an old staged config holds only while the staged enforcer is the old code that config was written for: it has no `config-file.js`, or its `CONFIG_VERSION` is one the staged config meets. So other commits go through until the enforcer and its config are committed together, and staging code that reads a later `configVersion` than the config staged beside it stops the commit with exit 2.

## The component gate

Under `componentGate`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Switches the gate on: its tools are listed and its hooks act |
| `autoSwap` | `false` | Forces the switch for hand-copied component markup (a component's own root class written by hand), since it maps to exactly one helper |
| `minScore` | none | The search score a candidate needs; a piece with no candidate at or above it has nothing fitting. Workshopr sets 5 |
| `clearMargin` | none | How far a search's first candidate must lead the second to be a clear winner. Workshopr sets 10, but no automatic swap uses it: only hand-copied markup is forced |
| `skip` | `^vendor/`, `^node_modules/`, `^\.git/`, `^\.ds-enforcer/` | Regular expressions matched against the project-relative path; a matching file is never gated, checked by the gate's hooks or the lookalike rules, or scanned for suggestions. Setting it replaces the whole list, and a pattern that is not a valid regular expression is left out. Workshopr sets `^api/`, `^cron/`, `^tests/`, `^emails/`, `^includes/email-templates/`, `^design-system/`, `^includes/components/`, `^\.scratch/`, `^admin/_archive/`, `^vendor/`, `^node_modules/`, `^\.claude/`, `^agents/` |
| `reviewUrl` | none | The review page link in messages and the summary; with none, they name the page without a link. Workshopr: `http://localhost:8084/design-system/review.php` |
| `shellParser` | none | A module, project-relative, whose `writeTargets(command, root, { cwd })` lists the files a shell command writes; with none, Bash is not gated. Workshopr: `agents/feature-build/scripts/walls.mjs` |
| `reviewer` | `the reviewer` | Who decides the cases, as the tool texts and messages name them. Workshopr: `Bill` |
| `files` | `{ "gate": [".php", ".css"], "detect": [".js", ".html"] }` | The file types the gate holds to a consult before markup is added (`gate`), and those whose lookalikes are reported for information only, never gated, blocked or queued (`detect`; `check --commit` lets them through too). The default is what the gate can judge: it reads markup and stylesheets, and it knows a component was used by a call to its helper, which a script or a static page cannot make. Workshopr sets the same |
| `pages` | `{ "types": null, "skip": [], "included": [], "notPages": [] }` | Where a suggested component's markup counts as a page, for the bar of three pages a suggestion has to clear (`gate/pages.mjs`). `types`: the page file types (null: the `gate` types that are not stylesheets); `skip`: copies and archives that are neither markup nor pages (a sync copy such as `page 2.php` always is one); `included`: files another file includes, which carry markup but are not pages; `notPages`: markup never counted as a page. Each list is regular expressions over the project-relative path. Workshopr: `.php`; `(^\|/)_archive/` and `index\.legacy\.php$`; the `includes`, `partials` and `views` folders and `_name.php`; `^admin/` |
| `scanSkip` | `[]` | Regular expressions for files the suggestion scan never reads, beside `skip` and the sync copies, `vendor/`, `node_modules` and `.min.` files it always leaves out. Workshopr: `_archive` and `(^\|/)index\.legacy\.php$` |

### Where its state lives

State lives in the folder `DS_ENFORCER_STATE_DIR` names, or else in `.ds-enforcer/` in the project: `sessions/` (one file per session: its consults, refusals, writes by agent and blocks), `review.json` (the queue) and `suggestions.json` (the suggested components). Ignore all three in git, since decisions are one machine's working state; `baseline.json` beside them stays committed. Each write goes to a temp file and is renamed into place, under a lock, because every hook and tool call is its own process. A `review.json` or `suggestions.json` that exists but can't be parsed is never written over, since it may hold the only copy of the reviewer's choices.

### Its tools and commands

Each MCP tool has a `ds-enforcer` command that does the same for an agent without it. A tool's description names the command by the enforcer's path from the project root when the enforcer sits inside the project, else by its full path, which is the form the gate's refusals always use so they run from any folder:

| MCP tool | Command | What it does |
|---|---|---|
| `consult_ui` | `consult --file <path> --piece "<text>" [--piece "<text>"...]` | The components that could build each piece, or nothing fitting |
| `record_case` | `record-case --json '{"file": ..., "reason": ..., "markup": ..., "piece_id" or "finding": ...}'` | Puts a kept or from-scratch piece in a gated file in the review queue (`sample_html` and `chosen` are optional) |
| `apply_review` | `apply-review` | Carries out the reviewer's decisions, then verifies and marks them |
| `scan_components` | `suggest [--force] [paths...]` | Suggested new components; with no paths it rescans and saves the list (the command at most once a day unless `--force`), with paths it scans only those and saves nothing |

The other three subcommands are hooks. `gate` (PreToolUse), `gate-post` (PostToolUse) and `finish` (Stop and SubagentStop) read Claude Code's payload on stdin and fail open: an unreadable payload, a missing file or an internal error lets the work through. The only deliberate blocks are the consult refusal and the finish check. No hook calls a model.

### Wiring its hooks

The plugin doesn't register the gate's hooks. Add them to `.claude/settings.json` beside the edit hook and the Stop report, with the path to your copy of the enforcer:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          { "type": "command", "command": "node /path/to/design-system-enforcer/bin/ds-enforcer.mjs gate", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|mcp__design-system-enforcer__consult_ui|mcp__design-system-enforcer__record_case",
        "hooks": [
          { "type": "command", "command": "node /path/to/design-system-enforcer/bin/ds-enforcer.mjs gate-post", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/design-system-enforcer/bin/ds-enforcer.mjs finish", "timeout": 30 }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/design-system-enforcer/bin/ds-enforcer.mjs finish", "timeout": 30 }
        ]
      }
    ]
  }
}
```

The `mcp__design-system-enforcer__` prefix in the PostToolUse matcher comes from the name you gave the server in `claude mcp add`. If yours differs, or the server came from the plugin, check the tool names in `/mcp` and change the matcher to match.

## Environment variables

| Variable | Meaning |
|---|---|
| `ENFORCER_CONFIG` | The config file to use, ahead of any search |
| `ENFORCER_PROJECT_ROOT` | The project directory, ahead of `CLAUDE_PROJECT_DIR` and the folder you're in |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code; the project directory when `ENFORCER_PROJECT_ROOT` isn't set |
| `DS_ENFORCER_STATE_DIR` | Where the component gate keeps its state, in place of `.ds-enforcer/` |
