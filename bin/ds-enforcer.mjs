#!/usr/bin/env node
/**
 * ds-enforcer            start the MCP server (what Claude Code runs)
 * ds-enforcer init       connect this project's design system (menu)
 * ds-enforcer sync       regenerate .ds-enforcer/ from the connected sources
 * ds-enforcer check      run the checks from the command line (pre-commit, CI)
 * ds-enforcer staged     the pre-commit gate: every check on the staged copy of what is being committed
 * ds-enforcer hook       Claude Code PostToolUse hook: check the file Claude just edited
 * ds-enforcer stop-hook  Claude Code Stop hook: refresh the report for this session's edits and show it
 * ds-enforcer report     write the violations as a checklist (design-system-report.md)
 * ds-enforcer apply      fix the ticked items in the checklist, re-check, mark them done
 * ds-enforcer consult    component gate: list the components that could build each UI piece
 * ds-enforcer record-case
 *                        component gate: put a kept or from-scratch piece in the reviewer's queue
 *                        (gate, gate-post, finish, suggest and apply-review are the gate's
 *                        other subcommands)
 */
import { existsSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

/* True when the MCP SDK resolves from here as the server will import it: from the package's own
   node_modules or any above it, as an npm install that hoists dependencies into the project leaves it. */
function sdkResolves() {
  try { import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'); return true; } catch { return false; }
}

/**
 * The MCP server's one dependency, for a worktree or a fresh clone that has none:
 * linked from the main checkout when it has it (instant, offline), else installed
 * from the lockfile. Everything it prints goes to stderr: stdout is the MCP channel.
 */
function ensureDeps() {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mods = join(pkg, 'node_modules');
  if (sdkResolves()) return;
  try {
    const git = args => execFileSync('git', args, { cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const main = dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const theirs = join(main, relative(git(['rev-parse', '--show-toplevel']), pkg), 'node_modules');
    if (theirs !== mods && !existsSync(mods) && existsSync(join(theirs, '@modelcontextprotocol/sdk'))) {
      symlinkSync(theirs, mods, 'dir');
      return;
    }
  } catch { /* not a git checkout: install below */ }
  process.stderr.write('ds-enforcer: installing the MCP server\'s dependencies (npm ci)\n');
  spawnSync('npm', ['ci', '--prefix', pkg, '--no-audit', '--no-fund', '--silent'], { stdio: ['ignore', 2, 2] });
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'serve') {
  ensureDeps();
  await import('../index.js');
} else if (cmd === 'init' || cmd === 'sync') {
  const cli = await import('../init/cli.mjs');
  process.exitCode = await (cmd === 'init' ? cli.runInit(rest) : cli.runSync(rest));
} else if (cmd === 'report' || cmd === 'apply') {
  const { runReportCli } = await import('../report-cli.mjs');
  process.exitCode = await runReportCli(cmd, rest);
} else if (cmd === 'hook') {
  const { runHook } = await import('../hook.mjs');
  process.exitCode = await runHook();
} else if (cmd === 'stop-hook') {
  const { runStopHook } = await import('../hook.mjs');
  process.exitCode = await runStopHook();
} else if (['consult', 'record-case', 'gate', 'gate-post', 'finish', 'suggest', 'apply-review'].includes(cmd)) {
  const { runGateCli } = await import('../gate/cli.mjs');
  process.exitCode = await runGateCli(cmd, rest);
} else if (cmd === 'staged') {
  const { runStaged } = await import('../staged.mjs');
  process.exitCode = await runStaged(rest);
} else if (cmd === 'check') {
  const { runCheck } = await import('../check.mjs');
  process.exitCode = await runCheck(rest);
} else {
  console.log('Usage: ds-enforcer [serve] | init [--root <dir>] [--yes] | sync [--root <dir>] | check [paths...] [--baseline] [--only <type,...>] [--all] [--a11y] [--since <ref>] [--format text|json|github|sarif] [--min low|medium|high] [--fail-on low|medium|high|never] [--root <dir>] | report [paths...] [--out <file>] [--min <sev>] [--a11y] | apply [--report <file>] [--tick R1,R4|auto|all] [--accept-rest] | consult --file <path> --piece "<text>" [--piece "<text>"...] | record-case --json \'{"file": ..., "reason": ..., "markup": ..., "piece_id" or "finding": ...}\'');
  process.exitCode = cmd === 'help' || cmd === '--help' ? 0 : 1;
}
