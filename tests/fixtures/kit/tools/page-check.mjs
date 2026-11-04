#!/usr/bin/env node
/**
 * The kit fixture's own page check, as a project's staged.checks entry runs it: each page given may
 * hold no more bespoke status badges than ds/page-baseline.json (by path) and ds/legacy-baseline.json
 * (files, by path) allow. Run from the project root: node tools/page-check.mjs <pages...>
 */
import { readFileSync } from 'node:fs';

const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
const pages = read('ds/page-baseline.json');
const legacy = read('ds/legacy-baseline.json').files || {};
let failed = 0;
for (const file of process.argv.slice(2)) {
  const found = (readFileSync(file, 'utf8').match(/class="[^"]*\bstatus-badge\b/g) || []).length;
  const allowed = Math.max(Number(pages[file]) || 0, Number(legacy[file]?.['status-badge']) || 0);
  if (found > allowed) { failed++; console.log(`${file}: ${found} bespoke status badges, ${allowed} in the baseline. Use kit_badge.`); }
}
console.log(`page check: ${process.argv.length - 2} pages, ${failed} failing`);
process.exitCode = failed ? 1 : 0;
