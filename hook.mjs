/**
 * `ds-enforcer hook`: a Claude Code PostToolUse hook. After Claude edits or writes a
 * file, check it; if the edit left new findings at or above the hook's severity
 * (config `hookMin`, default "medium"), print them and exit 2, which Claude Code
 * shows to Claude so it fixes them in its next step. Otherwise stay silent (exit 0).
 *
 * Never blocks work it can't judge: an unconnected project, a file type it doesn't
 * check, a file outside the project or any internal error all exit 0.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';

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
