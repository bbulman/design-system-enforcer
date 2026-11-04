/**
 * `ds-enforcer check [paths...]`: the same checks the MCP tools run, from the
 * command line, for pre-commit hooks and CI. No AI involved.
 *
 *   ds-enforcer check                 every checkable file in the project
 *   ds-enforcer check src/app         a folder or files (relative to where you are)
 *   --baseline                        record today's findings as the baseline, so only new ones fail
 *   --only <type,...>                 only these rules' findings; with --baseline, rewrite only their entries
 *   --all                             report every finding, baselined or not
 *   --a11y                            add the accessibility review (also on with config "a11y": true)
 *   --min low|medium|high             lowest severity to report (default low)
 *   --fail-on low|medium|high|never   exit 1 when a new finding at or above this is found (default high)
 *   --format text|json|github|sarif   output: text (default), json, GitHub annotations, or SARIF 2.1.0
 *   --json                            same as --format json
 *   --since <ref>                     only files changed since a git ref (for pull requests: the base commit);
 *                                     a renamed file keeps its baseline entries under its old path
 *   --files-from <file>               check the paths listed in a file, one per line (for very long lists)
 *   --root <dir>                      the project (default: found from where you are)
 *   --commit                          the pre-commit gate's terms (ds-enforcer staged runs it): a lookalike in a
 *                                     .js or .html file is shown for information, not failed; with config
 *                                     commitGate.jsComponents "block", a hand-copied component that has a
 *                                     js/ws.js twin fails like any other finding
 */
import { readFileSync, statSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { execFileSync } from 'child_process';

const RANK = { low: 1, medium: 2, high: 3, never: 4 };
export const EXTS = new Set(['.css', '.php', '.js', '.jsx', '.tsx', '.ts', '.vue', '.svelte', '.swift', '.html']);
const VALUED = new Set(['--min', '--fail-on', '--root', '--format', '--since', '--only', '--files-from']);
const option = (argv, name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };

/** Load the engine for the project, regenerating an init-connected catalog first. */
export async function loadEngine({ a11y = false } = {}) {
  const cfg = await import('./config.js');
  if (!cfg.connected) return null;
  if (cfg.config.sources?.length) {
    const { generate } = await import('./init/build.mjs');
    generate(cfg.PROJECT_ROOT, cfg.config);
  }
  const { TokenParser } = await import('./token-parser.js');
  const { ComponentRegistry } = await import('./component-registry.js');
  const { validateFile } = await import('./validators.js');
  const { loadNative } = await import('./native.js');
  let native;
  try { native = loadNative(); } catch { native = undefined; }
  const tokens = new TokenParser().load(), registry = new ComponentRegistry().load();
  const { driftFindings } = await import('./drift.js');
  const { relOf } = await import('./baseline.js');
  const drift = driftFindings(tokens.data?.catalog);
  const { reviewA11y } = await import('./a11y.js');
  const a11yOn = a11y || cfg.config.a11y === true || process.argv.includes('--a11y');
  // A token file's drift findings join its own (it is otherwise exempt from the checks).
  return { ...cfg, validate: (content, file) => [
    ...validateFile(content, file, tokens, registry, native),
    ...(drift[relOf(file)] || []),
    ...(a11yOn ? reviewA11y(content, file, tokens) : []),
  ] };
}

export async function runCheck(argv = []) {
  const root = option(argv, '--root');
  if (root) process.env.ENFORCER_PROJECT_ROOT = resolve(root);
  let engine;
  try { engine = await loadEngine(); } catch (error) {
    // Connected, but a file the config names is missing or broken: say which, rather than fall back to anything.
    const { CONFIG_PATH } = await import('./config.js');
    console.error(`The design system ${CONFIG_PATH} describes did not load: ${error.message}`);
    return 2;
  }
  if (!engine) {
    console.error('This project is not connected to a design system yet. Run `ds-enforcer init` first.');
    return 2;
  }
  // A config older than this code reads with rules off: the commit gate stops, every other check warns once.
  if (engine.staleConfig()) {
    if (argv.includes('--commit')) {
      console.error(`ds-enforcer check --commit stopped: ${engine.staleConfigText(engine.CONFIG_PATH, engine.config.configVersion)}`);
      return 2;
    }
    console.error(`ds-enforcer warning: ${engine.staleConfigText(engine.CONFIG_PATH, engine.config.configVersion)}`);
  }
  const { PROJECT_ROOT } = engine;
  const { walk } = await import('./init/importers.mjs');
  const bl = await import('./baseline.js');

  const min = RANK[option(argv, '--min', 'low')] ?? 1;
  const failOn = RANK[option(argv, '--fail-on', 'high')] ?? 3;
  const format = argv.includes('--json') ? 'json' : option(argv, '--format', 'text');
  if (!['text', 'json', 'github', 'sarif'].includes(format)) { console.error(`Unknown --format ${format}: use text, json, github or sarif`); return 2; }
  const since = option(argv, '--since');
  const writing = argv.includes('--baseline');
  const showAll = argv.includes('--all');
  const commit = argv.includes('--commit');
  const { LOOKALIKE_TYPES, namesTwin } = await import('./gate/lookalikes.mjs');
  const { gateSettings } = await import('./gate/settings.mjs');
  // In a commit, a lookalike in a file the gate only detects (componentGate.files.detect: JavaScript and HTML)
  // informs: there may be no component to call there. With commitGate.jsComponents "block", a hand-copied
  // component whose JavaScript twin (components.js) exists fails like anything else.
  const blockTwins = engine.config.commitGate?.jsComponents === 'block';
  const hasTwin = v => v.type === 'hand-copied-component' && namesTwin(v.suggestion);
  const detected = gateSettings().detected;
  const informs = (file, v) => commit && LOOKALIKE_TYPES.includes(v.type) && detected.has(extname(file).toLowerCase()) && !(blockTwins && hasTwin(v));
  const only = argv.includes('--only') ? String(option(argv, '--only', '')).split(',').map(s => s.trim()).filter(Boolean) : null;
  if (only && !only.length) { console.error('--only needs one or more finding types, comma-separated'); return 2; }
  const targets = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
  const listFile = option(argv, '--files-from');
  if (listFile) targets.push(...readFileSync(resolve(listFile), 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
  // A renamed file is checked under its new path; its baseline entries are under the old one.
  const renamedFrom = new Map();

  // Paths are relative to where you are, like any command; with --root, to that project.
  const base = root ? PROJECT_ROOT : process.cwd();
  const files = [];
  for (const t of targets.length ? targets : [PROJECT_ROOT]) {
    const abs = resolve(base, t);
    if (!existsSync(abs)) { console.error(`Not found: ${t}`); return 2; }
    if (statSync(abs).isDirectory()) files.push(...walk(abs, { accept: p => EXTS.has(extname(p)) }));
    else files.push(abs);
  }
  if (since) {
    // Only files the change touched; git runs here and nowhere else.
    let changed;
    try {
      changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${since}...HEAD`], { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\n').filter(Boolean).map(p => resolve(PROJECT_ROOT, p));
    } catch (error) {
      console.error(`--since ${since}: git could not compare (${String(error.stderr || error.message).trim().split('\n')[0]})`);
      return 2;
    }
    const keep = new Set(changed);
    files.splice(0, files.length, ...files.filter(f => keep.has(f)));
    try {
      const moves = execFileSync('git', ['diff', '--name-status', '-M', '--diff-filter=R', '-z', `${since}...HEAD`], { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0');
      for (let i = 0; i + 2 < moves.length; i += 3) if (moves[i].startsWith('R')) renamedFrom.set(moves[i + 2], moves[i + 1]);
    } catch { /* no renames to follow */ }
  }
  const relFiles = files.map(bl.relOf);

  const all = [];
  for (const file of files) {
    const found = engine.validate(readFileSync(file, 'utf8'), file)
      .filter(v => !only || only.includes(v.type))
      .sort((a, b) => (a.line || 0) - (b.line || 0));
    if (found.length) all.push({ file: bl.relOf(file), violations: found });
  }

  if (writing && only) {
    const w = bl.mergeBaseline(all, relFiles, only);
    const recorded = all.reduce((n, r) => n + r.violations.length, 0);
    console.log(`Baseline updated: ${recorded} existing ${only.join(', ')} finding${recorded === 1 ? '' : 's'} recorded in ${bl.relOf(w.path)}, ${w.total} in all. Every other entry is kept. Commit the file.`);
    return 0;
  }
  if (writing) {
    const w = bl.writeBaseline(all, relFiles);
    console.log(`Baseline written: ${w.total} existing finding${w.total === 1 ? '' : 's'} recorded in ${bl.relOf(w.path)}. From now on only new ones are reported. Commit the file.`);
    return 0;
  }

  const baseline = showAll ? null : bl.loadBaseline();
  let existingCount = 0;
  const results = [];
  for (const r of all) {
    const { fresh, existing } = bl.splitByBaseline(renamedFrom.get(r.file) ?? r.file, r.violations, baseline);
    existingCount += existing.length;
    const shown = fresh.filter(v => (RANK[v.severity] ?? 1) >= min);
    if (shown.length) results.push({ file: r.file, violations: shown });
  }
  // With --only, the other rules' entries were never looked for, so they cannot count as fixed.
  const scoped = baseline && only ? { ...baseline, counts: Object.fromEntries(Object.entries(baseline.counts || {}).filter(([key]) => only.includes(key.split('|')[1]))) } : baseline;
  const fixed = bl.fixedSince(scoped, all, relFiles);

  const count = sev => results.reduce((n, r) => n + r.violations.filter(v => v.severity === sev).length, 0);
  const totals = { files: files.length, withFindings: results.length, high: count('high'), medium: count('medium'), low: count('low'), baselined: existingCount, fixedSinceBaseline: fixed };
  if (format === 'json') {
    console.log(JSON.stringify({ totals, results: results.map(r => ({ file: r.file, violations: r.violations.map(({ type, severity, line, match, message, suggestion }) => ({ type, severity, line, match, message, suggestion })) })) }, null, 2));
  } else if (format === 'github') {
    console.log(githubAnnotations(results, totals, baseline));
  } else if (format === 'sarif') {
    console.log(JSON.stringify(sarif(results, engine.config.homepage), null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${r.file}`);
      for (const v of r.violations) {
        console.log(`  ${String(v.line ?? '').padStart(4)}  ${v.severity.padEnd(6)}  ${v.message}${informs(r.file, v) ? ' (information, not blocking)' : ''}`);
        if (v.suggestion) console.log(`${' '.repeat(16)}→ ${v.suggestion}`);
      }
    }
    const total = totals.high + totals.medium + totals.low;
    const kind = baseline ? 'new finding' : 'finding';
    let line = `\n${total ? '✖' : '✔'} ${files.length} files checked: ${total} ${kind}${total === 1 ? '' : 's'} (${totals.high} high, ${totals.medium} medium, ${totals.low} low) in ${results.length} file${results.length === 1 ? '' : 's'}`;
    if (baseline) line += `\n  ${existingCount} existing in the baseline${fixed ? `; ${fixed} fixed since (run with --baseline to lock that in)` : ''}`;
    console.log(line);
  }
  const worst = Math.max(0, ...results.flatMap(r => r.violations.filter(v => !informs(r.file, v)).map(v => RANK[v.severity] ?? 1)));
  return worst >= failOn ? 1 : 0;
}

// ─── Output formats for CI ───

const LEVEL = { high: 'error', medium: 'warning', low: 'notice' };
const escData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = s => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** GitHub Actions workflow commands: each finding becomes an annotation on the pull request. */
function githubAnnotations(results, totals, baseline) {
  const out = [];
  for (const r of results) for (const v of r.violations) {
    const title = `Design system (${v.severity})`;
    const text = v.suggestion ? `${v.message}. ${v.suggestion}` : v.message;
    out.push(`::${LEVEL[v.severity] || 'notice'} file=${escProp(r.file)},line=${v.line || 1},title=${escProp(title)}::${escData(text)}`);
  }
  const total = totals.high + totals.medium + totals.low;
  out.push(`${total} design system finding${total === 1 ? '' : 's'} (${totals.high} high, ${totals.medium} medium, ${totals.low} low) in ${totals.files} files${baseline ? `; ${totals.baselined} existing in the baseline` : ''}.`);
  return out.join('\n');
}

/** SARIF 2.1.0, for GitHub code scanning and other tools that read it. */
function sarif(results, homepage) {
  const rules = new Map();
  const items = [];
  for (const r of results) for (const v of r.violations) {
    if (!rules.has(v.type)) rules.set(v.type, { id: v.type, shortDescription: { text: v.type.replace(/-/g, ' ') } });
    items.push({
      ruleId: v.type,
      level: { high: 'error', medium: 'warning', low: 'note' }[v.severity] || 'note',
      message: { text: v.suggestion ? `${v.message}. ${v.suggestion}` : v.message },
      locations: [{ physicalLocation: { artifactLocation: { uri: r.file }, region: { startLine: v.line || 1 } } }],
    });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'ds-enforcer', ...(homepage ? { informationUri: homepage } : {}), rules: [...rules.values()] } }, results: items }],
  };
}
