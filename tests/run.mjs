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
import { pathToFileURL } from 'node:url';

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

/* An MCP session against a project in a 2025-era handshake: { init, tools, call(name, args), asked(), answerErrors(), close }.
   Each request the server sends the client is answered with answer(message), and its method is kept for asked().
   An answer that throws is sent to the server as a JSON-RPC error and its message kept for answerErrors(), so the
   test that used it fails on its own assertions instead of the run crashing. A preload is a module node imports
   before the server (--import), which can reach into the server's process. */
async function mcpSession(cwd, { server = join(ROOT, 'index.js'), protocolVersion = '2024-11-05', capabilities = {}, answer = () => ({}), preload } = {}) {
  const p = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), server], { cwd, env: { ...env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', err = ''; const waiting = new Map(); let id = 0; const asked = [], answerErrors = [];
  const send = m => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  p.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method && m.id !== undefined) {
        asked.push(m.method);
        Promise.resolve().then(() => answer(m)).then(result => send({ id: m.id, result }), error => {
          const message = error instanceof Error ? error.message : String(error);
          answerErrors.push(message);
          send({ id: m.id, error: { code: -32603, message: `The test's answer threw: ${message}` } });
        });
        continue;
      }
      waiting.get(m.id)?.(m);
    }
  });
  p.stderr.on('data', d => { err += d; });
  const req = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); send({ id: n, method, params }); });
  const init = (await req('initialize', { protocolVersion, capabilities, clientInfo: { name: 'test', version: '1' } })).result;
  send({ method: 'notifications/initialized' });
  const tools = (await req('tools/list', {})).result.tools;
  return { init, tools, stderr: () => err, asked: () => [...asked], answerErrors: () => [...answerErrors], call: async (name, args) => (await req('tools/call', { name, arguments: args })).result, close: () => p.kill() };
}

/* A 2026-07-28 session through the v2 client, pinned so it never falls back to a handshake: { client, list(),
   call(name, args), close }, where list and call resolve to { error } (the message) instead of rejecting;
   { error } when the server does not connect, so the test fails rather than the run; or null when
   @modelcontextprotocol/client (a dev dependency) is not installed. With elicit, the client declares forms
   and answers each one with elicit(params), counting them in client.asked. */
async function modernSession(cwd, { elicit } = {}) {
  let Client, StdioClientTransport;
  try {
    ({ Client } = await import('@modelcontextprotocol/client'));
    ({ StdioClientTransport } = await import('@modelcontextprotocol/client/stdio'));
  } catch { return null; }
  const client = new Client({ name: 'test', version: '1' }, { capabilities: elicit ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  client.asked = 0;
  if (elicit) client.setRequestHandler('elicitation/create', request => { client.asked++; return elicit(request.params); });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'index.js')], cwd, env: { ...env, CLAUDE_PROJECT_DIR: cwd }, stderr: 'ignore' }));
  } catch (error) {
    await client.close().catch(() => {});
    return { error: error.message };
  }
  const safely = promise => promise.catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
  return {
    client,
    list: () => safely(client.listTools()),
    call: (name, args) => safely(client.callTool({ name, arguments: args })),
    close: () => client.close().catch(() => {}),
  };
}

/* A fresh copy with a checklist of every finding in src, nothing ticked and no baseline yet. */
function acceptRestProject() {
  const p = project('react-tailwind');
  run(p, ['init', '--yes']);
  run(p, ['report', 'src']);
  return p;
}
const baselined = p => run(p, ['check', 'src']).code === 0;
const YES = { action: 'accept', content: { confirm: true } };
const textOf = result => result?.content?.[0]?.text ?? JSON.stringify(result);

async function mcp() {
  if (!existsSync(join(ROOT, 'node_modules', '@modelcontextprotocol', 'server', 'package.json'))) { console.log('SKIP  mcp: run npm install to test the server'); return; }
  const s = await mcpSession(react);
  const tools = s.tools.map(t => t.name);
  test('mcp: all twelve tools are listed', () => ok(['init', 'suggest_component', 'list_components', 'list_tokens', 'validate_file', 'check_snippet', 'audit_page', 'fix_file', 'a11y_review', 'native_apps', 'report', 'apply_report'].every(t => tools.includes(t)), `tools: ${tools.join(', ')}`));
  test('mcp: the component gate\'s tools are not listed where the gate is off', () => ok(!tools.some(t => ['consult_ui', 'record_case', 'scan_components', 'apply_review'].includes(t)), `tools: ${tools.join(', ')}`));
  test('mcp: the server reports the package version and the generic instructions', () => {
    ok(s.init.serverInfo.version === VERSION, `version ${s.init.serverInfo.version}, package ${VERSION}`);
    ok(s.init.serverInfo.name === 'design-system-enforcer', s.init.serverInfo.name);
    ok(/^Design system enforcer\. Before writing UI, find what exists/.test(s.init.instructions), s.init.instructions);
  });
  const shape = tools => JSON.stringify(tools.map(t => [t.name, t.annotations]));
  const older = [];
  for (const protocolVersion of ['2025-06-18', '2025-11-25']) {
    const o = await mcpSession(react, { protocolVersion });
    older.push([protocolVersion, o.init.protocolVersion, shape(o.tools)]);
    o.close();
  }
  test('mcp: the server speaks 2025-06-18 and 2025-11-25 as well as 2024-11-05', () => {
    for (const [asked, got, tools] of older) ok(got === asked && tools === shape(s.tools), `${asked}: got ${got}`);
  });

  const modern = await modernSession(react, {});
  if (!modern) console.log('SKIP  mcp: install @modelcontextprotocol/client to test 2026-07-28');
  else {
    const modernTools = modern.client && await modern.list();
    const modernPairs = modern.client && await modern.call('a11y_review', { tokens: true });
    test('mcp: a 2026-07-28 client discovers the server, its instructions and its annotated tools', () => {
      ok(!modern.error, modern.error);
      ok(modern.client.getNegotiatedProtocolVersion() === '2026-07-28', modern.client.getNegotiatedProtocolVersion());
      ok(modern.client.getInstructions().startsWith('Design system enforcer. Before writing UI'), modern.client.getInstructions());
      ok(!modernTools.error, `tools/list: ${modernTools.error}`);
      ok(shape(modernTools.tools) === shape(s.tools), 'tool lists differ between eras');
      ok(!modernPairs.error, `a11y_review: ${modernPairs.error}`);
      ok(/Colour pairs in the design system/.test(textOf(modernPairs)), 'a11y_review failed on 2026-07-28');
    });
    if (modern.client) await modern.close();
  }
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
  const driftFile = rf.find(v => v.type === 'token-drift').file;
  const driftAudit = (await s.call('audit_page', { file_path: driftFile })).content[0].text;
  const pageAudit = (await s.call('audit_page', { file_path: 'src/app/page.tsx' })).content[0].text;
  const pageCheck = (await s.call('validate_file', { file_path: 'src/app/page.tsx' })).content[0].text;
  test('mcp: audit_page reports the drift and the baseline marks validate_file reports', () => {
    ok(driftAudit.includes('--color-brand') && driftAudit.includes('Figma'), driftAudit);
    ok(/1 new; \d+ already in the project's baseline/.test(pageAudit), pageAudit);
    ok((pageAudit.match(/\[existing\]/g) || []).length === (pageCheck.match(/\*\(existing\)\*/g) || []).length, 'existing marks differ');
  });
  const reportPath = join(react, 'design-system-report.md');
  await s.call('report', { paths: ['src'] });
  const firstReport = readFileSync(reportPath, 'utf8');
  writeFileSync(reportPath, firstReport.replace('- [ ]', '- [x]'));
  await s.call('report', { paths: ['src'] });
  test('mcp: a second report keeps the boxes ticked in the first', () => {
    ok(/- \[ \] \*\*R\d+\*\*/.test(firstReport), 'the first report has no items to tick');
    ok((readFileSync(reportPath, 'utf8').match(/- \[x\]/g) || []).length === 1, 'the ticked box was lost');
  });
  s.close();

  // accept_rest moves every unticked finding into the baseline, so it asks the person first where the client has forms.
  const FORMS = { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } };
  {
    const p = acceptRestProject();
    const a = await mcpSession(p, { ...FORMS, answer: () => YES });
    const r = await a.call('apply_report', { accept_rest: true });
    a.close();
    test('mcp: accept_rest asks first, and a yes moves the rest into the baseline', () => {
      ok(JSON.stringify(a.asked()) === '["elicitation/create"]', `asked: ${a.asked().join(', ') || 'nothing'}`);
      ok(baselined(p), `not baselined: ${textOf(r)}`);
    });
  }
  {
    const p = acceptRestProject();
    const baselineFile = join(p, '.ds-enforcer/baseline.json');
    const before = existsSync(baselineFile);
    const a = await mcpSession(p, { ...FORMS, answer: () => ({ action: 'decline' }) });
    const r = await a.call('apply_report', { accept_rest: true });
    a.close();
    test('mcp: a no leaves the baseline alone and says so', () => {
      ok(!before && !existsSync(baselineFile), `baseline.json before: ${before}, after: ${existsSync(baselineFile)}`);
      ok(!baselined(p), 'the rest was moved into the baseline');
      ok(textOf(r).replace(/\*\*/g, '').includes('Not moved into the baseline: the form came back without a yes (declined, dismissed, or answered automatically by the client). If no form appeared, the user can run `ds-enforcer apply --accept-rest` on the command line.'), textOf(r));
    });
  }
  {
    const p = acceptRestProject();
    const a = await mcpSession(p, { ...FORMS, answer: () => ({ action: 'accept', content: { confirm: 'true' } }) });
    const r = await a.call('apply_report', { accept_rest: true });
    a.close();
    test('mcp: an answer that is not true counts as no', () => ok(!baselined(p), `baselined on confirm "true": ${textOf(r)}`));
  }
  {
    const p = acceptRestProject();
    const a = await mcpSession(p, { protocolVersion: '2025-06-18', capabilities: {} });
    const r = await a.call('apply_report', { accept_rest: true });
    a.close();
    test('mcp: a client with no forms keeps today\'s behaviour', () => {
      ok(a.asked().length === 0, `asked: ${a.asked().join(', ')}`);
      ok(baselined(p), `not baselined: ${textOf(r)}`);
    });
  }
  {
    const p = acceptRestProject();
    const m = await modernSession(p, { elicit: () => YES });
    if (!m) console.log('SKIP  mcp: install @modelcontextprotocol/client to test a 2026-07-28 form');
    else {
      const r = m.client && await m.call('apply_report', { accept_rest: true });
      if (m.client) await m.close();
      test('mcp: a 2026-07-28 client confirms through a form', () => {
        ok(!m.error, m.error);
        ok(!r.error, `apply_report: ${r.error}`);
        ok(m.client.asked === 1, `asked ${m.client.asked} times`);
        ok(baselined(p), `not baselined: ${textOf(r)}`);
      });
    }
  }
  {
    const p = acceptRestProject();
    const reportFile = join(p, 'design-system-report.md');
    const counts = [];
    const a = await mcpSession(p, { ...FORMS, answer: m => {
      counts.push(Number(/Move (\d+) unticked/.exec(m.params?.message)?.[1]));
      if (counts.length === 1) writeFileSync(reportFile, readFileSync(reportFile, 'utf8').replace('- [ ]', '- [x]'));
      return YES;
    } });
    const r = await a.call('apply_report', { accept_rest: true });
    a.close();
    test('mcp: a report that changes before the answer is asked about again', () => {
      ok(a.asked().length === 2, `asked ${a.asked().length} times: ${a.answerErrors().join('; ')}`);
      ok(counts[1] === counts[0] - 1, `counts asked about: ${counts.join(', ')}`);
      ok(baselined(p), `not baselined: ${textOf(r)}`);
    });
  }
  {
    const p = acceptRestProject();
    const reportFile = join(p, 'design-system-report.md');
    writeFileSync(reportFile, readFileSync(reportFile, 'utf8').replaceAll('- [ ]', '- [x]'));
    const a = await mcpSession(p, { ...FORMS, answer: () => YES });
    const r = await a.call('apply_report', { accept_rest: true });
    a.close();
    test('mcp: nothing to move means no question', () => {
      ok(a.asked().length === 0, `asked: ${a.asked().join(', ')}`);
      ok(r && !r.isError, textOf(r));
    });
  }
  {
    // apply_report reads the report twice: once for the question and once to apply it. Another session's
    // Stop hook can rewrite it in between; the preload stands in for that, unticking a finding just before
    // the second read, which no client message can time.
    const p = acceptRestProject();
    const reportFile = join(p, 'design-system-report.md');
    writeFileSync(reportFile, readFileSync(reportFile, 'utf8').replaceAll('- [ ]', '- [x]'));
    const preload = join(realpathSync(mkdtempSync(join(tmpdir(), 'dse-race-'))), 'untick-between-reads.mjs');
    temps.push(resolve(preload, '..'));
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const target = ${JSON.stringify(reportFile)};
const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = function (path, ...rest) {
  if (String(path) === target && ++reads === 2) {
    fs.writeFileSync(target, read(target, 'utf8').replace('- [x]', '- [ ]'));
    process.stderr.write('dse-race: unticked a finding before the second read of the report\\n');
  }
  return read.call(this, path, ...rest);
};
syncBuiltinESMExports();
`);
    const a = await mcpSession(p, { ...FORMS, answer: () => YES, preload });
    const r = await a.call('apply_report', { accept_rest: true });
    a.close();
    test('mcp: with nothing to ask about, a finding unticked before the report is applied is not moved', () => {
      ok(a.stderr().includes('dse-race: unticked a finding'), `the finding was never unticked: ${a.stderr()}`);
      ok(a.asked().length === 0, `asked: ${a.asked().join(', ')}`);
      ok(!existsSync(join(p, '.ds-enforcer/baseline.json')), `moved into the baseline unasked: ${textOf(r)}`);
      ok(textOf(r).replace(/\*\*/g, '').includes('Not moved into the baseline: the unticked findings changed while apply_report was running'), textOf(r));
    });
  }

  // init's connect replaces a hand-written config, and adds a hook, only with the person's yes where the client has forms.
  const elicited = session => session.asked().filter(m => m === 'elicitation/create').length;
  const replacedBy = (p, path) => JSON.parse(readFileSync(join(p, 'enforcer.config.json'), 'utf8')).sources?.some(s => s.path === path);
  {
    const p = project('kit');
    const configFile = join(p, 'enforcer.config.json');
    const before = readFileSync(configFile, 'utf8');
    const a = await mcpSession(p, { ...FORMS, answer: () => ({ action: 'decline' }) });
    const r = await a.call('init', { action: 'connect', sources: ['ds/tokens.css'], replace: true });
    a.close();
    test('mcp: init asks before replacing a hand-written config, and a no keeps it', () => {
      ok(r?.isError && textOf(r) === `Not connected: the form came back without a yes, so the hand-written ${configFile} stays as it is, and no hook was added either.`, textOf(r));
      ok(readFileSync(configFile, 'utf8') === before, 'the hand-written config was changed');
      ok(elicited(a) === 1, `asked ${elicited(a)} times: ${a.answerErrors().join('; ')}`);
    });
  }
  {
    const p = project('kit');
    const a = await mcpSession(p, { ...FORMS, answer: () => YES });
    const r = await a.call('init', { action: 'connect', sources: ['ds/tokens.css'], replace: true, hook: true });
    a.close();
    test('mcp: replace and hook are asked together, in one round', () => {
      ok(elicited(a) === 2, `asked ${elicited(a)} times: ${a.answerErrors().join('; ')}`);
      ok(replacedBy(p, 'ds/tokens.css'), `the config was not replaced: ${textOf(r)}`);
      ok(existsSync(join(p, '.claude/settings.local.json')), `no hook was added: ${textOf(r)}`);
    });
  }
  {
    const p = project('react-tailwind');
    const settings = join(p, '.claude/settings.local.json');
    const before = existsSync(settings);
    const a = await mcpSession(p, { ...FORMS, answer: () => ({ action: 'decline' }) });
    const r = await a.call('init', { action: 'connect', sources: reactConfig.sources.map(x => x.path), hook: true });
    a.close();
    test('mcp: a no to the hook connects without it', () => {
      ok(!before && !existsSync(settings), `settings.local.json before: ${before}, after: ${existsSync(settings)}`);
      ok(r && !r.isError && existsSync(join(p, 'enforcer.config.json')), `not connected: ${textOf(r)}`);
      ok(textOf(r).includes('**Hook**: not added (the form came back without a yes)'), textOf(r));
    });
  }
  {
    const p = project('kit');
    const a = await mcpSession(p, { protocolVersion: '2025-06-18', capabilities: {} });
    const r = await a.call('init', { action: 'connect', sources: ['ds/tokens.css'], replace: true });
    a.close();
    test('mcp: a client with no forms connects as before', () => {
      ok(a.asked().length === 0, `asked: ${a.asked().join(', ')}`);
      ok(replacedBy(p, 'ds/tokens.css'), `the config was not replaced: ${textOf(r)}`);
    });
  }
  {
    const p = project('kit');
    const configFile = join(p, 'enforcer.config.json');
    let answered = 0;
    const a = await mcpSession(p, { ...FORMS, answer: () => {
      if (++answered === 1) appendFileSync(configFile, '\n');
      return YES;
    } });
    const r = await a.call('init', { action: 'connect', sources: ['ds/tokens.css'], replace: true });
    a.close();
    test('mcp: a config that changes before the answer is asked about again', () => {
      ok(elicited(a) === 2, `asked ${elicited(a)} times: ${a.answerErrors().join('; ')}`);
      ok(replacedBy(p, 'ds/tokens.css'), `the config was not replaced: ${textOf(r)}`);
    });
  }
  {
    const p = project('kit');
    const configFile = join(p, 'enforcer.config.json');
    const before = readFileSync(configFile, 'utf8');
    const a = await mcpSession(p, { ...FORMS, answer: m => (/hook/.test(m.params?.message) ? YES : { action: 'decline' }) });
    const r = await a.call('init', { action: 'connect', sources: ['ds/tokens.css'], replace: true, hook: true });
    a.close();
    test('mcp: a no to replacing the config adds no hook, even with a yes to the hook', () => {
      ok(elicited(a) === 2, `asked ${elicited(a)} times: ${a.answerErrors().join('; ')}`);
      ok(r?.isError, textOf(r));
      ok(readFileSync(configFile, 'utf8') === before, 'the hand-written config was changed');
      ok(!existsSync(join(p, '.claude/settings.local.json')), 'a hook was added');
    });
  }
  {
    const p = project('kit');
    const configFile = join(p, 'enforcer.config.json');
    const before = readFileSync(configFile, 'utf8');
    const a = await mcpSession(p, { ...FORMS, answer: () => YES });
    const r = await a.call('init', { action: 'connect', sources: [], replace: true, hook: true });
    a.close();
    const q = project('react-tailwind');
    const b = await mcpSession(q, { ...FORMS, answer: () => YES });
    const hookOnly = await b.call('init', { action: 'connect', hook: true });
    b.close();
    test('mcp: init with no sources asks nothing, since a yes could only fail, and says to choose one', () => {
      for (const [session, result] of [[a, r], [b, hookOnly]]) {
        ok(session.asked().length === 0, `asked: ${session.asked().join(', ')}`);
        ok(result?.isError && textOf(result) === 'Choose at least one source to connect.', textOf(result));
      }
      ok(readFileSync(configFile, 'utf8') === before, 'the hand-written config was changed');
      ok(!existsSync(join(p, '.claude/settings.local.json')) && !existsSync(join(q, '.claude/settings.local.json')), 'a hook was added');
      ok(!existsSync(join(q, 'enforcer.config.json')), 'the unconnected project was connected');
    });
  }
  {
    // The two entries init adds: the edit hook (PostToolUse) and the report (Stop).
    const entries = {
      PostToolUse: [{ matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: `node "${BIN}" hook`, timeout: 30 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `node "${BIN}" stop-hook`, timeout: 60 }] }],
    };
    const withSettings = hooks => {
      const p = project('react-tailwind');
      mkdirSync(join(p, '.claude'));
      writeFileSync(join(p, '.claude/settings.local.json'), JSON.stringify({ hooks }, null, 2) + '\n');
      return p;
    };
    const sources = reactConfig.sources.map(x => x.path);
    const full = withSettings(entries);
    const before = readFileSync(join(full, '.claude/settings.local.json'), 'utf8');
    const a = await mcpSession(full, { ...FORMS, answer: () => ({ action: 'decline' }) });
    const r = await a.call('init', { action: 'connect', sources, hook: true });
    a.close();
    const half = withSettings({ PostToolUse: entries.PostToolUse });
    const b = await mcpSession(half, { ...FORMS, answer: () => YES });
    const rb = await b.call('init', { action: 'connect', sources, hook: true });
    b.close();
    test('mcp: init asks nothing about a hook already installed, and asks about one half installed', () => {
      ok(a.asked().length === 0, `asked: ${a.asked().join(', ')}`);
      ok(r && !r.isError && textOf(r).includes('**Hook**: already installed in `.claude/settings.local.json`'), textOf(r));
      ok(readFileSync(join(full, '.claude/settings.local.json'), 'utf8') === before, 'the installed hook was rewritten');
      ok(elicited(b) === 1, `asked ${elicited(b)} times about the half-installed hook: ${b.answerErrors().join('; ')}`);
      const stop = JSON.parse(readFileSync(join(half, '.claude/settings.local.json'), 'utf8')).hooks.Stop || [];
      ok(rb && !rb.isError && stop.some(e => e.hooks.some(h => /stop-hook/.test(h.command))), `the Stop hook was not added: ${textOf(rb)}`);
    });
  }
  {
    // Workshopr's shape: the hand-written config sits beside the enforcer and names the repository above it as
    // the project, so connect writes a second config at the project root, which takes over as the nearer one.
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'dse-takeover-')));
    temps.push(top);
    const copy = join(top, 'vendor/tools/enforcer');
    cpSync(ROOT, copy, { recursive: true, filter: src => !/[/\\](node_modules|test|tests|docs|\.git)$/.test(src) });
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const beside = join(copy, 'enforcer.config.json');
    writeFileSync(beside, JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURES, 'kit/enforcer.config.json'), 'utf8')), projectRoot: '../../..' }));
    cpSync(join(FIXTURES, 'kit'), top, { recursive: true });
    rmSync(join(top, 'enforcer.config.json'));
    mkdirSync(join(top, '.git'));
    const atRoot = join(top, 'enforcer.config.json');
    const besideBefore = readFileSync(beside, 'utf8');
    const server = join(copy, 'index.js');
    const args = { action: 'connect', sources: ['ds/tokens.css'], replace: true };
    const no = await mcpSession(top, { server, ...FORMS, answer: () => ({ action: 'decline' }) });
    const rNo = await no.call('init', args);
    no.close();
    const rootAfterNo = existsSync(atRoot);
    const messages = [];
    const yes = await mcpSession(top, { server, ...FORMS, answer: m => {
      messages.push(m.params?.message);
      if (messages.length === 1) writeFileSync(atRoot, '{}\n');
      return YES;
    } });
    const rYes = await yes.call('init', args);
    yes.close();
    test('mcp: replacing a config that is not at the project root names the root one it writes, and a no writes neither', () => {
      ok(rNo?.isError && textOf(rNo) === `Not connected: the form came back without a yes, so the hand-written ${beside} stays as it is, and no hook was added either.`, textOf(rNo));
      ok(!rootAfterNo, 'a no wrote a config at the project root');
      ok(messages[0] === `Write ${atRoot}, a config built from the chosen sources? It takes over from the hand-written ${beside}, which stays as it is.`, `asked: ${messages[0]}`);
    });
    test('mcp: the replace question is bound to the root config too, and a yes leaves the hand-written one as it was', () => {
      ok(messages.length === 2, `asked ${messages.length} times: ${yes.answerErrors().join('; ')}`);
      ok(!rYes?.isError && JSON.parse(readFileSync(atRoot, 'utf8')).sources?.some(s => s.path === 'ds/tokens.css'), `the root config was not written: ${textOf(rYes)}`);
      ok(readFileSync(beside, 'utf8') === besideBefore, 'the hand-written config beside the enforcer was changed');
    });
  }

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
  // A client may run a read-only tool without asking, so a tool that writes any file must never be marked read-only.
  const READ_ONLY = ['validate_file', 'audit_page', 'check_snippet', 'a11y_review', 'list_components', 'list_tokens', 'suggest_component', 'native_apps', 'consult_ui'];
  const DESTRUCTIVE = ['init', 'fix_file', 'report', 'apply_report', 'apply_review'];
  test('mcp kit: every tool has a title and annotations, and only the tools that write nothing are read-only', () => {
    for (const name of [...READ_ONLY, ...DESTRUCTIVE]) ok(byName[name], `${name} is not listed`);
    for (const t of k.tools) {
      const a = t.annotations || {};
      ok(typeof t.title === 'string' && t.title.trim(), `${t.name} has no title`);
      ok(a.openWorldHint === false, `${t.name}: openWorldHint ${a.openWorldHint}`);
      ok(a.readOnlyHint === READ_ONLY.includes(t.name), `${t.name}: readOnlyHint ${a.readOnlyHint}`);
      if (!a.readOnlyHint) ok(a.destructiveHint === DESTRUCTIVE.includes(t.name), `${t.name}: destructiveHint ${a.destructiveHint}`);
    }
    ok(byName.fix_file.annotations.idempotentHint === true, 'fix_file is not idempotent');
    ok(new Set(k.tools.map(t => t.title)).size === k.tools.length, 'two tools share a title');
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
  symlinkSync(realpathSync(join(ROOT, 'node_modules/zod')), join(app, 'node_modules/zod'), 'dir');
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
