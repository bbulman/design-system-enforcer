import { ROOT, kitConfig } from './helpers/kit.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summaryLines } from '../hook.mjs';
import { KIND } from '../gate/queue.mjs';
import { gateSettings } from '../gate/settings.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(HERE, 'bin/ds-enforcer.mjs');
const PROJECT = ROOT;
const REVIEW = gateSettings().reviewUrl;
const LINK = `Review page: ${REVIEW}`;

const made = [];
const fresh = prefix => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };
after(() => { for (const path of made) rmSync(path, { recursive: true, force: true }); });

let caseCount = 0;
/* A case as the queue stores it: open, undecided, kept, from session s1 unless told otherwise. */
const makeCase = (fields = {}) => {
  caseCount++;
  return {
    id: `C-${String(caseCount).padStart(6, '0')}`,
    created: new Date(2026, 9, 28, 9, caseCount).toISOString(),
    session: 's1',
    agent: 'main session',
    file: 'pages/team.php',
    line: 10,
    kind: KIND.KEPT,
    chosen: null,
    decision: 'pending',
    status: 'open',
    seen: false,
    ...fields,
  };
};
const lines = (queue, extra = {}) => summaryLines({ queue, session: 's1', suggestionsAdded: [], reviewUrl: REVIEW, ...extra });

test('names each automatic change, not just a count', () => {
  const queue = [
    makeCase({ kind: KIND.AUTO, status: 'applied', file: 'pages/team.php', line: 42, chosen: 'kit_button' }),
    makeCase({ kind: KIND.AUTO, status: 'applied', file: 'pages/home.php', line: 7, chosen: 'kit_badge' }),
    // Another session's swap, and one the agent was told to make but has not made yet.
    makeCase({ kind: KIND.AUTO, status: 'applied', session: 's2', file: 'pages/other.php', line: 3, chosen: 'kit_alert' }),
    makeCase({ kind: KIND.AUTO, status: 'open', file: 'pages/team.php', line: 50, chosen: 'kit_button' }),
  ];
  assert.deepEqual(lines(queue), [
    '2 changes made automatically:',
    '  pages/team.php:42 → kit_button()',
    '  pages/home.php:7 → kit_badge()',
    LINK,
  ]);
});

test('says nothing when there is nothing', () => {
  assert.deepEqual(lines([]), []);
  const decided = [makeCase({ decision: 'use-component' }), makeCase({ status: 'closed', decision: 'keep' }), makeCase({ status: 'applied', decision: 'use-component' })];
  assert.deepEqual(lines(decided), [], 'a decided or settled case is not waiting');
});

test('announces a suggestion once', () => {
  const announced = new Set(['S-000001']);
  const args = { suggestionsAdded: ['S-0a0a0a', 'S-000001', 'S-0a0a0a'], announced };
  assert.deepEqual(lines([], args), ['1 new component suggested', LINK]);
  assert.deepEqual([...announced].sort(), ['S-000001', 'S-0a0a0a']);
  assert.deepEqual(lines([], args), []);
});

test('counts the cases waiting for review the way the review page does', () => {
  const queue = [
    makeCase(),
    makeCase({ decision: 'later', session: 's2' }),
    makeCase({ kind: KIND.NONE }),
    makeCase({ kind: KIND.UNCONSULTED }),
    makeCase({ decision: 'use-component' }),
    makeCase({ status: 'closed', decision: 'fine' }),
    // An automatic swap belongs on the Changed automatically list, never in Waiting for you.
    makeCase({ kind: KIND.AUTO, chosen: 'kit_button' }),
  ];
  assert.deepEqual(lines(queue), ['4 cases waiting for review', LINK]);
  assert.deepEqual(lines([makeCase()]), ['1 case waiting for review', LINK]);
});

test('gives the lines in order, then the review page', () => {
  const queue = [makeCase(), makeCase({ kind: KIND.AUTO, status: 'applied', line: 4, chosen: 'kit_button' })];
  assert.deepEqual(lines(queue, { suggestionsAdded: ['S-0a0a0a', 'S-0b0b0b'] }), [
    '1 case waiting for review',
    '1 change made automatically:',
    '  pages/team.php:4 → kit_button()',
    '2 new components suggested',
    LINK,
  ]);
});

/* A throwaway git checkout and a config whose projectRoot is it, so the report and the scan stay out of the real project. */
function project(files) {
  const root = fresh('ds-summary-repo-');
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

function configFor(root, gate = {}) {
  const own = kitConfig();
  for (const key of ['tokensCss', 'catalog', 'synonyms', 'nativeManifest', 'searchModule', 'baseline']) {
    if (typeof own[key] === 'string') own[key] = join(PROJECT, own[key]);
  }
  own.projectRoot = root;
  Object.assign(own.componentGate, gate);
  const path = join(fresh('ds-summary-config-'), 'enforcer.config.json');
  writeFileSync(path, JSON.stringify(own));
  return path;
}

const guide = n => `<style>.dl-card { padding: 1rem; }</style>
<div class="dl-card">
  <h3>Guide ${n}</h3>
  <a href="/guide-${n}.pdf">Download</a>
</div>
`;
// page.css breaks a house rule, for the existing report; guides/ repeats one bespoke card, for a suggestion.
const plain = project({ 'page.css': '.note { color: #000; }\n' });
const guides = project({ 'guides/a.php': guide(1), 'guides/b.php': guide(2), 'guides/c.php': guide(3) });
const plainConfig = configFor(plain);
const guidesConfig = configFor(guides);


/* The hook's own background refresh is left out unless a test asks for it: these tests write suggestions.json as a refresh would. */
function stopHook(root, config, dir, payload = {}, extraEnv = { DS_ENFORCER_REFRESH: 'off' }) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, ENFORCER_CONFIG: config, DS_ENFORCER_STATE_DIR: dir, ...extraEnv };
  delete env.ENFORCER_PROJECT_ROOT;
  if (!extraEnv.DS_ENFORCER_REFRESH) delete env.DS_ENFORCER_REFRESH;
  return spawnSync(process.execPath, [CLI, 'stop-hook'], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'summary-test', cwd: root, hook_event_name: 'Stop', stop_hook_active: false, ...payload }),
    env,
  });
}

/* The systemMessage's lines, or none when the hook printed nothing; the hook always exits 0. */
function said(run) {
  assert.equal(run.status, 0, run.stderr);
  if (!run.stdout) return [];
  const out = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  const lines = out.systemMessage.split('\n');
  // The report's rule messages are the project's own text; the gate's lines follow its last line.
  assert.doesNotMatch(lines.slice(lines.findIndex(l => l.startsWith('Open ')) + 1).join('\n'), /[—–]/);
  return lines;
}

const writeQueue = (dir, cases) => writeFileSync(join(dir, 'review.json'), JSON.stringify({ cases }));
const editedThisSession = (root, session, files) => {
  mkdirSync(join(root, '.ds-enforcer'), { recursive: true });
  writeFileSync(join(root, '.ds-enforcer/session.json'), JSON.stringify({ session, files, shown: null }));
};
const entry = (id, name = `${id.toLowerCase()}-card`) => ({ id, name, word: 'card', count: 3, files: ['guides/a.php'], examples: [], closest: [], sources: ['scan'], first: '2026-10-28T09:00:00.000Z' });
const readStored = path => JSON.parse(readFileSync(path, 'utf8'));

test('the Stop hook gives the summary, then again only when it changes', () => {
  const dir = fresh('ds-summary-state-');
  const run = payload => said(stopHook(plain, plainConfig, dir, { session_id: 'summary-a', ...payload }));
  writeQueue(dir, [makeCase({ session: 'summary-a' })]);
  assert.deepEqual(run(), ['1 case waiting for review', LINK]);
  assert.deepEqual(run(), [], 'unchanged since it last spoke');
  writeQueue(dir, [makeCase(), makeCase({ kind: KIND.AUTO, status: 'applied', session: 'summary-a', line: 4, chosen: 'kit_button' })]);
  // Another Stop hook holding Claude (stop_hook_active) does not hold the gate's lines back.
  assert.deepEqual(run({ stop_hook_active: true }), ['1 case waiting for review', '1 change made automatically:', '  pages/team.php:4 → kit_button()', LINK]);
  assert.deepEqual(run(), []);
  assert.deepEqual(run({ session_id: 'summary-b' }), ['1 case waiting for review', LINK], 'a new session hears it once');
  writeQueue(dir, []);
  assert.deepEqual(run(), []);
});

test('the summary follows the existing report, and stands alone when the report has nothing new', () => {
  const dir = fresh('ds-summary-state-');
  const sid = 'summary-report';
  editedThisSession(plain, sid, ['page.css']);
  writeQueue(dir, [makeCase()]);
  const run = () => said(stopHook(plain, plainConfig, dir, { session_id: sid }));
  const first = run();
  assert.match(first[0], /^Design system report: \d+ violations? in 1 file edited this session/);
  assert.ok(first.some(l => l.startsWith('Open design-system-report.md')), first.join('\n'));
  assert.deepEqual(first.slice(-2), ['1 case waiting for review', LINK]);
  assert.deepEqual(run(), [], 'the report keeps its digest check');
  writeQueue(dir, [makeCase(), makeCase()]);
  assert.deepEqual(run(), ['2 cases waiting for review', LINK]);
});

test('the Stop hook announces what an earlier refresh listed, once, and leaves the rest of suggestions.json as it was', () => {
  const dir = fresh('ds-summary-state-');
  const path = join(dir, 'suggestions.json');
  const stored = {
    lastScan: '2026-10-28T09:00:00.000Z',
    entries: [entry('S-0c0c0c'), entry('S-0d0d0d', 'dl-card')],
    dismissed: ['S-0a0a0a'],
    build: ['S-0b0b0b'],
    announced: ['S-0c0c0c'],
    note: 'kept',
  };
  writeFileSync(path, JSON.stringify(stored));
  assert.deepEqual(said(stopHook(guides, guidesConfig, dir)), ['1 new component suggested', LINK]);
  assert.deepEqual(readStored(path), { ...stored, announced: ['S-0c0c0c', 'S-0d0d0d'] });
  assert.deepEqual(said(stopHook(guides, guidesConfig, dir)), [], 'announced once');
  assert.deepEqual(readStored(path).announced, ['S-0c0c0c', 'S-0d0d0d']);
});

test('a first run takes the list it finds as announced, and announces only what comes after', () => {
  for (const announced of [undefined, []]) {
    const dir = fresh('ds-summary-state-');
    const path = join(dir, 'suggestions.json');
    const seeded = Array.from({ length: 54 }, (_, i) => entry(`S-${String(i).padStart(6, '0')}`));
    writeFileSync(path, JSON.stringify({ entries: seeded, dismissed: [], build: [], ...(announced ? { announced } : {}) }));
    assert.deepEqual(said(stopHook(guides, guidesConfig, dir)), [], 'nothing said about the 54 already listed');
    const after = readStored(path);
    assert.deepEqual(after.announced, seeded.map(e => e.id));
    writeFileSync(path, JSON.stringify({ ...after, entries: [...seeded, entry('S-0e0e0e')] }));
    assert.deepEqual(said(stopHook(guides, guidesConfig, dir)), ['1 new component suggested', LINK]);
    assert.ok(readStored(path).announced.includes('S-0e0e0e'));
  }
});

test('an entry under the page bar is not announced until it clears it, even when the first run found only those', () => {
  const dir = fresh('ds-summary-state-');
  const path = join(dir, 'suggestions.json');
  const thin = { ...entry('S-0f0f0f', 'dl-card'), pages: 1 };
  writeFileSync(path, JSON.stringify({ minPages: 3, entries: [thin], dismissed: [], build: [] }));
  assert.deepEqual(said(stopHook(guides, guidesConfig, dir)), [], 'one page: nothing to say');
  assert.deepEqual(readStored(path).announced, []);
  writeFileSync(path, JSON.stringify({ ...readStored(path), entries: [{ ...thin, pages: 3 }] }));
  assert.deepEqual(said(stopHook(guides, guidesConfig, dir)), ['1 new component suggested', LINK]);
  assert.deepEqual(readStored(path).announced, ['S-0f0f0f']);
});

test('the Stop hook fails open on state it cannot read', () => {
  const dir = fresh('ds-summary-state-');
  const path = join(dir, 'suggestions.json');
  const broken = '{"dismissed": ["S-0a0a0a"], ';
  writeFileSync(path, broken);
  writeQueue(dir, [makeCase()]);
  const sid = 'summary-open';
  editedThisSession(plain, sid, ['page.css']);
  const run = stopHook(plain, plainConfig, dir, { session_id: sid });
  const out = said(run);
  assert.match(out[0], /^Design system report: /, 'the report still shows');
  assert.deepEqual(out.slice(-2), ['1 case waiting for review', LINK]);
  assert.match(run.stderr, /could not be read, so it was left as it is/);
  assert.equal(readFileSync(path, 'utf8'), broken);

  const other = fresh('ds-summary-state-');
  writeFileSync(join(other, 'review.json'), 'not json');
  assert.deepEqual(said(stopHook(plain, plainConfig, other, { session_id: 'summary-open-2' })), []);
});

test('the Stop hook adds nothing when the gate is off', () => {
  const dir = fresh('ds-summary-state-');
  writeQueue(dir, [makeCase({ session: 'summary-test' }), makeCase({ kind: KIND.AUTO, status: 'applied', session: 'summary-test', chosen: 'kit_button' })]);
  writeFileSync(join(dir, 'suggestions.json'), JSON.stringify({ entries: [entry('S-0f0f0f')], announced: ['S-000000'] }));
  const run = stopHook(guides, configFor(guides, { enabled: false }), dir, {}, {});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.deepEqual(readStored(join(dir, 'suggestions.json')).announced, ['S-000000']);
});

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(done, ms = 20000) {
  for (const until = Date.now() + ms; Date.now() < until; pause(50)) if (done()) return true;
  return false;
}

test('the Stop hook refreshes the suggestions in the background, without waiting for it', () => {
  // A git that takes two seconds: if the hook waited for the scan, suggestions.json would be there when it returned.
  const bin = fresh('ds-summary-bin-');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 2\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const dir = fresh('ds-summary-state-');
  const path = join(dir, 'suggestions.json');
  const run = stopHook(guides, guidesConfig, dir, {}, { PATH: `${bin}:${process.env.PATH}` });
  assert.deepEqual(said(run), []);
  assert.throws(() => readFileSync(path), { code: 'ENOENT' }, 'the hook returned before the refresh finished');
  const finished = () => {
    try { return typeof readStored(path).lastScan === 'string' && !existsSync(join(dir, 'suggestions.lock')); } catch { return false; }
  };
  assert.ok(waitFor(finished), 'the background refresh wrote suggestions.json');
  const { entries } = readStored(path);
  assert.ok(entries.length && entries.every(e => e.files.every(f => f.startsWith('guides/'))), `it scanned the hook's project: ${JSON.stringify(entries)}`);
  // The next Stop is a first run for the list it wrote: taken as announced.
  assert.deepEqual(said(stopHook(guides, guidesConfig, dir)), []);
  assert.deepEqual(readStored(path).announced, entries.map(e => e.id));
});

test('a Stop another hook is looping on starts no background refresh', () => {
  // The refresh's scan runs git ls-files: this git leaves a marker when it does.
  const bin = fresh('ds-summary-bin-');
  const marker = join(bin, 'scanned');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch "${marker}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const dir = fresh('ds-summary-state-');
  const env = { PATH: `${bin}:${process.env.PATH}` };
  said(stopHook(guides, guidesConfig, dir, { stop_hook_active: true }, env));
  assert.equal(waitFor(() => existsSync(marker), 2500), false, 'no refresh ran');
  // An ordinary Stop still starts one, so the marker would have shown.
  said(stopHook(guides, guidesConfig, dir, {}, env));
  assert.ok(waitFor(() => existsSync(marker)), 'an ordinary Stop refreshes');
  const finished = () => {
    try { return typeof readStored(join(dir, 'suggestions.json')).lastScan === 'string' && !existsSync(join(dir, 'suggestions.lock')); } catch { return false; }
  };
  assert.ok(waitFor(finished), 'the refresh it started finished');
});
