/**
 * Carrying out the reviewer's decisions from the review page, for apply_review and `ds-enforcer
 * apply-review`, the way apply_report carries out a ticked checklist. A swap to a component,
 * and an Undo of an automatic swap, are the agent's to make by hand: the case comes back with
 * the markup and the call, and the next run checks the file and marks it. Keep, fine and
 * should-become close the case and move its finding, where it has one, from the queue's
 * suppression into the baseline, since each leaves the agent's markup in place;
 * refreshSuggestions reads should-become by its decision. Undecided and later cases wait.
 */
import { readFileSync, existsSync } from 'node:fs';
import { projectPath, insideProject } from '../config.js';
import { keyOf, loadBaseline, splitByBaseline, appendToBaseline } from '../baseline.js';
import { loadEngine } from '../check.mjs';
import { loadCatalog } from '../search.mjs';
import { stateDir, gateSettings, sentenceStart } from './settings.mjs';
import { LOOKALIKE_TYPES } from './lookalikes.mjs';
import { KIND, loadQueue, updateCase } from './queue.mjs';

const CLOSES = new Set(['keep', 'fine', 'should-become']);
/* How far from the swap's line a restored finding may sit and still be the one Undo put back. */
const NEAR = 5;
const AGAIN = 'call apply_review again';
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/* Space, tab, line feed, vertical tab, form feed and carriage return: the same set locate() skips. */
const squash = s => String(s ?? '').replace(/[ \t\n\v\f\r]+/g, ' ').trim();
const helperOf = c => (typeof c === 'string' ? c : c?.helper);
/* The candidate the reviewer picked on the page, else the one it showed first. */
function chosenHelper(c) {
  if (typeof c.chosen === 'string' && c.chosen) return c.chosen;
  return (Array.isArray(c.candidates) ? c.candidates : []).map(helperOf).find(h => typeof h === 'string' && h) ?? null;
}
const lineAt = (content, at) => content.slice(0, at).split('\n').length;
const isSpace = code => code === 32 || (code >= 9 && code <= 13);

/**
 * The first and last line markup covers in content, or null when it is not there. Whitespace is
 * ignored, so markup put back with other indentation still counts as back.
 */
export function locate(content, markup) {
  const want = squash(markup);
  if (!want) return null;
  // Built as an array and joined once: appending to a string a character at a time, and reading
  // its end, made this quadratic, ten seconds on a megabyte.
  const flat = [];
  const at = [];
  let afterSpace = true; // leading whitespace is dropped, as squash() trims it
  for (let i = 0; i < content.length; i++) {
    if (!isSpace(content.charCodeAt(i))) { flat.push(content[i]); at.push(i); afterSpace = false; } else if (!afterSpace) { flat.push(' '); at.push(i); afterSpace = true; }
  }
  const k = flat.join('').indexOf(want);
  return k < 0 ? null : { from: lineAt(content, at[k]), to: lineAt(content, at[k + want.length - 1]) };
}

/** The file as the case's checks need it, or null when it is not a project file any more. */
function readCaseFile(engine, rel, baseline) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = projectPath(rel);
  if (!insideProject(abs) || !existsSync(abs)) return null;
  let content;
  try { content = readFileSync(abs, 'utf8'); } catch { return null; }
  const found = engine.validate(content, abs).filter(v => LOOKALIKE_TYPES.includes(v.type)).sort((a, b) => (a.line || 0) - (b.line || 0));
  const fresh = splitByBaseline(rel, found, baseline).fresh;
  return { content, fresh, keys: new Set(fresh.map(v => keyOf(rel, v))) };
}

/* The page shows the catalogue's example call, so that is the call handed back. */
function callFor(c, helper, catalog) {
  const candidate = (Array.isArray(c.candidates) ? c.candidates : []).find(x => helperOf(x) === helper);
  const example = catalog().catalog?.components?.[helper]?.example ?? (typeof candidate?.example === 'string' ? candidate.example : null);
  if (!example) return `${helper}()`;
  const single = /^<\?(?:=|php)\s*([\s\S]*?)\s*;?\s*\?>$/.exec(example.trim());
  return single && single[1].startsWith(`${helper}(`) && !single[1].includes('?>') ? single[1] : squash(example);
}

function swapLine(rel, c, file) {
  const at = c.finding ? file.fresh.find(v => keyOf(rel, v) === c.finding)?.line : null;
  return at || (locate(file.content, c.markup)?.from ?? c.line ?? null);
}

/* Where the call that replaced the original is now: the one nearest the case's line. */
function callLine(c, helper, content) {
  const near = Number.isInteger(c.line) ? c.line : 1;
  const lines = content.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(`${helper}(`)).map(([n]) => n);
  return lines.length ? lines.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0] : c.line ?? null;
}

/**
 * Carry out every decision the review page recorded. forClaude holds the swaps and undos for the
 * agent to make; applied, the ids the file now shows done; closed, the ids closed with no change
 * to the file; stillThere, the decisions that cannot be carried out, with why.
 */
export async function applyReview({ dir = stateDir(), engine, data } = {}) {
  if (engine === undefined) engine = await loadEngine();
  if (!engine) throw new Error('This project is not connected to a design system yet. Run init first.');
  let loaded = data;
  const catalog = () => (loaded ??= loadCatalog());
  const baseline = loadBaseline();
  const files = new Map();
  const fileOf = rel => {
    if (!files.has(rel)) files.set(rel, readCaseFile(engine, rel, baseline));
    return files.get(rel);
  };
  const baselined = new Set();
  const result = { forClaude: [], applied: [], closed: [], stillThere: [], baselined: 0 };
  // An open case held back every occurrence of its finding, so by default every one goes in.
  const toBaseline = (c, pick = () => true) => {
    if (typeof c.finding !== 'string' || !c.finding) return;
    const file = fileOf(c.file);
    const found = file ? file.fresh.filter(v => keyOf(c.file, v) === c.finding && pick(v) && !baselined.has(v)) : [];
    for (const v of found) baselined.add(v);
    result.baselined += appendToBaseline(found.map(violation => ({ file: c.file, violation })));
  };
  const handBack = (c, action, line, call, extra = {}) => result.forClaude.push({ id: c.id, action, file: c.file, line, markup: String(c.markup ?? ''), call, reason: String(c.reason ?? ''), ...extra });

  for (const c of loadQueue(dir)) {
    if (!isObj(c) || typeof c.id !== 'string') continue;
    if (c.decision === 'use-component' && c.status === 'open') {
      const helper = chosenHelper(c);
      if (!helper) { result.stillThere.push({ id: c.id, why: 'it names no component to use' }); continue; }
      const file = fileOf(c.file);
      if (!file) { result.stillThere.push({ id: c.id, why: 'its file is not in the project any more' }); continue; }
      const gone = !(c.finding && file.keys.has(c.finding)) && !locate(file.content, c.markup);
      // A stylesheet cannot call a helper: the pages that use its classes do.
      const called = /\.css$/i.test(c.file) || file.content.includes(`${helper}(`);
      if (gone && called) {
        updateCase(c.id, { status: 'applied' }, dir);
        result.applied.push(c.id);
      } else handBack(c, 'swap', swapLine(c.file, c, file), callFor(c, helper, catalog));
    } else if (c.decision === 'undo' && c.kind === KIND.AUTO && (c.status === 'open' || c.status === 'applied')) {
      const file = fileOf(c.file);
      if (!file) { result.stillThere.push({ id: c.id, why: 'its file is not in the project any more' }); continue; }
      if (!squash(c.markup)) { result.stillThere.push({ id: c.id, why: 'it kept no original markup to put back' }); continue; }
      // The markup kept is the lines around the finding. If those lines have changed since, its finding
      // back near the swap's line is enough; one further away is other markup, not the undo.
      const span = locate(file.content, c.markup);
      const restored = span ? v => v.line >= span.from && v.line <= span.to
        : v => Number.isInteger(c.line) && Math.abs(v.line - c.line) <= NEAR;
      if (span || (c.finding && file.fresh.some(v => keyOf(c.file, v) === c.finding && restored(v)))) {
        // Bill chose the original, so the finding it brings back must not be flagged, or swapped automatically, again.
        toBaseline(c, restored);
        updateCase(c.id, { status: 'closed' }, dir);
        result.applied.push(c.id);
      } else {
        const helper = chosenHelper(c);
        // The finding's own line is what goes back; markup, the lines around it, only says where.
        const original = typeof c.original === 'string' && squash(c.original) ? { original: c.original } : {};
        handBack(c, 'undo', helper ? callLine(c, helper, file.content) : c.line ?? null, helper ? `${helper}()` : null, original);
      }
    } else if (CLOSES.has(c.decision) && c.status === 'open') {
      // The baseline first: once the case is closed it no longer holds the finding back.
      toBaseline(c);
      updateCase(c.id, { status: 'closed' }, dir);
      result.closed.push(c.id);
    }
  }
  return result;
}

/* A code span that survives backticks in the markup. Markup is shown on one line, its whitespace squashed. */
function code(text) {
  const s = squash(text);
  const fence = '`'.repeat(Math.max(0, ...[...s.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

function itemLine(it) {
  const at = `\`${it.file}${Number.isInteger(it.line) ? `:${it.line}` : ''}\``;
  if (it.action === 'undo') {
    const where = it.call ? ` in place of ${code(it.call)}` : '';
    // A case from before the swap kept its own line has only the lines around it to give.
    if (!it.original) return `- **${it.id}** ${at}: undo the automatic swap. Put the original markup back${where}, so these lines read: ${code(it.markup)}`;
    return `- **${it.id}** ${at}: undo the automatic swap. Put the original markup back${where}. Its own line read: ${code(it.original)}. The lines around it read ${code(it.markup)} when the swap was made; they are only there to help you find the place, so leave any change made to them since as it is.`;
  }
  const reason = squash(it.reason);
  // The call is the catalogue's example, so its arguments are only a pattern.
  return `- **${it.id}** ${at}: replace ${code(it.markup)} with a call like ${code(it.call)}, keeping this markup's own text and links.${reason ? ` The agent's reason for its version: ${reason}` : ''}`;
}

export function formatApplyReview(r, { reviewUrl, again = AGAIN, reviewer = gateSettings().reviewer } = {}) {
  const ids = list => list.join(', ');
  let text = '## Applied the design system review\n\n';
  if (!r.forClaude.length && !r.applied.length && !r.closed.length && !r.stillThere.length && !r.baselined) {
    return `${text}No decisions are waiting to be carried out. ${sentenceStart(reviewer)} decides cases on the review page${reviewUrl ? `: ${reviewUrl}` : '.'}\n`;
  }
  text += `- **Applied**: ${r.applied.length}${r.applied.length ? ` (${ids(r.applied)})` : ''}\n`;
  if (r.closed.length) text += `- **Closed**: ${r.closed.length} (${ids(r.closed)})\n`;
  if (r.baselined) text += `- **Into the baseline**: ${r.baselined} finding${r.baselined === 1 ? '' : 's'}\n`;
  if (r.stillThere.length) text += `- **Not carried out**: ${r.stillThere.map(s => `${s.id} (${s.why})`).join('; ')}\n`;
  if (!r.forClaude.length) return `${text}\nEvery decision is carried out or reported above.\n`;
  text += `\n### For you to change (${r.forClaude.length})\n\n`;
  for (const it of r.forClaude) text += `${itemLine(it)}\n`;
  return `${text}\nMake each change, then ${again} to verify and mark it.\n`;
}
