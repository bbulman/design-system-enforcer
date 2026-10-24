/**
 * `ds-enforcer hook`: a Claude Code PostToolUse hook. After Claude edits or writes a
 * file, check it; if the edit left new findings at or above the hook's severity
 * (config `hookMin`, default "medium"), print them and exit 2, which Claude Code
 * shows to Claude so it fixes them in its next step. Otherwise stay silent (exit 0).
 *
 * It also notes each checked file in .ds-enforcer/session.json, so the Stop hook
 * (`ds-enforcer stop-hook`) can refresh design-system-report.md for the files edited
 * this session when Claude finishes, and show it if anything is left to fix.
 *
 * Never blocks work it can't judge: an unconnected project, a file type it doesn't
 * check, a file outside the project or any internal error all exit 0.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, extname, dirname } from 'path';
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
    const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
    if (!target) return 0;
    if (!process.env.CLAUDE_PROJECT_DIR && input.cwd) process.env.ENFORCER_PROJECT_ROOT = input.cwd;
    const { EXTS, loadEngine } = await import('./check.mjs');
    const abs = resolve(input.cwd || process.cwd(), target);
    if (!EXTS.has(extname(abs)) || !existsSync(abs)) return 0;
    const engine = await loadEngine();
    if (!engine || !engine.insideProject(abs)) return 0;
    const bl = await import('./baseline.js');
    const rel = bl.relOf(abs);
    noteEdit(engine, input.session_id, rel);
    const min = RANK[engine.config.hookMin || 'medium'] ?? 2;
    const found = engine.validate(readFileSync(abs, 'utf8'), abs);
    const { fresh } = bl.splitByBaseline(rel, found, bl.loadBaseline());
    const report = fresh.filter(v => (RANK[v.severity] ?? 1) >= min).sort((a, b) => (a.line || 0) - (b.line || 0));
    if (!report.length) return 0;
    const lines = report.slice(0, 20).map(v => `- line ${v.line}: ${v.message}${v.suggestion ? `. ${v.suggestion}` : ''}`);
    if (report.length > 20) lines.push(`- and ${report.length - 20} more (run validate_file on it for the full list)`);
    process.stderr.write(`Design system check on ${rel}: ${report.length} new finding${report.length === 1 ? '' : 's'} to fix.\n${lines.join('\n')}\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`ds-enforcer hook skipped: ${error.message}\n`);
    return 0;
  }
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
 * kept) and, if anything is left to fix, show a short summary to the person. It says
 * nothing when the list is empty or unchanged since it last spoke, and never blocks.
 * Config: autoReport (default true) turns it off; reportMin sets the lowest severity
 * listed (default "low"); openReport: true also opens the file in the default app.
 */
export async function runStopHook() {
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    if (input.stop_hook_active) return 0;
    if (!process.env.CLAUDE_PROJECT_DIR && input.cwd) process.env.ENFORCER_PROJECT_ROOT = input.cwd;
    const { loadEngine } = await import('./check.mjs');
    const engine = await loadEngine();
    if (!engine || engine.config.autoReport === false) return 0;
    const state = readSession(engine);
    if (input.session_id && state.session && state.session !== input.session_id) return 0;
    const files = (state.files || []).filter(f => existsSync(engine.projectPath(f)));
    if (!files.length) return 0;
    const { writeReport } = await import('./report.mjs');
    const r = await writeReport({ targets: files, base: engine.PROJECT_ROOT, min: engine.config.reportMin || 'low', keepTicks: true });
    const digest = createHash('sha1').update(r.items.map(v => `${v.file}|${v.line}|${v.type}|${v.match}`).join('\n')).digest('hex').slice(0, 12);
    const changed = digest !== state.shown;
    writeSession(engine, { ...state, files, shown: digest });
    if (!r.total || !changed) return 0;
    const top = r.items.slice(0, 8).map(v => `  ${v.ticked ? '☑' : '☐'} ${v.id} ${v.file}:${v.line || 1} ${v.message}`);
    if (r.total > 8) top.push(`  … and ${r.total - 8} more`);
    const message = [
      `Design system report: ${r.total} violation${r.total === 1 ? '' : 's'} in ${r.files} file${r.files === 1 ? '' : 's'} edited this session (${r.auto} auto-fixable).`,
      ...top,
      `Open ${r.rel}, tick the fixes you want, then say "apply the design system report" (or "tick all auto").`,
    ].join('\n');
    process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
    if (engine.config.openReport === true) openFile(r.path);
    return 0;
  } catch (error) {
    process.stderr.write(`ds-enforcer stop-hook skipped: ${error.message}\n`);
    return 0;
  }
}

function openFile(path) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* no viewer: the message is enough */ }
}
