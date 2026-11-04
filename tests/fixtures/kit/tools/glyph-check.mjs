#!/usr/bin/env node
/* The kit fixture's glyph check: every SVG in images/glyphs is drawn on the 24-unit grid. */
import { readdirSync, readFileSync } from 'node:fs';

const bad = readdirSync('images/glyphs').filter(f => f.endsWith('.svg') && !readFileSync(`images/glyphs/${f}`, 'utf8').includes('viewBox="0 0 24 24"'));
for (const f of bad) console.log(`images/glyphs/${f} is not on the 24-unit grid.`);
console.log(`glyph check: ${bad.length} off the grid`);
process.exitCode = bad.length ? 1 : 0;
