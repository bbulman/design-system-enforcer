import { kitConfig } from './helpers/kit.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PROJECT_ROOT, config } from '../config.js';
import { loadEngine } from '../check.mjs';
import { keyOf, loadBaseline, appendToBaseline, splitByBaseline } from '../baseline.js';
import { LOOKALIKE_TYPES } from '../gate/lookalikes.mjs';
import { KIND, loadQueue, addCase, updateCase } from '../gate/queue.mjs';
import { applyReview, formatApplyReview, locate } from '../gate/apply.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(HERE, 'bin/ds-enforcer.mjs');
const engine = await loadEngine();
const NOTHING = { forClaude: [], applied: [], closed: [], stillThere: [], baselined: 0 };
const AGAIN = 'Make each change, then call apply_review again to verify and mark it.';

const made = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'ds-apply-')); made.push(dir); return dir; };
// keep and undo write the baseline: these tests write a temporary one, never the project's committed file.
const savedBaseline = config.baseline;
config.baseline = join(fresh(), 'baseline.json');
after(() => {
  config.baseline = savedBaseline;
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

/* A page under pages/, which no baseline names; the name is new each run. */
function page(content) {
  const rel = `pages/zz-apply-test-${process.pid}-${randomBytes(3).toString('hex')}.php`;
  const abs = join(PROJECT_ROOT, rel);
  writeFileSync(abs, content);
  made.push(abs);
  return { rel, abs };
}

/* The key the edit hook gives the file's first finding of this type. */
function findingOf(rel, abs, type) {
  const v = engine.validate(readFileSync(abs, 'utf8'), abs).find(x => x.type === type);
  assert.ok(v, `${rel} has a ${type} finding`);
  return keyOf(rel, v);
}

/* The file's lookalike findings in line order, as the edit hook and the finish check see them. */
const lookalikes = abs => engine.validate(readFileSync(abs, 'utf8'), abs).filter(v => LOOKALIKE_TYPES.includes(v.type)).sort((a, b) => a.line - b.line);

const SPAN = '<span class="status-badge">Live</span>';
const row = inner => `<ul>\n  <li class="member">Ana ${inner}</li>\n</ul>\n`;
const apply = dir => applyReview({ dir, engine });

function keptCase(dir, rel, finding, decision, extra = {}) {
  const c = addCase({ kind: KIND.KEPT, file: rel, line: 2, finding, markup: SPAN, candidates: [{ helper: 'kit_pill' }, { helper: 'kit_badge' }], reason: 'The row is too tight for a badge', ...extra }, dir);
  return decision ? updateCase(c.id, { decision, ...(extra.chosen ? { chosen: extra.chosen } : {}) }, dir) : c;
}

test('a use-component case comes back for Claude, then verifies', async () => {
  const dir = fresh();
  const { rel, abs } = page(row(SPAN));
  const finding = findingOf(rel, abs, 'bespoke-lookalike');
  assert.equal(finding, `${rel}|bespoke-lookalike|status-badge`);
  const c = keptCase(dir, rel, finding, 'use-component', { chosen: 'kit_badge' });

  const first = await apply(dir);
  assert.deepEqual(first.applied, []);
  assert.equal(first.forClaude.length, 1);
  const [item] = first.forClaude;
  assert.deepEqual({ ...item, call: undefined }, { id: c.id, action: 'swap', file: rel, line: 2, markup: SPAN, call: undefined, reason: 'The row is too tight for a badge' });
  // Rae's chosen candidate, not the first one listed.
  assert.match(item.call, /^kit_badge\(/);
  assert.equal(loadQueue(dir)[0].status, 'open');

  // Called, but the hand-built span is still there.
  writeFileSync(abs, row(`${SPAN} <?= kit_badge('Live') ?>`));
  assert.deepEqual((await apply(dir)).forClaude.map(i => i.id), [c.id]);
  // The span is gone, but nothing calls the component.
  writeFileSync(abs, row('Live'));
  assert.deepEqual((await apply(dir)).forClaude.map(i => i.id), [c.id]);

  writeFileSync(abs, row("<?= kit_badge('Live', ['variant' => 'status', 'status' => 'success']) ?>"));
  const done = await apply(dir);
  assert.deepEqual(done, { ...NOTHING, applied: [c.id] });
  assert.equal(loadQueue(dir)[0].status, 'applied');
  assert.equal(loadQueue(dir)[0].decision, 'use-component');
  assert.deepEqual(await apply(dir), NOTHING);
});

test('with no candidate chosen, the first one is the call', async () => {
  const dir = fresh();
  const { rel, abs } = page(row(SPAN));
  keptCase(dir, rel, findingOf(rel, abs, 'bespoke-lookalike'), 'use-component');
  const [item] = (await apply(dir)).forClaude;
  assert.match(item.call, /^kit_pill\(/);
});

test('a case with no finding is done when its markup is gone and the component is called', async () => {
  const dir = fresh();
  const seats = '<div class="seats">A1 A2</div>';
  const { rel, abs } = page(`<?= kit_badge('Open') ?>\n${seats}\n`);
  const c = updateCase(addCase({ kind: KIND.UNCONSULTED, file: rel, line: 2, markup: seats, candidates: [{ helper: 'kit_badge' }], reason: 'Written without a consult after two refusals' }, dir).id, { decision: 'use-component', chosen: 'kit_badge' }, dir);
  // The helper is called elsewhere in the file, but the markup is still there.
  assert.deepEqual((await apply(dir)).forClaude.map(i => [i.id, i.line]), [[c.id, 2]]);
  writeFileSync(abs, "<?= kit_badge('Open') ?>\n<?= kit_badge('A1') ?>\n");
  assert.deepEqual(await apply(dir), { ...NOTHING, applied: [c.id] });
});

test('a stylesheet case is done when its rules are gone, since a stylesheet calls no helper', async () => {
  const dir = fresh();
  const rule = '.seat-pill { border-radius: 99px; }';
  const rel = `css/zz-apply-test-${process.pid}-${randomBytes(3).toString('hex')}.css`;
  const abs = join(PROJECT_ROOT, rel);
  writeFileSync(abs, `${rule}\n.seats { gap: 4px; }\n`);
  made.push(abs);
  const c = updateCase(addCase({ kind: KIND.KEPT, file: rel, line: 1, markup: rule, candidates: [{ helper: 'kit_pill' }], reason: 'r' }, dir).id, { decision: 'use-component' }, dir);
  assert.deepEqual((await apply(dir)).forClaude.map(i => i.id), [c.id]);
  writeFileSync(abs, '.seats { gap: 4px; }\n');
  assert.deepEqual(await apply(dir), { ...NOTHING, applied: [c.id] });
});

test('a moved finding is handed back at the line it is on now', async () => {
  const dir = fresh();
  const { rel, abs } = page(row(SPAN));
  const c = keptCase(dir, rel, findingOf(rel, abs, 'bespoke-lookalike'), 'use-component');
  writeFileSync(abs, `<h2>Team</h2>\n<p>Who is in.</p>\n${row(SPAN)}`);
  const [item] = (await apply(dir)).forClaude;
  assert.equal(item.id, c.id);
  assert.equal(item.line, 4);
});

test('keep sends the finding to the baseline', async () => {
  const dir = fresh();
  const { rel, abs } = page(row(`${SPAN} ${SPAN}`));
  const finding = findingOf(rel, abs, 'bespoke-lookalike');
  const c = keptCase(dir, rel, finding, 'keep');

  const r = await apply(dir);
  // The open case held back every occurrence of its finding, so every one moves into the baseline.
  assert.deepEqual(r, { ...NOTHING, closed: [c.id], baselined: 2 });
  assert.equal(loadBaseline().counts[finding], 2);
  const [stored] = loadQueue(dir);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.decision, 'keep');

  assert.deepEqual(await apply(dir), NOTHING);
  assert.equal(loadBaseline().counts[finding], 2);
});

test('fine and should-become close a case with no finding and leave the baseline alone', async () => {
  const dir = fresh();
  const { rel } = page(row('<div class="seat-map">A1</div>'));
  const ids = ['fine', 'should-become'].map(decision => {
    const c = addCase({ kind: KIND.NONE, file: rel, line: 2, piece: { id: 'P-aaaaaa', description: 'a seat map' }, markup: '<div class="seat-map">A1</div>', reason: 'Nothing draws a seat map' }, dir);
    return updateCase(c.id, { decision }, dir).id;
  });
  const before = JSON.stringify(loadBaseline());
  assert.deepEqual(await apply(dir), { ...NOTHING, closed: ids });
  assert.deepEqual(loadQueue(dir).map(c => [c.status, c.decision]), [['closed', 'fine'], ['closed', 'should-become']]);
  assert.equal(JSON.stringify(loadBaseline()), before);
});

test('fine and should-become move a nothing-fitting finding into the baseline', async () => {
  const dir = fresh();
  const { rel, abs } = page('<div class="seat-chip">A1</div>\n<div class="zone-chip">North</div>\n');
  const keys = ['seat-chip', 'zone-chip'].map(cls => `${rel}|bespoke-lookalike|${cls}`);
  assert.deepEqual(lookalikes(abs).map(v => keyOf(rel, v)), keys);
  const ids = [['fine', keys[0], 1], ['should-become', keys[1], 2]].map(([decision, finding, line]) => {
    const c = addCase({ kind: KIND.NONE, file: rel, line, finding, markup: '<div class="seat-chip">A1</div>', reason: 'Nothing draws a seat map' }, dir);
    return updateCase(c.id, { decision }, dir).id;
  });
  assert.deepEqual(await apply(dir), { ...NOTHING, closed: ids, baselined: 2 });
  for (const key of keys) assert.equal(loadBaseline().counts[key], 1);
  // Closed cases hold nothing back, so it is the baseline that keeps the edit hook and the finish check quiet.
  assert.deepEqual(splitByBaseline(rel, lookalikes(abs), loadBaseline()).fresh, []);
});

const BEFORE = '<div class="row">\n  <h2>Plans</h2>\n  <a class="kit-btn" href="/plans">Open</a>\n  <p>Saved plans</p>\n</div>';
const AFTER = "<div class=\"row\">\n  <h2>Plans</h2>\n  <?= kit_button('Open', ['href' => '/plans']) ?>\n  <p>Saved plans</p>\n</div>";

/* An automatic swap the agent made, which Rae chose to undo; its markup is the lines around the finding before the swap. */
function undoneSwap(dir, rel) {
  const c = addCase({ kind: KIND.AUTO, file: rel, line: 3, finding: `${rel}|hand-copied-component|kit-btn`, markup: BEFORE, chosen: 'kit_button', candidates: [{ helper: 'kit_button' }], reason: 'Clear match; swapped automatically' }, dir);
  return updateCase(c.id, { status: 'applied', decision: 'undo' }, dir);
}

test('undo restores the original markup', async () => {
  const dir = fresh();
  const { rel, abs } = page(`${AFTER}\n`);
  const c = undoneSwap(dir, rel);

  const first = await apply(dir);
  assert.equal(first.forClaude.length, 1);
  assert.equal(first.forClaude[0].markup, c.markup);
  assert.deepEqual({ ...first.forClaude[0], markup: undefined }, { id: c.id, action: 'undo', file: rel, line: 3, markup: undefined, call: 'kit_button()', reason: 'Clear match; swapped automatically' });
  assert.equal(loadQueue(dir)[0].status, 'applied');

  writeFileSync(abs, `${BEFORE}\n`);
  const finding = findingOf(rel, abs, 'hand-copied-component');
  const done = await apply(dir);
  // Rae chose the original, so its finding goes into the baseline: it is not flagged, or swapped, again.
  assert.deepEqual(done, { ...NOTHING, applied: [c.id], baselined: 1 });
  const [stored] = loadQueue(dir);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.decision, 'undo');
  assert.equal(loadBaseline().counts[finding], 1);
  assert.deepEqual(await apply(dir), NOTHING);
});

test('undo hands back the finding\'s own line apart from the lines around it', async () => {
  const dir = fresh();
  const { rel } = page(`${AFTER}\n`);
  const c = addCase({ kind: KIND.AUTO, file: rel, line: 3, finding: `${rel}|hand-copied-component|kit-btn`, markup: BEFORE, chosen: 'kit_button', candidates: [{ helper: 'kit_button' }], reason: 'Clear match; swapped automatically' }, dir);
  updateCase(c.id, { status: 'applied', decision: 'undo', original: '  <a class="kit-btn" href="/plans">Open</a>' }, dir);
  const [item] = (await apply(dir)).forClaude;
  assert.equal(item.original, '  <a class="kit-btn" href="/plans">Open</a>');
  assert.equal(item.markup, BEFORE);
  const text = formatApplyReview({ ...NOTHING, forClaude: [item] }, {});
  assert.ok(text.includes(`: undo the automatic swap. Put the original markup back in place of \`kit_button()\`. Its own line read: \`<a class="kit-btn" href="/plans">Open</a>\`. The lines around it read`), text);
  assert.ok(text.includes('they are only there to help you find the place, so leave any change made to them since as it is.'), text);
  assert.ok(!text.includes('so these lines read'), text);
});

test('an undo whose neighbouring lines changed is still recognised by its finding', async () => {
  const dir = fresh();
  const { rel, abs } = page(`${AFTER}\n`);
  const c = undoneSwap(dir, rel);
  writeFileSync(abs, `${BEFORE.replace('Saved plans', 'Your saved plans')}\n`);
  assert.deepEqual(await apply(dir), { ...NOTHING, applied: [c.id], baselined: 1 });
});

const FILLER = Array.from({ length: 8 }, (_, i) => `<p>Line ${i + 1}</p>`).join('\n');
const OTHER = '<a class="kit-btn" href="/other">Other</a>';

test('a hand-written kit-btn far from the swap is not taken for the undo', async () => {
  const dir = fresh();
  // OTHER is on line 14, eleven lines from the swap on line 3.
  const { rel, abs } = page(`${AFTER}\n${FILLER}\n${OTHER}\n`);
  const c = undoneSwap(dir, rel);
  assert.deepEqual((await apply(dir)).forClaude.map(i => i.id), [c.id]);
  assert.equal(loadQueue(dir)[0].status, 'applied');
  assert.equal(loadBaseline()?.counts?.[c.finding], undefined);

  // Put back: only the restored one goes into the baseline, and the other is still new.
  writeFileSync(abs, `${BEFORE}\n${FILLER}\n${OTHER}\n`);
  assert.deepEqual(await apply(dir), { ...NOTHING, applied: [c.id], baselined: 1 });
  assert.equal(loadBaseline().counts[c.finding], 1);
  assert.deepEqual(splitByBaseline(rel, lookalikes(abs), loadBaseline()).fresh.map(v => v.line), [14]);
});

test('restored markup that has moved down the file is still the undo', async () => {
  const dir = fresh();
  const { rel, abs } = page(`${AFTER}\n`);
  const c = undoneSwap(dir, rel);
  writeFileSync(abs, `${FILLER}\n${BEFORE}\n`);
  assert.deepEqual(await apply(dir), { ...NOTHING, applied: [c.id], baselined: 1 });
  assert.deepEqual(splitByBaseline(rel, lookalikes(abs), loadBaseline()).fresh, []);
});

test('an undo before the agent switched is done already', async () => {
  const dir = fresh();
  const { rel } = page(`${BEFORE}\n`);
  const c = addCase({ kind: KIND.AUTO, file: rel, line: 3, finding: `${rel}|hand-copied-component|kit-btn`, markup: BEFORE, chosen: 'kit_button', candidates: [{ helper: 'kit_button' }], reason: 'Clear match; swapped automatically' }, dir);
  updateCase(c.id, { decision: 'undo' }, dir);
  assert.deepEqual(await apply(dir), { ...NOTHING, applied: [c.id], baselined: 1 });
  assert.equal(loadQueue(dir)[0].status, 'closed');
});

test('later and pending cases are left alone', async () => {
  const dir = fresh();
  const { rel, abs } = page(row(SPAN));
  const finding = findingOf(rel, abs, 'bespoke-lookalike');
  keptCase(dir, rel, finding, 'later');
  keptCase(dir, rel, finding, null);
  // An automatic swap the agent still owes is the finish hook's, until Rae decides.
  addCase({ kind: KIND.AUTO, file: rel, line: 2, finding, markup: SPAN, chosen: 'kit_badge', candidates: [{ helper: 'kit_badge' }], reason: 'Clear match; swapped automatically' }, dir);
  const before = loadQueue(dir);
  assert.deepEqual(await apply(dir), NOTHING);
  assert.deepEqual(loadQueue(dir), before);
  assert.equal(loadBaseline()?.counts?.[finding], undefined);
});

test('a case that cannot be carried out is reported and stays as it is', async () => {
  const dir = fresh();
  const gone = `pages/zz-apply-missing-${process.pid}-${randomBytes(3).toString('hex')}.php`;
  const missing = keptCase(dir, gone, `${gone}|bespoke-lookalike|status-badge`, 'use-component');
  const { rel, abs } = page(row(SPAN));
  const nameless = keptCase(dir, rel, findingOf(rel, abs, 'bespoke-lookalike'), 'use-component', { candidates: [] });
  const before = loadQueue(dir);
  const r = await apply(dir);
  assert.deepEqual(r.forClaude, []);
  assert.deepEqual(r.stillThere, [
    { id: missing.id, why: 'its file is not in the project any more' },
    { id: nameless.id, why: 'it names no component to use' },
  ]);
  assert.deepEqual(loadQueue(dir), before);
});

test('locate finds markup across whitespace and gives its lines', () => {
  const markup = '<a class="kit-btn"\n   href="/x">Go</a>';
  assert.deepEqual(locate('<p>One</p>\n<a class="kit-btn" href="/x">Go</a>\n', markup), { from: 2, to: 2 });
  assert.deepEqual(locate('<p>One</p>\r\n\r\n<a  class="kit-btn"\r\n\thref="/x">Go</a>\r\n', markup), { from: 3, to: 4 });
  assert.deepEqual(locate('   \n\t<a class="kit-btn" href="/x">Go</a>', `  ${markup}\n`), { from: 2, to: 2 });
  assert.equal(locate('<a class="kit-btn" href="/y">Go</a>', markup), null);
  assert.equal(locate('<a class="kit-btn">Go</a>', ' \n '), null);
});

test('locate stays fast on a file of about a megabyte', () => {
  const block = '<div class="row">\n\t  <p>An item</p>\r\n</div>\n';
  const filler = block.repeat(Math.ceil(1_000_000 / block.length));
  const content = `${filler}<a class="kit-btn" href="/x">Go</a>\n`;
  const lines = content.split('\n').length - 1;
  const started = performance.now();
  const span = locate(content, '<a class="kit-btn"  href="/x">Go</a>');
  const took = performance.now() - started;
  assert.deepEqual(span, { from: lines, to: lines });
  // A generous bound: the character-at-a-time version took over ten seconds here.
  assert.ok(took < 2000, `locate took ${Math.round(took)} ms on ${content.length} characters`);
});

test('appendToBaseline adds to the counts and keeps every other entry', () => {
  const saved = config.baseline;
  try {
    config.baseline = join(fresh(), 'baseline.json');
    writeFileSync(config.baseline, JSON.stringify({ counts: { 'app/a.php|raw-control|<button>': 2, 'app/a.php|bespoke-lookalike|plan-card': 1 } }));
    const added = appendToBaseline([
      { file: 'app/a.php', violation: { type: 'bespoke-lookalike', match: 'plan-card' } },
      { file: 'app/b.php', violation: { type: 'hand-copied-component', match: 'kit-btn' } },
    ]);
    assert.equal(added, 2);
    const { counts, total } = loadBaseline();
    assert.deepEqual(counts, { 'app/a.php|bespoke-lookalike|plan-card': 2, 'app/a.php|raw-control|<button>': 2, 'app/b.php|hand-copied-component|kit-btn': 1 });
    assert.equal(total, 5);
    assert.equal(appendToBaseline([]), 0);
    // A baseline that exists but cannot be read is never replaced by a few new entries.
    writeFileSync(config.baseline, '{ not json');
    assert.throws(() => appendToBaseline([{ file: 'app/a.php', violation: { type: 'raw-control', match: '<input>' } }]), /could not be read/);
    assert.equal(readFileSync(config.baseline, 'utf8'), '{ not json');
  } finally {
    config.baseline = saved;
  }
});

test('the text gives the counts, then one line per change, then what to do next', () => {
  const text = formatApplyReview({
    forClaude: [
      { id: 'C-aaaaaa', action: 'swap', file: 'pages/team.php', line: 12, markup: '<span class="status-badge">\n  Live\n</span>', call: "kit_badge('Default', ['variant' => 'default'])", reason: 'The row is too tight' },
      { id: 'C-bbbbbb', action: 'undo', file: 'pages/plans.php', line: 3, markup: '<a class="kit-btn" href="/plans">Open</a>', call: 'kit_button()', reason: 'Clear match; swapped automatically' },
    ],
    applied: ['C-cccccc'],
    closed: ['C-dddddd', 'C-eeeeee'],
    stillThere: [{ id: 'C-ffffff', why: 'its file is not in the project any more' }],
    baselined: 1,
  }, { reviewUrl: 'http://localhost:9999/review' });
  assert.equal(text, [
    '## Applied the design system review',
    '',
    '- **Applied**: 1 (C-cccccc)',
    '- **Closed**: 2 (C-dddddd, C-eeeeee)',
    '- **Into the baseline**: 1 finding',
    '- **Not carried out**: C-ffffff (its file is not in the project any more)',
    '',
    '### For you to change (2)',
    '',
    "- **C-aaaaaa** `pages/team.php:12`: replace `<span class=\"status-badge\"> Live </span>` with a call like `kit_badge('Default', ['variant' => 'default'])`, keeping this markup's own text and links. The agent's reason for its version: The row is too tight",
    '- **C-bbbbbb** `pages/plans.php:3`: undo the automatic swap. Put the original markup back in place of `kit_button()`, so these lines read: `<a class="kit-btn" href="/plans">Open</a>`',
    '',
    AGAIN,
    '',
  ].join('\n'));
  assert.ok(!/[—–]/.test(text));
});

test('the text says when there is nothing to apply', () => {
  const text = formatApplyReview(NOTHING, { reviewUrl: 'http://localhost:9999/review' });
  assert.equal(text, '## Applied the design system review\n\nNo decisions are waiting to be carried out. Rae decides cases on the review page: http://localhost:9999/review\n');
  const done = formatApplyReview({ ...NOTHING, applied: ['C-aaaaaa'] }, {});
  assert.ok(done.endsWith('\nEvery decision is carried out or reported above.\n'), done);
});

test('a backtick in the markup does not break its code span', () => {
  const text = formatApplyReview({ ...NOTHING, forClaude: [{ id: 'C-aaaaaa', action: 'undo', file: 'js/a.js', line: 1, markup: 'el.innerHTML = `<a class="kit-btn">Go</a>`', call: 'kit_button()', reason: '' }] }, {});
  // Markdown drops one space at each end of a code span that has one at both.
  assert.ok(text.includes('read: `` el.innerHTML = `<a class="kit-btn">Go</a>` ``'), text);
});

const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { cwd: HERE, encoding: 'utf8', env: { ...process.env, ...env } });

function gateOffConfig() {
  const off = join(fresh(), 'enforcer.config.json');
  const own = kitConfig();
  writeFileSync(off, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, componentGate: { ...own.componentGate, enabled: false } }));
  return off;
}

test('ds-enforcer apply-review prints the same text', () => {
  const dir = fresh();
  const { rel, abs } = page(row(SPAN));
  const c = keptCase(dir, rel, findingOf(rel, abs, 'bespoke-lookalike'), 'use-component', { chosen: 'kit_badge' });
  const run = cli(['apply-review'], { DS_ENFORCER_STATE_DIR: dir });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith('## Applied the design system review\n'), run.stdout);
  assert.ok(run.stdout.includes(`### For you to change (1)\n\n- **${c.id}** \`${rel}:2\`: replace`), run.stdout);
  assert.ok(run.stdout.includes('\nMake each change, then run ds-enforcer apply-review again to verify and mark it.\n'), run.stdout);
  assert.equal(loadQueue(dir)[0].status, 'open');
});

test('ds-enforcer apply-review refuses arguments and does nothing when the gate is off', () => {
  const dir = fresh();
  const usage = cli(['apply-review', '--all'], { DS_ENFORCER_STATE_DIR: dir });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: ds-enforcer apply-review/);
  const off = cli(['apply-review'], { DS_ENFORCER_STATE_DIR: dir, ENFORCER_CONFIG: gateOffConfig() });
  assert.equal(off.status, 1);
  assert.equal(off.stdout, '');
  assert.match(off.stderr, /component gate is off/);
});

/* The MCP server over stdio: one JSON-RPC message per line each way. Its stderr is kept, for a failure to show. */
async function mcp(env, requests) {
  const server = spawn(process.execPath, [join(HERE, 'index.js')], { cwd: HERE, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let buffered = '';
  let log = '';
  server.stderr.on('data', chunk => { log += chunk; });
  const done = new Promise((resolve, reject) => {
    const fail = why => { clearTimeout(timer); reject(new Error(`${why}\nMCP server stderr:\n${log}`)); };
    const timer = setTimeout(() => fail('the MCP server did not answer in time'), 15000);
    server.stdout.on('data', chunk => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        const message = line.trim() ? JSON.parse(line) : null;
        if (message?.id !== undefined) replies.set(message.id, message);
        if (replies.size === requests.length + 1) { clearTimeout(timer); resolve(); }
      }
    });
    server.on('error', error => fail(error.message));
    // After the answers this is the kill below, and the promise is already settled.
    server.on('exit', code => fail(`the MCP server exited (${code}) before answering`));
  });
  const send = message => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({ id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'apply-test', version: '1' } } });
  send({ method: 'notifications/initialized' });
  requests.forEach((r, i) => send({ id: i + 1, ...r }));
  try { await done; } finally { server.kill(); }
  return { replies: requests.map((_, i) => replies.get(i + 1)), log };
}

function showingLog(log, check) {
  try { check(); } catch (error) {
    error.message += `\nMCP server stderr:\n${log}`;
    throw error;
  }
}

test('the apply_review tool is listed only with the gate on, and answers with the text', async () => {
  const dir = fresh();
  const on = await mcp({ DS_ENFORCER_STATE_DIR: dir }, [
    { method: 'tools/list', params: {} },
    { method: 'tools/call', params: { name: 'apply_review', arguments: {} } },
  ]);
  showingLog(on.log, () => {
    const [listed, called] = on.replies;
    const tool = listed.result.tools.find(t => t.name === 'apply_review');
    assert.ok(tool, 'apply_review is listed');
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
    assert.ok(!/[—–]/.test(tool.description));
    assert.equal(called.result.isError, undefined);
    assert.equal(called.result.content[0].text, formatApplyReview(NOTHING, { reviewUrl: 'http://localhost:9999/review' }));
  });

  const off = await mcp({ DS_ENFORCER_STATE_DIR: dir, ENFORCER_CONFIG: gateOffConfig() }, [
    { method: 'tools/list', params: {} },
    { method: 'tools/call', params: { name: 'apply_review', arguments: {} } },
  ]);
  showingLog(off.log, () => {
    const [listed, refused] = off.replies;
    assert.ok(!listed.result.tools.some(t => t.name === 'apply_review'));
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /component gate is off/);
  });
});
