/**
 * The component gate's finish check, for the Stop hook and for SubagentStop. Before an agent
 * finishes, every piece it declared for a gated file it changed is built with one of its
 * candidates or recorded as a case, and every new lookalike in those files is switched to a
 * component or recorded. Each agent answers only for its own writes and pieces, so a reviewer
 * that wrote nothing, or an agent working beside others, is never held to their work.
 *
 * With autoSwap on, hand-copied component markup may not stay: it maps to exactly one helper, so
 * it is recorded as swapped automatically and the agent is told to switch, and its next finish
 * checks that it did. A bespoke name never is: its search can name a clear winner that is wrong
 * (every -card class finds ws_card), so it goes to the queue like any other lookalike.
 *
 * Stop fires at the end of every main-session turn, so each finish is checked, but each item (a
 * piece id or a finding key) blocks an agent at most once: session.blocked[agentKey] lists the
 * items it was blocked on, and a finish blocks again only for an item not in that list, so an agent
 * that cannot comply is never held. session.swaps[agentKey] holds the ids of the automatic swaps it
 * was told to make, settled at its next finish, so agents of the same type never settle each other's.
 *
 * A subagent in the desktop app hands its report back before its SubagentStop block reaches it, so
 * the main session's Stop takes on, once, the items a finished subagent was blocked on and left,
 * and makes the automatic swaps it owed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { insideProject, projectPath } from '../config.js';
import { keyOf, loadBaseline, splitByBaseline } from '../baseline.js';
import { loadEngine } from '../check.mjs';
import { loadCatalog } from '../search.mjs';
import { gateSettings, stateDir, ENFORCER_CLI } from './settings.mjs';
import { readSession, updateSession, agentKey, agentLabel } from './session.mjs';
import { gateKind } from './markup.mjs';
import { consult } from './consult.mjs';
import { LOOKALIKE_TYPES } from './lookalikes.mjs';
import { KIND, loadQueue, addCase, updateCase, pageStylesheets } from './queue.mjs';

const PASS = Object.freeze({ block: false });
const OPENING = 'Before finishing, resolve these design-system items in the files you changed:';
const SWITCH = 'Switch these to the component:';
const LEFT = 'A subagent stopped before resolving these, in files it changed. Resolve them for it:';
const SHELL = `Without the record_case tool, run: ${ENFORCER_CLI} record-case --json '{"file": "<path>", "reason": "<why>", "markup": "<what you wrote>", "piece_id": "<P-...>"}', with "finding": "<key>" in place of piece_id for a finding.`;
const NOTHING = 'nothing in the inventory fits it, so call record_case with your reason.';
const AUTO_REASON = 'Clear match; swapped automatically';
const UNDONE_REASON = 'Did not switch after an automatic swap was required';
// The lines kept either side of a swapped finding, so Undo can find where the markup it replaced was.
const AROUND = 2;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
const isCss = rel => /\.css$/i.test(rel);
const isPhp = rel => /\.php$/i.test(rel);

const helperOf = c => (typeof c === 'string' ? c : c?.helper);
/* "ws_a()", "ws_a() or ws_b()", "ws_a(), ws_b() or ws_c()"; after a list, the item adds ", or call record_case". */
const calls = helpers => {
  const named = helpers.map(h => `${h}()`);
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} or ${named.at(-1)}`;
};
const buildWith = helpers => `build it with ${calls(helpers)}${helpers.length > 1 ? ',' : ''} or call record_case with your reason.`;
const what = v => (v.type === 'bespoke-lookalike' ? `hand-built ${v.word} (${v.match})` : `${v.match} written by hand`);

function around(content, line) {
  const lines = content.split('\n');
  const at = Math.max(1, line || 1) - 1;
  return lines.slice(Math.max(0, at - AROUND), at + AROUND + 1).join('\n');
}

/* The finding's own line, which Undo puts back; handing back only the lines around it would revert later edits to them. */
const lineOf = (content, line) => content.split('\n')[Math.max(1, line || 1) - 1] ?? '';

/* Only a project-relative path that still exists: writes can name files a git command since removed. */
function readProjectFile(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = projectPath(rel);
  if (!insideProject(abs) || !existsSync(abs)) return null;
  try { return readFileSync(abs, 'utf8'); } catch { return null; }
}

/* A write no agent's own list names predates those lists, so it is the main session's, as a piece with no agent is. */
function ownWrites(session, agent) {
  const own = Array.isArray(session.agentWrites[agent]) ? session.agentWrites[agent] : [];
  if (agent !== 'main') return own;
  const claimed = new Set(Object.values(session.agentWrites).filter(Array.isArray).flat());
  return [...own, ...session.writes.filter(rel => !claimed.has(rel))];
}

/** The file's lookalike findings the baseline does not already hold, in line order. */
function freshLookalikes(engine, rel, content, baseline) {
  const found = engine.validate(content, projectPath(rel))
    .filter(v => LOOKALIKE_TYPES.includes(v.type))
    .sort((a, b) => (a.line || 0) - (b.line || 0));
  return splitByBaseline(rel, found, baseline).fresh;
}

/*
 * A stylesheet cannot call a helper, so a piece declared for one is built by the agent's PHP pages.
 * An open case settles a piece or a finding. A piece is also settled by a closed or applied case its
 * own session recorded, because a piece has no baseline entry to remember Bill's decision; an earlier
 * session's case is no answer for the piece declared again.
 */
function pieceItem(rel, id, piece, homes, queue, sessionId) {
  const cases = queue.filter(c => isObj(c.piece) && c.piece.id === id && (c.status === 'open' || (sessionId && c.session === sessionId)));
  const named = `${rel} piece "${piece.description}"`;
  // The consult's nothing-fitting verdict is only sure for words with no component in them, so
  // such a piece is settled by its own nothing-fitting case and nothing else.
  if (piece.nothingFitting === true) return cases.some(c => c.kind === KIND.NONE) ? null : `${named}: ${NOTHING} (piece: ${id})`;
  const helpers = (Array.isArray(piece.candidates) ? piece.candidates : []).map(helperOf).filter(h => typeof h === 'string' && h);
  if (cases.length || helpers.some(h => homes.some(text => text.includes(`${h}(`)))) return null;
  return `${named}: ${helpers.length ? buildWith(helpers) : NOTHING} (piece: ${id})`;
}

/* A hand-copied root class is one helper's; a bespoke name gets the candidates record_case would show. */
function findingCandidates(v, rel, data, settings) {
  if (v.type === 'hand-copied-component') return v.component ? [{ helper: v.component }] : [];
  const words = String(v.match).replace(/[-_]+/g, ' ');
  return consult({ file: rel, pieces: [words] }, { data: data(), minScore: settings.minScore }).pieces[0].candidates;
}

/**
 * What one finding key needs: nothing, an ordinary item, or a forced swap, which converts an open
 * kept case for it or adds a new case. Only an open case settles a finding: one Bill closed or
 * applied is no answer for markup written again. An open case of another kind stands as it is:
 * an automatic swap already asked for, or a nothing-fitting or unconsulted case.
 */
function decide(v, rel, key, { queue, settings, data, forcible }) {
  const open = queue.filter(c => c.finding === key && c.status === 'open');
  const helper = forcible && v.type === 'hand-copied-component' ? v.component || null : null;
  if (helper) {
    if (open.some(c => c.kind !== KIND.KEPT)) return null;
    return { swap: helper, convert: open.filter(c => c.kind === KIND.KEPT).at(-1) ?? null };
  }
  if (open.length) return null;
  return { helpers: findingCandidates(v, rel, data, settings).map(c => c.helper) };
}

/* The agent was told to make these swaps when it was blocked; this is its next finish. False when they could not be checked. */
async function settleSwaps(ids, { dir, getEngine }) {
  const owed = loadQueue(dir).filter(c => ids.includes(c.id) && c.status === 'open' && c.kind === KIND.AUTO);
  if (!owed.length) return true;
  const engine = await getEngine();
  if (!engine) return false;
  const baseline = loadBaseline();
  const files = new Map();
  for (const c of owed) {
    if (!files.has(c.file)) {
      const content = readProjectFile(c.file);
      files.set(c.file, content === null ? null : { content, keys: new Set(freshLookalikes(engine, c.file, content, baseline).map(v => keyOf(c.file, v))) });
    }
    const file = files.get(c.file);
    const switched = file !== null && !file.keys.has(c.finding) && typeof c.chosen === 'string' && file.content.includes(`${c.chosen}(`);
    // A converted kept case carries the agent's own reason, so the outcome goes in its note. An Undo
    // pressed before the agent switched has nothing to undo: the kept case waits for a new decision.
    const undone = typeof c.note === 'string' ? { note: UNDONE_REASON } : { reason: UNDONE_REASON };
    updateCase(c.id, switched ? { status: 'applied', seen: false } : { kind: KIND.KEPT, decision: 'pending', ...undone }, dir);
  }
  return true;
}

export const runFinish = (payload, options) => check(payload, options, false);

/**
 * For the main session's next edit or shell command after a subagent stops: what that subagent left,
 * as the Stop would take it on, or null. It only tells, once per item (session.told), and writes nothing
 * else, so the Stop still holds the main session to anything it was told and left.
 */
export async function runNotice(payload, options) {
  return (await check(payload, options, true)).notice ?? null;
}

async function check(payload, { dir = stateDir(), engine, settings = gateSettings(), data } = {}, notify) {
  if (!settings.enabled || !isObj(payload)) return PASS;
  const id = payload.session_id;
  const agent = agentKey(payload);
  if (notify && agent !== 'main') return PASS;
  const session = readSession(id, dir);
  // The engine is loaded once, and only when something needs it: loading it is most of a finish's time.
  const getEngine = async () => (engine === undefined ? (engine = await loadEngine()) : engine);
  const settling = notify ? [] : strings(session.swaps[agent]);
  if (settling.length && await settleSwaps(settling, { dir, getEngine })) {
    updateSession(id, s => {
      const left = strings(s.swaps[agent]).filter(c => !settling.includes(c));
      if (left.length) s.swaps[agent] = left; else delete s.swaps[agent];
    }, dir);
  }
  const told = isObj(session.told) ? strings(session.told[agent]) : [];
  const seen = new Set([...strings(session.blocked[agent]), ...(notify ? told : [])]);
  // In this app a subagent hands its report back before its SubagentStop block reaches it, so the
  // main session takes on, once, what a subagent was blocked on and left: only those items, nothing new.
  // A subagent the payload lists as still running is left to its own finish.
  const running = new Set((Array.isArray(payload.background_tasks) ? payload.background_tasks : [])
    .filter(t => isObj(t) && t.type === 'subagent' && t.status === 'running').map(t => t.id));
  const leftBy = new Map(agent !== 'main' ? [] : Object.keys(session.blocked)
    .filter(k => k !== 'main' && !running.has(k))
    .map(k => [k, new Set(strings(session.blocked[k]).filter(key => !seen.has(key)))])
    .filter(([k, keys]) => keys.size || (!notify && strings(session.swaps[k]).length)));

  // JavaScript and HTML cannot call a helper, so only gated files are held to it.
  const files = new Map();
  for (const owner of notify ? [...leftBy.keys()] : [agent, ...leftBy.keys()]) {
    for (const rel of ownWrites(session, owner)) {
      if (typeof rel !== 'string' || gateKind(rel, settings) !== 'gate') continue;
      if (!files.has(rel)) {
        const content = readProjectFile(rel);
        if (content === null) continue;
        files.set(rel, { content, owners: new Set() });
      }
      files.get(rel).owners.add(owner);
    }
  }
  if (!files.size) return PASS;
  await getEngine();

  const queue = loadQueue(dir);
  const baseline = engine ? loadBaseline() : null;
  const pagesOf = owner => [...files].filter(([rel, f]) => isPhp(rel) && f.owners.has(owner)).map(([, f]) => f.content);
  // Whose item this is: the agent's own, a subagent's it takes on, or neither.
  const whose = (owner, itemKey) => (owner === agent ? 'own' : leftBy.get(owner)?.has(itemKey) ? 'left' : null);
  // The automatic swaps these subagents owe, and by finding the ones the main session can make: not
  // one Bill pressed Undo on, nor one that names no component.
  const owedIds = [];
  const owedBy = new Map();
  for (const owner of leftBy.keys()) {
    const ids = strings(session.swaps[owner]);
    for (const c of queue) {
      if (!ids.includes(c.id) || c.status !== 'open' || c.kind !== KIND.AUTO) continue;
      owedIds.push(c.id);
      if (typeof c.chosen === 'string' && c.chosen && c.decision !== 'undo') owedBy.set(c.finding, { owner, c });
    }
  }
  let catalog = data;
  const ctx = { queue, settings, data: () => (catalog ??= loadCatalog()) };
  const out = { own: { items: [], switches: [] }, left: { items: [], switches: [] } };
  const swaps = [];
  const keys = [];
  const taken = [];
  for (const [rel, { content, owners }] of files) {
    for (const [pid, piece] of Object.entries(session.pieces)) {
      const owner = isObj(piece) ? piece.agent ?? 'main' : null;
      if (!owner || piece.file !== rel || !owners.has(owner) || seen.has(pid)) continue;
      const side = whose(owner, pid);
      if (!side) continue;
      const item = pieceItem(rel, pid, piece, isCss(rel) ? pagesOf(owner) : [content], queue, id);
      if (item) { out[side].items.push(item); keys.push(pid); }
    }
    if (!engine) continue;
    // Spec section 7: a file written without a consult, or holding a nothing-fitting case, is never swapped automatically.
    const forcible = settings.autoSwap && session.files[rel]?.unconsulted !== true
      && !queue.some(c => c.kind === KIND.NONE && c.status === 'open' && c.file === rel);
    const decided = new Map();
    for (const v of freshLookalikes(engine, rel, content, baseline)) {
      const key = keyOf(rel, v);
      // Checked before deciding: an item already blocked on never asks for a swap again either.
      if (seen.has(key)) continue;
      const side = owners.has(agent) ? 'own' : [...owners].map(o => whose(o, key)).find(Boolean);
      if (!side) continue;
      let d = decided.get(key);
      if (d === undefined) {
        const owed = owedBy.get(key);
        // A subagent's item with an open case already stands as it is, a kept case waiting for Bill included.
        d = owed ? { swap: owed.c.chosen, taken: owed.c.id }
          : side === 'left' && queue.some(c => c.finding === key && c.status === 'open') ? null
            : decide(v, rel, key, { ...ctx, forcible });
        decided.set(key, d);
        if (d?.taken) taken.push(d.taken);
        else if (d?.swap) swaps.push({ rel, content, v, key, ...d });
        if (d) keys.push(key);
      }
      if (!d) continue;
      if (d.swap) out[side].switches.push(`${rel}:${v.line} ${what(v)}: build it with ${d.swap}(). (finding: ${key})`);
      else out[side].items.push(`${rel}:${v.line} ${what(v)}: ${d.helpers.length ? buildWith(d.helpers) : NOTHING} (finding: ${key})`);
    }
  }

  if (notify) {
    if (!keys.length) return PASS;
    updateSession(id, s => {
      s.told = isObj(s.told) ? s.told : {};
      s.told[agent] = [...new Set([...strings(s.told[agent]), ...keys])];
    }, dir);
    const { items, switches } = out.left;
    const lines = [LEFT, ...items];
    if (items.length) lines.push(SHELL);
    if (switches.length) lines.push(SWITCH, ...switches);
    return { block: false, notice: lines.join('\n') };
  }

  // Every other swap a subagent owed (made already, its markup gone, Undo pressed, or nothing to hand
  // on) is settled now, as the subagent's own next finish would have settled it.
  const gone = owedIds.filter(c => !taken.includes(c));
  const settled = gone.length && await settleSwaps(gone, { dir, getEngine }) ? gone : [];
  const blocking = keys.length > 0;
  if (!blocking && !settled.length) return PASS;

  const owed = [...taken];
  for (const swap of swaps) {
    const fields = {
      kind: KIND.AUTO,
      session: id ?? null,
      agent: agentLabel(payload),
      file: swap.rel,
      line: swap.v.line,
      finding: swap.key,
      markup: around(swap.content, swap.v.line),
      original: lineOf(swap.content, swap.v.line),
      stylesheets: pageStylesheets(swap.rel, swap.content),
      chosen: swap.swap,
    };
    // A converted case keeps the agent's reason and its sample: its own static HTML renders its version best.
    const c = swap.convert ? updateCase(swap.convert.id, { ...fields, note: AUTO_REASON, seen: false }, dir)
      : addCase({ ...fields, reason: AUTO_REASON, candidates: [{ helper: swap.swap }] }, dir);
    if (c) owed.push(c.id);
  }
  const moved = new Set([...taken, ...settled]);
  updateSession(id, s => {
    if (keys.length) s.blocked[agent] = [...new Set([...strings(s.blocked[agent]), ...keys])];
    if (owed.length) s.swaps[agent] = [...new Set([...strings(s.swaps[agent]), ...owed])];
    for (const owner of leftBy.keys()) {
      const left = strings(s.swaps[owner]).filter(c => !moved.has(c));
      if (left.length) s.swaps[owner] = left; else delete s.swaps[owner];
    }
  }, dir);
  if (!blocking) return PASS;

  const { own, left } = out;
  const lines = [];
  if (own.items.length || own.switches.length) {
    lines.push(OPENING, ...own.items);
    if (own.items.length) lines.push(SHELL);
    if (own.switches.length) lines.push(SWITCH, ...own.switches);
  }
  if (left.items.length || left.switches.length) {
    lines.push(LEFT, ...left.items);
    if (left.items.length && !own.items.length) lines.push(SHELL);
    if (left.switches.length) lines.push(SWITCH, ...left.switches);
  }
  return { block: true, reason: lines.join('\n') };
}
