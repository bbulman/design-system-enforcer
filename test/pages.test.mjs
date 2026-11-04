import { HERE, fresh, writeFiles } from './helpers/kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/*
 * gate/pages.mjs as a script outside the enforcer uses it (a harvest or review job): imported on its own,
 * from any folder, and given the project root. Each run is its own process with no ENFORCER_CONFIG, so
 * the rules come from the config each root holds.
 */
const PAGES = pathToFileURL(join(HERE, 'gate/pages.mjs')).href;
function run(script, cwd, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of ['ENFORCER_CONFIG', 'ENFORCER_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR']) delete env[k];
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const p = await import(${JSON.stringify(PAGES)});\n${script}`], { cwd, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout), stderr: r.stderr };
}

const files = ['index.php', 'secret/keys.php', 'parts/nav.php', 'old/_attic.php', 'about 2.php', 'notes.css'];
const project = config => writeFiles(fresh('ds-pages-'), {
  ...Object.fromEntries(files.map(f => [f, '<div class="promo-card">x</div>\n'])),
  ...(config === undefined ? {} : { 'enforcer.config.json': typeof config === 'string' ? config : JSON.stringify(config) }),
});
const RULES = { configVersion: 3, componentGate: { pages: { types: ['.php'], skip: ['_attic'], included: ['^parts/'], notPages: ['^secret/'] } } };
const count = root => `console.log(JSON.stringify({ described: p.pageCount({ name: 'a piano', files: ${JSON.stringify(files)} }, ${JSON.stringify(root)}), classed: p.pagesFor({ classes: ['promo-card'], files: ${JSON.stringify(files)} }, ${JSON.stringify(root)}) }));`;

test('the page rules are those of the root a function is given, whatever folder the script runs in', () => {
  const own = project(RULES);
  const { out } = run(count(own), fresh('ds-elsewhere-'));
  assert.equal(out.described, 1);
  assert.deepEqual(out.classed, { markupFiles: ['index.php', 'parts/nav.php', 'secret/keys.php'], pages: ['index.php'] });
});

test('a root with no config of its own uses the config of the project the process works on', () => {
  const own = project(RULES);
  const plain = project();
  // Run from inside the project with rules, or with it named by CLAUDE_PROJECT_DIR: its rules hold the plain root.
  const { out } = run(count(plain), own);
  assert.equal(out.described, 1);
  assert.deepEqual(out.classed.pages, ['index.php']);
  const named = run(count(plain), fresh('ds-elsewhere-'), { CLAUDE_PROJECT_DIR: own }).out;
  assert.deepEqual(named, out);
  // With no config anywhere, the default rules: every .php page counts, a sync copy never.
  const { out: defaults } = run(count(plain), fresh('ds-elsewhere-'));
  assert.equal(defaults.described, 4);
  assert.deepEqual(defaults.classed.pages, ['index.php', 'old/_attic.php', 'parts/nav.php', 'secret/keys.php']);
});

test('isPageFile, given no root, follows the project the script runs in', () => {
  const own = project(RULES);
  const script = `console.log(JSON.stringify(${JSON.stringify(files)}.map(p.isPageFile)));`;
  assert.deepEqual(run(script, own).out, [true, false, false, false, false, false]);
  assert.deepEqual(run(script, project()).out, [true, true, true, true, false, false]);
});

test('a config that cannot be read never stops the import: its project gets the default rules, with one note', () => {
  const broken = project('{ "componentGate": ');
  const { out, stderr } = run(`${count(broken)}\n${count(broken).replace('console.log', 'void')}\nconsole.error(p.MIN_PAGES, p.clearsBar({ sources: ['bill'] }, 0), p.classesOf({ name: 'x-card' }).join());`, fresh('ds-elsewhere-'));
  assert.equal(out.described, 4);
  assert.equal(stderr.match(/could not be read/g)?.length, 1, stderr);
  assert.match(stderr, /so the default page rules apply/);
  assert.match(stderr, /3 true x-card/);
});
