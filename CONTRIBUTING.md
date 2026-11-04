# Contributing

Thanks for helping. Issues and pull requests are both welcome.

## Run the tests

```bash
npm install
npm test
```

You need Node 20.11 or later, and git, since some tests build throwaway repositories. Every suite works on a made-up project copied to a temporary folder, so nothing touches the enforcer's own folder or the repository around it.

`npm test` runs three suites in order. Each can run on its own:

| Suite | Run it alone | What it covers |
|---|---|---|
| `self-test.js` | `node self-test.js` | The catalog-backed behaviour on the kit fixture: suggestions, option checks, the advice, the SwiftUI checks |
| `test/*.test.mjs` | `node --test test/*.test.mjs`, or one file: `node --test test/staged.test.mjs` | The component gate, the commit gate, the checklist and the hooks. Each test works on its own copy of the kit fixture, or a throwaway git repository built from it |
| `tests/run.mjs` | `node tests/run.mjs` | End to end, the way a user runs it: `init` and `check` on the React, Vue and Svelte fixtures, the baseline, the hooks, the report, the kit project and the MCP server. The MCP server test is skipped until `npm install` has run |

The fixtures live in `tests/fixtures/`:

- `react-tailwind`: React with Tailwind v4, a Figma variables export and a SwiftUI app.
- `vue` and `svelte`: one component library each.
- `kit`: a hand-configured design system built from PHP helper functions, with its own `enforcer.config.json` that switches on the house rules, the small-icon rule, the component gate and the commit gate. Its [README](tests/fixtures/kit/README.md) lists what's in it. `test/helpers/kit.mjs` copies it to a temporary folder and points the enforcer at the copy.

Every name in the fixtures is invented. A pull request should leave all three suites passing, and a new rule or option should come with a test that fails without it. Add to a fixture rather than pointing a test at a real project.

## Don't change existing output without saying so

People wire this tool into pre-commit hooks, CI and baselines, so its output is an interface. A change that alters any of these for code that already exists has to say so in the pull request:

- a finding's rule id, severity, message or suggestion;
- which files or lines a rule flags;
- the value a finding matched, since the baseline keys on file, rule and value;
- an exit code, a flag, or the shape of the `json`, `github` or `sarif` output;
- a config key or its default.

Say what changes, why, and what a user has to do about it, such as running `ds-enforcer check --baseline` again. A change that only adds (a new rule that's off by default, a new option) needs the same note, but no one has to act on it.

## Report a false positive

Open an issue with:

1. The smallest snippet that triggers it, and the file type.
2. The finding exactly as printed: the rule id from `ds-enforcer check --format json` (its `type` field), the severity and the message.
3. The relevant part of your `enforcer.config.json`: `framework`, `tailwind`, `sources`, and any keys you changed.
4. What you expected instead, and why.

Until it's fixed, put `ds-lint-disable-line` on the line, or run `ds-enforcer check --baseline` to accept it.
