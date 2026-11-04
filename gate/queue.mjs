/**
 * The review queue: the cases waiting for the reviewer (componentGate.reviewer), in <state>/review.json. A case is a
 * piece or a lookalike finding an agent kept as its own markup, built with nothing
 * fitting, wrote without a consult, or was made to swap. While a case is open its
 * finding is held back from the edit hook and the agents' gates, so no later edit
 * flags it again before the decision is carried out.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROJECT_ROOT, insideProject } from '../config.js';
import { keyOf, relOf } from '../baseline.js';
import { gateSettings, stateDir, readJson, writeJsonAtomic, withFileLock, sentenceStart, fileTypesText } from './settings.mjs';
import { gateKind } from './markup.mjs';
import { consult, pieceId } from './consult.mjs';
import { LOOKALIKE_TYPES, componentRootMap, findBespokeLookalikes, findHandCopied } from './lookalikes.mjs';

export const KIND = Object.freeze({ KEPT: 'kept', AUTO: 'swapped-automatically', NONE: 'nothing-fitting', UNCONSULTED: 'unconsulted' });

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' ? v.trim() : '');
const queuePath = dir => join(dir, 'review.json');
const PHP_BLOCK = /<\?(?:php\b|=)[\s\S]*?(?:\?>|$)/gi;

export function loadQueue(dir = stateDir()) {
  const stored = readJson(queuePath(dir), null);
  return Array.isArray(stored?.cases) ? stored.cases.filter(isObj) : [];
}

export class QueueReadError extends Error {}

/*
 * The cases a change starts from. A file that is there but cannot be parsed may hold the only copy
 * of Bill's decisions, so, as the review page and suggestions.json do, it is never written over.
 */
function casesToChange(dir) {
  const path = queuePath(dir);
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!raw.trim()) return [];
  let stored = null;
  try { stored = JSON.parse(raw); } catch { /* reported below */ }
  if (!isObj(stored)) throw new QueueReadError(`${path} could not be read, so it was left as it is. Fix or remove it, then try again.`);
  return Array.isArray(stored.cases) ? stored.cases.filter(isObj) : [];
}

/* The lock is a directory beside review.json; anything else that writes the file takes it too. */
function changeQueue(dir, change) {
  return withFileLock(join(dir, 'review.lock'), () => {
    const cases = casesToChange(dir);
    const result = change(cases);
    if (result !== null) writeJsonAtomic(queuePath(dir), { cases });
    return result;
  });
}

/** PHP is shown as an ellipsis: a sample is rendered as it stands, and nothing in it is ever run. */
export function staticSample(markup) {
  return String(markup ?? '').replace(PHP_BLOCK, '…');
}

export function addCase(input = {}, dir = stateDir()) {
  const markup = String(input.markup ?? '');
  const c = {
    id: null,
    created: new Date().toISOString(),
    session: input.session ?? null,
    agent: text(input.agent) || 'main session',
    file: input.file ?? null,
    line: Number.isInteger(input.line) ? input.line : null,
    kind: Object.values(KIND).includes(input.kind) ? input.kind : KIND.KEPT,
    piece: input.piece ?? null,
    finding: input.finding ?? null,
    markup,
    // An automatic swap's own line, which Undo puts back; its markup is the lines around it.
    ...(typeof input.original === 'string' ? { original: input.original } : {}),
    sample: staticSample(text(input.sample) ? input.sample : markup),
    stylesheets: Array.isArray(input.stylesheets) ? input.stylesheets : [],
    candidates: Array.isArray(input.candidates) ? input.candidates : [],
    chosen: input.chosen ?? null,
    reason: String(input.reason ?? ''),
    decision: 'pending',
    status: 'open',
    seen: false,
  };
  return changeQueue(dir, cases => {
    const taken = new Set(cases.map(x => x.id));
    do c.id = `C-${randomBytes(3).toString('hex')}`; while (taken.has(c.id));
    cases.push(c);
    return c;
  });
}

/** The case with the patch applied, or null when no case has that id. */
export function updateCase(id, patch, dir = stateDir()) {
  return changeQueue(dir, cases => {
    const i = cases.findIndex(c => c.id === id);
    if (i < 0) return null;
    cases[i] = { ...cases[i], ...patch, id };
    return cases[i];
  });
}

export function openSuppressionKeys(dir = stateDir()) {
  return new Set(loadQueue(dir).filter(c => c.status === 'open' && typeof c.finding === 'string' && c.finding).map(c => c.finding));
}

export const recordedText = (c, reviewer = gateSettings().reviewer) => `Case ${c.id} recorded. ${sentenceStart(reviewer)} will see it on the review page.`;

export class CaseInputError extends Error {}

const RECORD_INPUT = 'record_case takes file (the project-relative path the markup is in), reason, markup (what you wrote), and piece_id (P-... from the consult) or finding (the key a finding message ends with), plus sample_html and chosen if you have them.';

/**
 * Record an agent's case from record_case or `ds-enforcer record-case`. The session and agent
 * are filled later by the hook that sees the call. Throws CaseInputError for input it refuses.
 */
export function recordCase(input, { dir = stateDir(), data, minScore, settings = gateSettings() } = {}) {
  const { file, reason, markup, piece_id: pieceIdIn, finding: findingIn, sample_html: sampleHtml, chosen } = isObj(input) ? input : {};
  const [pid, finding] = [text(pieceIdIn), text(findingIn)];
  if (!text(file) || !text(reason) || !text(markup) || (!pid && !finding)) throw new CaseInputError(RECORD_INPUT);
  const abs = isAbsolute(file.trim()) ? resolve(file.trim()) : resolve(PROJECT_ROOT, file.trim());
  if (!insideProject(abs)) throw new CaseInputError(`Refused: ${file} is outside the project (${PROJECT_ROOT}).`);
  const rel = relOf(abs);
  // A file the gate only detects cannot call a helper, and a skipped file is never checked: the reviewer could do nothing with the case.
  if (gateKind(rel, settings) !== 'gate') {
    const types = fileTypesText(settings);
    throw new CaseInputError(`Refused: ${rel} is not a file the component gate covers (a ${types.gated} file outside componentGate.skip), so there is nothing to record.${types.detected ? ` Lookalikes in ${types.detected} files are only reported.` : ''}`);
  }
  if (pid && !/^P-[0-9a-f]{6}$/.test(pid)) throw new CaseInputError(`${pid} is not a piece id. Piece ids look like P-1a2b3c and come from consult_ui.`);
  const [fileOf, type, ...rest] = finding.split('|');
  if (finding && (fileOf !== rel || !LOOKALIKE_TYPES.includes(type) || !rest.join('|'))) {
    throw new CaseInputError(`${finding} is not a lookalike finding in ${rel}. Pass the key the finding message ends with, (finding: <key>).`);
  }

  let content = '';
  try { content = readFileSync(abs, 'utf8'); } catch { /* not written yet: no line and no stylesheets */ }
  const piece = pid ? consultedPiece(pid, rel, dir) : null;
  const candidates = [];
  const offer = helper => { if (helper && !candidates.some(c => c.helper === helper)) candidates.push({ helper }); };
  // A session stores a piece's candidates as helper names; a consult result holds { helper } objects.
  for (const c of piece?.candidates ?? []) offer(typeof c === 'string' ? c : c?.helper);
  if (type === 'hand-copied-component') offer(componentRootMap().get(rest.join('|')));
  if (type === 'bespoke-lookalike' && data) {
    const words = rest.join('|').replace(/[-_]+/g, ' ');
    for (const c of consult({ file: rel, pieces: [words] }, { data, minScore }).pieces[0].candidates) offer(c.helper);
  }
  // The consult decided whether a piece had anything fitting; for a finding alone, the candidates say.
  const kind = piece ? (piece.nothingFitting === true ? KIND.NONE : KIND.KEPT)
    : finding && !candidates.length ? KIND.NONE : KIND.KEPT;

  return addCase({
    file: rel,
    line: findingLine(content, abs, rel, finding) ?? markupLine(content, markup),
    kind,
    piece: pid ? { id: pid, description: piece?.description ?? '' } : null,
    finding: finding || null,
    markup,
    sample: text(sampleHtml) ? sampleHtml : markup,
    stylesheets: pageStylesheets(rel, content),
    candidates,
    chosen: text(chosen) || null,
    reason: reason.trim(),
  }, dir);
}

/* The consult that showed the agent this piece, from whichever session recorded it. A piece id
   is a hash of the file and the words, so a stored piece is only taken when both match. */
function consultedPiece(id, rel, dir) {
  const folder = join(dir, 'sessions');
  let names;
  try { names = readdirSync(folder).filter(n => n.endsWith('.json')); } catch { return null; }
  const mtime = n => { try { return statSync(join(folder, n)).mtimeMs; } catch { return 0; } };
  for (const name of names.sort((a, b) => mtime(b) - mtime(a))) {
    const p = readJson(join(folder, name), null)?.pieces?.[id];
    if (isObj(p) && typeof p.description === 'string' && pieceId(rel, p.description) === id) return p;
  }
  return null;
}

const lineAt = (content, at) => content.slice(0, at).split('\n').length;

function findingLine(content, abs, rel, finding) {
  if (!finding || !content) return null;
  const found = [...findBespokeLookalikes(content, abs), ...findHandCopied(content, abs, componentRootMap())];
  return found.find(v => keyOf(rel, v) === finding)?.line ?? null;
}

function markupLine(content, markup) {
  const at = content ? content.indexOf(markup.trim()) : -1;
  return at < 0 ? null : lineAt(content, at);
}

// PHP inside a tag (href="/x.css?v=<?= filemtime(...) ?>") carries a ">" of its own.
const LINK_TAG = /<link\b(?:<\?[\s\S]*?\?>|[^>])*>/gi;
const EXTRA_CSS = /\$extra_css\s*(?:\[\s*\])?\s*=\s*([^;]*)/g;
const STRING = /'([^']*)'|"([^"]*)"/g;

/** The page's own stylesheets, project-relative, in the order the file names them; only files that exist. */
export function pageStylesheets(rel, content) {
  const refs = [];
  for (const m of content.matchAll(LINK_TAG)) {
    const tag = m[0].replace(PHP_BLOCK, '');
    const href = /\bhref\s*=\s*\\?["']([^"'\\]*)/i.exec(tag);
    if (/\brel\s*=\s*\\?["']?stylesheet\b/i.test(tag) && href) refs.push([m.index, href[1]]);
  }
  for (const m of content.matchAll(EXTRA_CSS)) {
    for (const s of m[1].matchAll(STRING)) refs.push([m.index + s.index, s[1] ?? s[2]]);
  }
  const out = [];
  for (const [, ref] of refs.sort((a, b) => a[0] - b[0])) {
    const path = ref.split(/[?#]/)[0].trim();
    if (!path.endsWith('.css') || /^(?:[a-z][\w+.-]*:)?\/\//i.test(path)) continue;
    const abs = path.startsWith('/') ? resolve(PROJECT_ROOT, `.${path}`) : resolve(PROJECT_ROOT, dirname(rel), path);
    let isFile = false;
    try { isFile = insideProject(abs) && statSync(abs).isFile(); } catch { /* missing */ }
    if (isFile && !out.includes(relOf(abs))) out.push(relOf(abs));
  }
  return out;
}
