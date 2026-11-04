/**
 * The component gate's ds-enforcer subcommands. Each returns its exit code:
 * 0 done, 1 not available, 2 a usage error or a refused path. The hooks, gate,
 * gate-post and finish, read their payload from stdin and fail open: exit 0 unless
 * gate-post has findings for the agent to fix, which exit 2 shows it.
 */
import { resolve, isAbsolute } from 'node:path';
import { PROJECT_ROOT, insideProject } from '../config.js';
import { relOf } from '../baseline.js';
import { loadCatalog } from '../search.mjs';
import { gateSettings } from './settings.mjs';
import { consult, consultArgs, formatConsult } from './consult.mjs';
import { recordCase, recordedText, CaseInputError, QueueReadError } from './queue.mjs';
import { scanSuggestions, refreshSuggestions, dismissedIds, formatSuggestions, SuggestInputError } from './suggest.mjs';

const CONSULT_USAGE = 'Usage: ds-enforcer consult --file <path in the project> --piece "<what you are building>" [--piece "<another piece>"...]';
const RECORD_USAGE = 'Usage: ds-enforcer record-case --json \'{"file": "<path in the project>", "reason": "<why>", "markup": "<what you wrote>", "piece_id": "<P-... from the consult>"}\' (or "finding": "<the key a finding ends with>" in place of piece_id; "sample_html" and "chosen" are optional)';
const APPLY_USAGE = 'Usage: ds-enforcer apply-review (no arguments: it carries out every decision saved on the review page)';
const SUGGEST_USAGE = 'Usage: ds-enforcer suggest [--force] [paths...] (with no paths, refresh the saved list, scanning at most once a day unless --force; with paths, scan only those and save nothing)';
const GATE_OFF = 'The component gate is off for this project (componentGate.enabled in enforcer.config.json).';

export async function runGateCli(cmd, argv = []) {
  if (cmd === 'consult') return runConsult(argv);
  if (cmd === 'record-case') return runRecordCase(argv);
  if (cmd === 'suggest') return runSuggest(argv);
  if (cmd === 'apply-review') return runApplyReview(argv);
  if (cmd === 'gate') return runGateHook();
  if (cmd === 'gate-post') return runGatePostHook();
  if (cmd === 'finish') return runFinishHook();
  console.error(`ds-enforcer: unknown gate command ${cmd}`);
  return 2;
}

function runConsult(argv) {
  const { file, pieces } = consultArgs(argv);
  if (!file || !pieces.length) {
    console.error(CONSULT_USAGE);
    return 2;
  }
  const settings = gateSettings();
  if (!settings.enabled) {
    console.error(GATE_OFF);
    return 1;
  }
  const abs = isAbsolute(file) ? resolve(file) : resolve(PROJECT_ROOT, file);
  if (!insideProject(abs)) {
    console.error(`Refused: ${file} is outside the project (${PROJECT_ROOT}).`);
    return 2;
  }
  console.log(formatConsult(consult({ file: relOf(abs), pieces }, { data: loadCatalog(), minScore: settings.minScore })));
  return 0;
}

function runRecordCase(argv) {
  const at = argv.indexOf('--json');
  let input = null;
  try { input = at < 0 ? null : JSON.parse(argv[at + 1] ?? ''); } catch { /* reported as usage below */ }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    console.error(RECORD_USAGE);
    return 2;
  }
  const settings = gateSettings();
  if (!settings.enabled) {
    console.error(GATE_OFF);
    return 1;
  }
  try {
    console.log(recordedText(recordCase(input, { data: loadCatalog(), minScore: settings.minScore })));
    return 0;
  } catch (error) {
    if (!(error instanceof CaseInputError) && !(error instanceof QueueReadError)) throw error;
    console.error(error.message);
    return error instanceof CaseInputError ? 2 : 1;
  }
}

function runSuggest(argv) {
  const force = argv.includes('--force');
  const paths = argv.filter(a => a !== '--force');
  if (paths.some(a => a.startsWith('-'))) {
    console.error(SUGGEST_USAGE);
    return 2;
  }
  const settings = gateSettings();
  if (!settings.enabled) {
    console.error(GATE_OFF);
    return 1;
  }
  try {
    const data = loadCatalog();
    if (paths.length) {
      const dismissed = dismissedIds();
      const found = scanSuggestions({ files: paths, data, minScore: settings.minScore }).filter(s => !dismissed.has(s.id));
      console.log(formatSuggestions(found, { reviewUrl: settings.reviewUrl, scope: paths.join(', ') }));
    } else {
      const { entries } = refreshSuggestions({ force, data, minScore: settings.minScore });
      console.log(formatSuggestions(entries, { reviewUrl: settings.reviewUrl }));
    }
    return 0;
  } catch (error) {
    // An unreadable suggestions.json or a project that is not a git checkout: say so, change nothing.
    console.error(error.message);
    return error instanceof SuggestInputError ? 2 : 1;
  }
}

async function runApplyReview(argv) {
  if (argv.length) {
    console.error(APPLY_USAGE);
    return 2;
  }
  const settings = gateSettings();
  if (!settings.enabled) {
    console.error(GATE_OFF);
    return 1;
  }
  try {
    const { applyReview, formatApplyReview } = await import('./apply.mjs');
    const result = await applyReview({ data: loadCatalog() });
    console.log(formatApplyReview(result, { reviewUrl: settings.reviewUrl, again: 'run ds-enforcer apply-review again' }).trimEnd());
    return 0;
  } catch (error) {
    // A project that is not connected, or a baseline that cannot be read: say so.
    console.error(error.message);
    return 1;
  }
}

async function readPayload() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch { return null; }
}

/* A payload this cannot read is nothing to judge, so it passes in silence. */
async function runGateHook() {
  try {
    const payload = await readPayload();
    if (!payload) return 0;
    const { runGate } = await import('./pretool.mjs');
    const { decision, reason } = await runGate(payload);
    if (decision === 'deny') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    }
  } catch (error) {
    process.stderr.write(`ds-enforcer gate skipped: ${error.message}\n`);
  }
  return 0;
}

async function runGatePostHook() {
  try {
    const payload = await readPayload();
    if (!payload) return 0;
    const { runGatePost } = await import('./posttool.mjs');
    const { tell, withSubagentNotice } = await import('../hook.mjs');
    return tell(await withSubagentNotice(payload, await runGatePost(payload)));
  } catch (error) {
    process.stderr.write(`ds-enforcer gate-post skipped: ${error.message}\n`);
    return 0;
  }
}

/* Stop and SubagentStop both take { decision: 'block', reason } on stdout to keep the agent working. */
async function runFinishHook() {
  try {
    const payload = await readPayload();
    if (!payload) return 0;
    const { runFinish } = await import('./finish.mjs');
    const { block, reason } = await runFinish(payload);
    if (block) console.log(JSON.stringify({ decision: 'block', reason }));
  } catch (error) {
    process.stderr.write(`ds-enforcer finish skipped: ${error.message}\n`);
  }
  return 0;
}
