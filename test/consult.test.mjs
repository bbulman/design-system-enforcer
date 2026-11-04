import { ROOT, kitConfig } from './helpers/kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../search.mjs';
import { gateSettings } from '../gate/settings.mjs';
import { pieceId, consult, clearWinner, formatConsult } from '../gate/consult.mjs';

const data = loadCatalog();
const { minScore, clearMargin } = gateSettings();
const piece = description => consult({ file: 'pages/team.php', pieces: [description] }, { data, minScore }).pieces[0];
const CLI = fileURLToPath(new URL('../bin/ds-enforcer.mjs', import.meta.url));
const cli = args => spawnSync(process.execPath, [CLI, ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });

test('pieceId is stable and case-insensitive', () => {
  assert.equal(pieceId('a.php', 'Status label'), pieceId('a.php', ' status label '));
  assert.match(pieceId('a.php', 'Status label'), /^P-[0-9a-f]{6}$/);
  assert.notEqual(pieceId('a.php', 'Status label'), pieceId('b.php', 'Status label'));
});

test('the gate is calibrated', () => {
  assert.equal(typeof minScore, 'number');
  assert.equal(typeof clearMargin, 'number');
});

test('a status label finds kit_badge', () => {
  const p = piece('a status label on each team member row');
  assert.ok(p.candidates.map(c => c.helper).includes('kit_badge'));
  assert.ok(p.candidates.length <= 5);
  assert.ok(p.candidates.every(c => c.score >= minScore));
  assert.equal(p.nothingFitting, false);
  assert.equal(p.id, pieceId('pages/team.php', 'a status label on each team member row'));
});

test('calibration: these find candidates', () => {
  const expected = {
    'a confirm-before-delete dialog': ['kit_modal'],
    'an empty state when there are no comments': ['kit_empty_state'],
    'tabs to switch between lists': ['kit_tabs'],
    'a row of headline numbers': ['kit_stats', 'kit_stat'],
  };
  for (const [description, helpers] of Object.entries(expected)) {
    const found = piece(description).candidates.map(c => c.helper);
    assert.ok(helpers.some(h => found.includes(h)), `${description}: got ${found.join(', ') || 'nothing'}`);
  }
});

test('a table row with a number in it is not a row of stats', () => {
  for (const description of ['a table row with a seat number', 'one row per attendee showing their order number']) {
    assert.notEqual(clearWinner(piece(description).candidates, clearMargin), 'kit_stats', description);
  }
  assert.equal(clearWinner(piece('a row of headline numbers').candidates, clearMargin), 'kit_stats');
  assert.equal(clearWinner(piece('a headline number on a dashboard tile').candidates, clearMargin), 'kit_stat');
});

test('calibration: these find nothing fitting', () => {
  for (const description of ['a quaternion flux capacitor', 'a 3D rotating globe of attendees', 'a piano keyboard']) {
    const p = piece(description);
    assert.equal(p.nothingFitting, true, `${description}: got ${p.candidates.map(c => `${c.helper} ${c.score}`).join(', ')}`);
    assert.deepEqual(p.candidates, []);
  }
});

test('clearWinner', () => {
  assert.equal(clearWinner([{ helper: 'kit_badge', score: 10 }], 3), 'kit_badge');
  assert.equal(clearWinner([{ helper: 'a', score: 10 }, { helper: 'b', score: 8 }], 3), null);
  assert.equal(clearWinner([{ helper: 'a', score: 12 }, { helper: 'b', score: 8 }], 3), 'a');
  assert.equal(clearWinner([], 3), null);
});

test('formatConsult lists each piece with its candidates, or says nothing fits', () => {
  const result = consult({ file: 'pages/team.php', pieces: ['a status label on each team member row', 'a piano keyboard'] }, { data, minScore });
  const text = formatConsult(result);
  const [label, piano] = result.pieces;
  assert.ok(text.includes(`${label.id}  a status label on each team member row`));
  assert.ok(text.includes('- kit_badge'));
  assert.ok(text.includes(`Example: ${data.catalog.components.kit_badge.example}`));
  assert.ok(text.includes(`Preview: ${data.catalog.components.kit_badge.preview}`));
  assert.ok(text.includes(`${piano.id}  a piano keyboard\n  Nothing in the inventory fits this piece.`));
  assert.ok(text.endsWith('Build each piece with one of its candidates, or call record_case (shell: ds-enforcer record-case) with the piece id and your reason.'));
});

test('the consult text has no em or en dashes, though the catalog does', () => {
  const pieces = ['a status label on each team member row', 'a confirm-before-delete dialog',
    'an empty state when there are no comments', 'tabs to switch between lists', 'a row of headline numbers'];
  const result = consult({ file: 'pages/team.php', pieces }, { data, minScore });
  assert.ok(result.pieces.some(p => p.candidates.some(c => /[—–]/.test(`${c.whenToUse}${c.whenNotToUse}`))));
  const text = formatConsult(result);
  assert.ok(!text.includes('—'), 'em dash in the consult text');
  assert.ok(!text.includes('–'), 'en dash in the consult text');
});

test('the CLI refuses a missing file', () => {
  assert.equal(cli(['consult', '--piece', 'x']).status, 2);
});

test('the CLI refuses a consult with no pieces', () => {
  const run = cli(['consult', '--file', 'pages/team.php']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage: ds-enforcer consult --file/);
});

test('the CLI refuses a file outside the project', () => {
  const run = cli(['consult', '--file', '../../../../../etc/passwd', '--piece', 'a status label']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /outside the project/);
});

test('the CLI prints the consult', () => {
  const run = cli(['consult', '--file', 'pages/team.php', '--piece', 'a status label on each team member row', '--piece', 'a piano keyboard']);
  assert.equal(run.status, 0, run.stderr);
  const expected = formatConsult(consult({ file: 'pages/team.php', pieces: ['a status label on each team member row', 'a piano keyboard'] }, { data, minScore }));
  assert.equal(run.stdout.trimEnd(), expected);
});

test('the CLI does nothing when the gate is off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-consult-'));
  try {
    const off = join(dir, 'enforcer.config.json');
    const own = kitConfig();
    own.projectRoot = ROOT;
    own.componentGate.enabled = false;
    writeFileSync(off, JSON.stringify(own));
    const run = spawnSync(process.execPath, [CLI, 'consult', '--file', 'pages/team.php', '--piece', 'a status label'],
      { encoding: 'utf8', env: { ...process.env, ENFORCER_CONFIG: off } });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /component gate is off/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
