# Design System Enforcer

An MCP server and command-line tool that keeps AI coding agents inside your design system. It reads the tokens and components you already have, tells the agent what exists before it writes UI, and checks what it wrote, after every edit if you like. The same checks run in pre-commit and CI with no AI involved.

![ds-enforcer init and check running on shadcn/taxonomy](docs/demo.gif)

*`init` and `check app` on [shadcn/taxonomy](https://github.com/shadcn-ui/taxonomy) at commit `298a885`. The output is unedited apart from the shortened project path; `docs/demo/` has the transcript and the script that renders it.*

## Why

Coding agents write UI from their training data, not from your design system. They type hex colours, reach for Tailwind's default palette, guess spacing and hand-roll buttons your system already has. A style guide doesn't stop that; something has to answer "what should I use?" before the code is written and "is this right?" after.

The enforcer does both:

- **Before:** `suggest_component` names the component and the only variant values that exist; `list_tokens` finds the token for a role ("danger text", "card padding").
- **After:** `validate_file`, the edit hook and `ds-enforcer check` report what broke the rules, with the token, class or component to use instead.

## What it checks

| Rule | Where | Example |
|---|---|---|
| Hard-coded colour | CSS, JS, JSX/TSX, Vue, Svelte, Swift | `#7d3aed` → `var(--color-brand)` (practically identical) |
| Tailwind arbitrary values | class names, `@apply` | `bg-[#7C3AED]` → `bg-brand`; `p-[13px]` → `p-3.5` |
| Tailwind's default palette | class names, when you have your own colours | `text-red-600` → `text-destructive` (close) |
| Hard-coded spacing, radius, shadow, font | CSS; inline styles | `padding: 13px` → nearest spacing token |
| Raw control where the system has a component | JSX/TSX, Vue, Svelte, PHP | `<button>` → `<Button>` or your `<BaseButton>` |
| Figma and code disagree | token files | `--color-brand` is `#7C3AED` here but `#7B3AED` in Figma |
| Native theme drift | SwiftUI | a theme colour that no longer matches its web token |
| House rules you switch on | everywhere | no pure black, no pure white backgrounds |
| Accessibility | markup and CSS | contrast ratios, missing names and labels, keyboard traps |

When no token matches a colour exactly, the advice names the nearest one and how close it is, from "practically identical" to "the nearest, but clearly different".

A raw element styled with the system's own variants (`<button className={buttonVariants()}>`) counts as using the system and isn't flagged, and a component's own source folder may use the element it wraps.

## Quick start

```bash
# From source (an npm package is coming)
git clone https://github.com/bbulman/design-system-enforcer.git
cd design-system-enforcer && npm install && npm link   # puts `ds-enforcer` on your PATH

# In your app
cd ~/code/your-app
ds-enforcer init               # find your tokens and components, answer a few questions
ds-enforcer check --baseline   # existing codebase? record today's findings so only new ones count
ds-enforcer check              # run every check from the terminal

# Give Claude Code the tools (run from your app's folder)
claude mcp add design-system-enforcer -- node /path/to/design-system-enforcer/index.js
```

Requires Node 20.11 or later. Or install it as a Claude Code plugin, which bundles the tools and the edit hook (see below).

## Connecting your design system

`init` scans the project and offers what it finds as a numbered menu, with its suggestions ticked:

- **CSS variables:** custom properties, including Tailwind v4 `@theme` blocks, shadcn's bare HSL channels (`--primary: 222 47% 11%`) and `oklch()` colours.
- **W3C design tokens:** DTCG JSON (`$value`, `$type`, aliases like `{color.brand}`, colour objects, dimensions, shadows, font families) and Style Dictionary's `value` format.
- **Figma variables:** the JSON from Figma's variables API (`/v1/files/:key/variables/local`). Each variable takes its name from its Web code syntax when the designer set one (`var(--color-brand)`), otherwise from its path (`color/brand` becomes `--color-brand`), in each collection's default mode.
- **Components:** React, Vue and Svelte folders. It reads shadcn's `components.json` when there is one and otherwise prefers folders named `ui`. It records each component's props, `cva` variants and defaults, string-union props (`size?: 'sm' | 'md'`), Vue's `defineProps` (typed or runtime, with `validator` lists), Svelte's `$props()` and `export let`, and the doc comment.
- **SwiftUI themes:** Swift files that declare a set of colours, grouped by Xcode project or Swift package.

It detects Tailwind (v3 or v4) from your dependencies, then asks what `1rem` equals in pixels, whether to switch on the two house rules, and whether to add the edit hook. You can add paths the scan missed.

It writes:

| File | What it is |
|---|---|
| `enforcer.config.json` | Your settings and the connected sources |
| `.ds-enforcer/catalog.json` | Generated: every token and component, in the format the tools read |
| `.ds-enforcer/tokens.css` | Generated: the tokens as the checks see them (colours as hex, with the original in a comment) |
| `.ds-enforcer/native.json` | Generated when SwiftUI themes are connected: the apps and their theme files |
| `.ds-enforcer/synonyms.json` | Yours to edit: the words people use for things ("Dialog": ["modal", "popup"]). Starter words are added for common components; your entries are never changed |
| `.ds-enforcer/baseline.json` | Written by `check --baseline`: the findings you already had. Commit it |

The generated files rebuild themselves when a connected source changes. Commit them, or ignore them and run `ds-enforcer sync` after a clone.

**From Claude instead of the terminal:** on a project that isn't connected, every tool tells the agent to call `init`. It scans, asks you the same questions in chat, connects, and the tools work immediately with no restart. `init` never overwrites an `enforcer.config.json` you wrote by hand unless you explicitly say so.

## Adopting it on an existing codebase

Run `ds-enforcer check --baseline` once. From then on `check`, the edit hook and pull-request annotations report only what's new, and Claude's `validate_file` marks the old findings as *existing*. Findings are matched by file, rule and value rather than line number, so moving code around never makes an old finding look new, and the counts work as a ratchet: a file with three baselined `#fff`s may keep three, not four. When you fix old findings, run `--baseline` again to lock that in.

## Checking every edit Claude makes

Say yes to the hooks in `init` (or run it again later), and after Claude edits or writes a file the enforcer checks it. New findings at or above `medium` go straight back to Claude, which fixes them in its next step; anything else stays silent. It takes about 0.1 s per edit and never blocks work it can't judge (an unconnected project, a file type it doesn't check, a file outside the project).

`init` adds two hooks to `.claude/settings.local.json`: the edit hook, and a Stop hook that shows [the checklist report](#the-checklist-report) when Claude finishes. They go in your personal settings, because the command holds this machine's path to the enforcer. They take effect once Claude Code restarts. Set `hookMin` to `high` or `low` to change what it reports.

**As a plugin:** the repository is also a Claude Code plugin. `.claude-plugin/plugin.json` registers the MCP server and `hooks/hooks.json` registers both hooks, all through `${CLAUDE_PLUGIN_ROOT}`, so nothing machine-specific is written into your project.

## Pull requests

`ds-enforcer check --since <base> --format github` checks only the files a pull request changed and prints GitHub annotations, which appear on the diff. The repository includes a GitHub Action that does this:

```yaml
# .github/workflows/design-system.yml
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

`--format sarif` writes SARIF 2.1.0 for GitHub code scanning and other tools.

## The checklist report

`ds-enforcer report` (or ask Claude to "make a design system report") writes `design-system-report.md`: every finding as a checkbox, grouped by file, each marked **auto** (a swap with exactly one right answer) or **Claude** (needs judgment).

```markdown
## src/app/page.tsx (3)

- [ ] **R1** · line 6 · high · Arbitrary colour bg-[#7C3AED] → `bg-[#7C3AED]` → `bg-brand` · *auto*
- [ ] **R2** · line 9 · medium · Raw <button> → Use <Button> from @/components/ui/button · *Claude*
```

Tick the boxes you want (in the file, or from chat: "tick R2 and all auto"), then run `ds-enforcer apply` or ask Claude to "apply the design system report". The enforcer makes the auto swaps itself, hands the Claude items to Claude, re-checks every file and marks each box ✅ fixed, 🛠 for Claude or ⚠️ still there. Run `apply` again after Claude's edits to verify them. Unticked items are left alone; `apply --accept-rest` records them in the baseline so they stop coming back.

**It shows up by itself.** With the hooks on (`init` asks), when Claude finishes a reply in which it edited files, the report is refreshed for those files and, if anything is left to fix, a short summary appears in Claude Code with the first items and the file to open. It stays quiet when nothing is left or nothing changed since it last spoke, and keeps boxes you already ticked. Set `"openReport": true` to also open the file in your default app, `"reportMin": "medium"` to list less, or `"autoReport": false` to turn it off. In pull requests, the Action adds the same checklist for the changed files to the job summary.

## Figma

Connect a Figma variables export alongside your code tokens and every token both define is compared. A difference becomes a `token-drift` finding on the line that declares the token in code, so it shows up in `check`, the hook and pull requests like any other, and a baseline can hold the ones your team has accepted. `init` also reports how many Figma variables have no code token at all.

## Accessibility

`a11y_review` (and `check --a11y`, or `"a11y": true` in the config to make it part of every check and the hook) reviews what the code itself shows:

- **Names:** images without `alt`; buttons and links that hold only an icon and no label; form fields with no label (a placeholder isn't one).
- **Keyboard:** clickable `div`s and `span`s with no role, `tabIndex` or key handler; positive `tabIndex`; `aria-hidden` on focusable elements; autofocus.
- **Structure:** skipped heading levels, links without `href` or used as buttons, `<html>` without `lang`.
- **Contrast:** the WCAG ratio for text and background colours used together, from Tailwind classes on one element, inline styles and CSS rules, against AA (4.5:1, or 3:1 for large text).

`a11y_review` with `tokens: true` audits the design system's own colour pairs (each token with its `-foreground`, and `background` with `foreground`) before anyone uses them. Run on shadcn's default theme, it shows `muted-foreground` on `muted` at 4.34:1, just under AA.

It can't see the rendered page: focus order and visibility, target size, zoom and what a screen reader announces still need the browser's accessibility tree.

## MCP tools

| Tool | What it does |
|---|---|
| `init` | Detect sources, connect them (optionally with the edit hook), or resync |
| `suggest_component` | The component for a description, with its import, props and the only variant values that exist |
| `list_components` | Every component with its usage and summary |
| `list_tokens` | Tokens by category, or the best matches for a role |
| `validate_file` | Every violation in a file, with line numbers, severity and the fix; with a baseline, which are new |
| `check_snippet` | The same, for code not yet in a file (`css`, `php`, `js`, `jsx`, `tsx`, `vue`, `svelte`, `swift`) |
| `audit_page` | A full compliance report for a file |
| `fix_file` | Applies the unambiguous swaps (a colour, spacing or radius value that exactly matches one token). Has a dry run. Never edits Swift |
| `a11y_review` | The accessibility review of a file or snippet, or the design system's colour pairs |
| `native_apps` | For projects with SwiftUI apps: each app's theme files, build commands and current drift |
| `report` | Writes the [checklist report](#the-checklist-report) for a file, folder or the whole project |
| `apply_report` | Ticks items (ids, `auto` or `all`), makes the auto fixes, re-checks and marks each box; returns what is left for Claude |

## Command line

```bash
ds-enforcer init  [--root <dir>] [--yes]
ds-enforcer sync  [--root <dir>]
ds-enforcer check [paths...] [--baseline] [--all] [--a11y] [--since <ref>]
                  [--format text|json|github|sarif] [--min low|medium|high]
                  [--fail-on low|medium|high|never] [--root <dir>]
ds-enforcer report [paths...] [--out <file>] [--min low|medium|high] [--a11y]
ds-enforcer apply  [--report <file>] [--tick R1,R4|auto|all] [--accept-rest]
ds-enforcer hook       # the Claude Code edit hook (reads the hook's JSON on stdin)
ds-enforcer stop-hook  # the Claude Code Stop hook that shows the report
ds-enforcer       # starts the MCP server (what Claude Code runs)
```

`check` with no paths checks the whole project; paths are relative to the folder you're in, and the project is found the way git finds `.git`. It exits `1` when it finds a new finding at or above `--fail-on` (default `high`), and `2` when the project isn't connected, a path doesn't exist, or `--since` can't be compared. `--all` ignores the baseline. `init` also accepts answers piped in, one per line.

A pre-commit hook that checks only staged files:

```sh
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.css' '*.js' '*.jsx' '*.ts' '*.tsx' '*.vue' '*.svelte' '*.php' '*.swift')
[ -z "$files" ] || ds-enforcer check $files
```

## Configuration

`enforcer.config.json` is looked for in this order: the file named by `ENFORCER_CONFIG`; the nearest `enforcer.config.json` at or above the project directory (`ENFORCER_PROJECT_ROOT`, `CLAUDE_PROJECT_DIR` or the folder you're in); and `enforcer.config.json` beside the server, which only applies inside the project the server lives in.

| Key | Default | Meaning |
|---|---|---|
| `name` | none | Shown in tool output and the server name |
| `framework` | `css` | `react`, `vue` or `svelte` turns on the markup checks for those files (`init` sets it) |
| `sources` | `[]` | What `init` connected: `{ "type": "css" \| "dtcg" \| "figma" \| "react" \| "vue" \| "svelte" \| "swift", "path": "..." }` |
| `tailwind` | detected | `"v3"`, `"v4"` or `false` |
| `rootPx` | `16` | What `1rem` equals, for matching rem values to tokens |
| `rules.pureBlack`, `rules.pureWhite` | off | `{ "enabled", "severity", "message", "suggestion" }` |
| `a11y` | `false` | Make the accessibility review part of every `check` and the hook |
| `hookMin` | `medium` | The lowest severity the edit hook reports |
| `autoReport` | `true` | Show the checklist report when Claude finishes, if the Stop hook is on |
| `reportMin` | `low` | The lowest severity that report lists |
| `openReport` | `false` | Also open the report file in your default app |
| `baseline` | `.ds-enforcer/baseline.json` | Where the baseline lives |
| `exemptFiles` | your token files | File names never checked |
| `exemptDirs` | `node_modules`, `vendor`, `.git`, `.ds-enforcer` | Paths never checked |
| `checkJsx` | `false` | Run the markup checks without a component framework |
| `nativeExtras` | none | For SwiftUI apps: `brandFonts`, `iconFonts`, and per-app `sanctionedScopes` |
| `tokensCss`, `catalog`, `synonyms`, `nativeManifest`, `searchModule` | `.ds-enforcer/...` | For projects that generate their own catalog |
| `projectRoot` | `.` | The project, relative to the config file |

To silence one finding, put `ds-lint-disable-line` on the line or `ds-lint-disable-next-line` on the line above.

## Native apps (SwiftUI)

For a product with SwiftUI apps beside the web, the enforcer checks that each app's theme colours still match the web tokens they mirror, and that views use theme constants instead of colour literals. Pure black and brand fonts follow your house rules and `nativeExtras`. `init` finds the theme files and sets this up; `native_apps` shows each app with its build commands and a live drift summary. A trailing `// --token` comment on a theme constant says which token it mirrors, so a changed value is reported as drift rather than an unknown colour.

## Safety

- File tools read, and `fix_file` writes, only inside the project. Absolute paths elsewhere and `..` escapes are refused.
- The MCP server makes no network calls and runs no other programs. The command line runs `git` only for `--since`.
- `fix_file` only applies swaps with exactly one right answer and never touches Swift.
- `init` writes only `enforcer.config.json`, `.ds-enforcer/`, and, if you say yes, the hook entry in `.claude/settings.local.json`, keeping everything else there.

## Limitations

- Tailwind v3's `tailwind.config.js` isn't read; class names are matched to your tokens by name (`--primary` is `bg-primary`). Tailwind v4's `@theme` is read directly.
- Contrast is measured only for solid colours: a class with an opacity modifier (`bg-black/50`) or a translucent colour is skipped, since what shows through it is unknown. Only the base state is checked, not `hover:` or `dark:`.
- DTCG typography composites are skipped; they have no single CSS value.
- Components are read with patterns, not a compiler, so unusual export styles can be missed.
- The GitHub Action has been tested locally, not yet on GitHub itself.

## Tests

`npm test` runs `init` and `check` against the small projects in `tests/fixtures` (Tailwind v4 with React, Figma variables and a SwiftUI app; Vue; Svelte) and checks the findings and the edit hook.

`docs/examples/workshopr.enforcer.config.json` is a hand-written config for a PHP codebase with three SwiftUI apps, for teams that generate their own catalog instead of using `init`.

## Background

Built for [Workshopr.io](https://workshopr.io), where it guards a PHP and CSS codebase and three SwiftUI apps against agents that write UI every day.

## License

MIT. See [LICENSE](LICENSE).
