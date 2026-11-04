/**
 * The kit fixture (tests/fixtures/kit) as the project every test in this process works on. Import it
 * before anything that loads config.js: it copies the fixture to a fresh temporary folder, which the
 * tests may write in, and points the enforcer at it through the environment, which every hook and CLI
 * process a test starts inherits. Nothing a test does reaches the enforcer's own folder or the
 * repository around it. The copy is removed when the process exits.
 */
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The enforcer's own folder. */
export const HERE = fileURLToPath(new URL('../..', import.meta.url));
export const CLI = join(HERE, 'bin/ds-enforcer.mjs');
export const FIXTURE = join(HERE, 'tests/fixtures/kit');

const made = [];
/** A fresh temporary folder, removed when the process exits. */
export function fresh(prefix = 'ds-test-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A copy of the kit fixture in a fresh folder. */
export function kitCopy(prefix = 'ds-kit-') {
  const dir = fresh(prefix);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** The project this process works on: a copy of the fixture, its config named by ENFORCER_CONFIG. */
export const ROOT = kitCopy();
export const CONFIG = join(ROOT, 'enforcer.config.json');
process.env.ENFORCER_CONFIG = CONFIG;
process.env.CLAUDE_PROJECT_DIR = ROOT;
delete process.env.ENFORCER_PROJECT_ROOT;
delete process.env.DS_ENFORCER_STATE_DIR;
delete process.env.DS_ENFORCER_REFRESH;

/** The fixture's config, parsed fresh, to change and write elsewhere. */
export const kitConfig = () => JSON.parse(readFileSync(FIXTURE + '/enforcer.config.json', 'utf8'));

/** The fixture's config with changes, written to a fresh folder; its paths stay those of the project at root. */
export function configWith(changes = {}, root = ROOT) {
  const cfg = { ...kitConfig(), projectRoot: root, ...changes };
  for (const key of ['tokensCss', 'catalog', 'synonyms', 'nativeManifest', 'baseline']) {
    if (typeof cfg[key] === 'string' && !changes[key]) cfg[key] = join(ROOT, kitConfig()[key]);
  }
  const path = join(fresh('ds-config-'), 'enforcer.config.json');
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

/** Files written under a root, folders made as needed. */
export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
/** A throwaway git repository in a fresh folder with these files committed. */
export function repo(files, prefix = 'ds-repo-') {
  const root = writeFiles(fresh(prefix), files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture');
  return root;
}
export { git };
