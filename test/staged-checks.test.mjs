import { kitConfig } from './helpers/kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectChecks, stagedPlan, plannedCommands, exportSpecs, phpNote } from '../staged.mjs';

/* The kit fixture's staged.checks: a batched page check, a php-only lint, a sources check and an exporting one. */
const OWN = kitConfig().staged;
const CHECKS = projectChecks(OWN.checks);
const SNAP = '/tmp/ds-staged-snapshot';
const many = n => Array.from({ length: n }, (_, i) => `pages/generated/page-${i}.php`);
const plan = (staged, { php = true, present = true } = {}) => {
  const p = stagedPlan(staged, CHECKS);
  const runs = plannedCommands(p.triggered, { snap: SNAP, php: p.wantsPhp && php, exists: () => present })
    .flatMap(({ check, runs: list }) => list.map(r => ({ failure: check.failure, ...r })));
  return { ...p, runs, note: p.wantsPhp && !php ? phpNote(p.triggered, OWN.noPhp) : null };
};
const PAGE = () => `${SNAP}/tools/page-check.mjs`;

test('every check in the fixture compiles', () => {
  assert.deepEqual(CHECKS.map(c => c.failure), ['page check', 'php lint', 'catalog', 'glyphs']);
  assert.ok(CHECKS.every(c => c.when instanceof RegExp));
});

test('a page runs the page check on it, through this Node', () => {
  const p = plan(['pages/team.php']);
  assert.deepEqual(p.checkable, ['pages/team.php']);
  assert.equal(p.proceeds, true);
  assert.equal(p.sources, false);
  assert.deepEqual(p.runs, [{ failure: 'page check', label: 'Page check (page-check.mjs)', cmd: process.execPath, args: [PAGE(), 'pages/team.php'] }]);
});

test('pages run in batches of the check\'s size, each labelled by its range in its unit', () => {
  const p = plan(many(5));
  assert.deepEqual(p.runs.map(r => [r.label, r.args.length - 1]), [
    ['Page check (page-check.mjs), pages 1-2', 2],
    ['Page check (page-check.mjs), pages 3-4', 2],
    ['Page check (page-check.mjs), pages 5-5', 1],
  ]);
});

test('a sync copy is not checkable and triggers nothing', () => {
  const p = plan(['pages/team 2.php']);
  assert.deepEqual(p.checkable, []);
  assert.equal(p.proceeds, false);
});

test('a component template triggers the page check, the php lint and the sources check', () => {
  const p = plan(['lib/components/badge.php']);
  assert.equal(p.sources, true);
  assert.equal(p.wantsPhp, true);
  assert.deepEqual(p.runs.map(r => r.failure), ['page check', 'php lint', 'catalog']);
  assert.deepEqual(p.runs[1], { failure: 'php lint', label: 'PHP lint', cmd: 'php', args: ['-l', 'lib/components/badge.php'] });
  assert.deepEqual(p.runs[2].args, [`${SNAP}/tools/catalog-check.mjs`]);
});

test('without php, a check that needs it runs nothing and the note names it', () => {
  const p = plan(['lib/components/badge.php'], { php: false });
  assert.deepEqual(p.runs.map(r => r.failure), ['page check', 'catalog']);
  assert.equal(p.note, 'note: php not found, so these checks were skipped: php lint.');
  assert.equal(phpNote(stagedPlan(['lib/components/badge.php'], CHECKS).triggered, null), 'note: php not found, so these checks were skipped: php lint.');
});

test('a check whose required script is not in the snapshot runs nothing', () => {
  const p = plan(['pages/team.php', 'images/glyphs/close.svg', 'ds/tokens.css'], { present: false });
  assert.deepEqual(p.runs.map(r => r.failure), ['catalog']);
});

test('the snapshot exports the rules\' files and what a check adds', () => {
  assert.deepEqual(exportSpecs(CHECKS), ['*.php', '*.css', '*.js', '*.mjs', '*.json', '*.html', '*.swift', '*.md', 'images/glyphs/*.svg']);
  assert.deepEqual(exportSpecs([]), ['*.php', '*.css', '*.js', '*.mjs', '*.json', '*.html', '*.swift', '*.md']);
});

test('the baselines a rename re-keys are the two the page check reads', () => {
  assert.deepEqual(CHECKS.flatMap(c => c.baselines || []), [
    { file: 'ds/page-baseline.json' },
    { file: 'ds/legacy-baseline.json', key: 'files' },
  ]);
});

test('with no staged.checks, only the rules run: a page triggers nothing else', () => {
  const p = stagedPlan(['pages/team.php', 'ds/tokens.css'], projectChecks([]));
  assert.deepEqual(p.triggered, []);
  assert.equal(p.proceeds, true);
  assert.equal(p.sources, false);
  assert.equal(stagedPlan(['ds/catalog.json'], projectChecks([])).proceeds, false);
  assert.equal(stagedPlan(['ds/catalog.json'], CHECKS).proceeds, true);
});

test('{snapshot} is filled in the program and anywhere in an argument; {files} only as a whole argument', () => {
  const list = projectChecks([{ name: 'tool', when: '\\.txt$', command: ['{snapshot}/bin/tool', '--root={snapshot}/x', 'x{files}', '{files}'] }]);
  const [{ runs }] = plannedCommands(stagedPlan(['a.txt', 'b.txt'], list).triggered, { snap: SNAP, php: true, exists: () => true });
  assert.deepEqual(runs, [{ label: 'tool', cmd: `${SNAP}/bin/tool`, args: [`--root=${SNAP}/x`, 'x{files}', 'a.txt', 'b.txt'] }]);
});

test('a check with no usable trigger, name or command is left out, the rest kept', () => {
  const list = projectChecks([{ name: 'bad', when: '(', command: ['x'] }, { when: 'a', command: ['x'] }, { name: 'no command', when: 'a' }, { name: 'ok', when: '\\.txt$', command: ['node', '{snapshot}/x.mjs', '{files}'] }]);
  assert.deepEqual(list.map(c => c.name), ['ok']);
  const [{ runs }] = plannedCommands(stagedPlan(['a.txt', 'b.txt'], list).triggered, { snap: SNAP, php: false, exists: () => true });
  assert.deepEqual(runs, [{ label: 'ok', cmd: process.execPath, args: [`${SNAP}/x.mjs`, 'a.txt', 'b.txt'] }]);
});

test('staged.checks that is not a list plans nothing', () => {
  for (const bad of [undefined, null, {}, 'checks']) assert.deepEqual(projectChecks(bad), []);
});
