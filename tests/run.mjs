#!/usr/bin/env node
/**
 * End-to-end tests: copy each fixture project to a temp folder, run `init` and
 * `check` the way a user would, and assert on the findings. Also covers the
 * baseline, the edit hook, the accessibility review and, when the MCP SDK is
 * installed, the MCP server itself.
 *
 *   npm test
 */
import { spawnSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'ds-enforcer.mjs');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR;
delete env.ENFORCER_PROJECT_ROOT;
delete env.ENFORCER_CONFIG;

let passed = 0, failed = 0;
const temps = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

function project(name) {
  const dir = mkdtempSync(join(tmpdir(), `dse-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  temps.push(dir);
  return dir;
}
function run(cwd, args, input) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function findings(cwd, args = []) {
  const r = run(cwd, ['check', '--json', '--fail-on', 'never', ...args]);
  ok(r.code === 0, `check --json exited ${r.code}: ${r.err}`);
  return JSON.parse(r.out).results.flatMap(f => f.violations.map(v => ({ ...v, file: f.file })));
}
const has = (list, pred, msg) => ok(list.some(pred), msg);

// ─── React + Tailwind v4 + Figma + SwiftUI ───
const react = project('react-tailwind');
const init = run(react, ['init', '--yes']);
test('react: init connects tokens, Figma, components and the SwiftUI app', () => {
  ok(init.code === 0, `init exited ${init.code}: ${init.err}`);
  for (const s of ['Tailwind v4', 'SwiftUI app', 'differs between sources']) ok(init.out.includes(s), `init output lacks "${s}"`);
});
const rf = findings(react);
test('react: arbitrary colour points to the system class', () => has(rf, v => v.type === 'tailwind-arbitrary-color' && v.match === 'bg-[#7C3AED]' && v.suggestion.includes('bg-brand'), 'no bg-[#7C3AED] -> bg-brand'));
test('react: default palette colour gets the nearest system colour', () => has(rf, v => v.type === 'tailwind-default-palette' && v.match === 'text-red-600' && v.suggestion.includes('text-danger'), 'no text-red-600 -> text-danger'));
test('react: v4 radius token becomes its class', () => has(rf, v => v.type === 'tailwind-arbitrary-radius' && v.suggestion.includes('rounded-card'), 'no rounded-[12px] -> rounded-card'));
test('react: @apply in the token file is checked', () => has(rf, v => v.file.endsWith('app.css') && v.match === 'bg-blue-50', 'no finding for @apply bg-blue-50'));
test('react: Figma drift lands on the token line', () => has(rf, v => v.type === 'token-drift' && v.match === '--color-brand' && v.message.includes('Figma'), 'no --color-brand drift'));
test('react: SwiftUI theme drift and view literal', () => {
  has(rf, v => v.type === 'native-token-drift' && v.match?.includes('Palette.danger'), 'no Palette.danger drift');
  has(rf, v => v.type === 'native-hex-in-view' && v.file.endsWith('HomeView.swift'), 'no colour literal in HomeView');
});
test('react: the component\'s own source is not flagged', () => ok(!rf.some(v => v.file.includes('components/ui/')), 'components/ui produced findings'));

const a11y = findings(react, ['--a11y', 'src/app/a11y.tsx']).filter(v => v.type.startsWith('a11y-'));
test('a11y: names, labels, keyboard, structure and contrast', () => {
  for (const t of ['a11y-img-alt', 'a11y-name', 'a11y-label', 'a11y-keyboard', 'a11y-tabindex', 'a11y-hidden-focusable', 'a11y-heading-order', 'a11y-autofocus', 'a11y-link']) has(a11y, v => v.type === t, `no ${t}`);
  ok(a11y.filter(v => v.type === 'a11y-contrast').length === 3, `expected 3 contrast findings, got ${a11y.filter(v => v.type === 'a11y-contrast').length}`);
});
test('a11y: labelled controls are not flagged', () => {
  const names = a11y.filter(v => v.type === 'a11y-name').map(v => v.line);
  ok(names.join() === '9,13', `a11y-name lines were ${names.join()}, expected 9,13`);
  ok(!a11y.some(v => v.type === 'a11y-label' && v.line !== 14), 'a labelled field was flagged');
});

test('baseline: only new findings fail', () => {
  ok(run(react, ['check', '--baseline']).code === 0, 'check --baseline failed');
  ok(run(react, ['check']).code === 0, 'check failed with everything baselined');
  appendFileSync(join(react, 'src/app/page.tsx'), '\nexport const X = () => <p className="text-[#123456]">new</p>\n');
  const r = run(react, ['check']);
  ok(r.code === 1 && r.out.includes('1 new finding'), `expected one new high finding, got exit ${r.code}: ${r.out.slice(-200)}`);
});

test('hook: an edit with new findings reports them to Claude (exit 2)', () => {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { cwd: react, env, encoding: 'utf8', input: JSON.stringify({ cwd: react, tool_name: 'Edit', tool_input: { file_path: join(react, 'src/app/page.tsx') } }) });
  ok(r.status === 2 && r.stderr.includes('new finding'), `exit ${r.status}: ${r.stderr}`);
});
test('hook: a file it does not check stays silent (exit 0)', () => {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { cwd: react, env, encoding: 'utf8', input: JSON.stringify({ cwd: react, tool_input: { file_path: join(react, 'package.json') } }) });
  ok(r.status === 0 && !r.stderr, `exit ${r.status}: ${r.stderr}`);
});
test('check: GitHub annotation format', () => {
  const r = run(react, ['check', '--all', '--format', 'github', '--fail-on', 'never']);
  ok(/^::error file=src\/app\/page\.tsx,line=\d+,title=Design system \(high\)::/m.test(r.out), 'no ::error annotation');
});

// ─── The checklist report ───
const rep = project('react-tailwind');
run(rep, ['init', '--yes']);
test('report: writes a checklist with auto and Claude items', () => {
  const r = run(rep, ['report', 'src']);
  ok(r.code === 0 && /\d+ findings in \d+ files/.test(r.out), r.out + r.err);
  const md = readFileSync(join(rep, 'design-system-report.md'), 'utf8');
  ok(/- \[ \] \*\*R\d+\*\* .*bg-\[#7C3AED\]` → `bg-brand` · \*auto\*/.test(md), 'no auto item for bg-[#7C3AED] -> bg-brand');
  ok(/\*Claude\*/.test(md), 'no Claude item');
});
test('report: apply fixes ticked auto items, marks them, leaves the rest', () => {
  const md = readFileSync(join(rep, 'design-system-report.md'), 'utf8');
  const id = md.match(/\*\*(R\d+)\*\* · line 6 · high · Arbitrary colour bg-\[#7C3AED\]/)[1];
  const before = readFileSync(join(rep, 'src/app/page.tsx'), 'utf8');
  run(rep, ['apply', '--tick', id]);
  const after = readFileSync(join(rep, 'src/app/page.tsx'), 'utf8');
  ok(after.includes('hover:bg-brand') && !after.includes('bg-[#7C3AED]'), 'the swap was not made');
  ok(after.replace('hover:bg-brand', 'hover:bg-[#7C3AED]') === before, 'apply changed more than the one class');
  ok(new RegExp(`\\*\\*${id}\\*\\*.*— ✅ fixed`).test(readFileSync(join(rep, 'design-system-report.md'), 'utf8')), 'item not marked fixed');
});
test('report: a Claude item is handed back, then verified once fixed', () => {
  const md = readFileSync(join(rep, 'design-system-report.md'), 'utf8');
  const [first, second] = [...md.matchAll(/\*\*(R\d+)\*\* · line (9|10) · medium · Raw <button>/g)].map(m => m[1]);
  const r1 = run(rep, ['apply', '--tick', first]);
  ok(r1.out.includes(`🛠 ${first}`), `not handed to Claude: ${r1.out}`);
  const file = join(rep, 'src/app/a11y.tsx');
  const src = readFileSync(file, 'utf8').split('\n');
  src[8] = src[8].replace('<button onClick={close}>', '<Button onClick={close} aria-label="Close">').replace('</button>', '</Button>');
  writeFileSync(file, src.join('\n'));
  run(rep, ['apply']);
  const after = readFileSync(join(rep, 'design-system-report.md'), 'utf8');
  ok(new RegExp(`\\*\\*${first}\\*\\*.*— ✅ fixed`).test(after), 'fixed Claude item not marked');
  ok(!new RegExp(`\\*\\*${second}\\*\\*.*— ✅ fixed`).test(after), 'an untouched identical neighbour was marked fixed');
});
test('report: --accept-rest moves unticked items into the baseline', () => {
  const r = run(rep, ['apply', '--accept-rest']);
  ok(/unticked items? recorded in the baseline/.test(r.out), r.out);
  ok(run(rep, ['check', 'src']).code === 0, 'check still fails after accepting the rest');
});

test('stop hook: shows the report for this session\'s edits, then stays quiet until it changes', () => {
  appendFileSync(join(rep, 'src/app/page.tsx'), '\nexport const Late = () => <p className="text-[#123456] m-[7px]">late</p>;\n');
  const hookIn = (extra) => JSON.stringify({ session_id: 'sess-1', cwd: rep, ...extra });
  const edit = spawnSync(process.execPath, [BIN, 'hook'], { cwd: rep, env, input: hookIn({ tool_input: { file_path: 'src/app/page.tsx' } }), encoding: 'utf8' });
  ok(edit.status === 2, `edit hook exit ${edit.status}`);
  const stop = () => spawnSync(process.execPath, [BIN, 'stop-hook'], { cwd: rep, env, input: hookIn({}), encoding: 'utf8' });
  const first = stop();
  ok(first.status === 0 && /Design system report: \d+ violation/.test(JSON.parse(first.stdout).systemMessage), `first: ${first.stdout}${first.stderr}`);
  ok(existsSync(join(rep, 'design-system-report.md')), 'report not written');
  ok(stop().stdout.trim() === '', 'repeated the same report');
  const other = spawnSync(process.execPath, [BIN, 'stop-hook'], { cwd: rep, env, input: JSON.stringify({ session_id: 'sess-2', cwd: rep }), encoding: 'utf8' });
  ok(other.stdout.trim() === '', 'spoke for another session');
});

// ─── Vue ───
const vue = project('vue');
run(vue, ['init', '--yes']);
const vf = findings(vue);
test('vue: components imported with their variants', () => {
  const cat = JSON.parse(readFileSync(join(vue, '.ds-enforcer/catalog.json'), 'utf8')).components;
  ok(cat.BaseButton?.optionSpec?.variant?.values?.join() === 'primary,ghost,danger', 'BaseButton variants missing');
  ok(cat.TextInput?.optionSpec?.tone?.values?.join() === 'neutral,error', 'TextInput validator values missing');
});
test('vue: raw <button> points to BaseButton', () => has(vf, v => v.type === 'raw-control' && v.message.includes('<BaseButton>'), 'no raw-control -> BaseButton'));
test('vue: <style> and @apply are checked', () => {
  has(vf, v => v.type === 'hardcoded-color' && v.match === '#0EA5E9', 'no hard-coded colour in <style>');
  has(vf, v => v.type === 'tailwind-arbitrary-color' && v.suggestion.includes('text-danger'), 'no @apply text-[#E11D48] -> text-danger');
});

// ─── Svelte ───
const svelte = project('svelte');
run(svelte, ['init', '--yes']);
const sf = findings(svelte);
test('svelte: $props() variants and doc comment', () => {
  const b = JSON.parse(readFileSync(join(svelte, '.ds-enforcer/catalog.json'), 'utf8')).components.Button;
  ok(b?.optionSpec?.variant?.values?.join() === 'default,outline', 'Button variants missing');
  ok(b.summary === 'A button that commits an action.', `summary was "${b?.summary}"`);
});
test('svelte: markup, inline style and <style> checks', () => {
  has(sf, v => v.type === 'raw-control' && v.message.includes('<Button>'), 'no raw-control -> Button');
  has(sf, v => v.type === 'tailwind-default-palette' && v.suggestion.includes('text-ink'), 'no text-gray-900 -> text-ink');
  has(sf, v => v.type === 'hardcoded-color' && v.match === '#111827', 'no colour in <style>');
});

// ─── Safety and the MCP server ───
test('check: an unconnected project exits 2', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dse-empty-'));
  temps.push(empty);
  ok(run(empty, ['check']).code === 2, 'expected exit 2');
});

async function mcp() {
  if (!existsSync(join(ROOT, 'node_modules', '@modelcontextprotocol'))) { console.log('SKIP  mcp: run npm install to test the server'); return; }
  const p = spawn(process.execPath, [join(ROOT, 'index.js')], { cwd: react, env: { ...env, CLAUDE_PROJECT_DIR: react }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} } });
  const call = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await call('tools/list', {})).result.tools.map(t => t.name);
  test('mcp: all twelve tools are listed', () => ok(['init', 'suggest_component', 'list_components', 'list_tokens', 'validate_file', 'check_snippet', 'audit_page', 'fix_file', 'a11y_review', 'native_apps', 'report', 'apply_report'].every(t => tools.includes(t)), `tools: ${tools.join(', ')}`));
  const outside = await call('tools/call', { name: 'fix_file', arguments: { file_path: '/etc/hosts', dry_run: true } });
  test('mcp: file tools refuse paths outside the project', () => ok(outside.result.isError && /outside the project/.test(outside.result.content[0].text), outside.result.content[0].text));
  const pairs = await call('tools/call', { name: 'a11y_review', arguments: { tokens: true } });
  test('mcp: a11y_review audits colour pairs', () => ok(/Colour pairs in the design system/.test(pairs.result.content[0].text), 'no pair audit'));
  p.kill();
}

await mcp();
for (const d of temps) rmSync(d, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} of ${passed + failed} tests failed.` : `All ${passed} tests passed.`}`);
process.exitCode = failed ? 1 : 0;
