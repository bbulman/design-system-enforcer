/**
 * Enforcer settings. Everything specific to one project lives in an
 * enforcer.config.json. It is looked for, in order:
 *   1. the file ENFORCER_CONFIG names
 *   2. the nearest enforcer.config.json at or above the project directory
 *      (ENFORCER_PROJECT_ROOT, CLAUDE_PROJECT_DIR or the working directory),
 *      where `init` writes it
 *   3. enforcer.config.json beside this file (how Workshopr carries its own), only
 *      when the project being worked on is the one the server lives in
 * Paths in it are relative to projectRoot, which is relative to the config file.
 * A key the file leaves out keeps its default (config-defaults.js); the defaults
 * carry no house rules, so those are opt-in per project.
 *
 * With no config anywhere the project is not connected yet: the server still
 * starts, and every tool but init says to run init.
 */
import { readFileSync, lstatSync, realpathSync } from 'fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'path';
import { currentFormat, findConfig as findConfigFile } from './config-file.js';
import { DEFAULTS, merge } from './config-defaults.js';

export { DEFAULTS, merge } from './config-defaults.js';

// The config format this code reads, and what moved into the config with it (config-file.js has no side effects, for staged and init).
export { CONFIG_VERSION, MOVED_SETTINGS, currentFormat, staleConfigText } from './config-file.js';

/** A text template with its {key} placeholders filled from values; an unknown key is left as written. */
export const fillText = (template, values = {}) =>
  String(template).replace(/\{(\w+)\}/g, (m, key) => (Object.hasOwn(values, key) ? String(values[key]) : m));

/* config tokenNames[key] compiled, again only when the config changes; a pattern that is not a regular expression is left out. */
const compiledNames = new Map();
export function tokenNamePatterns(key) {
  const from = config.tokenNames?.[key];
  const hit = compiledNames.get(key);
  if (hit && hit.from === from) return hit.res;
  const res = [];
  for (const p of Array.isArray(from) ? from : []) {
    if (typeof p !== 'string') continue;
    try { res.push(new RegExp(p)); } catch { /* not a regular expression */ }
  }
  compiledNames.set(key, { from, res });
  return res;
}

/** A literal string, escaped for use inside a regular expression. */
export const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A text setting that may be a list of sentences, as one string. */
export const joinText = v => (Array.isArray(v) ? v.join(' ') : v);


/** The directory the user is working in: where init looks and writes. */
export const PROJECT_DIR = resolve(process.env.ENFORCER_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());

/** The config file for a project directory (PROJECT_DIR unless named), or null when there is none (config-file.js). */
export const findConfig = (projectDir = PROJECT_DIR) => findConfigFile(projectDir);

/* Live bindings: reloadConfig() reassigns these, and every importer sees the new values. */
export let CONFIG_PATH = null;
export let config = DEFAULTS;
export let PROJECT_ROOT = PROJECT_DIR;
export let connected = false;

export function reloadConfig() {
  CONFIG_PATH = findConfig();
  const fromFile = CONFIG_PATH ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) : {};
  config = merge(DEFAULTS, fromFile);
  PROJECT_ROOT = process.env.ENFORCER_PROJECT_ROOT ? PROJECT_DIR
    : CONFIG_PATH ? resolve(dirname(CONFIG_PATH), config.projectRoot) : PROJECT_DIR;
  connected = Boolean(CONFIG_PATH);
  return config;
}
reloadConfig();

/** A config path made absolute against the project root. */
export const projectPath = p => (isAbsolute(p) ? p : resolve(PROJECT_ROOT, p));

/** Raw-control skip patterns, written as regex strings in the config. */
export const rawControlSkip = () => config.rawControlSkip.map(s => new RegExp(s));

/** A connected config file written before CONFIG_VERSION, which this code would read with rules silently off. */
export const staleConfig = () => connected && !currentFormat(config);

/** True when a path resolves inside the project root (the root itself counts). */
export function insideProject(abs) {
  const rel = relative(PROJECT_ROOT, resolve(abs));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * insideProject for a path about to be written or read on the user's word: also true only when
 * its real location is inside the project's, so a symlink inside the project cannot lead out of it.
 * The nearest part of the path that exists is the one resolved; a link that leads nowhere is refused.
 */
export function insideProjectReal(abs) {
  if (!insideProject(abs)) return false;
  let at = resolve(abs);
  for (;;) {
    try { lstatSync(at); break; } catch { /* not there yet: its folder decides */ }
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
  let real, root;
  try { real = realpathSync(at); root = realpathSync(PROJECT_ROOT); } catch { return false; }
  const rel = relative(root, real);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
