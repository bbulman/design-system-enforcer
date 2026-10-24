/**
 * The terminal side of init: `ds-enforcer init` scans the project, shows what it
 * found as a numbered menu, asks a few questions and connects. `ds-enforcer sync`
 * reruns the import from the sources already in enforcer.config.json.
 *
 *   ds-enforcer init [--root <dir>] [--yes]
 *   ds-enforcer sync [--root <dir>]
 */
import { createInterface } from 'readline';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve, relative, join, extname } from 'path';
import { detect } from './detect.mjs';
import { connect, generate, installHook } from './build.mjs';
import { countFigma, folderFramework } from './importers.mjs';

const KIND = { css: 'Tokens: CSS variables', dtcg: 'Tokens: W3C / Style Dictionary JSON', figma: 'Tokens: Figma variables', react: 'Components: React', vue: 'Components: Vue', svelte: 'Components: Svelte', swift: 'Native: SwiftUI theme' };
const SERVER = resolve(import.meta.dirname, '..', 'index.js');

const flag = (argv, name) => argv.includes(name);
const option = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const rootOf = argv => resolve(option(argv, '--root') || process.env.ENFORCER_PROJECT_ROOT || process.cwd());

function typeOf(abs) {
  if (statSync(abs).isDirectory()) return folderFramework(abs);
  const ext = extname(abs).toLowerCase();
  if (['.css', '.scss', '.pcss'].includes(ext)) return 'css';
  if (ext === '.swift') return 'swift';
  if (ext === '.json') return countFigma(abs) ? 'figma' : 'dtcg';
  return null;
}

function parseChoice(answer, sources, defaults) {
  const a = answer.trim().toLowerCase();
  if (!a) return defaults;
  if (a === 'all') return sources.map(s => s.id);
  if (a === 'none') return [];
  const ids = a.split(/[\s,]+/).flatMap(part => {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) return Array.from({ length: +range[2] - +range[1] + 1 }, (_, i) => +range[1] + i);
    return [Number(part)];
  });
  const bad = ids.filter(n => !sources.some(s => s.id === n));
  if (bad.length) throw new Error(`No source numbered ${bad.join(', ')}`);
  return [...new Set(ids)];
}

export async function runInit(argv = []) {
  const root = rootOf(argv);
  const yes = flag(argv, '--yes') || flag(argv, '-y');
  // Answers are queued as lines arrive, so piped input (scripts, CI) works as well as typing;
  // once input ends, every remaining question takes its default.
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = [], waiting = [];
  let ended = false;
  rl.on('line', l => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()(''); });
  const ask = async (q, fallback = '') => {
    if (yes) return fallback;
    process.stdout.write(q);
    const answer = lines.length ? lines.shift() : ended ? '' : await new Promise(r => waiting.push(r));
    if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
    return answer;
  };
  const say = (s = '') => console.log(s);

  try {
    say('\nDesign System Enforcer: connect your design system');
    say(`Project: ${root}\n`);
    say('Scanning for tokens and components...');
    const { sources, defaults } = detect(root);

    if (sources.length) {
      say('');
      for (const type of ['css', 'dtcg', 'figma', 'react', 'vue', 'svelte', 'swift']) {
        const list = sources.filter(s => s.type === type);
        if (!list.length) continue;
        say(`${KIND[type]}`);
        for (const s of list) say(`  ${defaults.includes(s.id) ? '✓' : ' '} [${s.id}] ${s.path}  ${s.note}`);
      }
      say('');
    } else {
      say('Found nothing to connect automatically. You can add paths by hand below.\n');
    }

    let chosen = [];
    for (;;) {
      const answer = sources.length
        ? await ask('Connect which? Numbers like 1,3 or 1-4, "all", or Enter for the ✓ ones: ')
        : 'none';
      try { chosen = parseChoice(answer, sources, defaults).map(id => sources.find(s => s.id === id)); break; }
      catch (e) { say(e.message); }
    }

    for (;;) {
      const extra = (await ask('Add a path the scan missed (a tokens file or a components folder), or Enter to go on: ')).trim();
      if (!extra) break;
      const abs = resolve(root, extra);
      if (!existsSync(abs)) { say(`  Not found: ${extra}`); continue; }
      if (relative(root, abs).startsWith('..')) { say('  That path is outside the project.'); continue; }
      const type = typeOf(abs);
      if (!type) { say('  Use a .css/.scss file, a tokens .json file, a SwiftUI theme .swift file, or a components folder.'); continue; }
      chosen.push({ type, path: relative(root, abs) });
      say(`  Added ${KIND[type].toLowerCase()}: ${relative(root, abs)}`);
    }
    if (!chosen.length) { say('\nNothing chosen, so nothing was written.'); return 1; }

    const rootPx = Number((await ask('What does 1rem equal on your pages, in px? (Enter for 16): ', '16')).trim() || 16);
    const yesNo = a => /^y/i.test(a.trim());
    const rules = {
      pureBlack: yesNo(await ask('Flag pure black (#000) as a house rule? (y/N): ', 'n')),
      pureWhite: yesNo(await ask('Flag pure white backgrounds as a house rule? (y/N): ', 'n')),
    };

    const hook = yesNo(await ask('Check each file automatically after Claude edits it (a Claude Code hook)? (y/N): ', 'n'));

    const cfgPath = join(root, 'enforcer.config.json');
    let replace = false;
    if (existsSync(cfgPath) && !JSON.parse(readFileSync(cfgPath, 'utf8')).sources) {
      replace = yesNo(await ask('enforcer.config.json exists and was written by hand. Replace it? (y/N): ', 'n'));
      if (!replace) { say('Left it alone; nothing was written.'); return 1; }
    }

    say('\nAbout to connect:');
    for (const s of chosen) say(`  ${KIND[s.type]}: ${s.path}`);
    say(`  1rem = ${rootPx}px; house rules: ${[rules.pureBlack && 'no pure black', rules.pureWhite && 'no pure white backgrounds'].filter(Boolean).join(', ') || 'none'}`);
    if (hook) say('  Claude Code hook: check each file after Claude edits it');
    if (!yesNo((await ask('Write enforcer.config.json and .ds-enforcer/? (Y/n): ', 'y')) || 'y')) { say('Nothing was written.'); return 1; }

    const r = connect(root, { sources: chosen, rootPx, rules, replace });
    say(`\nConnected (${r.framework}).`);
    say(`  ${r.tokens} tokens: ${Object.entries(r.groups).map(([g, n]) => `${n} ${g.toLowerCase()}`).join(', ') || 'none'}`);
    say(`  ${r.components} components`);
    if (r.tailwind) say(`  Tailwind ${r.tailwind}: class names are checked too`);
    if (r.drift?.length) say(`  ${r.drift.length} token${r.drift.length === 1 ? ' differs' : 's differ'} between sources (e.g. ${r.drift[0].token}: ${r.drift[0].values.map(v => `${v.value} in ${v.path}`).join(' vs ')}); \`ds-enforcer check\` lists them`);
    if (r.nativeApps) say(`  ${r.nativeApps} SwiftUI app${r.nativeApps === 1 ? '' : 's'}: theme colours are checked against the web tokens`);
    if (r.onlyInFigma) say(`  ${r.onlyInFigma} Figma variable${r.onlyInFigma === 1 ? ' has' : 's have'} no matching code token`);
    if (hook) {
      const h = installHook(root);
      say(h.installed ? `  Hook added to ${relative(root, h.path)}: Claude is told about new findings after each edit` : `  Hook not added: ${h.reason}`);
    }
    if (r.skipped.length) say(`  ${r.skipped.length} composite tokens skipped (typography sets have no single CSS value)`);
    say('\nNext:');
    say(`  1. Add it to Claude Code, from this folder:`);
    say(`       claude mcp add design-system-enforcer -- node ${SERVER}`);
    say('  2. Teach it your words in .ds-enforcer/synonyms.json (e.g. "Dialog": ["modal", "popup"]).');
    say('  3. .ds-enforcer/catalog.json and tokens.css are generated: commit them, or add them to .gitignore and run `ds-enforcer sync` after a clone.');
    say('     The server resyncs on its own when a connected source changes.');
    say('  4. On an existing codebase, run `ds-enforcer check --baseline` once so only new findings count.\n');
    return 0;
  } finally {
    rl.close();
  }
}

export async function runSync(argv = []) {
  const root = rootOf(argv);
  const cfgPath = join(root, 'enforcer.config.json');
  if (!existsSync(cfgPath)) { console.error(`No enforcer.config.json in ${root}. Run ds-enforcer init first.`); return 1; }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  if (!cfg.sources?.length) { console.error('This config has no sources to sync from (it was written by hand).'); return 1; }
  const r = generate(root, cfg);
  console.log(`Synced: ${r.tokens} tokens, ${r.components} components.${r.drift.length ? ` ${r.drift.length} token${r.drift.length === 1 ? ' differs' : 's differ'} between sources.` : ''}`);
  return 0;
}
