#!/usr/bin/env node
/**
 * ds-enforcer            start the MCP server (what Claude Code runs)
 * ds-enforcer init       connect this project's design system (menu)
 * ds-enforcer sync       regenerate .ds-enforcer/ from the connected sources
 * ds-enforcer check      run the checks from the command line (pre-commit, CI)
 * ds-enforcer hook       Claude Code PostToolUse hook: check the file Claude just edited
 */
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'serve') {
  await import('../index.js');
} else if (cmd === 'init' || cmd === 'sync') {
  const cli = await import('../init/cli.mjs');
  process.exitCode = await (cmd === 'init' ? cli.runInit(rest) : cli.runSync(rest));
} else if (cmd === 'hook') {
  const { runHook } = await import('../hook.mjs');
  process.exitCode = await runHook();
} else if (cmd === 'check') {
  const { runCheck } = await import('../check.mjs');
  process.exitCode = await runCheck(rest);
} else {
  console.log('Usage: ds-enforcer [serve] | init [--root <dir>] [--yes] | sync [--root <dir>] | check [paths...] [--baseline] [--all] [--a11y] [--since <ref>] [--format text|json|github|sarif] [--min low|medium|high] [--fail-on low|medium|high|never] [--root <dir>]');
  process.exitCode = cmd === 'help' || cmd === '--help' ? 0 : 1;
}
