/**
 * `ds-enforcer hook`: a Claude Code PostToolUse hook. After Claude edits or writes a
 * file, check it; if the edit left new findings at or above the hook's severity
 * (config `hookMin`, default "medium"), print them and exit 2, which Claude Code
 * shows to Claude so it fixes them in its next step. Otherwise stay silent (exit 0).
 * With the component gate on, lookalikes in a file the gate does not cover (.js, .html)
 * are only information: they go to Claude as additionalContext on stdout, with exit 0.
 *
 * It also notes each checked file in .ds-enforcer/session.json, so the Stop hook
 * (`ds-enforcer stop-hook`) can refresh design-system-report.md for the files edited
 * this session when Claude finishes, and show it if anything is left to fix.
 *
 * Never blocks work it can't judge: an unconnected project, a file type it doesn't
 * check, a file outside the project or any internal error all exit 0.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, extname, dirname, join } from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';

const RANK = { low: 1, medium: 2, high: 3 };

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export async function runHook() {
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    if (!process.env.CLAUDE_PROJECT_DIR && input.cwd) process.env.ENFORCER_PROJECT_ROOT = input.cwd;
    return tell(await withSubagentNotice(input, await checkEdited(input)));
  } catch (error) {
    process.stderr.write(`ds-enforcer hook skipped: ${error.message}\n`);
    return 0;
  }
}

async function checkEdited(input) {
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) return {};
  const { EXTS, loadEngine } = await import('./check.mjs');
  const abs = resolve(input.cwd || process.cwd(), target);
  if (!EXTS.has(extname(abs)) || !existsSync(abs)) return {};
  const engine = await loadEngine();
  if (!engine || !engine.insideProject(abs)) return {};
  if (engine.staleConfig()) process.stderr.write(`ds-enforcer hook warning: ${engine.staleConfigText(engine.CONFIG_PATH, engine.config.configVersion)}\n`);
  const { relOf } = await import('./baseline.js');
  return reportFresh(engine, relOf(abs), input.session_id);
}

/*
 * A subagent in the desktop app hands back before its SubagentStop block reaches it, so the main
 * session hears what it left at its next edit or shell command, as information, and the Stop still
 * holds it there. A failure here never loses what the hook itself found.
 */
export async function withSubagentNotice(payload, found = {}) {
  let notice = null;
  try { notice = await (await import('./gate/finish.mjs')).runNotice(payload); } catch { /* fails open */ }
  return notice ? { ...found, info: [found.info, notice].filter(Boolean).join('\n\n') } : found;
}

/**
 * A PostToolUse hook's exit code for what reportFresh found. Findings to fix go to stderr with exit 2,
 * which Claude Code shows to Claude, with any information after them; information alone goes to
 * stdout as additionalContext with exit 0, since exit 2 would read as something to fix.
 */
export function tell({ message, info } = {}) {
  if (message) {
    process.stderr.write(`${message}${info ? `\n\n${info}` : ''}\n`);
    return 2;
  }
  if (info) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: info } }) + '\n');
  return 0;
}

const NOTHING = Object.freeze({ message: null, info: null });
const findings = n => `${n} new finding${n === 1 ? '' : 's'}`;
const lookalikes = n => `${n} lookalike${n === 1 ? '' : 's'}`;

/**
 * What the edit hook says about one project file, as { message, info }. message lists its new
 * findings at or above hookMin that no open case holds back, to fix; info lists the lookalikes in
 * a file the component gate does not cover, which cannot call a ws_* helper, so there is nothing to
 * record or consult on; in JavaScript it names the js/ws.js twin where a component has one. Both are null when there is nothing or the enforcer does not check
 * the file. The file is noted for the Stop hook's report either way.
 */
export async function reportFresh(engine, rel, sessionId) {
  const { EXTS } = await import('./check.mjs');
  const abs = engine.projectPath(rel);
  if (!EXTS.has(extname(abs)) || !existsSync(abs)) return NOTHING;
  const bl = await import('./baseline.js');
  noteEdit(engine, sessionId, rel);
  const min = RANK[engine.config.hookMin || 'medium'] ?? 2;
  const found = engine.validate(readFileSync(abs, 'utf8'), abs);
  let { fresh } = bl.splitByBaseline(rel, found, bl.loadBaseline());
  const { gateSettings } = await import('./gate/settings.mjs');
  const gate = gateSettings();
  let gated = true;
  if (gate.enabled) {
    // A finding with an open case in the review queue waits for the decision to be carried out.
    const { openSuppressionKeys } = await import('./gate/queue.mjs');
    const open = openSuppressionKeys();
    fresh = fresh.filter(v => !open.has(bl.keyOf(rel, v)));
    gated = (await import('./gate/markup.mjs')).gateKind(rel, gate) === 'gate';
  }
  const report = fresh.filter(v => (RANK[v.severity] ?? 1) >= min).sort((a, b) => (a.line || 0) - (b.line || 0));
  if (!report.length) return NOTHING;
  const { LOOKALIKE_TYPES, namesTwin } = await import('./gate/lookalikes.mjs');
  const isLookalike = v => LOOKALIKE_TYPES.includes(v.type);
  const toFix = gated ? report : report.filter(v => !isLookalike(v));
  const noted = gated ? [] : report.filter(isLookalike);
  // The key is what record_case takes to keep a lookalike as it is.
  const findingOf = v => (isLookalike(v) ? ` (finding: ${bl.keyOf(rel, v)})` : '');
  // A hand-copied component in JavaScript whose helper has a twin in the project's JavaScript file (components.js).
  const hasTwin = v => namesTwin(v.suggestion);
  const { functionPrefix, js } = engine.config.components || {};
  const listed = (list, line) => [...list.slice(0, 20).map(line), ...(list.length > 20 ? [`- and ${list.length - 20} more (run validate_file on it for the full list)`] : [])].join('\n');
  return {
    message: toFix.length ? `Design system check on ${rel}: ${findings(toFix.length)} to fix.\n${listed(toFix, v => `- line ${v.line}: ${v.message}${v.suggestion ? `. ${v.suggestion}` : ''}${findingOf(v)}`)}` : null,
    info: noted.length ? `Design system check on ${rel}: ${lookalikes(noted.length)} reported for information only. This file cannot call a ${functionPrefix ? `${functionPrefix}* ` : ''}helper, so nothing is recorded${noted.some(hasTwin) ? `. Where a line names a ${js.namespace}.* function, ${js.file || `the ${js.namespace} script`} draws that component in JavaScript: use it for markup you are writing${engine.config.commitGate?.jsComponents === 'block' ? ', because a new hand-copied one is blocked at commit' : ''}` : ' and nothing needs to change'}.\n${listed(noted, v => `- line ${v.line}: ${v.message}${hasTwin(v) ? `. ${v.suggestion}` : ''}`)}` : null,
  };
}

const SESSION = '.ds-enforcer/session.json';

function readSession(engine) {
  try { return JSON.parse(readFileSync(engine.projectPath(SESSION), 'utf8')); } catch { return {}; }
}

function writeSession(engine, data) {
  const path = engine.projectPath(SESSION);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  const ignore = engine.projectPath('.ds-enforcer/.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Per-session state from the Claude Code hooks; not for the repo\nsession.json\n');
}

/** Remember which files Claude touched in this session (a new session starts a new list). */
function noteEdit(engine, session, rel) {
  try {
    const state = readSession(engine);
    const fresh = state.session !== (session || null);
    const files = new Set(fresh ? [] : state.files || []);
    files.add(rel);
    writeSession(engine, { session: session || null, files: [...files], shown: fresh ? null : state.shown || null });
  } catch { /* noting is best-effort */ }
}

/**
 * `ds-enforcer stop-hook`: a Claude Code Stop hook. When Claude finishes a reply, write
 * design-system-report.md for the files edited this session (ticks already made are
 * kept) and, if anything is left to fix, show a short summary to the person. With the
 * component gate on, the summary ends with the gate's lines (summaryLines). Each part
 * says nothing when it is empty or unchanged since it last spoke, and it never blocks.
 * Config: autoReport (default true) turns the report off; reportMin sets the lowest
 * severity listed (default "low"); openReport: true also opens the file in the default app.
 */
export async function runStopHook() {
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    if (!process.env.CLAUDE_PROJECT_DIR && input.cwd) process.env.ENFORCER_PROJECT_ROOT = input.cwd;
    const { loadEngine } = await import('./check.mjs');
    const engine = await loadEngine();
    if (!engine) return 0;
    // Only the report waits out another Stop hook's loop: the gate's lines remember what they last said.
    const report = input.stop_hook_active || engine.config.autoReport === false ? null
      : await sessionReport(engine, input.session_id).catch(error => {
        process.stderr.write(`ds-enforcer stop-hook report skipped: ${error.message}\n`);
        return null;
      });
    const lines = [...(report ? [report.message] : []), ...(await gateSummary(input.session_id, engine.PROJECT_ROOT, { refresh: !input.stop_hook_active }))];
    if (!lines.length) return 0;
    process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }) + '\n');
    if (report && engine.config.openReport === true) openFile(report.path);
    return 0;
  } catch (error) {
    process.stderr.write(`ds-enforcer stop-hook skipped: ${error.message}\n`);
    return 0;
  }
}

/** The report's part of the message, or null when the list is empty or unchanged since it was last shown. */
async function sessionReport(engine, sessionId) {
  const state = readSession(engine);
  if (sessionId && state.session && state.session !== sessionId) return null;
  const files = (state.files || []).filter(f => existsSync(engine.projectPath(f)));
  if (!files.length) return null;
  const { writeReport } = await import('./report.mjs');
  const r = await writeReport({ targets: files, base: engine.PROJECT_ROOT, min: engine.config.reportMin || 'low', keepTicks: true });
  const digest = createHash('sha1').update(r.items.map(v => `${v.file}|${v.line}|${v.type}|${v.match}`).join('\n')).digest('hex').slice(0, 12);
  const changed = digest !== state.shown;
  writeSession(engine, { ...state, files, shown: digest });
  if (!r.total || !changed) return null;
  const top = r.items.slice(0, 8).map(v => `  ${v.ticked ? '☑' : '☐'} ${v.id} ${v.file}:${v.line || 1} ${v.message}`);
  if (r.total > 8) top.push(`  … and ${r.total - 8} more`);
  const message = [
    `Design system report: ${r.total} violation${r.total === 1 ? '' : 's'} in ${r.files} file${r.files === 1 ? '' : 's'} edited this session (${r.auto} auto-fixable).`,
    ...top,
    `Open ${r.rel}, tick the fixes you want, then say "apply the design system report" (or "tick all auto").`,
  ].join('\n');
  return { message, path: r.path };
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
// KIND.AUTO in gate/queue.mjs, which loads the config, so this module imports it only once a payload has named the project.
const AUTO = 'swapped-automatically';

/**
 * The component gate's lines for the end-of-session summary, each only when it has something to
 * say, then the review page link; none at all when there is nothing. Waiting cases are counted as
 * the review page's Waiting for you lists them, which leaves automatic swaps to Changed
 * automatically. session is this session's id: its applied automatic swaps are named one by one,
 * since an open one is written before the agent has switched. suggestionsAdded are the suggestion
 * ids that may be new: announced holds the ones already announced and gains the ones these lines
 * announce, so each is announced once.
 */
export function summaryLines({ queue = [], session = null, suggestionsAdded = [], reviewUrl, announced = new Set() } = {}) {
  const lines = [];
  const waiting = queue.filter(c => c.kind !== AUTO && c.status === 'open' && ['pending', 'later'].includes(c.decision ?? 'pending'));
  if (waiting.length) lines.push(`${plural(waiting.length, 'case')} waiting for review`);
  const swapped = session ? queue.filter(c => c.kind === AUTO && c.status === 'applied' && c.session === session) : [];
  if (swapped.length) {
    lines.push(`${plural(swapped.length, 'change')} made automatically:`);
    for (const c of swapped) lines.push(`  ${c.file}${Number.isInteger(c.line) ? `:${c.line}` : ''} → ${c.chosen}()`);
  }
  const fresh = [...new Set(suggestionsAdded)].filter(id => !announced.has(id));
  for (const id of fresh) announced.add(id);
  if (fresh.length) lines.push(`${plural(fresh.length, 'new component')} suggested`);
  return lines.length ? [...lines, ...(reviewUrl ? [`Review page: ${reviewUrl}`] : [])] : [];
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
const CLI = join(import.meta.dirname, 'bin/ds-enforcer.mjs');

/**
 * summaryLines for this session. Its suggestions are the ones an earlier refresh listed that were
 * never announced; each is announced once by its own line, and the rest is said again only when it
 * changes, which the gate's session file remembers. Then, when refresh is true, the refresh runs in
 * the background for the next Stop; a Stop another hook is looping on (stop_hook_active) can fire
 * many times a turn, and one refresh a turn is enough. Fails open: unreadable state never stops the report.
 */
async function gateSummary(sessionId, root, { refresh = true } = {}) {
  let enabled = false;
  try {
    const { gateSettings, stateDir, readJson, writeJsonAtomic, withFileLock } = await import('./gate/settings.mjs');
    const settings = gateSettings();
    enabled = settings.enabled;
    if (!enabled) return [];
    const dir = stateDir();
    const { loadQueue } = await import('./gate/queue.mjs');
    const sessions = await import('./gate/session.mjs');
    const base = { queue: loadQueue(dir), session: sessionId, reviewUrl: settings.reviewUrl };
    const steady = summaryLines({ ...base, suggestionsAdded: [] });
    let lines = steady;
    // The review page and the refresh write this file too, under this lock; only announced changes here.
    const path = join(dir, 'suggestions.json');
    withFileLock(join(dir, 'suggestions.lock'), () => {
      const stored = readJson(path, null);
      if (!isObj(stored)) {
        // As on the review page, a file that cannot be read is never written over.
        if (existsSync(path)) process.stderr.write(`ds-enforcer stop-hook: ${path} could not be read, so it was left as it is.\n`);
        return;
      }
      // Only entries at or over the page bar are worth a line; one under it is announced when it gets there.
      const floor = Number.isInteger(stored.minPages) ? stored.minPages : 0;
      const clears = e => !Number.isInteger(e?.pages) || e.pages >= floor || strings(e?.sources).includes('bill');
      const listed = (Array.isArray(stored.entries) ? stored.entries : []).filter(clears).map(e => e?.id).filter(id => typeof id === 'string');
      const announced = new Set(strings(stored.announced));
      const before = announced.size;
      // A first run finds the whole list already there (the first scan lists dozens): it is taken as said, not
      // announced at once. The flag says it has happened, since a list all under the bar announces nothing.
      const first = !before && stored.announcedInit !== true;
      if (first) for (const id of listed) announced.add(id);
      else lines = summaryLines({ ...base, suggestionsAdded: listed, announced });
      if (first || announced.size > before) writeJsonAtomic(path, { ...stored, announced: [...announced], ...(first ? { announcedInit: true } : {}) });
    });
    const key = steady.length ? createHash('sha1').update(steady.join('\n')).digest('hex').slice(0, 12) : null;
    const repeat = (sessions.readSession(sessionId, dir).summaryShown ?? null) === key;
    if (!repeat) sessions.updateSession(sessionId, s => { s.summaryShown = key; }, dir);
    return repeat && lines.length === steady.length ? [] : lines;
  } catch (error) {
    process.stderr.write(`ds-enforcer stop-hook summary skipped: ${error.message}\n`);
    return [];
  } finally {
    if (enabled && refresh) refreshInBackground(root);
  }
}

/**
 * `ds-enforcer suggest` in a detached process: its scan takes about a second once a day, more
 * than a hook may spend. It inherits this process's environment, so it finds the same project and
 * state. DS_ENFORCER_REFRESH=off leaves it out (the tests write suggestions.json themselves).
 */
function refreshInBackground(root) {
  if (process.env.DS_ENFORCER_REFRESH === 'off') return;
  try {
    const child = spawn(process.execPath, [CLI, 'suggest'], { cwd: root, detached: true, stdio: 'ignore' });
    child.on('error', () => { /* the next Stop tries again */ });
    child.unref();
  } catch { /* the next Stop tries again */ }
}

function openFile(path) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* no viewer: the message is enough */ }
}
