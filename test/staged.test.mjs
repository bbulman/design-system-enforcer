import { kitConfig, fresh, git, HERE, FIXTURE, CLI } from './helpers/kit.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { connect } from '../init/build.mjs';
import { CONFIG_VERSION } from '../config-file.js';

/* The gate runs in a throwaway git repository built from the kit fixture, never in the repository the
   enforcer lives in. The enforcer under test is copied into it at tools/ds-enforcer with the fixture's
   config beside it, the way a project that carries the enforcer in its own repository keeps it, and
   run from there, so it sits inside the repository it gates. */
const AT = 'tools/ds-enforcer';
const STAGED_CFG = `${AT}/enforcer.config.json`;
const NEW_CODE = `${AT}/config-file.js`;
const OWN = { ...kitConfig(), projectRoot: '../..' };
const OWN_TEXT = JSON.stringify(OWN, null, 2);
const { configVersion, ...PRE_VERSION } = OWN;
const V = CONFIG_VERSION;
let repo;

const sh = (...args) => git(repo, ...args);
const write = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
const env = () => { const e = { ...process.env }; for (const k of ['ENFORCER_CONFIG', 'ENFORCER_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR', 'DS_ENFORCER_STATE_DIR']) delete e[k]; return e; };
const gate = () => spawnSync(process.execPath, [join(repo, AT, 'bin/ds-enforcer.mjs'), 'staged'], { cwd: repo, encoding: 'utf8', env: env() });
const json = v => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const reset = () => sh('reset', '-q');
/* The enforcer staged as code older than configVersion: no config-file.js, and too old to run the gate
   itself (no icon-size.js), so the copy running the gate checks the rules. */
const stageOldCode = () => sh('rm', '--cached', '-q', '--ignore-unmatch', '--', NEW_CODE, `${AT}/icon-size.js`);

/**
 * Stage a config (an object, or text as it is) beside the enforcer for fn; working, when given, is what
 * the working-tree copy holds meanwhile. The index goes back to HEAD and the working copy to the config.
 */
function withStagedConfig(cfg, fn, { working } = {}) {
  write(STAGED_CFG, json(cfg));
  sh('add', '-f', STAGED_CFG);
  if (working !== undefined) write(STAGED_CFG, json(working));
  try { return fn(); } finally {
    reset();
    write(STAGED_CFG, OWN_TEXT);
  }
}

before(() => {
  repo = fresh('ds-staged-repo-');
  cpSync(FIXTURE, repo, { recursive: true });
  // The config is the one beside the enforcer, so the project has none of its own.
  rmSync(join(repo, 'enforcer.config.json'));
  cpSync(HERE, join(repo, AT), { recursive: true, filter: src => !/^(node_modules|\.omc|test|tests|docs|\.git)([/\\]|$)/.test(relative(HERE, src)) });
  write(STAGED_CFG, OWN_TEXT);
  sh('init', '-q');
  sh('add', '-A');
  sh('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture');
});

test('a staged small icon blocks the commit, named by its path from the project', () => {
  write('tests/gate-test/a.css', '.gt .glyphs-outlined { font-size: 12px; }\n');
  sh('add', 'tests/gate-test/a.css');
  try {
    const r = gate();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^Design-system check on what you are committing: 1 file\.$/m);
    assert.match(r.stdout, /^tests\/gate-test\/a\.css$/m);
    assert.match(r.stdout, /Icon drawn at 12px; an icon is at least 24px \(STYLE\.md §3\)/);
    assert.match(r.stderr, /Commit blocked by the design-system check: design-system rules\./);
    assert.match(r.stderr, /A component for what you built: ask suggest_component\./);
    // The committed config beside the enforcer is written for this code: no note.
    assert.doesNotMatch(r.stdout, /note: /);
  } finally {
    reset();
  }
});

test('a config beside the enforcer that is not staged or committed is read from the working tree, with a note', () => {
  sh('rm', '--cached', '-q', STAGED_CFG);
  write('tests/gate-test/a.css', '.gt .glyphs-outlined { font-size: 12px; }\n');
  sh('add', 'tests/gate-test/a.css');
  try {
    const r = gate();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /note: tools\/ds-enforcer\/enforcer\.config\.json is not staged or committed, so this commit is checked against the working-tree copy/);
    assert.match(r.stdout, /Icon drawn at 12px/);
  } finally {
    reset();
  }
});

test('only the staged copy counts: a clean stage passes over a dirty working copy and an untracked file', () => {
  write('tests/gate-test/b.css', '.gt .glyphs-outlined { font-size: var(--glyph-lg); }\n');
  sh('add', 'tests/gate-test/b.css');
  try {
    write('tests/gate-test/b.css', '.gt .glyphs-outlined { font-size: 10px; }\n');
    write('tests/gate-test/untracked.css', '.u .icon { width: 8px; }\n');
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Design-system check passed/);
  } finally {
    reset();
    rmSync(join(repo, 'tests/gate-test'), { recursive: true, force: true });
  }
});

test('nothing checkable staged: silent, and passes', () => {
  write('notes/notes.txt', 'notes\n');
  sh('add', 'notes/notes.txt');
  try {
    const r = gate();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    reset();
  }
});

test('without commitGate set, hand-copied component markup in JavaScript informs but does not block', () => {
  const { commitGate, ...noCommitGate } = OWN;
  withStagedConfig(noCommitGate, () => {
    write('js/gate-test/x.js', `el.innerHTML = '<a class="kit-btn kit-btn--primary">Go</a>';\n`);
    sh('add', 'js/gate-test/x.js');
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /kit-btn written by hand \(information, not blocking\)/);
    assert.doesNotMatch(r.stdout, /note: /);
  });
});

test('with commitGate.jsComponents "block", a JS copy of a component that has a twin blocks; one with no twin, or a bespoke class, informs', () => {
  write('js/gate-test/twin.js', `el.innerHTML = '<a class="kit-btn kit-btn--primary">Go</a>';\n`);
  sh('add', 'js/gate-test/twin.js');
  try {
    let r = gate();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Use kit\.button\(\) from js\/kit\.js/);
    reset();
    write('js/gate-test/no-twin.js', `el.innerHTML = '<div class="kit-modal"></div><span class="status-badge">Live</span>';\n`);
    sh('add', 'js/gate-test/no-twin.js');
    r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No JavaScript version of kit_modal yet; leave as is/);
    assert.match(r.stdout, /information, not blocking/);
  } finally {
    reset();
  }
});

test('a moved file keeps its baseline entries: a pure rename passes, the project\'s page check included', () => {
  // internal/goals.php has a bespoke badge in the baselines under its own path: the enforcer's and the page check's two.
  sh('mv', 'internal/goals.php', 'internal/goals-moved.php');
  try {
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 existing in the baseline/);
    assert.match(r.stdout, /^— Page check \(page-check\.mjs\)$/m);
    assert.match(r.stdout, /page check: 1 pages, 0 failing/);
  } finally {
    sh('mv', 'internal/goals-moved.php', 'internal/goals.php');
  }
  // The same markup at a new path the baselines do not name fails both.
  write('internal/goals-copy.php', readFileSync(join(repo, 'internal/goals.php'), 'utf8'));
  sh('add', 'internal/goals-copy.php');
  try {
    const r = gate();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Commit blocked by the design-system check: design-system rules, page check\./);
  } finally {
    reset();
    rmSync(join(repo, 'internal/goals-copy.php'));
  }
});

test('a staged component template runs the sources check and, where php is found, the php lint', () => {
  const php = spawnSync('php', ['-v'], { stdio: 'ignore' }).status === 0;
  write('lib/components/badge.php', `${readFileSync(join(repo, 'lib/components/badge.php'), 'utf8')}<?php /* touched */ ?>\n`);
  sh('add', 'lib/components/badge.php');
  try {
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 file, plus the design-system sources\./);
    assert.match(r.stdout, /^— Catalog freshness \(catalog-check\.mjs\)$/m);
    if (php) assert.match(r.stdout, /^— PHP lint$/m);
    else assert.match(r.stdout, /note: php not found, so these checks were skipped: php lint\./);
  } finally {
    reset();
    sh('checkout', '--', 'lib/components/badge.php');
  }
});

test('a check that fails names itself in the blocked line', () => {
  write('images/glyphs/tiny.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\n');
  sh('add', 'images/glyphs/tiny.svg');
  try {
    const r = gate();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /images\/glyphs\/tiny\.svg is not on the 24-unit grid/);
    assert.match(r.stderr, /Commit blocked by the design-system check: glyphs\./);
  } finally {
    reset();
    rmSync(join(repo, 'images/glyphs/tiny.svg'));
  }
});

test('a staged config that will not parse stops the commit with exit 2, even with nothing else staged', () => {
  withStagedConfig(`{ "configVersion": ${V}, `, () => {
    let r = gate();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /the staged tools\/ds-enforcer\/enforcer\.config\.json could not be parsed/);
    assert.match(r.stderr, /The commit is stopped/);
    write('tests/gate-test/c.css', '.gt .glyphs-outlined { font-size: var(--glyph-lg); }\n');
    sh('add', 'tests/gate-test/c.css');
    r = gate();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Design-system check passed/);
  }, { working: OWN_TEXT });
});

test('a working-tree config that will not parse stops a commit with something checkable, never a docs-only one', () => {
  // The staged copy is older than this code, so the gate falls back to the working-tree copy, which is broken.
  withStagedConfig(PRE_VERSION, () => {
    stageOldCode();
    write('notes/gate-test-notes.md', 'notes\n');
    sh('add', 'notes/gate-test-notes.md');
    let r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    // Passes, but says the project's own checks were not run.
    assert.match(r.stderr, /note: the project's own checks were not run on this commit, because .*enforcer\.config\.json could not be parsed/);
    write('tests/gate-test/e.css', '.gt .glyphs-outlined { font-size: var(--glyph-lg); }\n');
    sh('add', 'tests/gate-test/e.css');
    r = gate();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /enforcer\.config\.json could not be parsed/);
  }, { working: `{ "configVersion": ${V}, ` });
});

test(`a staged config older than configVersion ${V} is set aside for the working-tree copy, with a note, while the staged enforcer is the old code`, () => {
  // Were the staged copy used, its exemptDirs would hide the small icon and the commit would pass.
  withStagedConfig({ ...PRE_VERSION, exemptDirs: [...OWN.exemptDirs, 'tests/gate-test'] }, () => {
    stageOldCode();
    write('tests/gate-test/d.css', '.gt .glyphs-outlined { font-size: 12px; }\n');
    sh('add', 'tests/gate-test/d.css');
    const r = gate();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Icon drawn at 12px/);
    assert.match(r.stdout, new RegExp(`note: the staged .*enforcer\\.config\\.json predates configVersion ${V}, so this commit is checked against the working-tree copy`));
  }, { working: OWN_TEXT });
});

test('a staged config written for the older enforcer staged with it is set aside too: that pair is the old code with its own config', () => {
  // The enforcer staged as it was at configVersion 2, with the config it read then.
  const older = readFileSync(join(repo, NEW_CODE), 'utf8').replace(/\bCONFIG_VERSION = \d+/, 'CONFIG_VERSION = 2');
  withStagedConfig({ ...OWN, configVersion: 2, exemptDirs: [...OWN.exemptDirs, 'tests/gate-test'] }, () => {
    const current = readFileSync(join(repo, NEW_CODE), 'utf8');
    write(NEW_CODE, older);
    sh('add', NEW_CODE);
    write(NEW_CODE, current);
    write('tests/gate-test/f.css', '.gt .glyphs-outlined { font-size: 12px; }\n');
    sh('add', 'tests/gate-test/f.css');
    const r = gate();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`note: the staged .*enforcer\\.config\\.json predates configVersion ${V}, so this commit is checked against the working-tree copy`));
    assert.match(r.stdout, /Icon drawn at 12px/);
  }, { working: OWN_TEXT });
});

test('the enforcer code that reads configVersion, staged with a config that predates it, stops the commit with exit 2', () => {
  withStagedConfig(PRE_VERSION, () => {
    write('notes/gate-test-notes.md', 'notes\n');
    sh('add', 'notes/gate-test-notes.md');
    const r = gate();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`reads configVersion ${V}, but the enforcer\\.config\\.json staged with it does not have it`));
    assert.match(r.stderr, new RegExp(`has no "configVersion": ${V}`));
  }, { working: OWN_TEXT });
});

test(`a staged config at configVersion 2 beside code that reads ${V} stops the commit, naming only what moved since 2`, () => {
  withStagedConfig({ ...OWN, configVersion: 2 }, () => {
    write('notes/gate-test-notes.md', 'notes\n');
    sh('add', 'notes/gate-test-notes.md');
    const r = gate();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`reads configVersion ${V}, but the enforcer\\.config\\.json staged with it is written for configVersion 2`));
    assert.match(r.stderr, new RegExp(`is written for "configVersion": 2, older than this enforcer's ${V}`));
    assert.match(r.stderr, /iconSize \(the small-icon rule, off unless enabled/);
    assert.match(r.stderr, /componentGate \(files, pages, scanSkip\)/);
    assert.doesNotMatch(r.stderr, /components \(functionPrefix/);
  }, { working: OWN_TEXT });
});

test('check --commit with a config that has no configVersion stops with exit 2 and names the settings that moved; plain check warns once', () => {
  const dir = fresh('ds-version-test-');
  const cfg = join(dir, 'enforcer.config.json');
  writeFileSync(cfg, JSON.stringify({ ...PRE_VERSION, projectRoot: repo }));
  const run = args => spawnSync(process.execPath, [CLI, 'check', ...args], { cwd: repo, encoding: 'utf8', env: { ...env(), ENFORCER_CONFIG: cfg } });
  let r = run(['--commit', '--fail-on', 'medium', 'internal/goals.php']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`has no "configVersion": ${V}`));
  assert.match(r.stderr, /run init again and connect the same sources/);
  assert.match(r.stderr, /components \(functionPrefix, classPrefix/);
  assert.match(r.stderr, /componentGate \(skip, reviewUrl, shellParser, reviewer\)/);
  assert.match(r.stderr, /iconSize \(the small-icon rule/);
  assert.match(r.stderr, /tokenNames \(colorOrder, colorWords, appScoped, nativeCore\)/);
  r = run(['--fail-on', 'never', 'internal/goals.php']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stderr.match(new RegExp(`ds-enforcer warning: .*has no "configVersion": ${V}`, 'g'))?.length, 1, r.stderr);
});

test('connecting again a config an older init wrote adds configVersion and keeps its other settings', () => {
  const root = fresh('ds-reconnect-test-');
  writeFileSync(join(root, 'tokens.css'), ':root { --brand: #C2410C; --space-4: 16px; }\n.a { color: #123456; }\n');
  const old = {
    projectRoot: '.', framework: 'css', sources: [{ type: 'css', path: 'tokens.css' }],
    tokensCss: '.ds-enforcer/tokens.css', catalog: '.ds-enforcer/catalog.json', synonyms: '.ds-enforcer/synonyms.json',
    rootPx: 16, exemptFiles: ['tokens.css'], name: 'Acme', hookMin: 'low', a11y: true, exemptDirs: ['node_modules', 'legacy'],
    componentGate: { enabled: false }, rules: { pureBlack: { enabled: true, severity: 'high', message: 'm', suggestion: 's' } },
  };
  writeFileSync(join(root, 'enforcer.config.json'), JSON.stringify(old, null, 2));
  const check = () => spawnSync(process.execPath, [CLI, 'check', '--commit', '--fail-on', 'never', 'tokens.css'], { cwd: root, encoding: 'utf8', env: env() });
  let r = check();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run init again/);
  connect(root, { sources: old.sources, rootPx: 16, rules: { pureBlack: true } });
  const now = JSON.parse(readFileSync(join(root, 'enforcer.config.json'), 'utf8'));
  assert.equal(now.configVersion, V);
  for (const key of ['name', 'hookMin', 'a11y', 'exemptDirs', 'componentGate', 'sources', 'framework', 'tokensCss', 'catalog', 'synonyms', 'rootPx']) {
    assert.deepEqual(now[key], old[key], key);
  }
  assert.deepEqual(now.exemptFiles, ['tokens.css']);
  assert.equal(now.rules.pureBlack.enabled, true);
  r = check();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /configVersion/);
});
