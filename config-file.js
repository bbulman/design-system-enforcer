/**
 * Where a project's enforcer.config.json is, and the config format this code reads. Nothing here
 * loads a config, so the commit gate and init can import it before (or without) any config loading.
 *
 * A config file says which format it was written for in configVersion, which is not in config.js
 * DEFAULTS on purpose: a file without it is older than the settings below.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, relative, isAbsolute, dirname } from 'path';

/** The config beside the enforcer's code, where a project that keeps the enforcer inside it (Workshopr) keeps its own. */
export const BESIDE_CONFIG = resolve(import.meta.dirname, 'enforcer.config.json');

/**
 * The config file for a project directory, or null when there is none: the file ENFORCER_CONFIG
 * names; else the nearest enforcer.config.json at or above the directory, the way git finds .git;
 * else the one beside the enforcer, only when the directory is inside that config's projectRoot and
 * that root is a repository (it holds a .git directory, or a .git file in a worktree). Reading the
 * beside config is the only parse here, so a broken copy beside the enforcer throws.
 */
export function findConfig(projectDir) {
  if (process.env.ENFORCER_CONFIG) return resolve(process.env.ENFORCER_CONFIG);
  for (let dir = resolve(projectDir); ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'enforcer.config.json');
    if (existsSync(candidate) && candidate !== BESIDE_CONFIG) return candidate;
    if (dirname(dir) === dir) break;
  }
  // The config beside the server belongs to the project the server lives in, and applies only
  // when that project (or a folder inside it) is the one being worked on. Any other project,
  // named by the environment or just the working directory, must never be graded by it; nor
  // must a folder that merely sits above a copy of the enforcer. The project is a repository,
  // so its root holds .git; whatever its files hold at the moment (a sync tool's renamed copy,
  // a checkout under way), the config still applies, and the loader says what is missing.
  if (existsSync(BESIDE_CONFIG)) {
    const root = resolve(import.meta.dirname, JSON.parse(readFileSync(BESIDE_CONFIG, 'utf-8')).projectRoot || '.');
    const rel = relative(root, resolve(projectDir));
    if (existsSync(resolve(root, '.git')) && (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))) return BESIDE_CONFIG;
  }
  return null;
}

export const CONFIG_VERSION = 3;

/*
 * What moved from the code into the config with each version: before it, the enforcer supplied
 * Workshopr's values itself. Version 3 also switched the small-icon rule off unless iconSize turns it on.
 */
export const MOVED_SETTINGS = {
  2: [
    'components (functionPrefix, classPrefix, extraClassPrefixes, helperFile, sourceDirs, js)',
    'colorTokenChoice', 'homepage', 'rules.pureBlack.native',
    'text (instructions, tools, componentsFooter, noComponent, noColorToken, spacingOffScale, native)',
    'staged (checks, hint, noPhp)',
    'componentGate (skip, reviewUrl, shellParser, reviewer)',
  ],
  3: [
    'iconSize (the small-icon rule, off unless enabled: min, token, retired, glyphClasses, inlineGlyphClasses, doc)',
    'tokenNames (colorOrder, colorWords, appScoped, nativeCore)',
    'componentGate (files, pages, scanSkip)',
    'text.tools (the examples in the gate tools\' descriptions)',
  ],
};

/** True when a parsed config file was written for this code's format. */
export const currentFormat = fromFile => Number(fromFile?.configVersion) >= CONFIG_VERSION;

/**
 * What to say about a config file older than CONFIG_VERSION, given the configVersion it has (none
 * for a file older than version 2). One that init wrote never relied on the settings that moved,
 * and connecting again brings it up to date; one written by hand may have.
 */
export function staleConfigText(path, fromVersion) {
  const from = Number(fromVersion) || 0;
  const moved = Object.entries(MOVED_SETTINGS).filter(([v]) => Number(v) > from).flatMap(([, list]) => list);
  return (from ? `${path} is written for "configVersion": ${from}, older than this enforcer's ${CONFIG_VERSION}. `
    : `${path} has no "configVersion": ${CONFIG_VERSION}, so it reads as older than this enforcer. `)
    + `If \`ds-enforcer init\` wrote it, run init again and connect the same sources: that sets "configVersion": ${CONFIG_VERSION} and keeps the file's other settings (the answers set the sources, rootPx and house rules again). `
    + `If it is written by hand, these settings moved from the enforcer's code into the config, so a file this old has none of them: ${moved.join('; ')}. `
    + `Set the ones the project needs (the README's Configuration table lists each), then set "configVersion": ${CONFIG_VERSION}.`;
}
