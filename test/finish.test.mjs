import { kitConfig } from './helpers/kit.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PROJECT_ROOT } from '../config.js';
import { loadEngine } from '../check.mjs';
import { loadBaseline, splitByBaseline } from '../baseline.js';
import { gateSettings } from '../gate/settings.mjs';
import { readSession, updateSession, noteWrite } from '../gate/session.mjs';
import { LOOKALIKE_TYPES } from '../gate/lookalikes.mjs';
import { loadQueue, addCase, updateCase, KIND } from '../gate/queue.mjs';
import { runGate } from '../gate/pretool.mjs';
import { runFinish, runNotice } from '../gate/finish.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(HERE, 'bin/ds-enforcer.mjs');
const SID = 'finish-test';
const STATUS = 'a status label on each team member row';
const OPENING = 'Before finishing, resolve these design-system items in the files you changed:';
const SWITCH = 'Switch these to the component:';
const engine = await loadEngine();
const settings = gateSettings();
const auto = { ...settings, autoSwap: true };

const made = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'ds-finish-')); made.push(dir); return dir; };
after(() => { for (const path of made) rmSync(path, { recursive: true, force: true }); });

/* A page under pages/ (or a stylesheet under css/), which the gate covers and no baseline names; the name is new each run. */
function page(content, ext = 'php') {
  const rel = `${ext === 'css' ? 'css' : 'pages'}/zz-finish-test-${process.pid}-${randomBytes(3).toString('hex')}.${ext}`;
  const abs = join(PROJECT_ROOT, rel);
  writeFileSync(abs, content);
  made.push(abs);
  return { rel, abs };
}

const stop = (extra = {}) => ({ session_id: SID, cwd: PROJECT_ROOT, hook_event_name: 'Stop', stop_hook_active: false, ...extra });
const subagentStop = id => stop({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'oh-my-claudecode:executor' });
const finish = (payload, dir, s = settings) => runFinish(payload, { dir, engine, settings: s });

/* Writes and pieces as the gate hooks record them, for one agent. */
function record(dir, { writes = [], pieces = {}, agent = 'main', files = {} }) {
  updateSession(SID, s => {
    for (const rel of writes) noteWrite(s, agent, rel);
    for (const [id, p] of Object.entries(pieces)) s.pieces[id] = { ...p, agent };
    Object.assign(s.files, files);
  }, dir);
}

const piece = (file, extra = {}, id = 'P-aaaaaa') => ({ [id]: { file, description: STATUS, candidates: ['kit_badge'], nothingFitting: false, ...extra } });
const TEAM = '<ul>\n  <li class="member">Ana</li>\n</ul>\n';
const PASS = { block: false };

test('an unresolved declared piece blocks once', async () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  record(dir, { writes: [rel], pieces: piece(rel) });
  const first = await finish(stop(), dir);
  assert.equal(first.block, true);
  assert.equal(first.reason.split('\n')[0], OPENING);
  assert.ok(first.reason.includes(`\n${rel} piece "${STATUS}": build it with kit_badge() or call record_case with your reason. (piece: P-aaaaaa)`), first.reason);
  assert.deepEqual(readSession(SID, dir).blocked, { main: ['P-aaaaaa'] });
  assert.deepEqual(await finish(stop(), dir), PASS);
});

test('a piece built with its candidate passes', async () => {
  const dir = fresh();
  const { rel } = page("<ul>\n  <li class=\"member\">Ana <?= kit_badge('Live', ['variant' => 'success']) ?></li>\n</ul>\n");
  record(dir, { writes: [rel], pieces: piece(rel) });
  assert.deepEqual(await finish(stop(), dir), PASS);
  assert.deepEqual(readSession(SID, dir).blocked, {});
});

test('a recorded case resolves a piece', async () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  record(dir, { writes: [rel], pieces: piece(rel) });
  addCase({ file: rel, kind: KIND.KEPT, piece: { id: 'P-aaaaaa', description: STATUS }, markup: '<span class="member-state">Live</span>', reason: 'The row needs a dot, not a label' }, dir);
  assert.deepEqual(await finish(stop(), dir), PASS);
});

test('only an open case resolves a piece: one closed or applied in an earlier session does not', async () => {
  const { rel } = page(TEAM);
  for (const [kind, extra] of [[KIND.KEPT, {}], [KIND.NONE, { candidates: [], nothingFitting: true }]]) {
    for (const status of ['closed', 'applied']) {
      const dir = fresh();
      record(dir, { writes: [rel], pieces: piece(rel, extra) });
      const c = addCase({ file: rel, kind, piece: { id: 'P-aaaaaa', description: STATUS }, markup: '<span class="member-state">Live</span>', reason: 'r', session: 'older' }, dir);
      updateCase(c.id, { status }, dir);
      const blocked = await finish(stop(), dir);
      assert.equal(blocked.block, true, `${kind} ${status}`);
      assert.ok(blocked.reason.includes('(piece: P-aaaaaa)'), blocked.reason);
    }
  }
});

test('a case from this session settles its piece whatever Rae decided, so a decided piece never asks again', async () => {
  const { rel } = page(TEAM);
  for (const [kind, extra] of [[KIND.KEPT, {}], [KIND.NONE, { candidates: [], nothingFitting: true }]]) {
    for (const status of ['closed', 'applied']) {
      const dir = fresh();
      record(dir, { writes: [rel], pieces: piece(rel, extra) });
      const c = addCase({ file: rel, kind, piece: { id: 'P-aaaaaa', description: STATUS }, markup: '<span class="member-state">Live</span>', reason: 'r', session: SID }, dir);
      updateCase(c.id, { status }, dir);
      assert.deepEqual(await finish(stop(), dir), PASS, `${kind} ${status}`);
    }
  }
});

test('without a session id only an open case settles a piece, so an unstamped closed case is no answer', async () => {
  const { rel } = page(TEAM);
  const dir = fresh();
  // With no id the hooks share one session file, so its state is recorded under the same missing id.
  updateSession(null, st => {
    noteWrite(st, 'main', rel);
    for (const [id, p] of Object.entries(piece(rel))) st.pieces[id] = { ...p, agent: 'main' };
  }, dir);
  const c = addCase({ file: rel, kind: KIND.KEPT, piece: { id: 'P-aaaaaa', description: STATUS }, markup: '<span class="member-state">Live</span>', reason: 'r', session: null }, dir);
  updateCase(c.id, { status: 'closed' }, dir);
  const blocked = await finish(stop({ session_id: null }), dir);
  assert.equal(blocked.block, true);
  assert.ok(blocked.reason.includes('(piece: P-aaaaaa)'), blocked.reason);
});

test('a nothing-fitting piece is resolved only by a nothing-fitting case', async () => {
  const { rel } = page(TEAM);
  const pieces = piece(rel, { description: 'a dial that shows the energy of the room', candidates: [], nothingFitting: true });
  const kept = fresh();
  record(kept, { writes: [rel], pieces });
  addCase({ file: rel, kind: KIND.KEPT, piece: { id: 'P-aaaaaa' }, markup: '<div class="dial"></div>', reason: 'r' }, kept);
  const blocked = await finish(stop(), kept);
  assert.equal(blocked.block, true);
  assert.ok(blocked.reason.includes(`${rel} piece "a dial that shows the energy of the room": nothing in the inventory fits it, so call record_case with your reason. (piece: P-aaaaaa)`), blocked.reason);
  const none = fresh();
  record(none, { writes: [rel], pieces });
  addCase({ file: rel, kind: KIND.NONE, piece: { id: 'P-aaaaaa' }, markup: '<div class="dial"></div>', reason: 'Nothing draws a dial' }, none);
  assert.deepEqual(await finish(stop(), none), PASS);
});

test('a piece declared for a stylesheet is built by the PHP page the agent wrote', async () => {
  const css = page('.member-state { color: var(--brand-ink); }\n', 'css');
  const built = page("<ul>\n  <li class=\"member\">Ana <?= kit_badge('Live') ?></li>\n</ul>\n");
  const plain = page(TEAM);
  const ok = fresh();
  record(ok, { writes: [css.rel, built.rel], pieces: piece(css.rel) });
  assert.deepEqual(await finish(stop(), ok), PASS);
  const missing = fresh();
  record(missing, { writes: [css.rel, plain.rel], pieces: piece(css.rel) });
  const blocked = await finish(stop(), missing);
  assert.ok(blocked.reason.includes(`${css.rel} piece "${STATUS}": build it with kit_badge() or call record_case with your reason. (piece: P-aaaaaa)`), blocked.reason);
  // Another agent's page does not build this agent's piece.
  const elsewhere = fresh();
  record(elsewhere, { writes: [css.rel], pieces: piece(css.rel) });
  record(elsewhere, { writes: [built.rel], agent: 'a9' });
  assert.equal((await finish(stop(), elsewhere)).block, true);
  const recorded = fresh();
  record(recorded, { writes: [css.rel], pieces: piece(css.rel) });
  addCase({ file: css.rel, kind: KIND.KEPT, piece: { id: 'P-aaaaaa' }, markup: '.member-state {}', reason: 'r' }, recorded);
  assert.deepEqual(await finish(stop(), recorded), PASS);
});

test('baselined debt never blocks', async () => {
  const rel = 'internal/goals.php';
  const abs = join(PROJECT_ROOT, rel);
  const content = readFileSync(abs, 'utf8');
  const debt = engine.validate(content, abs).filter(v => LOOKALIKE_TYPES.includes(v.type));
  assert.ok(debt.some(v => v.match === 'status-badge'), `${rel} has a status-badge finding`);
  assert.deepEqual(splitByBaseline(rel, debt, loadBaseline()).fresh, [], `every lookalike in ${rel} is in the baseline`);
  const dir = fresh();
  const wording = await runGate({ session_id: SID, cwd: PROJECT_ROOT, hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: abs, old_string: '<p>No goals found</p>', new_string: '<p>No goals found yet</p>' } }, { dir, settings });
  assert.deepEqual(wording, { decision: 'allow' });
  assert.deepEqual(readSession(SID, dir).agentWrites, { main: [rel] });
  assert.deepEqual(await finish(stop(), dir), PASS);
  // The same markup at a path no baseline names is new, so it is the baseline that keeps the old page quiet.
  const copy = page(content);
  const control = fresh();
  record(control, { writes: [copy.rel] });
  const blocked = await finish(stop(), control);
  assert.equal(blocked.block, true);
  assert.ok(blocked.reason.includes(`(finding: ${copy.rel}|bespoke-lookalike|status-badge)`), blocked.reason);
});

const BADGE_PAGE = '<div>\n<span class="status-badge">Live</span>\n</div>\n';

test('a new lookalike blocks, an open case suppresses it', async () => {
  const { rel } = page(BADGE_PAGE);
  const key = `${rel}|bespoke-lookalike|status-badge`;
  const dir = fresh();
  record(dir, { writes: [rel] });
  const blocked = await finish(stop(), dir);
  assert.equal(blocked.block, true);
  const line = blocked.reason.split('\n').find(l => l.startsWith(`${rel}:2 `));
  assert.ok(line, blocked.reason);
  assert.ok(line.includes('kit_badge()'), line);
  // Several candidates read as a list ending "or", then ", or call record_case".
  assert.match(line, /: build it with (?:kit_\w+\(\), )*kit_\w+\(\) or kit_\w+\(\), or call record_case with your reason\. \(finding: /);
  assert.ok(!line.includes('one of'), line);
  assert.ok(line.endsWith(`, or call record_case with your reason. (finding: ${key})`), line);
  const suppressed = fresh();
  record(suppressed, { writes: [rel] });
  addCase({ file: rel, kind: KIND.KEPT, finding: key, markup: '<span class="status-badge">Live</span>', reason: 'r' }, suppressed);
  assert.deepEqual(await finish(stop(), suppressed), PASS);
});

test('a case Rae closed or applied does not resolve the same markup written again', async () => {
  const { rel } = page(BADGE_PAGE);
  const key = `${rel}|bespoke-lookalike|status-badge`;
  for (const status of ['applied', 'closed']) {
    const dir = fresh();
    record(dir, { writes: [rel] });
    const c = addCase({ file: rel, kind: KIND.KEPT, finding: key, markup: '<span class="status-badge">Live</span>', reason: 'r' }, dir);
    updateCase(c.id, { status }, dir);
    const blocked = await finish(stop(), dir);
    assert.equal(blocked.block, true, status);
    assert.ok(blocked.reason.includes(`(finding: ${key})`), blocked.reason);
  }
});

const BUTTON_PAGE = [
  '<link rel="stylesheet" href="/ds/tokens.css">',
  '<section>',
  '  <h2>Plan</h2>',
  '  <div>',
  '    <a class="kit-btn" href="/save">Save</a>',
  '  </div>',
  '  <p>Saved plans show here.</p>',
  '</section>',
  '',
].join('\n');
const SWAPPED = BUTTON_PAGE.replace('<a class="kit-btn" href="/save">Save</a>', "<?= kit_button('Save', ['href' => '/save']) ?>");
const AROUND = BUTTON_PAGE.split('\n').slice(2, 7).join('\n');
const buttonLine = rel => `${rel}:5 kit-btn written by hand: build it with kit_button(). (finding: ${rel}|hand-copied-component|kit-btn)`;

test('autoSwap forces a hand-copied button', async () => {
  const dir = fresh();
  const { rel, abs } = page(BUTTON_PAGE);
  const key = `${rel}|hand-copied-component|kit-btn`;
  record(dir, { writes: [rel] });
  const first = await finish(stop(), dir, auto);
  assert.equal(first.block, true);
  const lines = first.reason.split('\n');
  assert.equal(lines[0], OPENING);
  const at = lines.indexOf(SWITCH);
  assert.ok(at > 0, first.reason);
  assert.equal(lines[at + 1], buttonLine(rel));
  const queue = loadQueue(dir);
  assert.equal(queue.length, 1);
  const [c] = queue;
  assert.equal(c.kind, 'swapped-automatically');
  assert.equal(c.chosen, 'kit_button');
  assert.equal(c.finding, key);
  assert.equal(c.file, rel);
  assert.equal(c.line, 5);
  assert.equal(c.markup, AROUND);
  // Undo puts back the finding's own line; the lines around it are only for finding the place.
  assert.equal(c.original, '    <a class="kit-btn" href="/save">Save</a>');
  assert.deepEqual(c.stylesheets, ['ds/tokens.css']);
  assert.equal(c.reason, 'Clear match; swapped automatically');
  assert.equal(c.session, SID);
  assert.equal(c.agent, 'main session');
  assert.equal(c.status, 'open');
  assert.deepEqual(readSession(SID, dir).swaps, { main: [c.id] });
  writeFileSync(abs, SWAPPED);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const [done] = loadQueue(dir);
  assert.equal(done.id, c.id);
  assert.equal(done.status, 'applied');
  assert.equal(done.seen, false);
  assert.equal(done.kind, 'swapped-automatically');
});

test('an automatic swap left undone becomes a kept case', async () => {
  const dir = fresh();
  const { rel } = page(BUTTON_PAGE);
  record(dir, { writes: [rel], agent: 'a1' });
  assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
  assert.deepEqual(await finish(subagentStop('a1'), dir, auto), PASS);
  const [c] = loadQueue(dir);
  assert.equal(c.kind, 'kept');
  assert.equal(c.status, 'open');
  assert.equal(c.reason, 'Did not switch after an automatic swap was required');
  assert.equal(c.agent, 'oh-my-claudecode:executor');
});

test('Undo pressed before the agent switched leaves a kept case waiting for Rae', async () => {
  const dir = fresh();
  const { rel } = page(BUTTON_PAGE);
  record(dir, { writes: [rel] });
  assert.equal((await finish(stop(), dir, auto)).block, true);
  const [swap] = loadQueue(dir);
  updateCase(swap.id, { decision: 'undo' }, dir);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const [c] = loadQueue(dir);
  assert.equal(c.kind, KIND.KEPT);
  assert.equal(c.status, 'open');
  assert.equal(c.decision, 'pending');
});

test('autoSwap converts a kept case for a clear match and keeps its reason', async () => {
  const dir = fresh();
  const { rel } = page(BUTTON_PAGE);
  const key = `${rel}|hand-copied-component|kit-btn`;
  record(dir, { writes: [rel] });
  const kept = addCase({ file: rel, kind: KIND.KEPT, finding: key, markup: '<a class="kit-btn" href="/save">Save</a>', reason: 'It is a link', session: 'older' }, dir);
  const first = await finish(stop(), dir, auto);
  assert.equal(first.block, true);
  assert.ok(first.reason.includes(`${SWITCH}\n${buttonLine(rel)}`), first.reason);
  const queue = loadQueue(dir);
  assert.equal(queue.length, 1);
  const [c] = queue;
  assert.equal(c.id, kept.id);
  assert.equal(c.kind, KIND.AUTO);
  assert.equal(c.chosen, 'kit_button');
  assert.equal(c.reason, 'It is a link');
  assert.equal(c.note, 'Clear match; swapped automatically');
  assert.equal(c.markup, AROUND);
  assert.equal(c.original, '    <a class="kit-btn" href="/save">Save</a>');
  assert.equal(c.sample, '<a class="kit-btn" href="/save">Save</a>');
  assert.deepEqual(c.stylesheets, ['ds/tokens.css']);
  assert.equal(c.session, SID);
  // Left undone, it goes back to the queue with the agent's reason still on it.
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const [undone] = loadQueue(dir);
  assert.equal(undone.kind, KIND.KEPT);
  assert.equal(undone.reason, 'It is a link');
  assert.equal(undone.note, 'Did not switch after an automatic swap was required');
});

test('autoSwap never forces a bespoke lookalike, even with a clear winner', async () => {
  const dir = fresh();
  const { rel } = page('<div>\n<dialog class="share-modal">Share</dialog>\n</div>\n');
  record(dir, { writes: [rel] });
  const first = await finish(stop(), dir, auto);
  assert.equal(first.block, true);
  assert.ok(!first.reason.includes(SWITCH), first.reason);
  assert.ok(first.reason.includes(`${rel}:2 hand-built modal (share-modal): build it with kit_modal(), `), first.reason);
  assert.ok(first.reason.includes(`, or call record_case with your reason. (finding: ${rel}|bespoke-lookalike|share-modal)`), first.reason);
  assert.deepEqual(loadQueue(dir), []);
});

test('autoSwap leaves an unclear match in the queue', async () => {
  const { rel } = page(BADGE_PAGE);
  const key = `${rel}|bespoke-lookalike|status-badge`;
  // Without a case it is an ordinary item, not a forced swap.
  const bare = fresh();
  record(bare, { writes: [rel] });
  const blocked = await finish(stop(), bare, auto);
  assert.ok(blocked.reason.includes(`(finding: ${key})`), blocked.reason);
  assert.ok(!blocked.reason.includes(SWITCH), blocked.reason);
  assert.deepEqual(loadQueue(bare), []);
  const dir = fresh();
  record(dir, { writes: [rel] });
  addCase({ file: rel, kind: KIND.KEPT, finding: key, markup: '<span class="status-badge">Live</span>', reason: 'A plain label reads better here' }, dir);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const queue = loadQueue(dir);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, 'kept');
  assert.equal(queue[0].reason, 'A plain label reads better here');
});

test('autoSwap never forces a swap in an unconsulted file or one holding a nothing-fitting case', async () => {
  const { rel } = page(BUTTON_PAGE);
  const ordinary = `${rel}:5 kit-btn written by hand: build it with kit_button() or call record_case with your reason. (finding: ${rel}|hand-copied-component|kit-btn)`;
  const unconsulted = fresh();
  record(unconsulted, { writes: [rel], files: { [rel]: { consulted: false, refusals: 2, unconsulted: true } } });
  const first = await finish(stop(), unconsulted, auto);
  assert.ok(first.reason.split('\n').includes(ordinary), first.reason);
  assert.ok(!first.reason.includes(SWITCH), first.reason);
  assert.deepEqual(loadQueue(unconsulted), []);
  const nothing = fresh();
  record(nothing, { writes: [rel] });
  addCase({ file: rel, kind: KIND.NONE, piece: { id: 'P-bbbbbb', description: 'a plan timeline' }, markup: '<ol class="timeline"></ol>', reason: 'No timeline component' }, nothing);
  const second = await finish(stop(), nothing, auto);
  assert.ok(second.reason.split('\n').includes(ordinary), second.reason);
  assert.ok(!second.reason.includes(SWITCH), second.reason);
  assert.equal(loadQueue(nothing).length, 1);
});

test('a later turn blocks again for a new item, never for one it was already blocked on', async () => {
  const dir = fresh();
  const first = page(BADGE_PAGE);
  const firstKey = `${first.rel}|bespoke-lookalike|status-badge`;
  record(dir, { writes: [first.rel] });
  assert.equal((await finish(stop(), dir)).block, true);
  // Stop fires at the end of every main-session turn: the next turn changes nothing new.
  assert.deepEqual(await finish(stop(), dir), PASS);
  const second = page('<div>\n<div class="zzother-card">x</div>\n</div>\n');
  const secondKey = `${second.rel}|bespoke-lookalike|zzother-card`;
  record(dir, { writes: [second.rel] });
  const two = await finish(stop(), dir);
  assert.equal(two.block, true);
  assert.ok(two.reason.includes(`(finding: ${secondKey})`), two.reason);
  assert.ok(!two.reason.includes(firstKey), `an item already blocked on is not listed again: ${two.reason}`);
  assert.deepEqual(await finish(stop(), dir), PASS);
  assert.deepEqual(readSession(SID, dir).blocked, { main: [firstKey, secondKey] });
});

test('an automatic swap asked for in a later turn is settled at the finish after it', async () => {
  const dir = fresh();
  const badge = page(BADGE_PAGE);
  record(dir, { writes: [badge.rel] });
  assert.equal((await finish(stop(), dir, auto)).block, true);
  const { rel, abs } = page(BUTTON_PAGE);
  record(dir, { writes: [rel] });
  const two = await finish(stop(), dir, auto);
  assert.equal(two.block, true);
  assert.ok(two.reason.includes(`${SWITCH}\n${buttonLine(rel)}`), two.reason);
  writeFileSync(abs, SWAPPED);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const [swap] = loadQueue(dir);
  assert.equal(swap.kind, KIND.AUTO);
  assert.equal(swap.status, 'applied');
  assert.deepEqual(readSession(SID, dir).swaps, {});
});

const LEFT = 'A subagent stopped before resolving these, in files it changed. Resolve them for it:';

test('the main session takes on what a subagent was blocked on and left, once', async () => {
  const dir = fresh();
  const team = page(TEAM);
  const button = page(BUTTON_PAGE);
  const key = `${button.rel}|hand-copied-component|kit-btn`;
  record(dir, { writes: [team.rel, button.rel], pieces: piece(team.rel), agent: 'a1' });
  // The subagent is blocked, and in this app it hands back before it can act on the block.
  const theirs = await finish(subagentStop('a1'), dir, auto);
  assert.equal(theirs.block, true);
  const [owed] = loadQueue(dir);
  assert.equal(owed.kind, KIND.AUTO);
  const taken = await finish(stop(), dir, auto);
  assert.equal(taken.block, true);
  const lines = taken.reason.split('\n');
  assert.equal(lines[0], LEFT, taken.reason);
  assert.ok(lines.includes(`${team.rel} piece "${STATUS}": build it with kit_badge() or call record_case with your reason. (piece: P-aaaaaa)`), taken.reason);
  assert.equal(lines[lines.indexOf(SWITCH) + 1], buttonLine(button.rel), taken.reason);
  assert.ok(!lines.includes(OPENING), taken.reason);
  const s = readSession(SID, dir);
  assert.deepEqual(s.blocked.main.sort(), ['P-aaaaaa', key].sort());
  assert.deepEqual(s.swaps, { main: [owed.id] });
  // Once taken on, the same items never block the main session again.
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  assert.equal(loadQueue(dir)[0].kind, KIND.KEPT, 'a swap the main session was asked for and left is settled as kept');
});

test('a swap the main session makes for a subagent is settled at its next finish', async () => {
  const dir = fresh();
  const button = page(BUTTON_PAGE);
  record(dir, { writes: [button.rel], agent: 'a1' });
  assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
  assert.equal((await finish(stop(), dir, auto)).block, true);
  writeFileSync(button.abs, SWAPPED);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const [done] = loadQueue(dir);
  assert.equal(done.status, 'applied');
  assert.equal(done.seen, false);
});

test('the main session takes on nothing a subagent resolved, and holds its own items first', async () => {
  const dir = fresh();
  const theirs = page(BUTTON_PAGE);
  const mine = page(TEAM);
  record(dir, { writes: [theirs.rel], agent: 'a1' });
  record(dir, { writes: [mine.rel], pieces: piece(mine.rel) });
  assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
  writeFileSync(theirs.abs, SWAPPED);
  // Where the subagent did get its turn and switched, its own next finish settles the swap.
  assert.deepEqual(await finish(subagentStop('a1'), dir, auto), PASS);
  const own = await finish(stop(), dir, auto);
  assert.equal(own.block, true);
  assert.equal(own.reason.split('\n')[0], OPENING);
  assert.ok(!own.reason.includes(LEFT) && !own.reason.includes(theirs.rel), own.reason);
  assert.equal(loadQueue(dir)[0].status, 'applied');
});

test('a swap a subagent owed in a file the main session also wrote is asked of the main session', async () => {
  const dir = fresh();
  const button = page(BUTTON_PAGE);
  record(dir, { writes: [button.rel], agent: 'a1' });
  record(dir, { writes: [button.rel] });
  assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
  const [owed] = loadQueue(dir);
  const taken = await finish(stop(), dir, auto);
  assert.equal(taken.block, true);
  const lines = taken.reason.split('\n');
  assert.equal(lines[0], OPENING, taken.reason);
  assert.equal(lines[lines.indexOf(SWITCH) + 1], buttonLine(button.rel), taken.reason);
  assert.deepEqual(readSession(SID, dir).swaps, { main: [owed.id] });
  assert.equal(loadQueue(dir)[0].kind, KIND.AUTO);
});

test('a swap a subagent owed and someone since made is settled at the main session\'s Stop without a block', async () => {
  const dir = fresh();
  const button = page(BUTTON_PAGE);
  record(dir, { writes: [button.rel], agent: 'a1' });
  assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
  writeFileSync(button.abs, SWAPPED);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const [done] = loadQueue(dir);
  assert.equal(done.status, 'applied');
  assert.equal(done.seen, false);
  assert.deepEqual(readSession(SID, dir).swaps, {});
});

test('a swap a subagent already settled as kept is left to Rae, with his decision', async () => {
  const dir = fresh();
  const button = page(BUTTON_PAGE);
  record(dir, { writes: [button.rel], agent: 'a1' });
  // Where the subagent did get its turn and did not switch, its own finish made the swap a kept case.
  assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
  assert.deepEqual(await finish(subagentStop('a1'), dir, auto), PASS);
  const [kept] = loadQueue(dir);
  assert.equal(kept.kind, KIND.KEPT);
  updateCase(kept.id, { decision: 'keep' }, dir);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  const [after] = loadQueue(dir);
  assert.equal(after.kind, KIND.KEPT);
  assert.equal(after.decision, 'keep');
});

test('an owed swap Rae undid, or one with no component named, is settled as kept, never handed on', async () => {
  for (const change of [{ decision: 'undo' }, { chosen: null }]) {
    const dir = fresh();
    const button = page(BUTTON_PAGE);
    record(dir, { writes: [button.rel], agent: 'a1' });
    assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
    const [owed] = loadQueue(dir);
    updateCase(owed.id, change, dir);
    assert.deepEqual(await finish(stop(), dir, auto), PASS, JSON.stringify(change));
    const [after] = loadQueue(dir);
    assert.equal(after.kind, KIND.KEPT, JSON.stringify(change));
    assert.equal(after.decision, 'pending');
    assert.deepEqual(readSession(SID, dir).swaps, {});
  }
});

test('the main session takes nothing on from a subagent that is still running', async () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  record(dir, { writes: [rel], pieces: piece(rel), agent: 'a1' });
  assert.equal((await finish(subagentStop('a1'), dir)).block, true);
  const running = [{ id: 'a1', type: 'subagent', status: 'running', agent_type: 'general-purpose' }];
  assert.deepEqual(await finish(stop({ background_tasks: running }), dir), PASS);
  assert.equal(readSession(SID, dir).blocked.main, undefined);
  const done = [{ id: 'a1', type: 'subagent', status: 'completed' }];
  assert.equal((await finish(stop({ background_tasks: done }), dir)).block, true);
});

/* A tool call the main session (or, with agent_id, a subagent) just made. */
const toolUse = (extra = {}) => ({ session_id: SID, cwd: PROJECT_ROOT, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, ...extra });
const notice = (payload, dir, s = settings) => runNotice(payload, { dir, engine, settings: s });

test('the main session is told what a subagent left at its next tool call, once, and its Stop still holds it once', async () => {
  const dir = fresh();
  const team = page(TEAM);
  const button = page(BUTTON_PAGE);
  record(dir, { writes: [team.rel, button.rel], pieces: piece(team.rel), agent: 'a1' });
  assert.equal(await notice(toolUse(), dir, auto), null, 'nothing to tell before the subagent stops');
  assert.equal((await finish(subagentStop('a1'), dir, auto)).block, true);
  const [owed] = loadQueue(dir);
  // The subagent's own calls, and another subagent's, are never told.
  assert.equal(await notice(toolUse({ agent_id: 'a1', agent_type: 'general-purpose' }), dir, auto), null);
  assert.equal(await notice(toolUse({ agent_id: 'a2', agent_type: 'general-purpose' }), dir, auto), null);
  const told = await notice(toolUse(), dir, auto);
  const lines = told.split('\n');
  assert.equal(lines[0], LEFT, told);
  assert.ok(lines.includes(`${team.rel} piece "${STATUS}": build it with kit_badge() or call record_case with your reason. (piece: P-aaaaaa)`), told);
  assert.equal(lines[lines.indexOf(SWITCH) + 1], buttonLine(button.rel), told);
  // Telling records only that it told: no case moves, nothing is blocked, and it is said once.
  const s = readSession(SID, dir);
  assert.deepEqual(s.swaps, { a1: [owed.id] });
  assert.equal(s.blocked.main, undefined);
  assert.equal(loadQueue(dir).length, 1);
  assert.equal(await notice(toolUse(), dir, auto), null);
  // The Stop stays the backstop for what the main session was told and left.
  assert.equal((await finish(stop(), dir, auto)).block, true);
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
});

test('nothing is told about an item the main session settled before its next tool call', async () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  record(dir, { writes: [rel], pieces: piece(rel), agent: 'a1' });
  assert.equal((await finish(subagentStop('a1'), dir)).block, true);
  writeFileSync(abs, "<ul>\n  <li class=\"member\">Ana <?= kit_badge('Live') ?></li>\n</ul>\n");
  assert.equal(await notice(toolUse(), dir), null);
  assert.deepEqual(await finish(stop(), dir), PASS);
});

test('a subagent never takes on another agent\'s items', async () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  record(dir, { writes: [rel], pieces: piece(rel), agent: 'a1' });
  assert.equal((await finish(subagentStop('a1'), dir)).block, true);
  assert.deepEqual(await finish(subagentStop('a2'), dir), PASS);
});

test('JavaScript never blocks', async () => {
  const dir = fresh();
  const { rel } = page('const actions = `<a class="kit-btn" href="/save">Save</a><span class="status-badge">Live</span>`;\n', 'js');
  record(dir, { writes: [rel], pieces: piece(rel) });
  assert.deepEqual(await finish(stop(), dir, auto), PASS);
  assert.deepEqual(loadQueue(dir), []);
});

test('separate agents are blocked separately, each on its own items', async () => {
  const dir = fresh();
  const mine = page(TEAM);
  const theirs = page(BADGE_PAGE);
  record(dir, { writes: [mine.rel], pieces: piece(mine.rel), agent: 'a1' });
  record(dir, { writes: [theirs.rel], pieces: piece(theirs.rel, {}, 'P-cccccc'), agent: 'a2' });
  const one = await finish(subagentStop('a1'), dir);
  assert.equal(one.block, true);
  assert.ok(one.reason.includes('(piece: P-aaaaaa)'), one.reason);
  assert.ok(!one.reason.includes(theirs.rel), one.reason);
  assert.deepEqual(await finish(subagentStop('a1'), dir), PASS);
  const two = await finish(subagentStop('a2'), dir);
  assert.equal(two.block, true);
  assert.ok(two.reason.includes('(piece: P-cccccc)') && two.reason.includes(`(finding: ${theirs.rel}|bespoke-lookalike|status-badge)`), two.reason);
  assert.ok(!two.reason.includes(mine.rel), two.reason);
  assert.deepEqual(await finish(subagentStop('a2'), dir), PASS);
  assert.deepEqual(readSession(SID, dir).blocked, { a1: ['P-aaaaaa'], a2: ['P-cccccc', `${theirs.rel}|bespoke-lookalike|status-badge`] });
});

test('an agent that wrote nothing is not blocked on the work of others', async () => {
  const dir = fresh();
  const { rel } = page(BADGE_PAGE);
  record(dir, { writes: [rel], pieces: piece(rel), agent: 'a1' });
  assert.deepEqual(await finish(subagentStop('a2'), dir), PASS);
  assert.deepEqual(await finish(stop(), dir), PASS);
  assert.deepEqual(readSession(SID, dir).blocked, {});
  assert.equal((await finish(subagentStop('a1'), dir)).block, true);
});

test('a write or piece with no agent belongs to the main session', async () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  updateSession(SID, s => { s.writes.push(rel); s.pieces['P-aaaaaa'] = { file: rel, description: STATUS, candidates: ['kit_badge'], nothingFitting: false }; }, dir);
  assert.deepEqual(await finish(subagentStop('a1'), dir), PASS);
  assert.ok((await finish(stop(), dir)).reason.includes('(piece: P-aaaaaa)'));
});

test('a file the session wrote and then deleted is not checked', async () => {
  const dir = fresh();
  const gone = `pages/zz-finish-test-${process.pid}-gone.php`;
  record(dir, { writes: [gone], pieces: piece(gone) });
  assert.deepEqual(await finish(stop(), dir), PASS);
});

const cli = (payload, dir, env = {}) => spawnSync(process.execPath, [CLI, 'finish'], {
  cwd: PROJECT_ROOT,
  encoding: 'utf8',
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_ROOT, DS_ENFORCER_STATE_DIR: dir, ...env },
});

test('ds-enforcer finish prints the block once and always exits 0', () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  record(dir, { writes: [rel], pieces: piece(rel) });
  const first = cli(stop(), dir);
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(out), ['decision', 'reason']);
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.startsWith(`${OPENING}\n`), out.reason);
  // The shell command it gives names the enforcer by its full path, so it runs from any folder.
  assert.ok(out.reason.includes(`run: node ${CLI} record-case --json`), out.reason);
  const second = cli(stop(), dir);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '');
  for (const garbage of ['not json', '[]', '']) {
    const run = cli(garbage, dir);
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
  }
});

test('ds-enforcer finish says nothing when the gate is off', () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  record(dir, { writes: [rel], pieces: piece(rel) });
  const own = kitConfig();
  const off = join(dir, 'enforcer.config.json');
  writeFileSync(off, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, componentGate: { ...own.componentGate, enabled: false } }));
  const run = cli(stop(), dir, { ENFORCER_CONFIG: off });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.deepEqual(readSession(SID, dir).blocked, {});
});

test('the finish check stays under 500 ms', () => {
  const dir = fresh();
  // A long page: 1500 rows of markup and PHP, with bespoke badges for the check to find.
  const rows = Array.from({ length: 1500 }, (_, i) => (i % 50 === 7 ? `<span class="row-badge">${i}</span>` : i % 3 ? `<div class="row row-${i}"><span class="cell">${i}</span></div>` : `<?php echo kit_badge((string) ${i}); ?>`));
  const { rel } = page(`${rows.join('\n')}\n`);
  record(dir, { writes: [rel] });
  const started = Date.now();
  const run = cli(stop(), dir);
  const took = Date.now() - started;
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).decision, 'block');
  assert.ok(took < 500, `took ${took} ms`);
});
