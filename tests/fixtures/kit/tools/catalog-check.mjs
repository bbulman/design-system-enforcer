#!/usr/bin/env node
/* The kit fixture's catalog freshness check: every kit_* function in lib/components/kit.php has a catalog entry. */
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync('ds/catalog.json', 'utf8')).components;
const missing = [...readFileSync('lib/components/kit.php', 'utf8').matchAll(/^function (kit_\w+)\(/gm)].map(m => m[1]).filter(f => !catalog[f]);
for (const f of missing) console.log(`${f} is not in ds/catalog.json: regenerate the catalog.`);
console.log(`catalog check: ${missing.length ? 'stale' : 'fresh'}`);
process.exitCode = missing.length ? 1 : 0;
