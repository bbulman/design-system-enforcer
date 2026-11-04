/**
 * The component gate's PreToolUse hook. A write that adds markup to a gated UI file is
 * refused until the session has consulted on that file. Two refusals for a file are the
 * most it gets: the third attempt goes through and becomes an unconsulted case for Bill,
 * so an agent that cannot consult, or a broken enforcer, never stalls a build.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, insideProject, projectPath } from '../config.js';
import { relOf } from '../baseline.js';
import { gateSettings, stateDir, ENFORCER_CLI } from './settings.mjs';
import { readSession, updateSession, agentKey, agentLabel, hasWrite, noteWrite } from './session.mjs';
import { gateKind, markupTokens, addsMarkup } from './markup.mjs';

const REFUSALS = 2;
const MARKUP_CAP = 4000;
const NAMES_CAP = 20;
const ALLOW = Object.freeze({ decision: 'allow' });
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export const denyReason = rel => `Before adding markup to ${rel}, tell the design system what you are building. Call consult_ui with the file and one plain-words description per UI piece, or run: ${ENFORCER_CLI} consult --file ${rel} --piece "<description>". Then make this edit again.`;

/* The shell parser (componentGate.shellParser) may be absent from some checkouts (Workshopr's agents/
   is gitignored); without it, or with none configured, Bash is not gated. */
let walls = { path: undefined, module: null };
export async function loadWalls(parser = gateSettings().shellParser) {
  const path = parser ? projectPath(parser) : null;
  if (walls.path !== path) {
    walls = { path, module: path && existsSync(path) ? await import(pathToFileURL(path).href).catch(() => null) : null };
  }
  return walls.module;
}

const OPEN_PHP = /<\?(?:php\b|=)/gi;

/** True when offset `at` lies inside a PHP block that is open there (its "?>" comes at or after it). */
function inPhpAt(text, at) {
  OPEN_PHP.lastIndex = 0;
  for (let m; (m = OPEN_PHP.exec(text)) && m.index < at;) {
    const close = text.indexOf('?>', m.index + m[0].length);
    if (close === -1 || close >= at) return true;
    OPEN_PHP.lastIndex = close + 2;
  }
  return false;
}

/** The class names the new text brings, or its new element names when it brings no class. */
function newNames(before, after, ext) {
  const [old, now] = [markupTokens(before, ext), markupTokens(after, ext)];
  const classes = [...now.classes].filter(c => !old.classes.has(c));
  return classes.length ? classes : [...now.elements].filter(e => !old.elements.has(e));
}

const lineAt = (text, at) => text.slice(0, at).split('\n').length;

/*
 * An Edit adds markup when its own text does or the whole file does. Its own text catches a
 * second copy of a tag and class a busy page already uses; the whole file catches markup whose
 * context lies outside the fragment (a class added inside an attribute, a selector without its
 * "{"). A fragment that starts inside an open PHP block is read as PHP, so markup a PHP string
 * builds is not counted.
 */
function editWrite(rel, abs, edits) {
  const ext = extname(rel);
  let text = '';
  try { text = readFileSync(abs, 'utf8'); } catch { /* a new file: every fragment is read as markup */ }
  const out = { rel, adds: false, markup: [], names: new Set(), line: null };
  for (const e of edits) {
    if (!isObj(e)) continue;
    const [oldText, newText] = [String(e.old_string ?? ''), String(e.new_string ?? '')];
    const at = oldText ? text.indexOf(oldText) : 0;
    const php = !/^\.css$/i.test(ext) && at >= 0 && inPhpAt(text, at);
    const [before, after] = php ? [`<?php ${oldText}`, `<?php ${newText}`] : [oldText, newText];
    const next = at < 0 ? text
      : e.replace_all === true ? text.split(oldText).join(newText) : text.slice(0, at) + newText + text.slice(at + oldText.length);
    const fragment = addsMarkup(before, after, ext);
    if (fragment || addsMarkup(text, next, ext)) {
      out.adds = true;
      out.markup.push(newText);
      for (const n of fragment ? newNames(before, after, ext) : newNames(text, next, ext)) out.names.add(n);
      if (out.line === null && at >= 0) out.line = lineAt(text, at);
    }
    text = next;
  }
  return { ...out, markup: out.markup.join('\n'), names: [...out.names] };
}

function fileWrite(rel, abs, content) {
  const ext = extname(rel);
  let disk = '';
  try { disk = readFileSync(abs, 'utf8'); } catch { /* a new file */ }
  const after = String(content ?? '');
  const adds = addsMarkup(disk, after, ext);
  return { rel, adds, markup: adds ? after : '', names: adds ? newNames(disk, after, ext) : [], line: null };
}

/* In a stylesheet a quoted string is never a selector, but in a shell command it is how echo and printf carry one. */
const shellBody = (command, ext) => (/^\.css$/i.test(ext) ? command.replace(/["']/g, ' ') : command);

/*
 * A shell write has no before-text, so it adds markup when the command's own text brings markup
 * for that file type: a heredoc, echo or printf body. A sed, cp or touch brings none, so it passes
 * here and is left to the PostToolUse check and the finish check.
 */
async function bashWrites(payload, settings) {
  const command = String(payload.tool_input?.command ?? '');
  const parser = command.trim() ? await loadWalls(settings.shellParser) : null;
  if (!parser) return [];
  const targets = parser.writeTargets(command, PROJECT_ROOT, { cwd: payload.cwd || PROJECT_ROOT });
  return targets
    .filter(t => typeof t === 'string' && gateKind(t, settings) === 'gate')
    .map(rel => {
      const ext = extname(rel);
      const body = shellBody(command, ext);
      const adds = addsMarkup('', body, ext);
      return { rel, adds, markup: adds ? command : '', names: adds ? newNames('', body, ext) : [], line: null };
    });
}

/** Each gated file the call writes, with whether it adds markup, the text it adds and where. */
async function plannedWrites(payload, settings) {
  const tool = payload.tool_name;
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  if (tool === 'Bash') return bashWrites(payload, settings);
  if (!['Edit', 'MultiEdit', 'Write'].includes(tool) || typeof input.file_path !== 'string' || !input.file_path) return [];
  const abs = resolve(PROJECT_ROOT, input.file_path);
  if (!insideProject(abs)) return [];
  const rel = relOf(abs);
  if (gateKind(rel, settings) !== 'gate') return [];
  if (tool === 'Write') return [fileWrite(rel, abs, input.content)];
  return [editWrite(rel, abs, tool === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits : [])];
}

const cleared = f => f?.consulted === true || f?.unconsulted === true;

export async function runGate(payload, { dir = stateDir(), settings = gateSettings(), data } = {}) {
  if (!settings.enabled || !isObj(payload)) return ALLOW;
  const writes = await plannedWrites(payload, settings);
  if (!writes.length) return ALLOW;
  const id = payload.session_id;
  const agent = agentKey(payload);
  const known = readSession(id, dir);
  if (writes.every(w => (!w.adds || cleared(known.files[w.rel])) && hasWrite(known, agent, w.rel))) return ALLOW;

  // Decided under the session lock, so parallel hooks count each refusal once.
  let outcome = ALLOW;
  let through = [];
  updateSession(id, s => {
    const waiting = writes.filter(w => w.adds && !cleared(s.files[w.rel]));
    const short = waiting.find(w => (s.files[w.rel]?.refusals ?? 0) < REFUSALS);
    if (short) {
      for (const w of waiting) {
        const f = s.files[w.rel] = { consulted: false, refusals: 0, ...s.files[w.rel] };
        f.refusals = (Number(f.refusals) || 0) + 1;
      }
      outcome = { decision: 'deny', reason: denyReason(short.rel) };
      return;
    }
    for (const w of waiting) s.files[w.rel] = { ...s.files[w.rel], unconsulted: true };
    for (const w of writes) noteWrite(s, agent, w.rel);
    through = waiting;
  }, dir);
  for (const w of through) await recordUnconsulted(payload, w, { dir, settings, data });
  return outcome;
}

/* The case shows the candidates a search on the new class names finds now, as the consult would have. */
async function recordUnconsulted(payload, w, { dir, settings, data }) {
  const { addCase, KIND } = await import('./queue.mjs');
  let candidates = [];
  if (w.names.length) {
    const { consult } = await import('./consult.mjs');
    const catalog = data ?? (await import('../search.mjs')).loadCatalog();
    const words = w.names.slice(0, NAMES_CAP).map(n => n.replace(/[-_]+/g, ' ')).join(' ');
    candidates = consult({ file: w.rel, pieces: [words] }, { data: catalog, minScore: settings.minScore })
      .pieces[0].candidates.map(c => ({ helper: c.helper }));
  }
  addCase({
    kind: KIND.UNCONSULTED,
    session: payload.session_id ?? null,
    agent: agentLabel(payload),
    file: w.rel,
    line: w.line,
    markup: w.markup.slice(0, MARKUP_CAP),
    reason: 'Written without a consult after two refusals',
    candidates,
  }, dir);
}
