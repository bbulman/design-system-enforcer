import { kitConfig } from './helpers/kit.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PROJECT_ROOT } from '../config.js';
import { updateSession } from '../gate/session.mjs';
import { pieceId } from '../gate/consult.mjs';
import { KIND, loadQueue, addCase, updateCase, openSuppressionKeys, staticSample, recordCase, CaseInputError } from '../gate/queue.mjs';
import { gateSettings } from '../gate/settings.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(HERE, 'bin/ds-enforcer.mjs');
const SESSION_JSON = join(PROJECT_ROOT, '.ds-enforcer/session.json');

const made = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'ds-queue-')); made.push(dir); return dir; };
after(() => { for (const path of made) rmSync(path, { recursive: true, force: true }); });

/* A page under pages/, which the gate covers and no baseline names; the name is new each run. */
function viewFile(content, ext = 'php') {
  const rel = `pages/zz-queue-test-${process.pid}-${randomBytes(3).toString('hex')}.${ext}`;
  const abs = join(PROJECT_ROOT, rel);
  writeFileSync(abs, content);
  made.push(abs);
  return { rel, abs };
}

const cli = (args, dir, options = {}) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: HERE, encoding: 'utf8', env: { ...process.env, DS_ENFORCER_STATE_DIR: dir }, ...options });

/* The edit hook also notes the file in the project's own .ds-enforcer/session.json (the fixture copy's); put it back. */
function keepingSessionJson(fn) {
  const saved = existsSync(SESSION_JSON) ? readFileSync(SESSION_JSON) : null;
  try { return fn(); } finally {
    if (saved === null) rmSync(SESSION_JSON, { force: true }); else writeFileSync(SESSION_JSON, saved);
  }
}

test('addCase fills defaults', () => {
  const dir = fresh();
  const c = addCase({ file: 'app/a.php', kind: KIND.KEPT, markup: '<span class="a-badge">x</span>', reason: 'r', decision: 'keep', status: 'closed', seen: true }, dir);
  assert.match(c.id, /^C-[0-9a-f]{6}$/);
  assert.equal(c.status, 'open');
  assert.equal(c.decision, 'pending');
  assert.equal(c.seen, false);
  assert.equal(c.sample, '<span class="a-badge">x</span>');
  assert.ok(!Number.isNaN(Date.parse(c.created)));
  assert.equal(c.session, null);
  assert.deepEqual(loadQueue(dir), [c]);
});

test('a review.json that cannot be read is never written over', () => {
  for (const broken of ['not json', '{"cases": [{"id": "C-000001"', '[]']) {
    const dir = fresh();
    const path = join(dir, 'review.json');
    writeFileSync(path, broken);
    assert.throws(() => addCase({ file: 'app/a.php', kind: KIND.KEPT, markup: '<b>x</b>', reason: 'r' }, dir), new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be read, so it was left as it is`));
    assert.throws(() => updateCase('C-000001', { status: 'closed' }, dir), /could not be read/);
    assert.equal(readFileSync(path, 'utf8'), broken);
    const run = cli(['record-case', '--json', JSON.stringify({ file: 'pages/team.php', reason: 'r', markup: '<b>x</b>', piece_id: 'P-123abc' })], dir);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /could not be read, so it was left as it is/);
    assert.doesNotMatch(run.stderr, /at .*queue\.mjs/, 'a message, not a stack trace');
    assert.equal(readFileSync(path, 'utf8'), broken);
  }
  // An empty file holds nothing to lose.
  const dir = fresh();
  writeFileSync(join(dir, 'review.json'), '  \n');
  assert.ok(addCase({ file: 'app/a.php', kind: KIND.KEPT, markup: '<b>x</b>', reason: 'r' }, dir));
  assert.equal(loadQueue(dir).length, 1);
});

test('staticSample never keeps PHP', () => {
  assert.equal(staticSample('<p><?php system("rm -rf /"); ?></p><b><?= $x ?></b>'), '<p>…</p><b>…</b>');
  assert.equal(staticSample('<p>a</p><?PHP echo 1;'), '<p>a</p>…');
  assert.equal(staticSample('<i class="x">plain</i>'), '<i class="x">plain</i>');
});

// Each writer is its own process, as hooks and tool calls are. The children load the module
// first and then wait for one shared start time, so they collide.
test('parallel writers lose nothing', async () => {
  const dir = fresh();
  const N = 10;
  const child = `
    const { addCase } = await import(process.env.QUEUE_MODULE);
    const wait = Number(process.env.START_AT) - Date.now();
    if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    addCase({ file: process.env.ENTRY, kind: 'kept', markup: '<b>x</b>', reason: 'r' }, process.env.STATE_DIR);
  `;
  const env = { ...process.env, QUEUE_MODULE: pathToFileURL(join(HERE, 'gate/queue.mjs')).href, STATE_DIR: dir, START_AT: String(Date.now() + 600) };
  const codes = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((done, fail) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child], { env: { ...env, ENTRY: `f${i}.php` }, stdio: 'inherit' });
    p.on('error', fail);
    p.on('exit', done);
  })));
  assert.deepEqual(codes, Array(N).fill(0));
  const stored = JSON.parse(readFileSync(join(dir, 'review.json'), 'utf8'));
  assert.equal(stored.cases.length, N);
  const queue = loadQueue(dir);
  assert.equal(queue.length, N);
  assert.deepEqual(queue.map(c => c.file).sort(), Array.from({ length: N }, (_, i) => `f${i}.php`).sort());
  assert.equal(new Set(queue.map(c => c.id)).size, N);
  assert.deepEqual(readdirSync(dir), ['review.json']);
});

test('openSuppressionKeys holds the finding of an open case and not of a closed one', () => {
  const dir = fresh();
  addCase({ file: 'app/a.php', kind: KIND.KEPT, finding: 'app/a.php|bespoke-lookalike|a-badge', markup: '<b>x</b>', reason: 'r' }, dir);
  const closed = addCase({ file: 'app/b.php', kind: KIND.KEPT, finding: 'app/b.php|bespoke-lookalike|b-card', markup: '<b>y</b>', reason: 'r' }, dir);
  addCase({ file: 'app/c.php', kind: KIND.NONE, piece: { id: 'P-000000', description: 'a dial' }, markup: '<b>z</b>', reason: 'r' }, dir);
  const updated = updateCase(closed.id, { status: 'closed', decision: 'fine' }, dir);
  assert.equal(updated.status, 'closed');
  assert.equal(updated.id, closed.id);
  assert.equal(updateCase('C-ffffff', { status: 'closed' }, dir), null);
  assert.deepEqual([...openSuppressionKeys(dir)], ['app/a.php|bespoke-lookalike|a-badge']);
});

test('runHook stays quiet for a suppressed finding', () => {
  const dir = fresh();
  const { rel, abs } = viewFile('<div>\n<span class="status-badge">Live</span>\n</div>\n');
  const key = `${rel}|bespoke-lookalike|status-badge`;
  const input = JSON.stringify({ session_id: 'queue-test', cwd: PROJECT_ROOT, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: abs } });
  const hook = () => cli(['hook'], dir, { cwd: PROJECT_ROOT, input });
  keepingSessionJson(() => {
    const before = hook();
    assert.equal(before.status, 2, before.stderr);
    assert.ok(before.stderr.trimEnd().endsWith(`(finding: ${key})`), before.stderr);
    addCase({ file: rel, kind: KIND.KEPT, finding: key, markup: '<span class="status-badge">Live</span>', reason: 'r' }, dir);
    const run = hook();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  });
});

test('record_case refuses a file outside the project', () => {
  const dir = fresh();
  const run = cli(['record-case', '--json', JSON.stringify({ file: '../../etc/passwd', reason: 'r', markup: '<b>x</b>', finding: '../../etc/passwd|bespoke-lookalike|x-card' })], dir);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /outside the project/);
  assert.deepEqual(loadQueue(dir), []);
  assert.ok(!existsSync(join(dir, 'review.json')));
});

test('record-case records a case and fills it from the file', () => {
  const dir = fresh();
  const { rel } = viewFile([
    '<?php $extra_css = [\'/lib/components/kit.css\', \'/css/not-there.css\']; ?>',
    '<link rel="stylesheet" href="/ds/tokens.css?v=<?= filemtime(__FILE__) ?>">',
    '<span class="status-badge"><?= $label ?></span>',
    '',
  ].join('\n'));
  const finding = `${rel}|bespoke-lookalike|status-badge`;
  const markup = '<span class="status-badge"><?= $label ?></span>';
  const run = cli(['record-case', '--json', JSON.stringify({ file: rel, reason: 'It needs a pulse ring', markup, finding, chosen: 'kit_badge' })], dir);
  assert.equal(run.status, 0, run.stderr);
  const [c] = loadQueue(dir);
  assert.equal(run.stdout, `Case ${c.id} recorded. Rae will see it on the review page.\n`);
  assert.equal(c.file, rel);
  assert.equal(c.line, 3);
  assert.equal(c.kind, KIND.KEPT);
  assert.equal(c.finding, finding);
  assert.equal(c.piece, null);
  assert.equal(c.markup, markup);
  assert.equal(c.sample, '<span class="status-badge">…</span>');
  assert.deepEqual(c.stylesheets, ['lib/components/kit.css', 'ds/tokens.css']);
  assert.ok(c.candidates.some(x => x.helper === 'kit_badge'), JSON.stringify(c.candidates));
  assert.equal(c.chosen, 'kit_badge');
  assert.equal(c.reason, 'It needs a pulse ring');
  assert.equal(c.session, null);
  assert.equal(c.agent, 'main session');
});

test('a piece the consult recorded brings its words, its candidates and its kind', () => {
  const dir = fresh();
  const { rel } = viewFile('<div class="dial">x</div>\n');
  // Task 1's Session shape: a piece's candidates are helper names.
  const label = { id: pieceId(rel, 'a status label'), file: rel, description: 'a status label', candidates: ['kit_badge', 'kit_status'], nothingFitting: false };
  const dial = { id: pieceId(rel, 'a rotary dial'), file: rel, description: 'a rotary dial', candidates: [], nothingFitting: true };
  updateSession('s1', s => { s.pieces[label.id] = label; s.pieces[dial.id] = dial; }, dir);
  for (const piece of [label, dial]) {
    const run = cli(['record-case', '--json', JSON.stringify({ file: rel, reason: 'r', markup: '<div class="dial">x</div>', piece_id: piece.id })], dir);
    assert.equal(run.status, 0, run.stderr);
  }
  const [kept, none] = loadQueue(dir);
  assert.deepEqual(kept.piece, { id: label.id, description: 'a status label' });
  assert.deepEqual(kept.candidates, [{ helper: 'kit_badge' }, { helper: 'kit_status' }]);
  assert.equal(kept.kind, KIND.KEPT);
  assert.equal(kept.line, 1);
  assert.deepEqual(none.piece, { id: dial.id, description: 'a rotary dial' });
  assert.deepEqual(none.candidates, []);
  assert.equal(none.kind, KIND.NONE);
});

test('record-case refuses incomplete or mismatched input and adds nothing', () => {
  const dir = fresh();
  const base = { file: 'pages/team.php', reason: 'r', markup: '<b>x</b>' };
  const attempts = [
    ['--json', '{not json'],
    ['--json', JSON.stringify(base)],
    ['--json', JSON.stringify({ ...base, reason: ' ', piece_id: 'P-123abc' })],
    ['--json', JSON.stringify({ ...base, piece_id: 'piece one' })],
    ['--json', JSON.stringify({ ...base, finding: 'pages/other.php|bespoke-lookalike|x-card' })],
    ['--json', JSON.stringify({ ...base, finding: 'pages/team.php|hardcoded-color|#fff' })],
    [],
  ];
  for (const args of attempts) {
    const run = cli(['record-case', ...args], dir);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.notEqual(run.stderr, '');
  }
  assert.ok(!existsSync(join(dir, 'review.json')));
});

test('record-case refuses a file the gate does not cover, and queues nothing', () => {
  const dir = fresh();
  const js = viewFile('const t = `<span class="status-badge">Live</span>`;\n', 'js');
  const html = viewFile('<span class="status-badge">Live</span>\n', 'html');
  const skipped = 'tests/zz-queue-test.php';
  for (const [rel, extra] of [
    [js.rel, { finding: `${js.rel}|bespoke-lookalike|status-badge` }],
    [html.rel, { finding: `${html.rel}|bespoke-lookalike|status-badge` }],
    [html.rel, { piece_id: 'P-123abc' }],
    [skipped, { piece_id: 'P-123abc' }],
  ]) {
    const run = cli(['record-case', '--json', JSON.stringify({ file: rel, reason: 'r', markup: '<span class="status-badge">Live</span>', ...extra })], dir);
    assert.equal(run.status, 2, `${rel}: ${run.stderr}`);
    assert.equal(run.stderr.trim(), `Refused: ${rel} is not a file the component gate covers (a .php or .css file outside componentGate.skip), so there is nothing to record. Lookalikes in .js and .html files are only reported.`);
  }
  assert.ok(!existsSync(join(dir, 'review.json')));
});

test('record-case does nothing when the gate is off', () => {
  const dir = fresh();
  const own = kitConfig();
  const off = join(dir, 'enforcer.config.json');
  writeFileSync(off, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, componentGate: { ...own.componentGate, enabled: false } }));
  const run = spawnSync(process.execPath, [CLI, 'record-case', '--json', JSON.stringify({ file: 'pages/team.php', reason: 'r', markup: '<b>x</b>', piece_id: 'P-123abc' })],
    { cwd: HERE, encoding: 'utf8', env: { ...process.env, DS_ENFORCER_STATE_DIR: dir, ENFORCER_CONFIG: off } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /component gate is off/);
  assert.ok(!existsSync(join(dir, 'review.json')));
});

test('the refusal names the file types the project gates and only reports', () => {
  const settings = { ...gateSettings(), gated: new Set(['.twig']), detected: new Set(['.vue', '.js', '.html']) };
  assert.throws(() => recordCase({ file: 'pages/team.php', reason: 'r', markup: '<b>x</b>', piece_id: 'P-123abc' }, { dir: fresh(), settings }),
    e => e instanceof CaseInputError && e.message === 'Refused: pages/team.php is not a file the component gate covers (a .twig file outside componentGate.skip), so there is nothing to record. Lookalikes in .vue, .js and .html files are only reported.');
  const none = { ...settings, detected: new Set() };
  assert.throws(() => recordCase({ file: 'pages/team.php', reason: 'r', markup: '<b>x</b>', piece_id: 'P-123abc' }, { dir: fresh(), settings: none }),
    e => e.message.endsWith('so there is nothing to record.'));
});
