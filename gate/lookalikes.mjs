/**
 * The widened lookalike rules: markup whose block class carries a component
 * word (status-badge, plan-card), and a component's own root class written by
 * hand (<a class="ws-btn">). Classes are read from class attributes anywhere in
 * the file, PHP strings and JavaScript templates included, as findRawControls
 * reads raw source.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectPath, config, escapeRe } from '../config.js';
import { relPath } from '../native.js';

export const LOOKALIKE_TYPES = ['bespoke-lookalike', 'hand-copied-component'];

const WORDS = 'badge|pill|chip|card|tile|modal|dialog|toast|tabs|empty|toggle|avatar|alert|banner|tooltip|skeleton';
const BESPOKE = new RegExp(`^\\w[\\w-]*-(${WORDS})$`, 'i');
// An escaped quote (class=\"x\") is how markup sits inside a double-quoted PHP string.
const CLASS_ATTR = /(?<![\w-])class\s*=\s*\\?(?:"([^"]*?)\\?"|'([^']*?)\\?')/gi;
// PHP or ${...} glued to a class (ws-btn<?= ... ?>) would otherwise hide it.
const EMBEDDED = /<\?[\s\S]*?(?:\?>|$)|\$\{[^}]*\}?/g;
const CLASS_NAME = /^-?[_a-zA-Z][\w-]*$/;
const lineOf = (content, at) => content.substring(0, at).split('\n').length;

/** Each class attribute's class names, with the offset each one starts at. */
function classAttributes(content) {
  const out = [];
  for (const m of content.matchAll(CLASS_ATTR)) {
    const value = (m[1] ?? m[2]).replace(EMBEDDED, s => ' '.repeat(s.length));
    const start = m.index + m[0].search(/["']/) + 1;
    out.push([...value.matchAll(/\S+/g)].filter(t => CLASS_NAME.test(t[0])).map(t => ({ name: t[0], at: start + t.index })));
  }
  return out;
}

/* The project's component naming (components in enforcer.config.json), read on each call so a reloaded config applies. */
const naming = () => config.components || {};

// A template there is the component itself (components.sourceDirs), and so are the scripts that draw
// the components in JavaScript (components.js.sourceFiles).
const inComponentSource = filePath => {
  const rel = relPath(filePath);
  const { sourceDirs = [], js } = naming();
  return sourceDirs.some(d => rel.startsWith(d)) || (js?.sourceFiles || []).includes(rel);
};

/** The suggestion that names a helper's JavaScript twin: "Use ws.button() from js/ws.js", or without the file when the config names none. */
const twinSuggestion = (twin, file) => `Use ${twin}()${file ? ` from ${file}` : ''}`;

/** True when a finding's suggestion names a JavaScript twin (components.js), as findHandCopied writes it. */
export function namesTwin(suggestion) {
  const js = naming().js;
  if (!js?.namespace) return false;
  return new RegExp(`^Use ${escapeRe(js.namespace)}\\.[a-zA-Z]+\\(\\)${js.file ? ` from ${escapeRe(js.file)}` : ''}$`).test(suggestion || '');
}

/** Each helper's twin in the JavaScript file (ws_button: ws.button), from the catalog's js field, reread when the catalog changes. */
let twins = { mtime: -1, ns: null, map: new Map() };
function jsTwins() {
  const ns = naming().js?.namespace;
  if (!ns) return new Map();
  const path = projectPath(config.catalog);
  let mtime;
  try { mtime = statSync(path).mtimeMs; } catch { return new Map(); }
  if (mtime !== twins.mtime || ns !== twins.ns) {
    const map = new Map();
    const callRe = new RegExp(`^(${escapeRe(ns)}\\.[a-zA-Z]+)\\(`);
    try {
      for (const [name, c] of Object.entries(JSON.parse(readFileSync(path, 'utf8')).components || {})) {
        const call = callRe.exec(c.js || '');
        if (call) map.set(name, call[1]);
      }
    } catch { /* a catalog that will not parse names no twin */ }
    twins = { mtime, ns, map };
  }
  return twins.map;
}
// An element (__), a modifier (--) or a state (is-empty) is never the block that names the piece.
const notBlock = name => name.includes('__') || name.includes('--') || /^(is|has|no)-/i.test(name);

export function findBespokeLookalikes(content, filePath) {
  if (inComponentSource(filePath)) return [];
  const violations = [];
  for (const classes of classAttributes(content)) {
    const own = naming().classPrefix;
    if (own && classes.some(c => c.name.startsWith(own))) continue;
    const hit = classes.find(c => !notBlock(c.name) && BESPOKE.test(c.name));
    if (!hit) continue;
    const word = BESPOKE.exec(hit.name)[1].toLowerCase();
    violations.push({
      type: 'bespoke-lookalike',
      severity: 'medium',
      line: lineOf(content, hit.at),
      match: hit.name,
      word,
      message: `Hand-built ${word}: ${hit.name}`,
      suggestion: 'Call consult_ui with what this is, then use one of its candidates',
      autoFixable: false,
      file: filePath,
    });
  }
  return violations;
}

export function findHandCopied(content, filePath, rootMap) {
  if (inComponentSource(filePath)) return [];
  const js = /\.js$/i.test(filePath);
  const violations = [];
  for (const classes of classAttributes(content)) {
    for (const c of classes) {
      const helper = rootMap.get(c.name);
      if (!helper) continue;
      const twin = js ? jsTwins().get(helper) : null;
      violations.push({
        type: 'hand-copied-component',
        severity: 'medium',
        line: lineOf(content, c.at),
        match: c.name,
        component: helper,
        message: `${c.name} written by hand`,
        suggestion: js ? (twin ? twinSuggestion(twin, naming().js.file) : `No JavaScript version of ${helper} yet; leave as is`) : `Use ${helper}()`,
        autoFixable: false,
        file: filePath,
      });
    }
  }
  return violations;
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const FUNCTION = /^\s*function\s+(\w+)\s*\(/gm;
const INCLUDE = /\b(?:include|require)(?:_once)?\s*\(?\s*__DIR__\s*\.\s*['"]\/([\w.-]+\.php)['"]/;
const TEMPLATE_NOISE = [
  [BLOCK_COMMENT, ' '],
  [/<!--[\s\S]*?-->/g, ' '],
  [/<(style|script)\b[\s\S]*?<\/\1>/gi, ' '],
  [/(^|[^:'"\\])\/\/[^\n]*/g, '$1'],
];
// Not after ".", "-" or "$": a CSS selector, a custom property, data-ws-* or a variable. A trailing "-" is an id prefix.
const rootClassRe = classPrefix => new RegExp(`(?<![\\w$.-])${escapeRe(classPrefix)}[a-z0-9]+(?:-[a-z0-9]+)*(?![\\w-])`);

function firstRootClass(path, rootClass) {
  let src;
  try { src = readFileSync(path, 'utf8'); } catch { return null; }
  for (const [re, to] of TEMPLATE_NOISE) src = src.replace(re, to);
  return rootClass.exec(src)?.[0] ?? null;
}

/* The helpers file's functions (functionPrefix) mapped from the root class (classPrefix) each one's template opens. */
function buildRootMap(helpersPath, fp, cp) {
  const src = readFileSync(helpersPath, 'utf8').replace(BLOCK_COMMENT, ' ');
  const fns = [...src.matchAll(FUNCTION)];
  const rootClass = rootClassRe(cp);
  const claims = new Map();
  fns.forEach((m, i) => {
    if (!m[1].startsWith(fp)) return;
    const include = INCLUDE.exec(src.slice(m.index, fns[i + 1]?.index ?? src.length));
    const root = include && firstRootClass(join(dirname(helpersPath), include[1]), rootClass);
    if (root) claims.set(root, [...(claims.get(root) ?? []), m[1]]);
  });
  // A root several templates share goes to the one claimant named after it (ws-level-up, opened by
  // level-up-grid.php and by footer.php, is ws_level_up_grid's); with no single such claimant (ws-field,
  // under both ws_input and ws_select) it belongs to no helper.
  const map = new Map();
  for (const [root, helpers] of claims) {
    const named = helpers.filter(h => h.startsWith(`${fp}${root.slice(cp.length).replace(/-/g, '_')}`));
    const helper = helpers.length === 1 ? helpers[0] : named.length === 1 ? named[0] : null;
    if (helper) map.set(root, helper);
  }
  // A class named after a helper is that helper's, ahead of any template: ws-modal is ws_modal, not ws_modal_start.
  for (const [, name] of fns) if (name.startsWith(fp)) map.set(`${cp}${name.slice(fp.length).replace(/_/g, '-')}`, name);
  return map;
}

let cached = null;

/**
 * Root class to helper, rebuilt when the helpers file (components.helperFile) changes; empty when
 * the project names no helpers file, or no function and class prefix to pair its helpers by.
 */
export function componentRootMap() {
  const { helperFile, functionPrefix: fp, classPrefix: cp } = naming();
  if (!helperFile || !fp || !cp) return new Map();
  const path = projectPath(helperFile);
  let mtime;
  try { mtime = statSync(path).mtimeMs; } catch { return new Map(); }
  if (cached?.path !== path || cached.mtime !== mtime || cached.fp !== fp || cached.cp !== cp) cached = { path, mtime, fp, cp, map: buildRootMap(path, fp, cp) };
  return cached.map;
}
