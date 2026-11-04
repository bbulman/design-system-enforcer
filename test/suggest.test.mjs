import { ROOT, kitConfig } from './helpers/kit.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog, rankComponents } from '../search.mjs';
import { gateSettings } from '../gate/settings.mjs';
import { KIND, addCase } from '../gate/queue.mjs';
import { scanSuggestions, refreshSuggestions, formatSuggestions, SuggestInputError } from '../gate/suggest.mjs';

const data = loadCatalog();
const { minScore } = gateSettings();
const HERE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(HERE, 'bin/ds-enforcer.mjs');
const PROJECT = ROOT;

const made = [];
const fresh = prefix => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };
after(() => { for (const path of made) rmSync(path, { recursive: true, force: true }); });

/* A throwaway git repository with these files committed. */
function repo(files) {
  const root = fresh('ds-suggest-repo-');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture');
  return root;
}

const guide = n => `<?php $title = 'Guide ${n}'; ?>
<style>
  .dl-card { padding: 1rem; }
  .stat-card { padding: 1rem; }
</style>
<section>
  <div class="dl-card">
    <h3><?= $title ?></h3>
    <a href="/guide-${n}.pdf">Download</a>
  </div>
  <div class="stat-card"><strong>${n}</strong> downloads</div>
</section>
`;

/* Three real pages, and copies the scan must not count: a numbered duplicate, an archive,
   a legacy index and a folder componentGate.skip names. */
const GUIDES = {
  'guides/a.php': guide(1),
  'guides/b.php': guide(2),
  'guides/c.php': guide(3),
  'guides/a 2.php': guide(1),
  'internal/_old/old.php': guide(4),
  'guides/home.legacy.php': guide(5),
  'ds/demo.php': guide(6),
};
const guides = repo(GUIDES);

test('dl-card in 3 files becomes a suggestion', () => {
  const dl = scanSuggestions({ root: guides, data, minScore }).find(s => s.name === 'dl-card');
  assert.ok(dl, 'dl-card is suggested');
  assert.equal(dl.files.length, 3);
  assert.deepEqual(dl.files, ['guides/a.php', 'guides/b.php', 'guides/c.php']);
  assert.match(dl.id, /^S-[0-9a-f]{6}$/);
  assert.equal(dl.word, 'card');
  assert.equal(dl.count, 3);
  assert.deepEqual(dl.sources, ['scan']);
  assert.ok(!Number.isNaN(Date.parse(dl.first)));
  assert.ok(dl.closest.includes('kit_card'));
  const [example] = dl.examples;
  assert.deepEqual({ file: example.file, line: example.line, cls: example.cls }, { file: 'guides/a.php', line: 7, cls: 'dl-card' });
  assert.equal(example.sample, '  <div class="dl-card">\n    <h3>…</h3>\n    <a href="/guide-1.pdf">Download</a>');
});

test('stat-card does not, because kit_stat exists', () => {
  const found = scanSuggestions({ root: guides, data, minScore });
  assert.ok(!found.some(s => s.name === 'stat-card'));
  assert.ok(rankComponents('stat', data).some(c => c.name === 'kit_stat' && c.score >= minScore));
});

test('one component word across 3 bespoke classes becomes one suggestion', () => {
  const root = repo({
    'run/a.php': '<ol class="run-timeline"><li>Start</li></ol>\n',
    'run/b.php': '<ol class="day-timeline"><li>Start</li></ol>\n',
    'run/c.js': 'list.innerHTML = `<ol class="fac-timeline"></ol>`;\n',
  });
  const found = scanSuggestions({ root, data, minScore });
  assert.deepEqual(found.map(s => s.name), ['-timeline']);
  const [timeline] = found;
  assert.equal(timeline.word, 'timeline');
  assert.equal(timeline.count, 3);
  assert.deepEqual(timeline.files, ['run/a.php', 'run/b.php', 'run/c.js']);
  assert.deepEqual(timeline.examples.map(x => x.cls).sort(), ['day-timeline', 'fac-timeline', 'run-timeline']);
  // The closest components leave out those that only share a word with their usage notes.
  const scores = new Map(rankComponents('timeline', data, 50).map(c => [c.name, c.score]));
  assert.ok([...scores.values()].some(score => score < 3), 'the catalogue has one-point matches to leave out');
  assert.ok(timeline.closest.every(h => scores.get(h) >= 3), timeline.closest.join(', '));
});

test('a word entry leaves out every class that has an entry of its own', () => {
  const root = repo({
    'run/a.php': '<ol class="zeb-timeline"></ol>\n<ol class="day-timeline"></ol>\n',
    'run/b.php': '<ol class="zeb-timeline"></ol>\n<ol class="fac-timeline"></ol>\n',
    'run/c.php': '<ol class="zeb-timeline"></ol>\n<ol class="week-timeline"></ol>\n',
  });
  const found = scanSuggestions({ root, data, minScore });
  assert.deepEqual(found.map(s => s.name).sort(), ['-timeline', 'zeb-timeline']);
  const word = found.find(s => s.name === '-timeline');
  assert.deepEqual(word.classes, ['day-timeline', 'fac-timeline', 'week-timeline']);
  assert.equal(word.count, 3);
  assert.deepEqual(found.find(s => s.name === 'zeb-timeline').classes, ['zeb-timeline']);

  // With the class that has its own entry left out, two bespoke names are not a spread.
  const two = repo({
    'run/a.php': '<ol class="zeb-timeline"></ol>\n<ol class="day-timeline"></ol>\n',
    'run/b.php': '<ol class="zeb-timeline"></ol>\n<ol class="fac-timeline"></ol>\n',
    'run/c.php': '<ol class="zeb-timeline"></ol>\n',
  });
  assert.deepEqual(scanSuggestions({ root: two, data, minScore }).map(s => s.name), ['zeb-timeline']);
});

test('structural words name no piece: no list, row, panel or sheet is suggested', () => {
  const page = '<ul class="reading-list"></ul><div class="series-row"></div><aside class="getbook-panel"></aside><div class="notes-sheet"></div>\n';
  const root = repo({
    'books/a.php': page, 'books/b.php': page, 'books/c.php': page,
    'books/d.php': '<ul class="a-list"></ul><ul class="b-list"></ul><ul class="c-list"></ul><div class="a-row"></div><div class="b-row"></div><div class="c-row"></div>\n',
  });
  assert.deepEqual(scanSuggestions({ root, data, minScore }), []);
});

/* Five pages of one family, two cards with no shared prefix on the same pages, and the family's stylesheet. */
const SOLUTIONS = Object.fromEntries([
  ...['alignment', 'build-trust', 'creativity'].map(slug => [`solutions/${slug}/index.php`, `<section>
  <div class="solo-exercise-card"><a href="/library/">View</a></div>
  <div class="solo-exercise-card"><a href="/library/">View</a></div>
  <div class="solo-tip-card">1</div>
  <div class="solo-template-card">Template</div>
  <div class="music-card">Music</div>
  <div class="pause-card">Pause</div>
</section>
`]),
  ['css/solutions.css', '.solo-exercise-card { padding: 1rem; }\n.solo-tip-card { padding: 1rem; }\n'],
]);

test('classes that share a prefix, a component word and their pages are one family entry', () => {
  const found = scanSuggestions({ root: repo(SOLUTIONS), data, minScore });
  const family = found.filter(s => s.name.startsWith('solo-'));
  assert.equal(family.length, 1, found.map(s => s.name).join(', '));
  assert.equal(family[0].name, 'solo-*-card');
  assert.deepEqual(family[0].classes, ['solo-exercise-card', 'solo-tip-card', 'solo-template-card'], 'the busiest first');
  assert.equal(family[0].count, 6 + 3 + 3 + 2, 'twelve elements, and the stylesheet that defines two of the classes');
  assert.equal(family[0].files.length, 4);
  assert.deepEqual(family[0].examples.map(x => x.cls), ['solo-exercise-card', 'solo-tip-card', 'solo-template-card']);
  assert.ok(family[0].examples.every(x => x.file.startsWith('solutions/')), 'markup examples, not the stylesheet');
  // Pages hold many different pieces: the same files without a shared prefix are not a family.
  assert.ok(found.some(s => s.name === 'music-card'));
  assert.ok(found.some(s => s.name === 'pause-card'));
});

test('a class the catalogue covers by the rest of its name leaves the family, and alone it is no suggestion', () => {
  // The same pages with a component for "exercise": solo-exercise-card is covered (as stat-card is by kit_stat).
  const withExercise = structuredClone(data);
  withExercise.catalog.components.kit_exercise_tile = { signature: 'kit_exercise_tile(array $item): string', summary: 'Render an exercise as a tile', scope: 'component' };
  assert.ok(rankComponents('solo exercise', withExercise).some(c => c.name === 'kit_exercise_tile' && c.score >= minScore));
  const family = scanSuggestions({ root: repo(SOLUTIONS), data: withExercise, minScore }).filter(s => s.name.startsWith('solo-'));
  assert.deepEqual(family.map(s => [s.name, s.classes]), [['solo-*-card', ['solo-tip-card', 'solo-template-card']]]);
  const lone = repo(Object.fromEntries(['a', 'b', 'c'].map(n => [`solutions/${n}.php`, '<div class="solo-exercise-card">x</div>\n'])));
  assert.deepEqual(scanSuggestions({ root: lone, data: withExercise, minScore }), []);
});

test('a dismissed family stays out after it shrinks to one class, and a dismissed class keeps its family out', () => {
  const families = repo(SOLUTIONS);
  const lone = repo(Object.fromEntries(['a', 'b', 'c'].map(n => [`solutions/${n}.php`, '<div class="solo-exercise-card">x</div>\n'])));
  const single = scanSuggestions({ root: lone, data, minScore });
  assert.deepEqual(single.map(s => s.name), ['solo-exercise-card']);
  const dismissing = (dir, id) => {
    const path = join(dir, 'suggestions.json');
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.entries = stored.entries.filter(e => e.id !== id);
    stored.dismissed.push(id);
    writeFileSync(path, JSON.stringify(stored));
  };

  const one = fresh('ds-suggest-state-');
  const family = refreshSuggestions({ dir: one, force: true, root: families, data, minScore }).entries.find(e => e.name === 'solo-*-card');
  dismissing(one, family.id);
  assert.deepEqual(refreshSuggestions({ dir: one, force: true, root: lone, data, minScore }).entries, []);

  const two = fresh('ds-suggest-state-');
  refreshSuggestions({ dir: two, force: true, root: lone, data, minScore });
  dismissing(two, single[0].id);
  const after = refreshSuggestions({ dir: two, force: true, root: families, data, minScore }).entries;
  assert.ok(!after.some(e => e.name === 'solo-*-card'), after.map(e => e.name).join(', '));
  assert.ok(after.some(e => e.name === 'music-card'), 'other entries are unaffected');
});

test('a path outside the project is refused', () => {
  assert.throws(() => scanSuggestions({ root: guides, files: ['../elsewhere'], data, minScore }), SuggestInputError);
});

test('a scan of named paths covers only those paths', () => {
  const found = scanSuggestions({ root: guides, files: ['guides/a.php', 'guides/b.php'], data, minScore });
  assert.ok(!found.some(s => s.name === 'dl-card'), 'two files are under the threshold');
});

test('a dismissed suggestion never returns', () => {
  const dir = fresh('ds-suggest-state-');
  const first = refreshSuggestions({ dir, force: true, root: guides, data, minScore });
  const id = first.entries.find(e => e.name === 'dl-card').id;
  assert.ok(first.added.includes(id));

  // What the review page's Dismiss writes, with an id already on the build list and one announced.
  const path = join(dir, 'suggestions.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['announced', 'build', 'dismissed', 'entries', 'lastScan', 'minPages']);
  stored.entries = stored.entries.filter(e => e.id !== id);
  stored.dismissed.push(id);
  stored.build.push('S-0b0b0b');
  stored.announced.push(id);
  writeFileSync(path, JSON.stringify(stored));

  const again = refreshSuggestions({ dir, force: true, root: guides, data, minScore });
  assert.ok(!again.entries.some(e => e.id === id));
  assert.ok(!again.added.includes(id));
  const kept = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(!kept.entries.some(e => e.id === id));
  assert.deepEqual(kept.dismissed, [id]);
  assert.deepEqual(kept.build, ['S-0b0b0b']);
  assert.deepEqual(kept.announced, [id]);
});

test("a nothing-fitting case becomes a suggestion with source 'case' once it is noted on three pages", () => {
  const dir = fresh('ds-suggest-state-');
  const note = (file) => addCase({
    file, line: 4, kind: KIND.NONE,
    piece: { id: 'P-abcdef', description: 'a piano keyboard for the warm-up' },
    markup: '<div class="piano-keys"><?= $keys ?></div>', reason: 'Nothing in the inventory fits.',
  }, dir);
  note('warmup/a.php');
  note('warmup/b.php');
  // A partial is not a page, so it does not bring the note to the bar.
  note('parts/warmup.php');
  const refresh = () => refreshSuggestions({ dir, force: true, root: guides, data, minScore, scan: () => [] });
  assert.ok(!refresh().entries.some(e => /piano/.test(e.name)), 'two pages are under the bar');

  note('warmup/c.php');
  const { entries, added } = refresh();
  const piano = entries.find(e => e.name === 'a piano keyboard for the warm-up');
  assert.ok(piano);
  assert.deepEqual(piano.sources, ['case']);
  assert.match(piano.id, /^S-[0-9a-f]{6}$/);
  assert.equal(piano.count, 4);
  assert.equal(piano.pages, 3);
  assert.deepEqual(piano.files, ['parts/warmup.php', 'warmup/a.php', 'warmup/b.php', 'warmup/c.php']);
  assert.deepEqual(piano.examples[0], { file: 'warmup/a.php', line: 4, cls: null, sample: '<div class="piano-keys">…</div>' });
  assert.deepEqual(piano.reasons, ['Nothing in the inventory fits.']);
  assert.ok(added.includes(piano.id));
});

test('each entry carries the pages it is hand-written on, and the file carries the bar', () => {
  const dir = fresh('ds-suggest-state-');
  const { entries } = refreshSuggestions({ dir, force: true, root: guides, data, minScore });
  const dl = entries.find(e => e.name === 'dl-card');
  assert.equal(dl.pages, 3, 'guides/a, b and c; the duplicate, archive and legacy copies are not pages');
  assert.equal(JSON.parse(readFileSync(join(dir, 'suggestions.json'), 'utf8')).minPages, 3);
});

test("Rae's should-become adds 'bill', a case he called fine drops out, and a finding joins the scan's entry", () => {
  const dir = fresh('ds-suggest-state-');
  const description = 'a piano keyboard for the warm-up';
  const none = { kind: KIND.NONE, markup: '<div class="piano-keys"></div>', reason: 'Nothing fits.' };
  addCase({ ...none, file: 'pages/a.php', piece: { id: 'P-aaaaaa', description } }, dir);
  const marked = addCase({ ...none, file: 'pages/b.php', piece: { id: 'P-bbbbbb', description: 'A piano  keyboard for the warm-up' } }, dir);
  const fine = addCase({ ...none, file: 'pages/c.php', piece: { id: 'P-cccccc', description: 'a sundial' } }, dir);
  addCase({ ...none, file: 'guides/a.php', line: 7, finding: 'guides/a.php|bespoke-lookalike|dl-card', markup: '<div class="dl-card">' }, dir);
  // The review page records decisions in place; addCase always starts a case as pending.
  const queuePath = join(dir, 'review.json');
  const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  queue.cases.find(c => c.id === marked.id).decision = 'should-become';
  queue.cases.find(c => c.id === fine.id).decision = 'fine';
  writeFileSync(queuePath, JSON.stringify(queue));

  const { entries } = refreshSuggestions({ dir, force: true, root: guides, data, minScore });
  const piano = entries.filter(e => /piano/i.test(e.name));
  assert.equal(piano.length, 1, 'two wordings of one piece are one suggestion');
  assert.deepEqual(piano[0].sources, ['case', 'bill']);
  assert.equal(piano[0].count, 2);
  assert.deepEqual(piano[0].files, ['pages/a.php', 'pages/b.php']);
  assert.ok(!entries.some(e => e.name === 'a sundial'));
  const dl = entries.filter(e => e.name === 'dl-card');
  assert.equal(dl.length, 1);
  assert.deepEqual(dl[0].sources, ['scan', 'case']);
  assert.equal(dl[0].files.length, 3);
  assert.deepEqual(piano[0].reasons, ['Nothing fits.'], 'the same reason twice is listed once');
  assert.deepEqual(dl[0].reasons, ['Nothing fits.']);
});

test("a case's reasons are kept, five at most; a scan-only entry has none, and a later run that day adds none twice", () => {
  const dir = fresh('ds-suggest-state-');
  for (let i = 1; i <= 7; i++) {
    addCase({ kind: KIND.NONE, file: `warmup/v${i}.php`, piece: { id: 'P-dddddd', description: 'a piano keyboard' }, markup: '<div></div>', reason: `Reason ${i}.` }, dir);
  }
  addCase({ kind: KIND.NONE, file: 'guides/a.php', finding: 'guides/a.php|bespoke-lookalike|dl-card', markup: '<div class="dl-card">', reason: 'Downloads have no component.' }, dir);
  const at = new Date(2026, 9, 28, 9, 0);
  const first = refreshSuggestions({ dir, root: guides, data, minScore, now: at }).entries;
  const later = refreshSuggestions({ dir, root: guides, data, minScore, now: new Date(2026, 9, 28, 18, 0) }).entries;
  for (const entries of [first, later]) {
    assert.deepEqual(entries.find(e => e.name === 'a piano keyboard').reasons, ['Reason 1.', 'Reason 2.', 'Reason 3.', 'Reason 4.', 'Reason 5.']);
    assert.deepEqual(entries.find(e => e.name === 'dl-card').reasons, ['Downloads have no component.']);
  }
  assert.ok(!('reasons' in scanSuggestions({ root: guides, data, minScore }).find(e => e.name === 'dl-card')));
});

test('a finding on one class of a family joins the family entry', () => {
  const dir = fresh('ds-suggest-state-');
  addCase({ kind: KIND.NONE, file: 'solutions/alignment/index.php', finding: 'solutions/alignment/index.php|bespoke-lookalike|solo-tip-card', markup: '<div class="solo-tip-card">', reason: 'Tips have no card.' }, dir);
  const entries = refreshSuggestions({ dir, force: true, root: repo(SOLUTIONS), data, minScore }).entries;
  assert.ok(!entries.some(e => e.name === 'solo-tip-card'));
  const family = entries.find(e => e.name === 'solo-*-card');
  assert.deepEqual(family.sources, ['scan', 'case']);
  assert.deepEqual(family.reasons, ['Tips have no card.']);
});

test('an entry with no close component says so without claiming the catalogue has nothing', () => {
  const text = formatSuggestions([{ id: 'S-1a1a1a', name: '-search', count: 4, files: ['a.php'], examples: [], closest: [], sources: ['scan'] }], { reviewUrl: 'http://localhost:9999/review' });
  assert.match(text, /No component ranks clearly above a passing mention\./);
  assert.doesNotMatch(text, /comes? close/);
});

test('the scan runs once a day', () => {
  const dir = fresh('ds-suggest-state-');
  let calls = 0;
  const found = scanSuggestions({ root: guides, data, minScore });
  const scan = () => { calls++; return found; };
  const at = new Date(2026, 9, 28, 9, 0);
  const one = refreshSuggestions({ dir, root: guides, data, minScore, scan, now: at });
  const two = refreshSuggestions({ dir, root: guides, data, minScore, scan, now: new Date(2026, 9, 28, 23, 30) });
  assert.equal(calls, 1);
  assert.deepEqual(two.entries.map(e => e.id), one.entries.map(e => e.id), 'the day\'s scan is kept');
  assert.deepEqual(two.added, []);
  assert.equal(JSON.parse(readFileSync(join(dir, 'suggestions.json'), 'utf8')).lastScan, at.toISOString());
  refreshSuggestions({ dir, root: guides, data, minScore, scan, now: new Date(2026, 9, 28, 23, 45), force: true });
  assert.equal(calls, 2);
  refreshSuggestions({ dir, root: guides, data, minScore, scan, now: new Date(2026, 9, 29, 8, 0) });
  assert.equal(calls, 3);
});

test('an unreadable suggestions.json is left as it is', () => {
  const dir = fresh('ds-suggest-state-');
  writeFileSync(join(dir, 'suggestions.json'), '{"dismissed": ["S-0a0a0a"], ');
  assert.throws(() => refreshSuggestions({ dir, force: true, root: guides, data, minScore, scan: () => [] }), /could not be read/);
  assert.equal(readFileSync(join(dir, 'suggestions.json'), 'utf8'), '{"dismissed": ["S-0a0a0a"], ');
});

/* The CLI against the fixture repository, through a config whose projectRoot is that repository. */
function fixtureConfig(changes = {}) {
  const own = kitConfig();
  own.projectRoot = guides;
  own.catalog = join(PROJECT, own.catalog);
  own.synonyms = join(PROJECT, own.synonyms);
  Object.assign(own.componentGate, changes);
  const path = join(fresh('ds-suggest-config-'), 'enforcer.config.json');
  writeFileSync(path, JSON.stringify(own));
  return path;
}
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { cwd: HERE, encoding: 'utf8', env: { ...process.env, ...env } });

test('ds-enforcer suggest refreshes the list and prints it with the review page link', () => {
  const dir = fresh('ds-suggest-state-');
  const run = cli(['suggest', '--force'], { ENFORCER_CONFIG: fixtureConfig(), DS_ENFORCER_STATE_DIR: dir });
  assert.equal(run.status, 0, run.stderr);
  const stored = JSON.parse(readFileSync(join(dir, 'suggestions.json'), 'utf8'));
  const dl = stored.entries.find(e => e.name === 'dl-card');
  assert.ok(dl);
  assert.match(run.stdout, new RegExp(`${dl.id}  dl-card: 3 places in 3 files, on 3 pages, found by the codebase scan\\.`));
  assert.match(run.stdout, /http:\/\/localhost:9999\/review\?area=suggested/);
  assert.doesNotMatch(run.stdout, /[—–]/);
});

test('ds-enforcer suggest with paths prints that scan and saves nothing', () => {
  const dir = fresh('ds-suggest-state-');
  const run = cli(['suggest', 'guides'], { ENFORCER_CONFIG: fixtureConfig(), DS_ENFORCER_STATE_DIR: dir });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dl-card: 3 places in 3 files/);
  assert.throws(() => readFileSync(join(dir, 'suggestions.json')), { code: 'ENOENT' });
});

test('ds-enforcer suggest refuses a path outside the project and an unknown flag', () => {
  const env = { ENFORCER_CONFIG: fixtureConfig(), DS_ENFORCER_STATE_DIR: fresh('ds-suggest-state-') };
  const outside = cli(['suggest', '../elsewhere'], env);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /outside the project/);
  const flag = cli(['suggest', '--forse'], env);
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /Usage: ds-enforcer suggest/);
});

test('ds-enforcer suggest does nothing when the gate is off', () => {
  const dir = fresh('ds-suggest-state-');
  const run = cli(['suggest', '--force'], { ENFORCER_CONFIG: fixtureConfig({ enabled: false }), DS_ENFORCER_STATE_DIR: dir });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /component gate is off/);
  assert.throws(() => readFileSync(join(dir, 'suggestions.json')), { code: 'ENOENT' });
});
