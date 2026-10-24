/**
 * The violation checklist: a Markdown report with one checkbox per finding, which a
 * person ticks and the enforcer then works through.
 *
 *   ds-enforcer report [paths...]   write design-system-report.md (new findings only)
 *   ds-enforcer apply               fix the ticked items, re-check, mark them done
 *
 * Each item says who fixes it. "auto": a swap with exactly one right answer
 * (bg-[#7C3AED] -> bg-brand), applied by the enforcer itself. "Claude": a fix that
 * needs judgment (a raw <button> to <Button>, a missing label, the nearest colour
 * when none matches), made by Claude and verified by the enforcer.
 *
 * The machine-readable part of each item is an HTML comment at the end of its line,
 * invisible when the Markdown is rendered, so ticking a box anywhere (an editor,
 * GitHub, a phone) is all it takes.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import { EXTS, loadEngine } from './check.mjs';

export const DEFAULT_REPORT = 'design-system-report.md';
const ITEM = /^- \[( |x|X)\] (.*?)\s*<!-- dse (\{.*\}) -->\s*$/;
const STATUS = /\s+— (✅ fixed|⚠️ still there[^<]*|🛠 for Claude|☑️ accepted)$/;
const RANK = { low: 1, medium: 2, high: 3 };
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function scan(engine, targets, base) {
  const { walk } = await import('./init/importers.mjs');
  const bl = await import('./baseline.js');
  const files = [];
  for (const t of targets.length ? targets : [engine.PROJECT_ROOT]) {
    const abs = resolve(base, t);
    if (!existsSync(abs)) throw new Error(`Not found: ${t}`);
    if (statSync(abs).isDirectory()) files.push(...walk(abs, { accept: p => EXTS.has(extname(p)) }));
    else if (EXTS.has(extname(abs))) files.push(abs);
  }
  const baseline = bl.loadBaseline();
  const out = [];
  let existing = 0;
  for (const file of files) {
    const rel = bl.relOf(file);
    const found = engine.validate(readFileSync(file, 'utf8'), file).sort((a, b) => (a.line || 0) - (b.line || 0));
    const split = bl.splitByBaseline(rel, found, baseline);
    existing += split.existing.length;
    for (const v of split.fresh) out.push({ ...v, file: rel });
  }
  return { findings: out, files: files.length, existing, baseline: Boolean(baseline) };
}

const kindOf = v => (v.autoFixable && v.fix && !v.file.endsWith('.swift') ? 'auto' : 'claude');
const fixText = v => (kindOf(v) === 'auto' ? `\`${v.fix.from}\` → \`${v.fix.to}\`` : v.suggestion || 'fix by hand');

const tickKey = v => `${v.file}|${v.type}|${v.match ?? ''}`;

/** Write the checklist for the findings in `targets` (or the whole project). With
 *  keepTicks, boxes ticked in the existing report stay ticked for the same finding. */
export async function writeReport({ targets = [], base = process.cwd(), out, min = 'low', a11y = false, keepTicks = false } = {}) {
  const engine = await loadEngine({ a11y });
  if (!engine) throw new Error('This project is not connected to a design system yet. Run init first.');
  const { findings, files, existing, baseline } = await scan(engine, targets, base);
  const shown = findings.filter(v => (RANK[v.severity] ?? 1) >= (RANK[min] ?? 1));
  const path = engine.projectPath(out || DEFAULT_REPORT);
  if (!engine.insideProject(path)) throw new Error('The report must be written inside the project.');
  const ticked = new Set();
  if (keepTicks && existsSync(path)) {
    for (const item of parseReport(readFileSync(path, 'utf8')).items || []) if (item.ticked) ticked.add(tickKey(item));
  }
  const byFile = new Map();
  shown.forEach((v, i) => {
    v.id = `R${i + 1}`;
    v.ticked = ticked.has(tickKey(v));
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file).push(v);
  });
  const auto = shown.filter(v => kindOf(v) === 'auto').length;
  const lines = [
    '# Design system report',
    '',
    `${shown.length} finding${shown.length === 1 ? '' : 's'} in ${byFile.size} of ${files} files checked${baseline ? `; ${existing} existing ones in the baseline are not listed` : ''}. Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    '**Tick the fixes you want**, then run `ds-enforcer apply` or ask Claude to "apply the design system report". You can also tick from chat: "tick R1, R4 and all auto".',
    '',
    `- **auto** (${auto}): a swap with exactly one right answer; the enforcer makes it.`,
    `- **Claude** (${shown.length - auto}): needs judgment; Claude makes the change and the enforcer checks it.`,
    '',
    'Each box is marked when it is done. Unticked items stay as they are; `ds-enforcer apply --accept-rest` records them in the baseline so they stop coming back.',
    '',
  ];
  for (const [file, list] of byFile) {
    lines.push(`## ${file} (${list.length})`, '');
    for (const v of list) {
      const data = { id: v.id, file: v.file, line: v.line || 1, type: v.type, match: v.match ?? null, severity: v.severity, kind: kindOf(v), ...(kindOf(v) === 'auto' ? { fix: v.fix } : {}), message: v.message, suggestion: v.suggestion || null };
      lines.push(`- [${v.ticked ? 'x' : ' '}] **${v.id}** · line ${v.line || 1} · ${v.severity} · ${v.message} → ${fixText(v)} · *${kindOf(v) === 'auto' ? 'auto' : 'Claude'}* <!-- dse ${JSON.stringify(data)} -->`);
    }
    lines.push('');
  }
  if (!shown.length) lines.push('Nothing to fix. ✔', '');
  writeFileSync(path, lines.join('\n'));
  return { path, rel: engine.relOf ? engine.relOf(path) : out || DEFAULT_REPORT, total: shown.length, auto, files: byFile.size, items: shown };
}

export function parseReport(text) {
  const lines = text.split('\n');
  const items = [];
  lines.forEach((line, i) => {
    const m = line.match(ITEM);
    if (!m) return;
    try {
      const data = JSON.parse(m[3]);
      const status = (m[2].match(STATUS) || [])[1] || null;
      items.push({ ...data, ticked: m[1] !== ' ', status, index: i });
    } catch { /* a hand-edited comment that no longer parses is skipped */ }
  });
  return { lines, items };
}

function setLine(lines, item, { ticked = item.ticked, status }) {
  const m = lines[item.index].match(ITEM);
  const body = m[2].replace(STATUS, '');
  lines[item.index] = `- [${ticked ? 'x' : ' '}] ${body}${status ? ` — ${status}` : ''} <!-- dse ${m[3]} -->`;
}

const keyOf = x => `${x.type}|${x.match ?? ''}`;

/**
 * Which report items in one file are still there. Identical findings (four raw
 * <button>s in a row) are told apart by pairing each finding the file has now with
 * the nearest report item of the same kind; report items left unpaired are fixed.
 * `items` are all the report's items for the file, ticked or not, so a fixed one
 * can't be confused with an untouched neighbour.
 */
function remaining(items, found) {
  const left = new Set();
  const groups = new Map();
  for (const it of items) { const k = keyOf(it); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  for (const [k, group] of groups) {
    const unpaired = new Set(group);
    for (const v of found.filter(x => keyOf(x) === k).sort((a, b) => (a.line || 0) - (b.line || 0))) {
      let best = null;
      for (const it of unpaired) if (!best || Math.abs(it.line - (v.line || 1)) < Math.abs(best.line - (v.line || 1))) best = it;
      if (best && Math.abs(best.line - (v.line || 1)) <= 20) { unpaired.delete(best); left.add(best); }
    }
  }
  return left;
}

/** Replace the finding's text with its fix on its line, or within three lines if code moved. */
function applyFix(lines, item) {
  const { from, to } = item.fix;
  const re = new RegExp(`(?<![\\w-])${esc(from)}(?![\\w-])`);
  const at = item.line - 1;
  for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
    const i = at + offset;
    if (i < 0 || i >= lines.length || !re.test(lines[i])) continue;
    lines[i] = lines[i].replace(re, to);
    return true;
  }
  return false;
}

/**
 * Work through the ticked items: apply the auto fixes, re-check every file a ticked
 * item is in, mark what is fixed, and return the ticked Claude items still to do.
 * `select` ticks items first: ids ("R4"), "auto" or "all".
 */
export async function applyReport({ report, select = [], acceptRest = false } = {}) {
  const engine = await loadEngine();
  if (!engine) throw new Error('This project is not connected to a design system yet. Run init first.');
  const path = engine.projectPath(report || DEFAULT_REPORT);
  if (!engine.insideProject(path)) throw new Error('The report must be inside the project.');
  if (!existsSync(path)) throw new Error(`No report at ${report || DEFAULT_REPORT}. Write one first (ds-enforcer report).`);
  const text = readFileSync(path, 'utf8');
  const { lines, items } = parseReport(text);
  const wanted = new Set(select.map(s => String(s).toUpperCase()));
  for (const it of items) {
    if (wanted.has('ALL') || wanted.has(it.id) || (wanted.has('AUTO') && it.kind === 'auto')) it.ticked = true;
  }

  const todo = items.filter(it => it.ticked && it.status !== '✅ fixed');
  const byFile = new Map();
  for (const it of todo) { if (!byFile.has(it.file)) byFile.set(it.file, []); byFile.get(it.file).push(it); }

  const applied = [], missed = [];
  for (const [file, list] of byFile) {
    const abs = engine.projectPath(file);
    if (!engine.insideProject(abs) || !existsSync(abs)) { list.forEach(it => missed.push({ ...it, why: 'file not found' })); continue; }
    const src = readFileSync(abs, 'utf8').split('\n');
    let changed = false;
    for (const it of list.filter(i => i.kind === 'auto').sort((a, b) => b.line - a.line)) {
      if (applyFix(src, it)) { applied.push(it); changed = true; } else missed.push({ ...it, why: 'the text was not found near its line' });
    }
    if (changed) writeFileSync(abs, src.join('\n'));
    // Verify every ticked item in the file against a fresh check, auto and Claude alike,
    // leaving out findings the baseline already holds.
    const bl = await import('./baseline.js');
    const { fresh } = bl.splitByBaseline(file, engine.validate(src.join('\n'), abs), bl.loadBaseline());
    const still = remaining(items.filter(i => i.file === file && i.status !== '☑️ accepted' && i.status !== '✅ fixed'), fresh);
    for (const it of list) it.done = !still.has(it);
  }

  const forClaude = [];
  for (const it of todo) {
    if (it.done) setLine(lines, it, { ticked: true, status: '✅ fixed' });
    else if (it.kind === 'claude') { setLine(lines, it, { ticked: true, status: '🛠 for Claude' }); forClaude.push(it); }
    else setLine(lines, it, { ticked: true, status: `⚠️ still there${missed.find(m => m.id === it.id) ? ` (${missed.find(m => m.id === it.id).why})` : ''}` });
  }
  // Ticked boxes that had nothing to do (already fixed) keep their mark; ticks from `select` are written back.
  for (const it of items) if (it.ticked && !todo.includes(it) && it.status !== '✅ fixed') setLine(lines, it, { ticked: true, status: it.status });

  let accepted = 0;
  if (acceptRest) {
    const bl = await import('./baseline.js');
    const rest = items.filter(it => !it.ticked && it.status !== '☑️ accepted');
    if (rest.length) {
      const current = bl.loadBaseline() || { counts: {} };
      const counts = { ...current.counts };
      for (const it of rest) {
        const key = bl.keyOf(it.file, { type: it.type, match: it.match, message: it.message });
        counts[key] = (counts[key] || 0) + 1;
        setLine(lines, it, { ticked: false, status: '☑️ accepted' });
        accepted++;
      }
      const { writeFileSync: write, mkdirSync } = await import('fs');
      const { dirname } = await import('path');
      const bpath = bl.baselinePath();
      mkdirSync(dirname(bpath), { recursive: true });
      write(bpath, JSON.stringify({ ...current, _comment: current._comment || 'Findings this project already had, so only new ones fail. Written by `ds-enforcer check --baseline`; re-run it to lock in fixes. Commit this file.', updatedAt: new Date().toISOString(), total: Object.values(counts).reduce((a, b) => a + b, 0), counts }, null, 2) + '\n');
    }
  }

  writeFileSync(path, lines.join('\n'));
  const fixed = todo.filter(it => it.done);
  return {
    path, report: report || DEFAULT_REPORT,
    fixed: fixed.length, appliedAuto: applied.length,
    stillThere: todo.filter(it => !it.done && it.kind === 'auto').map(it => ({ id: it.id, file: it.file, line: it.line, why: missed.find(m => m.id === it.id)?.why || 'the check still finds it' })),
    forClaude: forClaude.map(({ id, file, line, message, suggestion, match }) => ({ id, file, line, message, suggestion, match })),
    accepted,
    unticked: items.filter(it => !it.ticked && it.status !== '☑️ accepted').length - accepted,
  };
}
