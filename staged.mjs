/**
 * `ds-enforcer staged`: the pre-commit design-system gate.
 *
 * It checks exactly what is being committed: the staged copy of each staged
 * file, never the working tree. Another session's unfinished or untracked
 * files cannot block a commit, and nothing left unstaged can slip through.
 *
 *   1. The index's PHP, CSS, JS, HTML, JSON, Swift and Markdown files, and what the
 *      project's checks add (export), are exported to a temporary folder (git checkout-index).
 *   2. Against that snapshot:
 *        - this enforcer's rules on the staged files, measured against
 *          .ds-enforcer/baseline.json so only new findings fail, at medium and above;
 *        - the project's own checks, config staged.checks, each when a staged path
 *          matches it (Workshopr's: check-page.php on the staged PHP pages, and when a
 *          design-system source is staged, check-drift.php, generate-catalog.php --check,
 *          generate-tokens-dtcg.php --check and scripts/ds-ws-icons.mjs --check).
 *   3. The snapshot is removed, also when the commit is interrupted.
 *
 * The rules come from the staged copy of the enforcer once it can run the gate,
 * so a half-edited enforcer in the working tree cannot break commits and the
 * result matches CI; until then, from this copy. One config serves the rules and
 * the project's checks alike (chooseConfig): the staged copy of the project's config
 * when it is written for this code, else, while the staged enforcer is the old code
 * too, the working-tree copy, with a note. A staged config that will not parse, or an
 * old one staged with the new code, stops the commit (exit 2), and so does a broken or
 * old working-tree copy when something checkable is staged, rather than run with rules off.
 * A renamed or moved file keeps its baseline entries, the enforcer's and those its
 * checks name: they are moved to its new path in the snapshot.
 *
 * Exit 1 when any check fails. Each failure prints its file, line and the fix.
 * In JavaScript, a new hand-copied component that has a JavaScript twin fails when
 * the config sets "commitGate": { "jsComponents": "block" } (Workshopr's does);
 * a copy with no twin yet, and a bespoke lookalike, are shown for information.
 * Bypass one commit, rarely and on the reviewer's say-so: git commit --no-verify.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_VERSION, BESIDE_CONFIG, currentFormat, staleConfigText, findConfig } from './config-file.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = 'enforcer.config.json';
const CHECKABLE = new Set(['.php', '.css', '.js', '.html', '.swift']);
const EXPORT = ['*.php', '*.css', '*.js', '*.mjs', '*.json', '*.html', '*.swift', '*.md'];

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const hasPhp = () => spawnSync('php', ['-v'], { stdio: 'ignore' }).status === 0;

function run(label, cmd, args, cwd, env = {}) {
  process.stdout.write(`\n— ${label}\n`);
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  return r.status === 0;
}

/** Old path => new path for each rename or move being committed. */
function stagedRenames(root) {
  const out = new Map();
  const parts = git(['diff', '--cached', '--name-status', '-M', '--diff-filter=R', '-z'], { cwd: root }).split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i].startsWith('R')) out.set(parts[i + 1], parts[i + 2]);
  return out;
}

/**
 * The project's own checks (config staged.checks), each with its trigger compiled. A check runs when
 * a staged path matches its `when`. In its command, an argument that is exactly `{files}` becomes
 * the matching paths, one argument each (it is never filled in inside a longer argument);
 * `{snapshot}` anywhere in the program or an argument becomes the snapshot's folder; and "node" as
 * the program is this Node. One with no name, no usable `when` or no command is left out, so a bad
 * entry cannot stop every commit.
 */
export function projectChecks(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c.name !== 'string' || !Array.isArray(c.command) || !c.command.length || typeof c.when !== 'string') continue;
    let when;
    try { when = new RegExp(c.when); } catch { continue; }
    out.push({ ...c, when, failure: c.failure || c.name });
  }
  return out;
}

/** Each check with the staged paths that trigger it, in config order; only the triggered ones. */
export function triggeredChecks(staged, checks) {
  return checks.map(check => ({ check, files: staged.filter(f => check.when.test(f)) })).filter(t => t.files.length);
}

/**
 * What the staged paths call for, before any snapshot: the files the rules check (a sync copy such as
 * "page 2.php" is never one), the project's checks they trigger, whether there is anything to do,
 * whether the opening line names the design-system sources, and whether a triggered check needs php.
 */
export function stagedPlan(staged, checks) {
  const checkable = staged.filter(f => CHECKABLE.has(extname(f)) && !/ \d+\.[a-z]+$/.test(f));
  const triggered = triggeredChecks(staged, checks);
  return {
    checkable,
    triggered,
    proceeds: checkable.length > 0 || triggered.length > 0,
    sources: triggered.some(t => t.check.sources),
    wantsPhp: triggered.some(t => t.check.needsPhp),
  };
}

/** The git pathspecs the snapshot exports: the files the rules read, and those the project's checks add (export). */
export const exportSpecs = checks => [...EXPORT, ...checks.flatMap(c => (Array.isArray(c.export) ? c.export.filter(e => typeof e === 'string') : []))];

/** The note for checks skipped because php was not found: staged.noPhp ({checks} filled in), or a plain one. */
export function phpNote(triggered, noPhp) {
  const skipped = triggered.filter(t => t.check.needsPhp).map(t => t.check.failure).join(', ');
  return noPhp ? String(noPhp).split('{checks}').join(skipped) : `note: php not found, so these checks were skipped: ${skipped}.`;
}

/**
 * The commands the triggered checks run, as [{ check, runs: [{ label, cmd, args }] }] in order. php says
 * whether php was found; exists(rel) whether a path is in the snapshot. A check that needs php without
 * it, or whose `requires` is not in the snapshot, runs nothing; one with `batch` gets its files in
 * batches of that size, each labelled by its range ("pages 1-400").
 */
export function plannedCommands(triggered, { snap, php, exists }) {
  const atSnapshot = a => String(a).split('{snapshot}').join(snap);
  const planned = [];
  for (const { check, files } of triggered) {
    if (check.needsPhp && !php) continue;
    if (check.requires && !exists(check.requires)) continue;
    const takesFiles = check.command.includes('{files}');
    const size = takesFiles && Number.isInteger(check.batch) && check.batch > 0 ? check.batch : files.length;
    const runs = [];
    for (let i = 0; i < (takesFiles ? files.length : 1); i += size) {
      const batch = files.slice(i, i + size);
      const args = check.command.slice(1).flatMap(a => (a === '{files}' ? batch : [atSnapshot(a)]));
      const label = `${check.name}${takesFiles && files.length > size ? `, ${check.unit || 'files'} ${i + 1}-${Math.min(i + size, files.length)}` : ''}`;
      runs.push({ label, cmd: check.command[0] === 'node' ? process.execPath : atSnapshot(check.command[0]), args });
    }
    planned.push({ check, runs });
  }
  return planned;
}

const DEFAULT_SETTINGS = Object.freeze({ checks: [], hint: null, noPhp: null });

/** A config's staged settings (staged.checks, hint, noPhp), its checks compiled. */
function stagedSettings(json) {
  const own = json?.staged && typeof json.staged === 'object' && !Array.isArray(json.staged) ? json.staged : {};
  return { ...DEFAULT_SETTINGS, ...own, checks: projectChecks(own.checks) };
}

/**
 * The running enforcer's folder from the top of its own checkout, so the same path finds its copy in
 * the repository being committed, another worktree of it included: '' when the enforcer is the
 * checkout itself, null when it is in none.
 */
function enforcerPath() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const rel = relative(r.stdout.trim(), HERE);
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
}
const under = (dir, file) => (dir ? `${dir}/${file}` : file);

/** The index's copy of a file, or null when the index has none. */
function stagedText(root, rel) {
  const r = spawnSync('git', ['cat-file', 'blob', `:${rel}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

const unparsed = (what, error) => `${what} could not be parsed (${error.message}). The commit is stopped so that the checks it names are not skipped; fix the file and commit again.`;

/* A file only the enforcer that reads configVersion has: staged at the enforcer's path, the commit carries that code. */
const NEW_CODE = 'config-file.js';

/**
 * The configVersion the enforcer staged at `at` reads (CONFIG_VERSION in its config-file.js), or null
 * when the staged enforcer is older than configVersion (it has no config-file.js) or there is none.
 */
function stagedCodeVersion(root, at) {
  const text = at === null ? null : stagedText(root, under(at, NEW_CODE));
  if (text === null) return null;
  const m = /\bCONFIG_VERSION\s*=\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : CONFIG_VERSION;
}

/**
 * The one config a run uses, for the rules and the project's checks alike: { json, rel, staged: true }
 * for the staged copy, { json, path, staged: false, note } for the working-tree one, { none: true },
 * or { error, always } where always stops the commit whatever it stages and otherwise only when
 * something checkable is staged.
 *
 * The config is the project's, as config-file.js findConfig finds it from the repository root: the
 * one beside the running enforcer (at is the enforcer's folder, enforcerPath) only when the root is
 * inside its projectRoot. Its staged copy is used when it is written for this code (configVersion).
 * Staged but older, it is set aside for the working-tree copy, with a note, only while the staged
 * enforcer is old code that it was written for (no config-file.js, or one whose CONFIG_VERSION it
 * meets), so that other commits go through until the enforcer is committed; staged beside code
 * that reads a later configVersion than it has, it is an error. Not staged at all, the working-tree
 * copy is used, with a note.
 */
function chooseConfig(root, at) {
  let working, brokenBeside = null;
  // Reading the beside config's projectRoot is findConfig's only parse: when it throws, that copy is the broken one.
  try { working = findConfig(root); } catch (error) { working = BESIDE_CONFIG; brokenBeside = error; }
  if (!working) return { none: true };
  const beside = working === BESIDE_CONFIG;
  const r = relative(root, working);
  const rel = beside ? (at === null ? null : under(at, CONFIG)) : (r.startsWith('..') || isAbsolute(r) ? null : r.split(sep).join('/'));
  const text = rel === null ? null : stagedText(root, rel);
  let reason = null;
  if (text !== null) {
    let json;
    try { json = JSON.parse(text); } catch (error) { return { error: unparsed(`the staged ${rel}`, error), always: true }; }
    if (currentFormat(json)) return { json, rel, staged: true };
    // Older than this code, but written for the enforcer staged beside it: that pair is the old code
    // with its own config, so other commits go through. Older than the staged enforcer reads, it is not.
    const needs = beside ? stagedCodeVersion(root, at) : null;
    if (needs !== null && !(Number(json.configVersion) >= needs)) {
      const has = json.configVersion != null ? `is written for configVersion ${json.configVersion}` : 'does not have it';
      return { error: `the enforcer code staged at ${at || '.'} reads configVersion ${needs}, but the ${CONFIG} staged with it ${has}, so the commit would carry code that runs with rules off. ${staleConfigText(`The staged ${rel}`, json.configVersion)}`, always: true };
    }
    if (!existsSync(working)) return { json, rel, staged: true };
    reason = `the staged ${rel} predates configVersion ${CONFIG_VERSION}`;
  } else if (rel !== null) {
    reason = `${rel} is not staged or committed`;
  }
  let json;
  try {
    if (brokenBeside) throw brokenBeside;
    json = JSON.parse(readFileSync(working, 'utf8'));
  } catch (error) {
    return { error: unparsed(working, error), always: false };
  }
  const note = reason ? `note: ${reason}, so this commit is checked against the working-tree copy, ${working}.` : null;
  return { json, path: working, staged: false, note };
}

/**
 * The snapshot's baselines, the enforcer's (config baseline, a project-relative path) and those the
 * project's checks name, with a moved file's entries under its new path.
 */
function followRenames(snap, renames, checks, baseline) {
  if (!renames.size) return;
  const rewrite = (rel, fn) => {
    if (isAbsolute(rel)) return;
    const path = join(snap, rel);
    if (!existsSync(path)) return;
    try { writeFileSync(path, JSON.stringify(fn(JSON.parse(readFileSync(path, 'utf8'))))); } catch { /* left as it is */ }
  };
  rewrite(typeof baseline === 'string' && baseline ? baseline : '.ds-enforcer/baseline.json', b => {
    const counts = {};
    for (const [key, n] of Object.entries(b.counts || {})) {
      const bar = key.indexOf('|');
      const to = renames.get(key.slice(0, bar));
      const k = to ? to + key.slice(bar) : key;
      counts[k] = (counts[k] || 0) + n;
    }
    return { ...b, counts };
  });
  const byFile = map => Object.fromEntries(Object.entries(map).map(([file, v]) => [renames.get(file) ?? file, v]));
  // A baseline keyed by file, as a whole ({ file }) or under one key ({ file, key }).
  for (const { file, key } of checks.flatMap(c => (Array.isArray(c.baselines) ? c.baselines : []))) {
    if (typeof file !== 'string') continue;
    if (!key) rewrite(file, byFile);
    else rewrite(file, l => (l[key] && typeof l[key] === 'object' ? { ...l, [key]: byFile(l[key]) } : l));
  }
}

export async function runStaged() {
  let root;
  try { root = git(['rev-parse', '--show-toplevel']).trim(); } catch { console.error('ds-enforcer staged: not inside a git repository'); return 2; }
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root }).split('\0').filter(Boolean);
  const at = enforcerPath();
  const chosen = chooseConfig(root, at);
  if (chosen.error) {
    // A broken working-tree copy is only the fallback: it stops a commit that has something to check, never a docs-only one.
    // Its own checks are unknown while it will not parse, so say they were not run rather than pass in silence.
    if (!chosen.always && !stagedPlan(staged, []).proceeds) {
      if (staged.length) console.error(`ds-enforcer staged: note: the project's own checks were not run on this commit, because ${chosen.error.split(' The commit is stopped')[0]}`);
      return 0;
    }
    console.error(`ds-enforcer staged: ${chosen.error}`);
    return 2;
  }
  const settings = chosen.none ? { ...DEFAULT_SETTINGS } : stagedSettings(chosen.json);
  const { checkable, triggered, proceeds, sources, wantsPhp } = stagedPlan(staged, settings.checks);
  if (!proceeds) return 0;
  if (chosen.none) {
    console.error(`ds-enforcer staged: no ${CONFIG} for this repository, so nothing staged can be checked. Connect it with ds-enforcer init.`);
    return 2;
  }
  if (!currentFormat(chosen.json)) {
    console.error(`ds-enforcer staged: ${staleConfigText(chosen.staged ? `The staged ${chosen.rel}` : chosen.path, chosen.json.configVersion)}`);
    return 2;
  }

  const made = mkdtempSync(join(tmpdir(), 'ds-staged-'));
  const cleanup = () => rmSync(made, { recursive: true, force: true });
  const interrupted = signal => () => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', interrupted('SIGINT'));
  process.once('SIGTERM', interrupted('SIGTERM'));
  const failed = [];
  try {
    // The real path: on macOS the temp folder is behind a symlink, and baseline keys are paths from the project root.
    const snap = realpathSync(made);
    const list = git(['ls-files', '-z', '--', ...exportSpecs(settings.checks)], { cwd: root });
    const out = spawnSync('git', ['checkout-index', '-z', '--stdin', `--prefix=${snap}/`], { cwd: root, input: list, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (out.status !== 0) { console.error(`ds-enforcer staged: could not export the staged files (${String(out.stderr).trim()})`); return 2; }
    followRenames(snap, stagedRenames(root), settings.checks, chosen.json.baseline);
    console.log(`Design-system check on what you are committing: ${checkable.length} file${checkable.length === 1 ? '' : 's'}${sources ? ', plus the design-system sources' : ''}.`);
    if (chosen.note) console.log(chosen.note);

    if (checkable.length) {
      // The staged enforcer once it can run the gate (it matches CI and cannot be half-edited), else this one.
      const stagedCode = at === null ? null : join(snap, at);
      const capable = stagedCode !== null && existsSync(join(stagedCode, 'icon-size.js')) && existsSync(join(stagedCode, 'check.mjs'))
        && /'--commit'/.test(readFileSync(join(stagedCode, 'check.mjs'), 'utf8'));
      const bin = capable ? join(stagedCode, 'bin/ds-enforcer.mjs') : join(HERE, 'bin/ds-enforcer.mjs');
      const config = chosen.staged ? join(snap, chosen.rel) : chosen.path;
      const listFile = join(snap, '.ds-staged-files');
      writeFileSync(listFile, checkable.join('\n'));
      const ok = run('Design-system rules (new findings only)', process.execPath, [bin, 'check', '--commit', '--fail-on', 'medium', '--files-from', listFile], snap,
        { ENFORCER_PROJECT_ROOT: snap, ENFORCER_CONFIG: config });
      if (!ok) failed.push('design-system rules');
    }
    const php = wantsPhp && hasPhp();
    for (const { check, runs } of plannedCommands(triggered, { snap, php, exists: rel => existsSync(join(snap, rel)) })) {
      let ok = true;
      for (const r of runs) if (!run(r.label, r.cmd, r.args, snap)) ok = false;
      if (!ok) failed.push(check.failure);
    }
    if (wantsPhp && !php) console.log(`\n${phpNote(triggered, settings.noPhp)}`);
  } finally {
    cleanup();
  }

  if (failed.length) {
    console.error(`\nCommit blocked by the design-system check: ${failed.join(', ')}.`);
    console.error(`Fix what is listed above and stage the fix.${settings.hint ? ` ${settings.hint}` : ''}`);
    console.error('A finding that is genuinely right here: mark the line ds-lint-disable-line and say why in the commit message.');
    return 1;
  }
  console.log('\n✔ Design-system check passed.');
  return 0;
}
