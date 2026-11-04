import { kitConfig } from './helpers/kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config, PROJECT_ROOT, projectPath } from '../config.js';
import { TokenParser } from '../token-parser.js';
import { ComponentRegistry } from '../component-registry.js';
import { validateFile } from '../validators.js';
import { mergeBaseline } from '../baseline.js';
import { LOOKALIKE_TYPES, componentRootMap, findBespokeLookalikes, findHandCopied } from '../gate/lookalikes.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const VIEW = projectPath('pages/example.php');
const rootMap = componentRootMap();
const tokens = new TokenParser().load();
const registry = new ComponentRegistry().load();
const validate = (content, file) => validateFile(content, file, tokens, registry);
const ofType = (found, type) => found.filter(v => v.type === type);

test('LOOKALIKE_TYPES names the two rules', () => {
  assert.deepEqual(LOOKALIKE_TYPES, ['bespoke-lookalike', 'hand-copied-component']);
});

test('a bespoke status badge is one bespoke-lookalike', () => {
  const found = findBespokeLookalikes('<span class="status-badge">Live</span>', VIEW);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    type: 'bespoke-lookalike',
    severity: 'medium',
    line: 1,
    match: 'status-badge',
    word: 'badge',
    message: 'Hand-built badge: status-badge',
    suggestion: 'Call consult_ui with what this is, then use one of its candidates',
    autoFixable: false,
    file: VIEW,
  });
});

test('a bespoke card and a bespoke empty state are each one finding', () => {
  for (const [html, cls, word] of [['<div class="plan-card">', 'plan-card', 'card'], ['<div class="comments-empty">', 'comments-empty', 'empty']]) {
    const found = findBespokeLookalikes(html, VIEW);
    assert.equal(found.length, 1, html);
    assert.equal(found[0].match, cls);
    assert.equal(found[0].word, word);
  }
});

test('an element that also carries a kit-* class uses the component', () => {
  assert.deepEqual(findBespokeLookalikes('<div class="kit-card plan-card">', VIEW), []);
});

test('a BEM element is not a block', () => {
  assert.deepEqual(findBespokeLookalikes('<h1 class="app-hero__title">', VIEW), []);
  assert.deepEqual(findBespokeLookalikes('<span class="plan__status-badge">', VIEW), []);
});

test('a BEM modifier or a state class is never the bespoke class', () => {
  for (const cls of ['st-blank--empty', 'saved-item--card', 'chip--alert', 'is-empty', 'has-toast', 'no-card']) {
    assert.deepEqual(findBespokeLookalikes(`<div class="${cls}">`, VIEW), [], cls);
  }
  assert.equal(findBespokeLookalikes('<div class="chip--alert is-empty status-badge">', VIEW)[0]?.match, 'status-badge');
});

test('a file under lib/components/ gives no finding from either rule', () => {
  const hero = projectPath('lib/components/hero.php');
  const markup = '<div class="hero-badge"><a class="kit-btn">Go</a></div>';
  assert.deepEqual(findBespokeLookalikes(markup, hero), []);
  assert.deepEqual(findHandCopied(markup, hero, rootMap), []);
  assert.deepEqual(validate(markup, hero).filter(v => LOOKALIKE_TYPES.includes(v.type)), []);
  assert.equal(validate(markup, VIEW).filter(v => LOOKALIKE_TYPES.includes(v.type)).length, 2);
});

test('one finding per element, on the line its class sits', () => {
  const found = findBespokeLookalikes('<div>\n  <p>x</p>\n  <span class="live status-badge team-pill">Live</span>\n</div>', VIEW);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.equal(found[0].match, 'status-badge');
});

test('PHP and template expressions inside a class attribute are not class names', () => {
  assert.equal(findBespokeLookalikes(`<span class="status-badge<?= $live ? ' is-live' : '' ?>">`, VIEW)[0]?.match, 'status-badge');
  assert.equal(findHandCopied(`<a class="kit-btn<?= $p ? ' kit-btn--primary' : '' ?>">`, VIEW, rootMap)[0]?.match, 'kit-btn');
  assert.equal(findBespokeLookalikes('<span class="plan-card${extra}">', VIEW)[0]?.match, 'plan-card');
  assert.equal(findBespokeLookalikes(`echo '<span class="' . $c . ' status-badge">';`, VIEW)[0]?.match, 'status-badge');
  assert.equal(findBespokeLookalikes(`$h = "<div class=\\"plan-card\\">";`, VIEW)[0]?.match, 'plan-card');
  assert.deepEqual(findBespokeLookalikes('<p data-class="plan-card" className="x-card">', VIEW), []);
});

test('hand-copied kit-btn markup is one hand-copied-component, and its modifier is not', () => {
  const found = findHandCopied('<a class="kit-btn kit-btn--primary">Go</a>', VIEW, rootMap);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    type: 'hand-copied-component',
    severity: 'medium',
    line: 1,
    match: 'kit-btn',
    component: 'kit_button',
    message: 'kit-btn written by hand',
    suggestion: 'Use kit_button()',
    autoFixable: false,
    file: VIEW,
  });
});

test('componentRootMap maps root classes to their helpers', () => {
  assert.equal(rootMap.get('kit-btn'), 'kit_button');
  assert.equal(rootMap.get('kit-badge'), 'kit_badge');
  assert.equal(rootMap.get('kit-alert'), 'kit_alert');
  assert.equal(rootMap.get('kit-modal'), 'kit_modal');
  assert.equal(rootMap.get('kit-empty-state'), 'kit_empty_state');
  assert.equal(rootMap.has('kit-visually-hidden'), false);
});

test('a root two templates share goes to the one helper named after it, else to neither', () => {
  // footer.php opens with the promotion section, so it shares kit-promo with promo-grid.php.
  assert.equal(rootMap.get('kit-promo'), 'kit_promo_grid');
  // input.php and select.php both open with kit-field, and neither helper is named after it.
  assert.equal(rootMap.has('kit-field'), false);
  assert.equal(rootMap.get('kit-input'), 'kit_input');
  assert.equal(rootMap.get('kit-select'), 'kit_select');
});

test('validateFile on an .html file returns only the lookalike rules', () => {
  const found = validate('<span class="status-badge" style="color: red">Live</span>', projectPath('pages/example.html'));
  assert.equal(found.length, 1);
  assert.equal(found[0].type, 'bespoke-lookalike');
  assert.equal(found[0].match, 'status-badge');
});

test('validateFile leaves out the files componentGate.skip names', () => {
  const markup = '<div class="promo-card">Half price</div><a class="kit-btn">Go</a>';
  for (const rel of ['emails/templates/x.php', 'emails/x.php', 'tests/x.php', 'ds/components/demos/x.php', 'api/x.php']) {
    const found = validate(markup, projectPath(rel)).filter(v => LOOKALIKE_TYPES.includes(v.type));
    assert.deepEqual(found, [], rel);
  }
  assert.equal(validate(markup, VIEW).filter(v => LOOKALIKE_TYPES.includes(v.type)).length, 2);
});

test('validateFile runs both rules on PHP, and a ds-lint-disable marker hides them', () => {
  const found = validate('<span class="status-badge">Live</span>\n<a class="kit-btn">Go</a>', VIEW);
  assert.equal(ofType(found, 'bespoke-lookalike').length, 1);
  assert.equal(ofType(found, 'hand-copied-component').length, 1);
  const quiet = validate('<span class="status-badge">Live</span> <!-- ds-lint-disable-line -->', VIEW);
  assert.equal(ofType(quiet, 'bespoke-lookalike').length, 0);
});

test('a component template is the component: no hand-copied-component', () => {
  const badge = projectPath('lib/components/badge.php');
  assert.equal(ofType(validate(readFileSync(badge, 'utf8'), badge), 'hand-copied-component').length, 0);
  assert.equal(ofType(validate('<span class="kit-badge">x</span>', badge), 'hand-copied-component').length, 0);
  assert.equal(ofType(validate('<span class="kit-badge">x</span>', VIEW), 'hand-copied-component').length, 1);
});

test('in a .js file a hand-copied component is reported with its js/kit.js twin, or none where it has none', () => {
  const file = projectPath('js/example.js');
  const content = `el.innerHTML = '<a class="kit-btn">Go</a>';`;
  const [found] = findHandCopied(content, file, rootMap);
  assert.equal(found.severity, 'medium');
  assert.equal(found.suggestion, 'Use kit.button() from js/kit.js');
  assert.equal(ofType(validate(content, file), 'hand-copied-component').length, 1);
  const untwinned = [...rootMap].find(([, helper]) => !['kit_button', 'kit_badge', 'kit_pill', 'kit_alert', 'kit_input', 'kit_select', 'kit_tabs', 'kit_empty_state', 'kit_card'].includes(helper));
  const [other] = findHandCopied(`el.innerHTML = '<div class="${untwinned[0]}"></div>';`, file, rootMap);
  assert.equal(other.suggestion, `No JavaScript version of ${untwinned[1]} yet; leave as is`);
});

test('a JavaScript twin with a namespace but no file is named without a file, and still counts as a twin', async () => {
  const { namesTwin } = await import('../gate/lookalikes.mjs');
  const saved = config.components.js;
  config.components.js = { namespace: saved.namespace, sourceFiles: saved.sourceFiles };
  try {
    const [found] = findHandCopied(`el.innerHTML = '<a class="kit-btn">Go</a>';`, projectPath('js/example.js'), rootMap);
    assert.equal(found.suggestion, 'Use kit.button()');
    assert.ok(namesTwin(found.suggestion));
    assert.ok(!namesTwin('Use kit.button() from undefined'));
  } finally {
    config.components.js = saved;
  }
  assert.ok(namesTwin('Use kit.button() from js/kit.js'));
});

test('the scripts that draw components in JavaScript are the components: no hand-copied-component', () => {
  for (const rel of ['js/kit.js']) {
    const abs = projectPath(rel);
    assert.equal(ofType(validate(readFileSync(abs, 'utf8'), abs), 'hand-copied-component').length, 0, rel);
  }
});

test('mergeBaseline replaces only the named types for the scanned files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-lookalike-'));
  const saved = config.baseline;
  try {
    config.baseline = join(dir, 'baseline.json');
    writeFileSync(config.baseline, JSON.stringify({ counts: {
      'app/a.php|raw-control|<button>': 2,
      'app/a.php|bespoke-lookalike|old-card': 1,
      'app/b.php|bespoke-lookalike|b-card': 1,
    } }));
    const results = [{ file: 'app/a.php', violations: [
      { type: 'bespoke-lookalike', match: 'status-badge' },
      { type: 'hand-copied-component', match: 'kit-btn' },
      { type: 'raw-control', match: '<input>' },
    ] }];
    const written = mergeBaseline(results, ['app/a.php'], LOOKALIKE_TYPES);
    const { counts, total } = JSON.parse(readFileSync(config.baseline, 'utf8'));
    assert.deepEqual(counts, {
      'app/a.php|bespoke-lookalike|status-badge': 1,
      'app/a.php|hand-copied-component|kit-btn': 1,
      'app/a.php|raw-control|<button>': 2,
      'app/b.php|bespoke-lookalike|b-card': 1,
    });
    assert.equal(total, 5);
    assert.deepEqual(written, { path: config.baseline, total: 5 });
  } finally {
    config.baseline = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check --only reports only the named rules, and never counts the others as fixed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-lookalike-'));
  try {
    const file = join(dir, 'page.html');
    writeFileSync(file, '<span class="status-badge">Live</span>\n<a class="kit-btn">Go</a>\n');
    const rel = relative(PROJECT_ROOT, file).split(sep).join('/');
    const own = kitConfig();
    const cfg = join(dir, 'enforcer.config.json');
    writeFileSync(cfg, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, baseline: join(dir, 'baseline.json') }));
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ counts: { [`${rel}|raw-control|<button>`]: 1 } }));
    const env = { ...process.env, ENFORCER_CONFIG: cfg };
    delete env.ENFORCER_PROJECT_ROOT;
    const run = spawnSync(process.execPath, [join(HERE, 'bin/ds-enforcer.mjs'), 'check', file, '--only', 'hand-copied-component', '--format', 'json'], { cwd: HERE, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(out.results.flatMap(r => r.violations.map(v => v.type)), ['hand-copied-component']);
    assert.equal(out.totals.fixedSinceBaseline, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the gate off, the rules add nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-lookalike-'));
  try {
    const own = kitConfig();
    const cfg = join(dir, 'enforcer.config.json');
    writeFileSync(cfg, JSON.stringify({ ...own, projectRoot: PROJECT_ROOT, componentGate: { ...own.componentGate, enabled: false } }));
    const url = f => pathToFileURL(join(HERE, f)).href;
    const script = `
      const { validateFile } = await import(${JSON.stringify(url('validators.js'))});
      const { TokenParser } = await import(${JSON.stringify(url('token-parser.js'))});
      const { ComponentRegistry } = await import(${JSON.stringify(url('component-registry.js'))});
      const { gateSettings } = await import(${JSON.stringify(url('gate/settings.mjs'))});
      const t = new TokenParser().load(), r = new ComponentRegistry().load();
      const markup = '<span class="status-badge">Live</span><a class="kit-btn">Go</a>';
      const types = f => validateFile(markup, ${JSON.stringify(PROJECT_ROOT)} + f, t, r).map(v => v.type);
      console.log(JSON.stringify({ enabled: gateSettings().enabled, html: types('/x/page.html'), php: types('/pages/x.php'), js: types('/js/x.js') }));
    `;
    const env = { ...process.env, ENFORCER_CONFIG: cfg };
    delete env.ENFORCER_PROJECT_ROOT;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: HERE, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.enabled, false);
    assert.deepEqual(out.html, []);
    for (const type of [...out.php, ...out.js]) assert.ok(!LOOKALIKE_TYPES.includes(type), type);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
