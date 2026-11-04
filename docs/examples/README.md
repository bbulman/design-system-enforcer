# Example configs

Two configs written by hand, for projects that keep their own catalog instead of letting `init` generate one.

## Workshopr

[`workshopr.enforcer.config.json`](workshopr.enforcer.config.json) is the real setup at [Workshopr.io](https://workshopr.io), the codebase the enforcer was built in: a PHP site whose components are `ws_*` helper functions, three SwiftUI apps, and agents that write UI every day. It uses most of what the enforcer offers: the house rules, the small-icon rule, its own generated catalog and token search, the commit gate with Workshopr's own page and drift checks, and the component gate with its review page.

Two things differ from the file Workshopr runs. `projectRoot` is `"."`, as it would be for a config at a project's root (Workshopr keeps its copy beside the enforcer, three folders down). And three messages use a colon where the original has a dash.

Its paths, prefixes, review page and reviewer name are Workshopr's. Read it for the shape of each setting, and replace the values with your own. [configuration.md](../configuration.md) explains every key.

## Kit

[`tests/fixtures/kit/enforcer.config.json`](../../tests/fixtures/kit/enforcer.config.json) is a smaller example: the config of the made-up PHP-helper design system the tests run against. It switches on the same features with invented names (`kit_*` helpers, `kit-*` classes), so it's easier to read end to end. The fixture's [README](../../tests/fixtures/kit/README.md) lists what else is in the project.
