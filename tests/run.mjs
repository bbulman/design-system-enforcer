#!/usr/bin/env node
/**
 * End-to-end tests: copy each fixture project to a temp folder, run `init` and
 * `check` the way a user would, and assert on the findings. Also covers the
 * baseline, the edit hook, the accessibility review, the checklist report and,
 * when the MCP SDK is installed, the MCP server itself. The kit fixture is a
 * project configured by hand (a PHP-helper design system with the house rules,
 * the small-icon rule and the component gate on); the others are connected by init.
 *
 *   npm test
 */
import { spawnSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `dse-${name}-`)));
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
const reactConfig = JSON.parse(readFileSync(join(react, 'enforcer.config.json'), 'utf8'));
test('react: init writes the config format this code reads, with no house rule it was not asked for', () => {
  const { CONFIG_VERSION } = JSON.parse(JSON.stringify({ CONFIG_VERSION: Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'config-file.js'), 'utf8'))[1]) }));
  ok(reactConfig.configVersion === CONFIG_VERSION, `configVersion ${reactConfig.configVersion}, expected ${CONFIG_VERSION}`);
  for (const key of ['iconSize', 'tokenNames', 'components', 'text', 'staged']) ok(!(key in reactConfig), `init wrote ${key}`);
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
test('react: an init-connected project has no small-icon rule and no lookalike rules, which a project switches on', () => {
  appendFileSync(join(react, 'src/app/app.css'), '\n.toolbar .icon { width: 12px; }\n');
  const after = findings(react, ['src/app/app.css']);
  ok(!after.some(v => v.type === 'small-icon'), 'small-icon reported without iconSize');
  ok(!rf.some(v => ['bespoke-lookalike', 'hand-copied-component'].includes(v.type)), 'a lookalike was reported with the gate off');
});

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

test('report: the report is written and read only inside the project, a symlink out of it included', () => {
  const outside = mkdtempSync(join(tmpdir(), 'dse-outside-'));
  temps.push(outside);
  symlinkSync(outside, join(rep, 'linkout'));
  for (const out of [join(outside, 'r.md'), '../r.md', 'linkout/r.md']) {
    const r = run(rep, ['report', '--out', out, 'src']);
    ok(r.code === 2 && /^Refused: .* is outside the project \(.*\)\. The report is written and read only inside it\./.test(r.err), `${out}: exit ${r.code}: ${r.err}`);
  }
  ok(!existsSync(join(outside, 'r.md')), 'a report was written outside the project');
  const applied = run(rep, ['apply', '--report', 'linkout/r.md']);
  ok(applied.code === 2 && /Refused: linkout\/r\.md is outside the project/.test(applied.err), `apply: exit ${applied.code}: ${applied.err}`);
  // The GitHub Action's job summary writes its report here.
  const action = run(rep, ['report', '--out', '.ds-enforcer/pr-report.md', 'src']);
  ok(action.code === 0 && existsSync(join(rep, '.ds-enforcer/pr-report.md')), `the action's report: exit ${action.code}: ${action.err}`);
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

// ─── Kit: a PHP-helper design system configured by hand ───
const kit = project('kit');
const kf = findings(kit, ['--all']);
const kitHas = (type, pred, msg) => has(kf, v => v.type === type && pred(v), msg);
test('kit: raw markup names the project\'s helper', () => {
  kitHas('raw-control', v => v.file === 'pages/sampler.php' && v.suggestion.startsWith('Use kit_button($text, $options), or kit_icon_button()'), 'no raw <button> -> kit_button');
  kitHas('legacy-class', v => v.suggestion.startsWith('Use kit_modal() instead.'), 'no .modal-overlay -> kit_modal');
  kitHas('option-value', v => v.message === 'Warning: kit_badge() has no variant "shiny"', 'no unknown variant warning');
});
test('kit: the lookalike rules run with the gate on, in the project\'s names', () => {
  kitHas('hand-copied-component', v => v.match === 'kit-btn' && v.suggestion === 'Use kit_button()', 'no hand-copied kit-btn');
  kitHas('bespoke-lookalike', v => v.match === 'status-badge' && v.file === 'pages/sampler.php', 'no bespoke status-badge');
});
test('kit: the house rules and the small-icon rule speak in the project\'s words', () => {
  kitHas('small-icon', v => v.message === 'Icon glyph drawn at 14px by an inline style; an icon is at least 24px (STYLE.md §3)', 'no inline glyph finding');
  kitHas('small-icon', v => v.file === 'css/site.css' && v.suggestion === 'Use var(--glyph-lg) or larger; a size that follows its text: max(var(--glyph-lg), 1em)', 'no stylesheet glyph finding');
  kitHas('hardcoded-font-size', v => /under an 87\.5% root/.test(v.suggestion), 'no font-size advice under the 14px root');
  kitHas('hardcoded-color', v => v.suggestion === 'Use var(--brand-ink) instead', 'colorOrder did not pick --brand-ink over --old-ink');
});
test('kit: the baseline holds the old page, and the native apps are clean', () => {
  const r = run(kit, ['check', '--fail-on', 'never', 'internal', 'apps']);
  ok(r.code === 0 && /0 new findings/.test(r.out) && /1 existing in the baseline/.test(r.out), r.out + r.err);
});
test('kit: check --commit fails on a new finding, and a lookalike in JavaScript only informs', () => {
  writeFileSync(join(kit, 'js/new.js'), "el.innerHTML = '<span class=\"status-badge\">x</span>';\n");
  const js = run(kit, ['check', '--commit', '--fail-on', 'medium', 'js/new.js']);
  ok(js.code === 0 && js.out.includes('(information, not blocking)'), `js: exit ${js.code}: ${js.out}`);
  const php = run(kit, ['check', '--commit', '--fail-on', 'medium', 'pages/sampler.php']);
  ok(php.code === 1, `php: exit ${php.code}`);
});
test('kit: the gate refuses an unconsulted write that adds markup, and lets the second agent tool call through only after a consult', () => {
  const state = mkdtempSync(join(tmpdir(), 'dse-kit-state-'));
  temps.push(state);
  const hook = (cmd, payload) => spawnSync(process.execPath, [BIN, cmd], { cwd: kit, encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: kit, DS_ENFORCER_STATE_DIR: state }, input: JSON.stringify({ session_id: 'kit-e2e', cwd: kit, ...payload }) });
  const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(kit, 'pages/new.php'), content: '<span class="status-badge">x</span>' } };
  const denied = hook('gate', write);
  ok(denied.status === 0 && JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision === 'deny', `not denied: ${denied.stdout}${denied.stderr}`);
  const consult = run(kit, ['consult', '--file', 'pages/new.php', '--piece', 'a status label on each row']);
  ok(consult.code === 0 && consult.out.includes('- kit_badge'), consult.out + consult.err);
  hook('gate-post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `node ${BIN} consult --file pages/new.php --piece "a status label on each row"` }, tool_response: { stdout: consult.out, stderr: '' } });
  const allowed = hook('gate', write);
  ok(allowed.status === 0 && allowed.stdout === '', `not allowed after the consult: ${allowed.stdout}${allowed.stderr}`);
});

test('config: a config beside a copy of the enforcer applies only inside the repository its projectRoot names', () => {
  // The enforcer at <top>/vendor/tools/enforcer, with a config beside it naming <top> as its project.
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'dse-beside-')));
  temps.push(top);
  const copy = join(top, 'vendor/tools/enforcer');
  cpSync(ROOT, copy, { recursive: true, filter: src => !/[/\\](node_modules|test|tests|docs|\.git)$/.test(src) });
  const kitConfig = JSON.parse(readFileSync(join(FIXTURES, 'kit/enforcer.config.json'), 'utf8'));
  writeFileSync(join(copy, 'enforcer.config.json'), JSON.stringify({ ...kitConfig, projectRoot: '../../..' }));
  cpSync(join(FIXTURES, 'kit'), top, { recursive: true });
  rmSync(join(top, 'enforcer.config.json'));
  const check = cwd => spawnSync(process.execPath, [join(copy, 'bin/ds-enforcer.mjs'), 'check', '--fail-on', 'never'], { cwd, env, encoding: 'utf8' });
  // <top> is no repository, only a folder above a copy of the enforcer: the config grades nothing there.
  const none = check(join(top, 'pages'));
  ok(none.status === 2 && /not connected/.test(none.stderr), `exit ${none.status}: ${none.stdout}${none.stderr}`);
  // A repository (its .git is all that is looked for): the config beside the enforcer is the project's.
  mkdirSync(join(top, '.git'));
  const connected = check(join(top, 'pages'));
  ok(connected.status === 0 && /files checked/.test(connected.stdout), `exit ${connected.status}: ${connected.stdout}${connected.stderr}`);
  // Its token file gone (a sync tool's renamed copy, a checkout under way): still the project's config,
  // and check says what did not load rather than call the project unconnected.
  cpSync(join(top, 'ds/tokens.css'), join(top, 'ds/tokens 2.css'));
  rmSync(join(top, 'ds/tokens.css'));
  const missing = check(join(top, 'pages'));
  ok(missing.status === 2 && /enforcer\.config\.json describes did not load: ENOENT.*ds\/tokens\.css/.test(missing.stderr) && !/not connected/.test(missing.stderr),
    `exit ${missing.status}: ${missing.stdout}${missing.stderr}`);
});

// ─── Safety and the MCP server ───
test('check: an unconnected project exits 2', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dse-empty-'));
  temps.push(empty);
  ok(run(empty, ['check']).code === 2, 'expected exit 2');
});

/* An MCP session against a project: { init, tools, call(name, args), close }. */
async function mcpSession(cwd, { server = join(ROOT, 'index.js') } = {}) {
  const p = spawn(process.execPath, [server], { cwd, env: { ...env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', err = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} } });
  p.stderr.on('data', d => { err += d; });
  const req = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const init = (await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result;
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await req('tools/list', {})).result.tools;
  return { init, tools, stderr: () => err, call: async (name, args) => (await req('tools/call', { name, arguments: args })).result, close: () => p.kill() };
}

async function mcp() {
  if (!existsSync(join(ROOT, 'node_modules', '@modelcontextprotocol'))) { console.log('SKIP  mcp: run npm install to test the server'); return; }
  const s = await mcpSession(react);
  const tools = s.tools.map(t => t.name);
  test('mcp: all twelve tools are listed', () => ok(['init', 'suggest_component', 'list_components', 'list_tokens', 'validate_file', 'check_snippet', 'audit_page', 'fix_file', 'a11y_review', 'native_apps', 'report', 'apply_report'].every(t => tools.includes(t)), `tools: ${tools.join(', ')}`));
  test('mcp: the component gate\'s tools are not listed where the gate is off', () => ok(!tools.some(t => ['consult_ui', 'record_case', 'scan_components', 'apply_review'].includes(t)), `tools: ${tools.join(', ')}`));
  test('mcp: the server reports the package version and the generic instructions', () => {
    ok(s.init.serverInfo.version === VERSION, `version ${s.init.serverInfo.version}, package ${VERSION}`);
    ok(s.init.serverInfo.name === 'design-system-enforcer', s.init.serverInfo.name);
    ok(/^Design system enforcer\. Before writing UI, find what exists/.test(s.init.instructions), s.init.instructions);
  });
  const outside = await s.call('fix_file', { file_path: '/etc/hosts', dry_run: true });
  test('mcp: file tools refuse paths outside the project', () => ok(outside.isError && /outside the project/.test(outside.content[0].text), outside.content[0].text));
  // fix_file writes: a path inside the project that a symlink leads out of is refused, and nothing outside changes.
  const away = mkdtempSync(join(tmpdir(), 'dse-away-'));
  temps.push(away);
  writeFileSync(join(away, 'x.css'), '.a { color: #7C3AED; }\n');
  symlinkSync(away, join(react, 'linked'));
  writeFileSync(join(react, 'src/app/fixme.css'), '.a { color: #7C3AED; }\n');
  const linked = await s.call('fix_file', { file_path: 'linked/x.css' });
  const fixedInside = await s.call('fix_file', { file_path: 'src/app/fixme.css' });
  test('mcp: fix_file refuses a path a symlink leads out of the project, and fixes one inside', () => {
    ok(linked.isError && /^Error: Refused: linked\/x\.css is outside the project/.test(linked.content[0].text), linked.content[0].text);
    ok(readFileSync(join(away, 'x.css'), 'utf8') === '.a { color: #7C3AED; }\n', 'the file outside the project was changed');
    ok(!fixedInside.isError && readFileSync(join(react, 'src/app/fixme.css'), 'utf8').includes('var(--color-brand)'), fixedInside.content[0].text);
  });
  const pairs = await s.call('a11y_review', { tokens: true });
  test('mcp: a11y_review audits colour pairs', () => ok(/Colour pairs in the design system/.test(pairs.content[0].text), 'no pair audit'));
  const report = await s.call('report', { out: '../elsewhere.md' });
  test('mcp: the report tool refuses a report path outside the project', () => ok(report.isError && /Refused: \.\.\/elsewhere\.md is outside the project/.test(report.content[0].text), report.content[0].text));
  s.close();

  const k = await mcpSession(kit);
  const byName = Object.fromEntries(k.tools.map(t => [t.name, t]));
  test('mcp kit: the gate\'s tools are listed, their shell lines name the enforcer by its full path from outside the project', () => {
    ok(k.tools.length === 16, `tools: ${k.tools.map(t => t.name).join(', ')}`);
    ok(byName.consult_ui.description.includes(`Shell equivalent: node ${BIN} consult --file <path>`), byName.consult_ui.description);
    ok(byName.record_case.description.includes('Only for a .php or .css file the gate covers (lookalikes in .js and .html files are only reported).'), byName.record_case.description);
    ok(byName.record_case.description.includes('The case waits for Rae on the review page'), byName.record_case.description);
    ok(byName.consult_ui.inputSchema.properties.file.description === 'Project-relative path of the file you are about to change, e.g. pages/team.php', byName.consult_ui.inputSchema.properties.file.description);
    ok(byName.list_tokens.description === 'List the kit fixture\'s tokens from ds/tokens.css.', byName.list_tokens.description);
  });
  test('mcp kit: the server is named for the project and speaks its instructions', () => {
    ok(k.init.serverInfo.name === 'kit-design-system-enforcer' && k.init.serverInfo.version === VERSION, JSON.stringify(k.init.serverInfo));
    ok(k.init.instructions.startsWith('Kit design system enforcer. Kit fixture: find the kit_* helper') && k.init.instructions.endsWith('The contract: ds/GUIDE.md (web) and ds/NATIVE.md (native).'), k.init.instructions);
  });
  const colors = (await k.call('list_tokens', { category: 'colors' })).content[0].text;
  test('mcp kit: list_tokens files the project\'s own colour names under colours (tokenNames.colorWords)', () => ok(colors.includes('`--shop-hue-1`') && colors.includes('`--color-ink`') && !colors.includes('`--space-4`'), colors));
  const apps = (await k.call('native_apps', { app: 'pocket' })).content[0].text;
  test('mcp kit: native_apps shows the app, its commands and its live check', () => ok(apps.startsWith('## Pocket (pocket)') && apps.includes('xcodebuild -project apps/pocket/Pocket.xcodeproj -scheme Pocket') && apps.includes('Native check, live (0 findings, 0 new against the baseline)'), apps));
  k.close();

  // The enforcer inside the project it serves: the shell lines name it by its path from the project root.
  const inside = project('kit');
  cpSync(ROOT, join(inside, 'tools/ds-enforcer'), { recursive: true, filter: src => !/[/\\](node_modules|test|tests|docs|\.git)$/.test(src) });
  symlinkSync(join(ROOT, 'node_modules'), join(inside, 'tools/ds-enforcer/node_modules'), 'dir');
  const ownSession = await mcpSession(inside, { server: join(inside, 'tools/ds-enforcer/index.js') });
  const own = ownSession.tools;
  ownSession.close();
  // Installed as a dependency (npm install github:…): the package under the project's node_modules, its own
  // dependency hoisted beside it, and no lockfile in the package. The server starts without installing anything.
  const app = realpathSync(mkdtempSync(join(tmpdir(), 'dse-installed-')));
  temps.push(app);
  const pkg = join(app, 'node_modules/design-system-enforcer');
  cpSync(ROOT, pkg, { recursive: true, filter: src => !/[/\\](node_modules|test|tests|docs|\.git|enforcer\.config\.json|package-lock\.json)$/.test(src) });
  symlinkSync(realpathSync(join(ROOT, 'node_modules/@modelcontextprotocol')), join(app, 'node_modules/@modelcontextprotocol'), 'dir');
  const installed = await mcpSession(app, { server: join(pkg, 'bin/ds-enforcer.mjs') });
  installed.close();
  test('bin: an install that hoists the SDK into the project starts the server without installing anything', () => {
    ok(installed.init?.serverInfo?.name === 'design-system-enforcer' && installed.init.serverInfo.version === VERSION, JSON.stringify(installed.init));
    ok(!/installing|npm ci/.test(installed.stderr()), installed.stderr());
    ok(!existsSync(join(pkg, 'node_modules')), 'it made the package a node_modules of its own');
  });
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  test('plugin: the server starts through bin/ds-enforcer.mjs, so a plugin install gets the same dependency check', () => {
    ok(JSON.stringify(plugin.mcpServers['design-system-enforcer'].args) === JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/bin/ds-enforcer.mjs']), JSON.stringify(plugin.mcpServers));
    ok(plugin.version === VERSION, `plugin ${plugin.version}, package ${VERSION}`);
  });

  test('mcp kit: an enforcer inside the project names its command by its path from the project root', () => {
    const consult = own.find(t => t.name === 'consult_ui')?.description || '';
    ok(consult.includes('Shell equivalent: node tools/ds-enforcer/bin/ds-enforcer.mjs consult --file <path>'), consult);
  });
}

await mcp();
for (const d of temps) rmSync(d, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} of ${passed + failed} tests failed.` : `All ${passed} tests passed.`}`);
process.exitCode = failed ? 1 : 0;
