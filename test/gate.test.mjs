import { kitConfig } from './helpers/kit.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PROJECT_ROOT } from '../config.js';
import { readSession, updateSession, noteWrite, agentKey, agentLabel } from '../gate/session.mjs';
import { pieceId } from '../gate/consult.mjs';
import { loadQueue, addCase, KIND } from '../gate/queue.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(HERE, 'bin/ds-enforcer.mjs');
const SESSION_JSON = join(PROJECT_ROOT, '.ds-enforcer/session.json');
const SID = 'gate-test';
const STATUS = 'a status label on each team member row';

const made = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'ds-gate-')); made.push(dir); return dir; };
after(() => { for (const path of made) rmSync(path, { recursive: true, force: true }); });

/* A page under pages/ (or a stylesheet under css/), which the gate covers and no baseline names; the name is new each run. */
function page(content, ext = 'php') {
  const rel = `${ext === 'css' ? 'css' : 'pages'}/zz-gate-test-${process.pid}-${randomBytes(3).toString('hex')}.${ext}`;
  const abs = join(PROJECT_ROOT, rel);
  writeFileSync(abs, content);
  made.push(abs);
  return { rel, abs };
}

/* Hooks run in the project with CLAUDE_PROJECT_DIR set; the state goes to a fresh folder. */
function hook(cmd, payload, dir, env = {}) {
  const base = { ...process.env };
  for (const key of ['ENFORCER_CONFIG', 'ENFORCER_PROJECT_ROOT']) delete base[key];
  return spawnSync(process.execPath, [CLI, cmd], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...base, CLAUDE_PROJECT_DIR: PROJECT_ROOT, DS_ENFORCER_STATE_DIR: dir, ...env },
  });
}

const pre = (tool, input, extra = {}) => ({ session_id: SID, cwd: PROJECT_ROOT, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...extra });
const post = (tool, input, response, extra = {}) => ({ ...pre(tool, input, extra), hook_event_name: 'PostToolUse', tool_response: response });
const edit = (abs, oldString, newString) => pre('Edit', { file_path: abs, old_string: oldString, new_string: newString });

const reasonFor = rel => `Before adding markup to ${rel}, tell the design system what you are building. Call consult_ui with the file and one plain-words description per UI piece, or run: node ${CLI} consult --file ${rel} --piece "<description>". Then make this edit again.`;

function denied(run) {
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

function allowed(run) {
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
}

/* The edit hook also notes files in the project's own .ds-enforcer/session.json; put it back. */
function keepingSessionJson(fn) {
  const saved = existsSync(SESSION_JSON) ? readFileSync(SESSION_JSON) : null;
  try { return fn(); } finally {
    if (saved === null) rmSync(SESSION_JSON, { force: true }); else writeFileSync(SESSION_JSON, saved);
  }
}

const TEAM = '<ul>\n  <li class="member">Ana</li>\n</ul>\n';
const ADD_BADGE = ['<li class="member">Ana</li>', '<li class="member">Ana <span class="status-badge">Live</span></li>'];

test('a markup-adding Edit without a consult is denied with the verbatim reason', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  assert.equal(denied(hook('gate', edit(abs, ...ADD_BADGE), dir)), reasonFor(rel));
  assert.deepEqual(readSession(SID, dir).files[rel], { consulted: false, refusals: 1 });
  assert.deepEqual(readSession(SID, dir).writes, []);
});

test('the command a refusal gives runs from a subfolder', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  const reason = denied(hook('gate', edit(abs, ...ADD_BADGE), dir));
  const command = /or run: (node .+ --piece "<description>")\./.exec(reason)[1].replace('<description>', STATUS);
  const env = { ...process.env, DS_ENFORCER_STATE_DIR: dir };
  for (const key of ['ENFORCER_CONFIG', 'ENFORCER_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR']) delete env[key];
  const run = spawnSync('/bin/sh', ['-c', command], { cwd: join(PROJECT_ROOT, 'pages'), encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('kit_badge'), run.stdout);
  assert.ok(run.stdout.includes(pieceId(rel, STATUS)), run.stdout);
});

test('a wording-only Edit is allowed and its file is listed once in the session writes', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  allowed(hook('gate', edit(abs, '<li class="member">Ana</li>', '<li class="member">Ana B.</li>'), dir));
  allowed(hook('gate', edit(abs, '<li class="member">Ana</li>', '<li class="member">Anna</li>'), dir));
  assert.deepEqual(readSession(SID, dir).writes, [rel]);
  assert.deepEqual(readSession(SID, dir).agentWrites, { main: [rel] });
});

test('a second agent writing a listed file gets it in its own list', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  const wording = extra => ({ ...edit(abs, '<li class="member">Ana</li>', '<li class="member">Ana B.</li>'), ...extra });
  allowed(hook('gate', wording({}), dir));
  allowed(hook('gate', wording({ agent_id: 'a1', agent_type: 'Explore' }), dir));
  allowed(hook('gate', wording({ agent_id: 'a1', agent_type: 'Explore' }), dir));
  const s = readSession(SID, dir);
  assert.deepEqual(s.writes, [rel]);
  assert.deepEqual(s.agentWrites, { main: [rel], a1: [rel] });
});

test('an Edit to api/plans.php is allowed', () => {
  const dir = fresh();
  allowed(hook('gate', edit(join(PROJECT_ROOT, 'api/plans.php'), '<?php', '<?php ?><dialog class="share-modal"></dialog><?php'), dir));
  assert.deepEqual(readSession(SID, dir).writes, []);
});

test('an Edit to an HTML file is only detected, never gated', () => {
  const dir = fresh();
  allowed(hook('gate', edit(join(PROJECT_ROOT, 'pages/hybrid.html'), '<body>', '<body><div class="share-modal"></div>'), dir));
});

test('after a consult is recorded, the same Edit is allowed', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  const consulted = hook('gate-post', post('mcp__design-system-enforcer__consult_ui', { file: rel, pieces: [STATUS, '  '] }, [{ type: 'text', text: 'Components that could build each piece' }]), dir);
  assert.equal(consulted.status, 0, consulted.stderr);
  assert.equal(consulted.stderr, '');
  const s = readSession(SID, dir);
  assert.equal(s.files[rel].consulted, true);
  const piece = s.pieces[pieceId(rel, STATUS)];
  assert.equal(piece.file, rel);
  assert.equal(piece.description, STATUS);
  assert.equal(piece.nothingFitting, false);
  assert.equal(piece.agent, 'main');
  assert.ok(piece.candidates.includes('kit_badge'), JSON.stringify(piece.candidates));
  assert.ok(piece.candidates.every(c => typeof c === 'string'));
  assert.deepEqual(Object.keys(s.pieces), [pieceId(rel, STATUS)]);
  allowed(hook('gate', edit(abs, ...ADD_BADGE), dir));
  assert.deepEqual(readSession(SID, dir).writes, [rel]);
});

test('a consult through the shell is recorded the same way', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  const command = `cd ${PROJECT_ROOT} && node ${CLI} consult --file ${rel} --piece "${STATUS}" --piece 'a confirm-before-delete dialog'`;
  const run = hook('gate-post', post('Bash', { command }, { stdout: 'Components that could build each piece', stderr: '', interrupted: false }, { agent_id: 'a7', agent_type: 'Explore' }), dir);
  assert.equal(run.status, 0, run.stderr);
  const s = readSession(SID, dir);
  assert.equal(s.files[rel].consulted, true);
  assert.ok(Object.values(s.pieces).every(p => p.agent === 'a7'), JSON.stringify(s.pieces));
  assert.deepEqual(Object.keys(s.pieces).sort(), [pieceId(rel, STATUS), pieceId(rel, 'a confirm-before-delete dialog')].sort());
  assert.ok(s.pieces[pieceId(rel, 'a confirm-before-delete dialog')].candidates.includes('kit_modal'));
  allowed(hook('gate', edit(abs, ...ADD_BADGE), dir));
});

test('two refusals, then allowed and recorded as unconsulted', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  const payload = pre('Edit', { file_path: abs, old_string: ADD_BADGE[0], new_string: ADD_BADGE[1] }, { agent_id: 'a1', agent_type: 'oh-my-claudecode:executor' });
  denied(hook('gate', payload, dir));
  denied(hook('gate', payload, dir));
  allowed(hook('gate', payload, dir));
  const queue = loadQueue(dir);
  assert.equal(queue.length, 1);
  const [c] = queue;
  assert.equal(c.kind, 'unconsulted');
  assert.equal(c.file, rel);
  assert.equal(c.line, 2);
  assert.equal(c.session, SID);
  assert.equal(c.agent, 'oh-my-claudecode:executor');
  assert.equal(c.markup, ADD_BADGE[1]);
  assert.equal(c.reason, 'Written without a consult after two refusals');
  assert.ok(c.candidates.some(x => x.helper === 'kit_badge'), JSON.stringify(c.candidates));
  assert.ok(c.candidates.every(x => Object.keys(x).join() === 'helper'));
  assert.deepEqual(readSession(SID, dir).writes, [rel]);
  assert.deepEqual(readSession(SID, dir).agentWrites, { a1: [rel] });
  // The way through is once per file: later writes pass without another case.
  allowed(hook('gate', payload, dir));
  assert.equal(loadQueue(dir).length, 1);
});

test('markup a PHP block echoes is not markup; the same class in plain markup is', () => {
  const dir = fresh();
  const { rel, abs } = page("<?php\n$label = 'Live';\necho '<div>';\n?>\n<p class=\"lead\">Hi</p>\n");
  allowed(hook('gate', edit(abs, "echo '<div>';", "echo '<div class=\"x\">';"), dir));
  assert.equal(denied(hook('gate', edit(abs, '<p class="lead">Hi</p>', '<p class="lead x">Hi</p>'), dir)), reasonFor(rel));
});

test('an Edit whose markup context lies outside its own text is still gated', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  assert.equal(denied(hook('gate', edit(abs, 'member">Ana', 'member status-badge">Ana'), dir)), reasonFor(rel));
  assert.equal(denied(hook('gate', edit(abs, '"member"', '"member status-badge"'), dir)), reasonFor(rel));
  const css = page('.plan-card .title { color: var(--brand-ink); }\n', 'css');
  assert.equal(denied(hook('gate', edit(css.abs, '.plan-card .title', '.plan-card .status-badge'), dir)), reasonFor(css.rel));
});

test('MultiEdit compares each edit with the text it replaces', () => {
  const dir = fresh();
  const { rel, abs } = page('<p class="a">One</p>\n<p class="b">Two</p>\n');
  const multi = edits => pre('MultiEdit', { file_path: abs, edits });
  allowed(hook('gate', multi([{ old_string: 'One', new_string: 'Uno' }, { old_string: 'Two', new_string: 'Dos' }]), dir));
  // A second <p class="a"> is a token the whole file already had; the edit's own text did not.
  const reason = denied(hook('gate', multi([{ old_string: 'One', new_string: 'Uno' }, { old_string: '<p class="b">Two</p>', new_string: '<p class="b">Two</p><p class="a">Three</p>' }]), dir));
  assert.equal(reason, reasonFor(rel));
});

test('Write compares its content with the file on disk', () => {
  const dir = fresh();
  const { rel, abs } = page(TEAM);
  allowed(hook('gate', pre('Write', { file_path: abs, content: TEAM.replace('Ana', 'Ana B.') }), dir));
  assert.equal(denied(hook('gate', pre('Write', { file_path: abs, content: TEAM.replace('Ana', 'Ana <span class="status-badge">Live</span>') }), dir)), reasonFor(rel));
  const rel2 = `pages/zz-gate-test-${process.pid}-new.php`;
  assert.equal(denied(hook('gate', pre('Write', { file_path: join(PROJECT_ROOT, rel2), content: '<div class="plan-card"></div>' }), dir)), reasonFor(rel2));
});

test('NotebookEdit is allowed', () => {
  const dir = fresh();
  allowed(hook('gate', pre('NotebookEdit', { notebook_path: join(PROJECT_ROOT, 'pages/x.ipynb'), new_source: '<div class="x"></div>' }), dir));
});

test('a Bash heredoc into pages/x.php is gated', () => {
  const dir = fresh();
  const command = "cat > pages/x.php <<'EOF'\n<span class=\"status-badge\">Live</span>\nEOF";
  assert.equal(denied(hook('gate', pre('Bash', { command }), dir)), reasonFor('pages/x.php'));
  allowed(hook('gate', pre('Bash', { command: 'ls pages > /dev/null && git status' }), dir));
  const css = "cat >> css/x.css <<'EOF'\n.plan-card { padding: 0; }\nEOF";
  assert.equal(denied(hook('gate', pre('Bash', { command: css }), dir)), reasonFor('css/x.css'));
  assert.equal(denied(hook('gate', pre('Bash', { command: "echo '.plan-card { padding: 0; }' >> css/y.css" }), dir)), reasonFor('css/y.css'));
});

test('a Bash write whose command brings no markup is not gated, and still counts as a write', () => {
  const dir = fresh();
  const { rel } = page(TEAM);
  const other = page(TEAM);
  for (const command of [
    `sed -i '' 's/Ana/Anna/' ${rel}`,
    `perl -pi -e 's/Ana/Anna/' ${rel}`,
    `cp ${other.rel} ${rel}`,
    `touch ${rel}`,
  ]) allowed(hook('gate', pre('Bash', { command }), dir));
  const s = readSession(SID, dir);
  assert.equal(s.files[rel], undefined, 'no refusal was counted');
  assert.deepEqual(s.writes, [rel]);
  assert.deepEqual(loadQueue(dir), []);
});

test('the Bash way through records the case with the command as its markup', () => {
  const dir = fresh();
  const rel = `pages/zz-gate-test-${process.pid}-${randomBytes(3).toString('hex')}.php`;
  made.push(join(PROJECT_ROOT, rel));
  const command = `cat > ${rel} <<'EOF'\n<span class="status-badge">Live</span>\nEOF`;
  denied(hook('gate', pre('Bash', { command }), dir));
  denied(hook('gate', pre('Bash', { command }), dir));
  allowed(hook('gate', pre('Bash', { command }), dir));
  const [c] = loadQueue(dir);
  assert.equal(c.kind, 'unconsulted');
  assert.equal(c.file, rel);
  assert.equal(c.markup, command);
  assert.ok(c.candidates.some(x => x.helper === 'kit_badge'), JSON.stringify(c.candidates));
  assert.deepEqual(readSession(SID, dir).writes, [rel]);
});

test('garbage on stdin allows', () => {
  const dir = fresh();
  for (const cmd of ['gate', 'gate-post']) {
    const run = hook(cmd, 'not json', dir);
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
  }
});

test('disabled gate allows everything', () => {
  const dir = fresh();
  const { abs } = page(TEAM);
  const own = kitConfig();
  const off = join(dir, 'enforcer.config.json');
  writeFileSync(off, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, componentGate: { ...own.componentGate, enabled: false } }));
  allowed(hook('gate', edit(abs, ...ADD_BADGE), dir, { ENFORCER_CONFIG: off }));
  assert.ok(!existsSync(join(dir, 'sessions')));
});

test('the gate stays under 500 ms', () => {
  const dir = fresh();
  // A long page: 1500 rows of markup and PHP, a plain <div> line in its second half.
  const rows = Array.from({ length: 1500 }, (_, i) => (i % 3 ? `<div class="row row-${i}"><span class="cell">${i}</span></div>` : `<?php $n = ${i}; echo kit_badge((string) $n); ?>`));
  const { rel, abs } = page(`${rows.join('\n')}\n`);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const target = lines.slice(Math.floor(lines.length / 2)).find(l => /<div\b[^>]*>/.test(l) && !l.includes('<?'));
  assert.ok(target, 'the page has a plain <div> line in its second half');
  const started = Date.now();
  const run = hook('gate', edit(abs, target, target.replace(/<div\b/, '<div data-x="1"><span class="probe-badge">x</span></div><div')), dir);
  const took = Date.now() - started;
  assert.equal(denied(run), reasonFor(rel));
  assert.ok(took < 500, `took ${took} ms`);
});

test('record_case gives its case the session and the agent', () => {
  const dir = fresh();
  const c = addCase({ file: 'pages/team.php', kind: KIND.KEPT, markup: '<b>x</b>', reason: 'r' }, dir);
  const other = addCase({ file: 'pages/team.php', kind: KIND.KEPT, markup: '<b>y</b>', reason: 'r' }, dir);
  const text = `Case ${c.id} recorded. Rae will see it on the review page.`;
  const run = hook('gate-post', post('mcp__design-system-enforcer__record_case', { file: 'pages/team.php' }, [{ type: 'text', text }], { agent_id: 'a9', agent_type: 'feature-build:feature-builder' }), dir);
  assert.equal(run.status, 0, run.stderr);
  const [got, untouched] = loadQueue(dir);
  assert.equal(got.session, SID);
  assert.equal(got.agent, 'feature-build:feature-builder');
  assert.equal(untouched.id, other.id);
  assert.equal(untouched.session, null);
});

const BADGE_PAGE = '<div>\n<span class="status-badge">Live</span>\n</div>\n';

test('a Bash write is checked through the changed files Claude Code reports', () => {
  const dir = fresh();
  const { rel, abs } = page(BADGE_PAGE);
  keepingSessionJson(() => {
    const listed = hook('gate-post', post('Bash', { command: `node scripts/build-page.mjs ${rel}` }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [abs] } }), dir);
    assert.equal(listed.status, 2, listed.stderr);
    assert.ok(listed.stderr.startsWith(`Design system check on ${rel}: 1 new finding to fix.\n`), listed.stderr);
    assert.ok(listed.stderr.trimEnd().endsWith(`(finding: ${rel}|bespoke-lookalike|status-badge)`), listed.stderr);
    const quiet = hook('gate-post', post('Bash', { command: 'git status' }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [] } }), dir);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stderr, '');
  });
  // A write the gate never saw beforehand still counts for the finish check.
  assert.deepEqual(readSession(SID, dir).writes, [rel]);
  assert.deepEqual(readSession(SID, dir).agentWrites, { main: [rel] });
});

test('a file that changed while the command ran but that the command never names is not the agent\'s', () => {
  const dir = fresh();
  const mine = page('<p>Mine</p>\n');
  const theirs = page(BADGE_PAGE);
  keepingSessionJson(() => {
    // Claude Code lists every file that changed during the command, another session's edits included.
    // A name that only contains the file's, or a listed name full of glob characters, names nothing.
    const odd = join(PROJECT_ROOT, 'pages/zz-a**b?.php');
    const command = `php -l ${mine.rel} && cat ${theirs.rel}.bak x${theirs.rel.split('/').pop()}`;
    const run = hook('gate-post', post('Bash', { command }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [mine.abs, theirs.abs, odd] } }), dir);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  });
  assert.deepEqual(readSession(SID, dir).writes, [mine.rel]);
});

test('a changed file counts when the command names it by its file name, a path from its folder or a glob', () => {
  const sub = 'pages';
  const cases = [
    [p => `cd ${sub} && sed -i '' 's/Live/Now/' ${p.rel.split('/').pop()}`, PROJECT_ROOT],
    [p => `sed -i '' 's/Live/Now/' ./${p.rel.split('/').pop()}`, join(PROJECT_ROOT, sub)],
    [() => `sed -i '' 's/Live/Now/' pages/zz-gate-test-${process.pid}-*.php`, PROJECT_ROOT],
    [p => `printf '%s' x >${p.rel.split('/').pop()}`, join(PROJECT_ROOT, sub)],
    [p => `cat <${p.rel.split('/').pop()} | tee -a ${p.rel.split('/').pop()}`, join(PROJECT_ROOT, sub)],
  ];
  for (const [command, cwd] of cases) {
    const dir = fresh();
    const p = page(BADGE_PAGE);
    keepingSessionJson(() => {
      const run = hook('gate-post', { ...post('Bash', { command: command(p) }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [p.abs] } }), cwd }, dir);
      assert.equal(run.status, 2, `${command(p)}: ${run.stderr}`);
      assert.ok(run.stderr.includes(`(finding: ${p.rel}|bespoke-lookalike|status-badge)`), run.stderr);
    });
    assert.deepEqual(readSession(SID, dir).writes, [p.rel], command(p));
  }
});

test('a Bash write a subagent makes goes into its own list', () => {
  const dir = fresh();
  const { rel, abs } = page('<p>Plain</p>\n');
  keepingSessionJson(() => {
    const run = hook('gate-post', post('Bash', { command: `node scripts/build-page.mjs ${rel}` }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [abs] } }, { agent_id: 'a3', agent_type: 'Explore' }), dir);
    assert.equal(run.status, 0, run.stderr);
  });
  assert.deepEqual(readSession(SID, dir).agentWrites, { a3: [rel] });
});

test('every changed gated file goes into the session writes, past the files it checks', () => {
  const dir = fresh();
  const pages = Array.from({ length: 25 }, (_, i) => page(`<p>Page ${i}</p>\n`));
  keepingSessionJson(() => {
    const run = hook('gate-post', post('Bash', { command: `node scripts/build-pages.mjs pages/zz-gate-test-${process.pid}-*.php` }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 25, changedFiles: pages.map(p => p.abs) } }), dir);
    assert.equal(run.status, 0, run.stderr);
  });
  assert.deepEqual(readSession(SID, dir).writes.sort(), pages.map(p => p.rel).sort());
});

test('a file the command deleted is not a session write', () => {
  const dir = fresh();
  const kept = page('<p>Kept</p>\n');
  const flagged = page('<p>Marked deleted</p>\n');
  const gone = join(PROJECT_ROOT, `pages/zz-gate-test-${process.pid}-gone.php`);
  const diff = { files: [{ filePath: flagged.abs, hunks: [], deleted: true }], moreFiles: 0, changedFiles: [kept.abs, flagged.abs, gone] };
  keepingSessionJson(() => {
    const run = hook('gate-post', post('Bash', { command: `node scripts/tidy-pages.mjs ${kept.rel} ${flagged.rel} ${gone}` }, { stdout: '', stderr: '', bashEditDiff: diff }), dir);
    assert.equal(run.status, 0, run.stderr);
  });
  assert.deepEqual(readSession(SID, dir).writes, [kept.rel]);
});

test('without a changed-file list, a Bash write is found in the command', () => {
  const dir = fresh();
  const { rel } = page(BADGE_PAGE);
  keepingSessionJson(() => {
    const parsed = hook('gate-post', post('Bash', { command: `sed -i '' 's/Live/Now/' ${rel}` }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, unavailable: true } }), dir);
    assert.equal(parsed.status, 2, parsed.stderr);
    assert.ok(parsed.stderr.includes(`(finding: ${rel}|bespoke-lookalike|status-badge)`), parsed.stderr);
  });
});

/* The edit hook's stdout, when it prints one: a PostToolUse additionalContext for the agent, with exit 0. */
function noted(run) {
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const out = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  return out.hookSpecificOutput.additionalContext;
}

const LOOKALIKES = '<a class="kit-btn" href="/save">Save</a><span class="status-badge">Live</span>';
const editPost = abs => post('Edit', { file_path: abs, old_string: 'x', new_string: 'y' }, { filePath: abs });

test('the edit hook reports .js and .html lookalikes for information only', () => {
  const dir = fresh();
  for (const [ext, content] of [['js', `const actions = \`${LOOKALIKES}\`;\n`], ['html', `<div>\n${LOOKALIKES}\n</div>\n`]]) {
    const { rel, abs } = page(content, ext);
    keepingSessionJson(() => {
      const told = noted(hook('hook', editPost(abs), dir));
      assert.ok(told.startsWith(`Design system check on ${rel}: 2 lookalikes reported for information only.`), told);
      assert.ok(told.includes('kit-btn written by hand') && told.includes('Hand-built badge: status-badge'), told);
      assert.ok(!told.includes('(finding:'), told);
      assert.ok(!told.includes('consult_ui'), told);
      assert.ok(!/to fix/.test(told), told);
    });
  }
  // A gated file is unchanged: its lookalikes are findings to fix, each with its key.
  const php = page(`<div>\n${LOOKALIKES}\n</div>\n`);
  keepingSessionJson(() => {
    const run = hook('hook', editPost(php.abs), dir);
    assert.equal(run.status, 2, run.stderr);
    assert.ok(run.stderr.startsWith(`Design system check on ${php.rel}: 2 new findings to fix.`), run.stderr);
    assert.ok(run.stderr.includes(`(finding: ${php.rel}|bespoke-lookalike|status-badge)`), run.stderr);
  });
});

test('in a .js file, older rules still ask for a fix and the lookalikes stay information only', () => {
  const dir = fresh();
  const own = kitConfig();
  const low = join(dir, 'enforcer.config.json');
  writeFileSync(low, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, hookMin: 'low' }));
  const { rel, abs } = page(`el.style.color = 'var(--old-ink)';\nconst t = \`${LOOKALIKES}\`;\n`, 'js');
  keepingSessionJson(() => {
    const run = hook('hook', editPost(abs), dir, { ENFORCER_CONFIG: low });
    assert.equal(run.status, 2, run.stderr);
    const [fix, info] = run.stderr.trimEnd().split('\n\n');
    assert.ok(fix.startsWith(`Design system check on ${rel}: 1 new finding to fix.`), fix);
    assert.ok(fix.includes('--old-ink is a legacy alias'), fix);
    assert.ok(info.startsWith(`Design system check on ${rel}: 2 lookalikes reported for information only.`), info);
    assert.ok(!run.stderr.includes('(finding:'), run.stderr);
  });
});

test('a Bash write to a .js file reports its lookalikes for information only', () => {
  const dir = fresh();
  const { rel, abs } = page(`const t = \`${LOOKALIKES}\`;\n`, 'js');
  keepingSessionJson(() => {
    const told = noted(hook('gate-post', post('Bash', { command: `node scripts/build-js.mjs ${rel}` }, { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [abs] } }), dir));
    assert.ok(told.startsWith(`Design system check on ${rel}: 2 lookalikes reported for information only.`), told);
    assert.ok(!told.includes('(finding:'), told);
  });
  assert.deepEqual(readSession(SID, dir).writes, []);
});

/* A subagent that stopped with a piece it never built, as its blocked SubagentStop leaves the session. */
function leftBySubagent(dir) {
  const { rel } = page(TEAM);
  updateSession(SID, st => {
    noteWrite(st, 'a1', rel);
    st.pieces['P-aaaaaa'] = { file: rel, description: STATUS, candidates: ['kit_badge'], nothingFitting: false, agent: 'a1' };
    st.blocked.a1 = ['P-aaaaaa'];
  }, dir);
  return rel;
}
const LEFT = 'A subagent stopped before resolving these, in files it changed. Resolve them for it:';

test('the main session\'s next edit or shell command tells it what a subagent left, as information', () => {
  for (const make of [
    () => ['hook', post('Edit', { file_path: page('<p>Plain</p>\n').abs, old_string: 'a', new_string: 'b' }, { success: true })],
    () => ['gate-post', post('Bash', { command: 'ls' }, { stdout: '', stderr: '' })],
  ]) {
    const dir = fresh();
    const rel = leftBySubagent(dir);
    const [cmd, payload] = make();
    keepingSessionJson(() => {
      const told = noted(hook(cmd, payload, dir));
      assert.ok(told.startsWith(`${LEFT}\n${rel} piece "${STATUS}": build it with kit_badge()`), `${cmd}: ${told}`);
      const subagent = hook(cmd, { ...payload, agent_id: 'a2', agent_type: 'general-purpose' }, dir);
      assert.equal(subagent.status, 0, subagent.stderr);
      assert.ok(!subagent.stdout.includes(LEFT), `${cmd}: ${subagent.stdout}`);
      // Told once.
      assert.ok(!hook(cmd, payload, dir).stdout.includes(LEFT), cmd);
    });
  }
});

test('lookalikes in a file the gate skips are not reported at all', () => {
  const dir = fresh();
  for (const folder of ['emails/templates', 'tests']) {
    mkdirSync(join(PROJECT_ROOT, folder), { recursive: true });
    const rel = `${folder}/zz-gate-test-${process.pid}-${randomBytes(3).toString('hex')}.php`;
    const abs = join(PROJECT_ROOT, rel);
    writeFileSync(abs, '<div class="promo-card">Half price</div>\n');
    made.push(abs);
    keepingSessionJson(() => {
      const run = hook('hook', editPost(abs), dir);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(!run.stderr.includes('promo-card') && !run.stdout.includes('promo-card'), `${run.stderr}${run.stdout}`);
    });
  }
});

test('a bad pattern in componentGate.skip leaves the gate and the edit hook working', () => {
  const dir = fresh();
  const own = kitConfig();
  const bad = join(dir, 'enforcer.config.json');
  writeFileSync(bad, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, componentGate: { ...own.componentGate, skip: ['(', '^api/'] } }));
  const { rel, abs } = page(BADGE_PAGE);
  assert.equal(denied(hook('gate', edit(abs, '<span class="status-badge">Live</span>', '<span class="status-badge">Live</span><b class="x">!</b>'), dir, { ENFORCER_CONFIG: bad })), reasonFor(rel));
  keepingSessionJson(() => {
    const run = hook('hook', editPost(abs), dir, { ENFORCER_CONFIG: bad });
    assert.equal(run.status, 2, run.stderr);
    assert.ok(run.stderr.includes(`(finding: ${rel}|bespoke-lookalike|status-badge)`), run.stderr);
  });
});

test('agentKey and agentLabel', () => {
  assert.equal(agentKey({ agent_id: 'a1', agent_type: 'Explore' }), 'a1');
  assert.equal(agentKey({ session_id: 's' }), 'main');
  assert.equal(agentLabel({ agent_id: 'a1', agent_type: 'Explore' }), 'Explore');
  assert.equal(agentLabel({}), 'main session');
});
