import { HERE } from './helpers/kit.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { readSession, updateSession } from '../gate/session.mjs';
import { gateSettings, stateDir, readJson, writeJsonAtomic } from '../gate/settings.mjs';
import { config } from '../config.js';

const made = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'ds-gate-')); made.push(dir); return dir; };
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

test('readSession returns an empty session for an unknown id', () => {
  const dir = fresh();
  assert.deepEqual(readSession('s1', dir), { session: 's1', files: {}, pieces: {}, writes: [], agentWrites: {}, blocked: {}, swaps: {} });
});

test('updateSession persists and returns the mutated session', () => {
  const dir = fresh();
  const returned = updateSession('s1', s => { s.writes.push('a.php'); }, dir);
  assert.deepEqual(returned.writes, ['a.php']);
  assert.deepEqual(readSession('s1', dir).writes, ['a.php']);
});

test('two sessions never share a file', () => {
  const dir = fresh();
  updateSession('s1', s => { s.writes.push('a.php'); }, dir);
  updateSession('s2', s => { s.writes.push('b.php'); }, dir);
  assert.deepEqual(readdirSync(join(dir, 'sessions')).sort(), ['s1.json', 's2.json']);
  assert.deepEqual(readSession('s1', dir).writes, ['a.php']);
  assert.deepEqual(readSession('s2', dir).writes, ['b.php']);
});

test('a corrupt session file reads as empty', () => {
  const dir = fresh();
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', 's1.json'), '{not json');
  assert.deepEqual(readSession('s1', dir).files, {});
});

test('writeJsonAtomic leaves no temp file behind', () => {
  const dir = fresh();
  const target = join(dir, 'review.json');
  writeJsonAtomic(target, { cases: [1] });
  writeJsonAtomic(target, { cases: [1, 2] });
  assert.deepEqual(readdirSync(dir), ['review.json']);
  assert.deepEqual(readJson(target, null), { cases: [1, 2] });
});

// Each hook is its own process, so the race is between processes, not promises. The
// children load the module first and then wait for one shared start time, so they collide.
test('concurrent updates to one session from separate processes all survive', async () => {
  const dir = fresh();
  const N = 12;
  const child = `
    const { updateSession } = await import(process.env.SESSION_MODULE);
    const wait = Number(process.env.START_AT) - Date.now();
    if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    updateSession('race', s => { s.writes.push(process.env.ENTRY); }, process.env.STATE_DIR);
  `;
  const env = { ...process.env, SESSION_MODULE: pathToFileURL(join(import.meta.dirname, '../gate/session.mjs')).href, STATE_DIR: dir, START_AT: String(Date.now() + 600) };
  const codes = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((done, fail) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child], { env: { ...env, ENTRY: `f${i}.php` }, stdio: 'inherit' });
    p.on('error', fail);
    p.on('exit', done);
  })));
  assert.deepEqual(codes, Array(N).fill(0));
  assert.deepEqual(readSession('race', dir).writes.sort(), Array.from({ length: N }, (_, i) => `f${i}.php`).sort());
  assert.deepEqual(readdirSync(join(dir, 'sessions')), ['race.json']);
});

test('a stale lock left by a killed hook is reclaimed', () => {
  const dir = fresh();
  const lockPath = join(dir, 'sessions', 's1.lock');
  mkdirSync(lockPath, { recursive: true });
  const old = new Date(Date.now() - 10_000);
  utimesSync(lockPath, old, old);
  updateSession('s1', s => { s.writes.push('a.php'); }, dir);
  assert.deepEqual(readSession('s1', dir).writes, ['a.php']);
  assert.deepEqual(readdirSync(join(dir, 'sessions')), ['s1.json']);
});

test('a lock held past the wait cap fails open within the hook budget', () => {
  const dir = fresh();
  const lockPath = join(dir, 'sessions', 's1.lock');
  mkdirSync(lockPath, { recursive: true });
  const t0 = Date.now();
  updateSession('s1', s => { s.writes.push('a.php'); }, dir);
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 400, `waited ${took} ms`);
  assert.deepEqual(readSession('s1', dir).writes, ['a.php']);
  assert.ok(existsSync(lockPath), 'another hook\'s lock is left alone');
});

test('a session id never leaves the sessions folder', () => {
  const dir = fresh();
  updateSession('../../escape', s => { s.writes.push('a.php'); }, dir);
  assert.deepEqual(readdirSync(dir), ['sessions']);
  assert.deepEqual(readdirSync(join(dir, 'sessions')), ['______escape.json']);
  assert.deepEqual(readSession('../../escape', dir).writes, ['a.php']);
});

test('readJson returns the fallback for a missing file', () => {
  assert.deepEqual(readJson(join(fresh(), 'nope.json'), { empty: true }), { empty: true });
});

test('stateDir honours DS_ENFORCER_STATE_DIR', () => {
  const dir = fresh();
  const before = process.env.DS_ENFORCER_STATE_DIR;
  process.env.DS_ENFORCER_STATE_DIR = dir;
  try { assert.equal(stateDir(), dir); } finally {
    if (before === undefined) delete process.env.DS_ENFORCER_STATE_DIR; else process.env.DS_ENFORCER_STATE_DIR = before;
  }
});

test('gateSettings compiles the skip list to regular expressions', () => {
  const g = gateSettings();
  assert.ok(g.skip.length > 0 && g.skip.every(r => r instanceof RegExp));
  assert.ok(g.skip.some(r => r.test('api/plans.php')));
  assert.ok(!g.skip.some(r => r.test('pages/team.php')));
  assert.equal(g.reviewUrl, 'http://localhost:9999/review');
  assert.equal(g.reviewer, 'Rae');
  assert.equal(g.shellParser, 'tools/shell-writes.mjs');
  assert.equal(typeof g.enabled, 'boolean');
  assert.equal(typeof g.autoSwap, 'boolean');
});

test('gateSettings reads the page rules, the scan skips and the file types', () => {
  const { pages, scanSkip, gated, detected } = gateSettings();
  assert.deepEqual(pages.types, ['.php']);
  assert.ok(pages.skip.some(r => r.test('internal/_old/x.php')) && pages.skip.some(r => r.test('pages/home.legacy.php')));
  assert.ok(pages.included.some(r => r.test('parts/nav.php')) && pages.included.some(r => r.test('pages/_row.php')));
  assert.ok(pages.notPages.some(r => r.test('internal/goals.php')));
  assert.ok(scanSkip.some(r => r.test('internal/_old/x.css')));
  assert.deepEqual([[...gated], [...detected]], [['.php', '.css'], ['.js', '.html']]);
});

test('with no page types set, the pages are the gated types that are not stylesheets; with none, the gate defaults', () => {
  const saved = config.componentGate;
  try {
    config.componentGate = { ...saved, pages: { ...saved.pages, types: null }, files: { gate: ['.php', '.twig', '.scss'], detect: [] } };
    assert.deepEqual(gateSettings().pages.types, ['.php', '.twig']);
    assert.deepEqual([...gateSettings().detected], []);
    config.componentGate = { enabled: true };
    const g = gateSettings();
    assert.deepEqual(g.pages, { types: ['.php'], skip: [], included: [], notPages: [] });
    assert.deepEqual([[...g.gated], [...g.detected]], [['.php', '.css'], ['.js', '.html']]);
    assert.deepEqual(g.scanSkip, []);
    assert.equal(g.reviewer, 'the reviewer');
  } finally {
    config.componentGate = saved;
  }
});

test('gateSettings skips a skip pattern that is not a valid regular expression, and keeps the rest', () => {
  const saved = config.componentGate;
  config.componentGate = { ...saved, skip: ['(', '^api/', '[a-', 7, '^tests/'] };
  try {
    const g = gateSettings();
    assert.equal(g.skip.length, 2);
    assert.ok(g.skip.some(r => r.test('api/plans.php')) && g.skip.some(r => r.test('tests/x.php')));
    assert.ok(!g.skip.some(r => r.test('pages/team.php')));
  } finally {
    config.componentGate = saved;
  }
});

test('the gate tools name the enforcer by its path from the project when it sits inside it, else by its full path', () => {
  const script = `const { projectCli, ENFORCER_CLI } = await import(${JSON.stringify(new URL('../gate/settings.mjs', import.meta.url).href)}); console.log(JSON.stringify([projectCli(), ENFORCER_CLI]));`;
  const run = root => {
    const env = { ...process.env, ENFORCER_PROJECT_ROOT: root };
    delete env.ENFORCER_CONFIG;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const [inside, full] = run(dirname(HERE));
  assert.equal(inside, `node ${basename(HERE)}/bin/ds-enforcer.mjs`);
  assert.equal(full, `node ${join(HERE, 'bin/ds-enforcer.mjs')}`);
  const [outside] = run(fresh());
  assert.equal(outside, full);
});
