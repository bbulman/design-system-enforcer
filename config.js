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
 * A key the file leaves out keeps the default below; the defaults carry no
 * house rules, so those are opt-in per project.
 *
 * With no config anywhere the project is not connected yet: the server still
 * starts, and every tool but init says to run init.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'path';

export const DEFAULTS = {
  projectRoot: '.',
  framework: 'css',
  tokensCss: '.ds-enforcer/tokens.css',
  catalog: '.ds-enforcer/catalog.json',
  synonyms: '.ds-enforcer/synonyms.json',
  nativeManifest: null,
  searchModule: null,
  rootPx: 16,
  sources: [],
  exemptFiles: [],
  exemptDirs: ['node_modules', 'vendor', '.git', '.ds-enforcer'],
  rawControlSkip: ['^vendor/', '^node_modules/', '^\\.git/'],
  docs: { web: null, native: null },
  rules: {
    pureBlack: { enabled: false, severity: 'high', message: 'Pure black (#000) is not allowed', suggestion: '' },
    pureWhite: { enabled: false, severity: 'medium', message: 'Pure white backgrounds are not allowed', suggestion: '' },
  },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

/** The directory the user is working in: where init looks and writes. */
export const PROJECT_DIR = resolve(process.env.ENFORCER_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());

function findConfig() {
  if (process.env.ENFORCER_CONFIG) return resolve(process.env.ENFORCER_CONFIG);
  // The nearest enforcer.config.json at or above the project directory, the way git finds .git.
  for (let dir = PROJECT_DIR; ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'enforcer.config.json');
    if (existsSync(candidate) && candidate !== resolve(import.meta.dirname, 'enforcer.config.json')) return candidate;
    if (dirname(dir) === dir) break;
  }
  // The config beside the server belongs to the project the server lives in, and applies only
  // when that project (or a folder inside it) is the one being worked on. Any other project,
  // named by the environment or just the working directory, must never be graded by it.
  const beside = resolve(import.meta.dirname, 'enforcer.config.json');
  if (existsSync(beside)) {
    const root = resolve(import.meta.dirname, JSON.parse(readFileSync(beside, 'utf-8')).projectRoot || '.');
    const rel = relative(root, PROJECT_DIR);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return beside;
  }
  return null;
}

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

/** True when a path resolves inside the project root (the root itself counts). */
export function insideProject(abs) {
  const rel = relative(PROJECT_ROOT, resolve(abs));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
