/**
 * The baseline: the findings a project already had when it adopted the enforcer, so
 * only new ones fail. A finding is keyed by file, rule and what it matched, not by
 * line, so moving code around never makes an old finding look new. Counts make it
 * a ratchet: a file with three baselined #fff colours may keep three, not four.
 *
 *   ds-enforcer check --baseline   records today's findings (re-run to lock in fixes)
 *   ds-enforcer check --baseline --only <type,...>
 *                                  re-records only those rules' findings, keeping the rest
 *   ds-enforcer check              reports only findings beyond the baseline
 */
import { readFileSync, existsSync } from 'fs';
import { relative, sep } from 'path';
import { config, PROJECT_ROOT, projectPath } from './config.js';
import { writeJsonAtomic } from './gate/settings.mjs';

export const baselinePath = () => projectPath(config.baseline || '.ds-enforcer/baseline.json');

const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/;+(?=["')]|$)/g, '');
export const relOf = abs => relative(PROJECT_ROOT, abs).split(sep).join('/');
export const keyOf = (rel, v) => `${rel}|${v.type}|${norm(v.match ?? v.message)}`;

/** { counts: { key: n }, createdAt } or null when the project has none. */
export function loadBaseline() {
  const path = baselinePath();
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Split one file's findings into new ones and ones the baseline already holds. */
export function splitByBaseline(rel, violations, baseline) {
  if (!baseline) return { fresh: violations, existing: [] };
  const left = new Map();
  const fresh = [], existing = [];
  for (const v of violations) {
    const key = keyOf(rel, v);
    if (!left.has(key)) left.set(key, baseline.counts?.[key] || 0);
    if (left.get(key) > 0) { left.set(key, left.get(key) - 1); existing.push(v); } else fresh.push(v);
  }
  return { fresh, existing };
}

/** How many baselined findings in these files are gone. */
export function fixedSince(baseline, results, files) {
  if (!baseline) return 0;
  const scanned = new Set(files);
  const seen = new Map();
  for (const { file, violations } of results) for (const v of violations) {
    const k = keyOf(file, v);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  let fixed = 0;
  for (const [key, n] of Object.entries(baseline.counts || {})) {
    if (!scanned.has(key.split('|')[0])) continue;
    fixed += Math.max(0, n - (seen.get(key) || 0));
  }
  return fixed;
}

/**
 * Write the baseline from a full set of results. Entries for files outside `files`
 * are kept, so baselining one folder never forgets the rest.
 */
export function writeBaseline(results, files) {
  const previous = loadBaseline();
  const scanned = new Set(files);
  const counts = {};
  for (const [key, n] of Object.entries(previous?.counts || {})) if (!scanned.has(key.split('|')[0])) counts[key] = n;
  addCounts(counts, results);
  return saveBaseline(counts);
}

/**
 * Re-record only the findings of `types` in `files`, keeping every other entry,
 * so a new rule's existing debt can be baselined without re-recording the rest.
 */
export function mergeBaseline(results, files, types) {
  const scanned = new Set(files);
  const only = new Set(types);
  const counts = {};
  for (const [key, n] of Object.entries(loadBaseline()?.counts || {})) {
    const [file, type] = key.split('|');
    if (!(scanned.has(file) && only.has(type))) counts[key] = n;
  }
  addCounts(counts, results.map(r => ({ ...r, violations: r.violations.filter(v => only.has(v.type)) })));
  return saveBaseline(counts);
}

/**
 * Add one count per finding, keeping every other entry: the reviewer's keep decisions on the review
 * page, one finding at a time. How many were added.
 */
export function appendToBaseline(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(e => typeof e?.file === 'string' && e.violation);
  if (!list.length) return 0;
  const current = loadBaseline();
  // Writing over a file that exists but cannot be read would forget everything it held.
  if (!current && existsSync(baselinePath())) throw new Error(`The baseline at ${relOf(baselinePath())} could not be read. Fix it, then try again.`);
  const counts = { ...(current?.counts || {}) };
  addCounts(counts, list.map(({ file, violation }) => ({ file, violations: [violation] })));
  saveBaseline(counts);
  return list.length;
}

function addCounts(counts, results) {
  for (const { file, violations } of results) for (const v of violations) {
    const k = keyOf(file, v);
    counts[k] = (counts[k] || 0) + 1;
  }
}

function saveBaseline(counts) {
  const path = baselinePath();
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  writeJsonAtomic(path, {
    _comment: 'Findings this project already had, so only new ones fail. Written by `ds-enforcer check --baseline`; re-run it to lock in fixes. Commit this file.',
    updatedAt: new Date().toISOString(),
    total,
    counts: sorted,
  });
  return { path, total };
}
