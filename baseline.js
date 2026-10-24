/**
 * The baseline: the findings a project already had when it adopted the enforcer, so
 * only new ones fail. A finding is keyed by file, rule and what it matched, not by
 * line, so moving code around never makes an old finding look new. Counts make it
 * a ratchet: a file with three baselined #fff colours may keep three, not four.
 *
 *   ds-enforcer check --baseline   records today's findings (re-run to lock in fixes)
 *   ds-enforcer check              reports only findings beyond the baseline
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, relative, sep } from 'path';
import { config, PROJECT_ROOT, projectPath } from './config.js';

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
  for (const { file, violations } of results) for (const v of violations) {
    const k = keyOf(file, v);
    counts[k] = (counts[k] || 0) + 1;
  }
  const path = baselinePath();
  mkdirSync(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, JSON.stringify({
    _comment: 'Findings this project already had, so only new ones fail. Written by `ds-enforcer check --baseline`; re-run it to lock in fixes. Commit this file.',
    updatedAt: new Date().toISOString(),
    total: Object.values(sorted).reduce((a, b) => a + b, 0),
    counts: sorted,
  }, null, 2) + '\n');
  return { path, total: Object.values(sorted).reduce((a, b) => a + b, 0) };
}
