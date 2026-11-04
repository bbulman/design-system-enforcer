/**
 * Per-session gate state, one file per Claude Code session in <state>/sessions/,
 * so concurrent sessions never overwrite each other.
 */
import { join } from 'node:path';
import { stateDir, readJson, writeJsonAtomic, withFileLock } from './settings.mjs';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* Claude Code puts agent_id and agent_type on a subagent's hook payloads and never on the main session's. */
export const agentKey = payload => String(payload?.agent_id || 'main');
export const agentLabel = payload => String(payload?.agent_type || 'main session');

/** Session ids come from hook payloads, so they are never trusted as path segments. */
const safeId = id => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
const sessionPath = (id, dir) => join(dir, 'sessions', `${safeId(id)}.json`);

export function readSession(id, dir = stateDir()) {
  const stored = readJson(sessionPath(id, dir), null);
  const s = isObj(stored) ? stored : {};
  return {
    ...s,
    session: String(id ?? ''),
    files: isObj(s.files) ? s.files : {},
    pieces: isObj(s.pieces) ? s.pieces : {},
    writes: Array.isArray(s.writes) ? s.writes : [],
    // The same writes by agentKey, so the finish check holds each agent to its own work only.
    agentWrites: isObj(s.agentWrites) ? s.agentWrites : {},
    blocked: isObj(s.blocked) ? s.blocked : {},
    swaps: isObj(s.swaps) ? s.swaps : {},
  };
}

const ownWrites = (s, agent) => (Array.isArray(s.agentWrites[agent]) ? s.agentWrites[agent] : []);

/** True when the session already lists this write, for the session and for the agent. */
export const hasWrite = (s, agent, rel) => s.writes.includes(rel) && ownWrites(s, agent).includes(rel);

/** List a gated write for the session and for the agent that made it. */
export function noteWrite(s, agent, rel) {
  if (!s.writes.includes(rel)) s.writes.push(rel);
  const own = s.agentWrites[agent] = ownWrites(s, agent);
  if (!own.includes(rel)) own.push(rel);
}

/** Read, mutate and write under a per-session lock. */
export function updateSession(id, mutate, dir = stateDir()) {
  return withFileLock(join(dir, 'sessions', `${safeId(id)}.lock`), () => {
    const s = readSession(id, dir);
    mutate(s);
    writeJsonAtomic(sessionPath(id, dir), s);
    return s;
  });
}
