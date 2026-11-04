/**
 * The component gate's PostToolUse hook. It records a consult, made through consult_ui or
 * `ds-enforcer consult`, against the session; gives a recorded case its session and agent;
 * and checks the UI files a Bash command changed and names, the way the edit hook checks an Edit.
 */
import { existsSync } from 'node:fs';
import { resolve, isAbsolute, basename } from 'node:path';
import { PROJECT_ROOT, insideProject } from '../config.js';
import { relOf } from '../baseline.js';
import { gateSettings, stateDir } from './settings.mjs';
import { readSession, updateSession, agentKey, agentLabel, hasWrite, noteWrite } from './session.mjs';
import { gateKind } from './markup.mjs';
import { consult, consultArgs } from './consult.mjs';
import { loadWalls } from './pretool.mjs';

const CONSULT_TOOL = 'mcp__design-system-enforcer__consult_ui';
const RECORD_TOOL = 'mcp__design-system-enforcer__record_case';
const COMMAND = (sub, flags) => new RegExp(String.raw`(?:^|[\s/'"])ds-enforcer(?:\.mjs)?['"]?[ \t]+${sub}(?=[\s;&|)]|$)`, flags);
const CONSULT_CMD = COMMAND('consult', 'g');
const RECORD_CMD = COMMAND('record-case', '');
const RECORDED = /Case (C-[0-9a-f]{6}) recorded/g;
// A hook has 30 seconds and each check reads and validates a whole file.
const CHECK_CAP = 20;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** Shell words from s[i] to the next unquoted separator, with quotes and escapes removed. */
function shellWords(s, i) {
  const out = [];
  let cur = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      const end = close < 0 ? s.length : close;
      cur = (cur ?? '') + s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let v = '';
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && /["\\$`]/.test(s[i + 1] ?? '')) i++;
        v += s[i];
      }
      cur = (cur ?? '') + v;
    } else if (c === '\\' && i + 1 < s.length) cur = (cur ?? '') + s[++i];
    else if (c === ' ' || c === '\t') { if (cur !== null) out.push(cur); cur = null; }
    else if (/[;&|\n()<>]/.test(c)) break;
    else cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** The --file and --piece arguments of each `ds-enforcer consult` the command runs. */
const shellConsults = command => [...command.matchAll(CONSULT_CMD)].map(m => consultArgs(shellWords(command, m.index + m[0].length)));

/* consult_ui's and the CLI's own checks: a file inside the project and at least one piece. */
function consultedFiles(requests, { data, settings }) {
  const results = [];
  for (const { file, pieces } of requests) {
    const described = Array.isArray(pieces) ? pieces.filter(p => typeof p === 'string' && p.trim()) : [];
    if (typeof file !== 'string' || !file.trim() || !described.length) continue;
    const abs = resolve(PROJECT_ROOT, file.trim());
    if (!insideProject(abs)) continue;
    // The consult is deterministic: run again on the same input, it gives the ids the agent saw.
    results.push(consult({ file: relOf(abs), pieces: described }, { data, minScore: settings.minScore }));
  }
  return results;
}

const responseText = r => (typeof r === 'string' ? r : JSON.stringify(r ?? ''));

async function claimCases(payload, text, dir) {
  const ids = [...new Set([...text.matchAll(RECORDED)].map(m => m[1]))];
  if (!ids.length) return;
  const { updateCase } = await import('./queue.mjs');
  for (const id of ids) updateCase(id, { session: payload.session_id ?? null, agent: agentLabel(payload) }, dir);
}

// globRe turns `*` and `?` into patterns itself, so escapeRe leaves them; escapeAll is for literal text.
const escapeRe = text => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
const escapeAll = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* A shell glob as a whole-path pattern: `**` crosses folders, `*` and `?` stay inside one. */
const globRe = rel => new RegExp(`^${escapeRe(rel).replace(/\*\*\//g, '\0').replace(/\*\*/g, '\x01')
  .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '(?:.*/)?').replace(/\x01/g, '.*')}$`);

/*
 * Claude Code's list holds every file that changed while the command ran, so in a checkout other
 * sessions share it also holds their edits. A listed file is the agent's only when the command names
 * it: by a path ending in its file name, or by a glob.
 */
function namedBy(command, cwd) {
  const globs = command.split(/[\s'"`;|&()<>]+/).filter(t => /[*?]/.test(t))
    .map(t => globRe(relOf(isAbsolute(t) ? resolve(t) : resolve(cwd, t))));
  // Every path that names the file ends in its name, so one bounded match on the name covers them.
  return abs => new RegExp(`(?:^|[\\s'"=/:(,{<>;|&@\x60])${escapeAll(basename(abs))}(?:$|[\\s'";|&)<>,}:\x60])`).test(command)
    || globs.some(g => g.test(relOf(abs)));
}

/**
 * The project-relative UI files a Bash command changed, named and left in place: Claude Code's own
 * list when it has one, else the command's write targets.
 */
async function changedFiles(payload, settings) {
  const cwd = payload.cwd || PROJECT_ROOT;
  const absOf = p => (isAbsolute(p) ? resolve(p) : resolve(cwd, p));
  const diff = payload.tool_response?.bashEditDiff;
  let paths = null;
  const deleted = new Set();
  if (isObj(diff) && !diff.unavailable && !diff.skipped) {
    const files = Array.isArray(diff.files) ? diff.files.filter(f => isObj(f) && typeof f.filePath === 'string' && f.filePath) : [];
    for (const f of files) if (f.deleted === true) deleted.add(absOf(f.filePath));
    paths = Array.isArray(diff.changedFiles) ? diff.changedFiles : Array.isArray(diff.files) ? files.map(f => f.filePath) : null;
  }
  const command = String(payload.tool_input?.command ?? '');
  let rels;
  if (paths) {
    const named = namedBy(command, cwd);
    rels = paths.filter(p => typeof p === 'string' && p).map(absOf).filter(abs => insideProject(abs) && !deleted.has(abs) && named(abs)).map(relOf);
  } else {
    const parser = command.trim() ? await loadWalls() : null;
    rels = parser ? parser.writeTargets(command, PROJECT_ROOT, { cwd }).filter(t => typeof t === 'string') : [];
  }
  return [...new Set(rels)].filter(rel => gateKind(rel, settings) !== null && existsSync(resolve(PROJECT_ROOT, rel)));
}

export async function runGatePost(payload, { dir = stateDir(), data, settings = gateSettings() } = {}) {
  if (!settings.enabled || !isObj(payload)) return { message: null, info: null };
  const tool = String(payload.tool_name ?? '');
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const command = tool === 'Bash' ? String(input.command ?? '') : '';
  const requests = tool === CONSULT_TOOL ? [{ file: input.file, pieces: input.pieces }] : shellConsults(command);
  const catalog = requests.length ? data ?? (await import('../search.mjs')).loadCatalog() : data;
  const consults = consultedFiles(requests, { data: catalog, settings });

  if (tool === RECORD_TOOL || RECORD_CMD.test(command)) await claimCases(payload, responseText(payload.tool_response), dir);

  const changed = tool === 'Bash' && command.trim() ? await changedFiles(payload, settings) : [];
  const messages = [];
  const infos = [];
  if (changed.length) {
    const { loadEngine } = await import('../check.mjs');
    const { reportFresh } = await import('../hook.mjs');
    const engine = await loadEngine();
    for (const rel of engine ? changed.slice(0, CHECK_CAP) : []) {
      const { message, info } = await reportFresh(engine, rel, payload.session_id);
      if (message) messages.push(message);
      if (info) infos.push(info);
    }
  }

  // A Bash write the gate could not see beforehand still counts for the finish check.
  const listed = changed.filter(rel => gateKind(rel, settings) === 'gate');
  const agent = agentKey(payload);
  const known = listed.length ? readSession(payload.session_id, dir) : null;
  const unlisted = listed.filter(rel => !hasWrite(known, agent, rel));
  if (consults.length || unlisted.length) {
    updateSession(payload.session_id, s => {
      for (const r of consults) {
        s.files[r.file] = { refusals: 0, ...s.files[r.file], consulted: true };
        for (const p of r.pieces) {
          s.pieces[p.id] = { file: r.file, description: p.description, candidates: p.candidates.map(c => c.helper), nothingFitting: p.nothingFitting, agent };
        }
      }
      for (const rel of unlisted) noteWrite(s, agent, rel);
    }, dir);
  }
  return { message: messages.length ? messages.join('\n') : null, info: infos.length ? infos.join('\n') : null };
}
