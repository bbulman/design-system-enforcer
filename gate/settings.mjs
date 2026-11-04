/**
 * Component gate settings, where its state lives, and the JSON read and write
 * every gate module shares. The gate is opt-in: componentGate.enabled in the
 * project's enforcer.config.json.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, DEFAULTS, merge, projectPath, PROJECT_ROOT } from '../config.js';
import { compilePatterns as compile, fileTypes, pageRules } from '../config-defaults.js';

const shellWord = p => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const BIN = fileURLToPath(new URL('../bin/ds-enforcer.mjs', import.meta.url));
/** The enforcer's command line as a message gives it: by its full path, so it runs from any folder. */
export const ENFORCER_CLI = `node ${shellWord(BIN)}`;

/**
 * The enforcer's command line as a tool description gives it, to run from the project root: by its
 * path from the project when the enforcer sits inside it, else by its full path (ENFORCER_CLI).
 */
export function projectCli() {
  const rel = relative(PROJECT_ROOT, BIN);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `node ${shellWord(rel.split(sep).join('/'))}` : ENFORCER_CLI;
}



export function gateSettings() {
  const g = merge(DEFAULTS.componentGate, config.componentGate);
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const gated = fileTypes(g.files?.gate);
  return {
    enabled: g.enabled === true,
    autoSwap: g.autoSwap === true,
    minScore: num(g.minScore),
    clearMargin: num(g.clearMargin),
    skip: compile(g.skip),
    // The review page's link for messages and the summary; null when the project has none.
    reviewUrl: g.reviewUrl ? String(g.reviewUrl) : null,
    // The module that finds a shell command's write targets; with none, Bash is not gated.
    shellParser: typeof g.shellParser === 'string' && g.shellParser ? g.shellParser : null,
    // Who decides the cases on the review page, as messages name them.
    reviewer: typeof g.reviewer === 'string' && g.reviewer.trim() ? g.reviewer.trim() : DEFAULTS.componentGate.reviewer,
    // The file types the gate holds to a consult, and those whose lookalikes it only reports (gate/markup.mjs).
    gated: new Set(gated),
    detected: new Set(fileTypes(g.files?.detect)),
    // Where a suggested component's markup counts as a page (gate/pages.mjs).
    pages: pageRules(g),
    // Files the suggestion scan never reads, beyond skip.
    scanSkip: compile(g.scanSkip),
  };
}

/** The gate's file types as messages name them: { gated: ".php or .css", detected: ".js and .html" } (detected empty when none). */
export function fileTypesText(settings = gateSettings()) {
  const list = (set, word) => { const l = [...(set || [])]; return l.length > 1 ? `${l.slice(0, -1).join(', ')} ${word} ${l.at(-1)}` : l.join(''); };
  return { gated: list(settings.gated ?? DEFAULTS.componentGate.files.gate, 'or'), detected: list(settings.detected ?? DEFAULTS.componentGate.files.detect, 'and') };
}

/** A name at the start of a sentence: "the reviewer" as "The reviewer". */
export const sentenceStart = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** Read at call time, so a test or hook can point it elsewhere through the environment. */
export function stateDir() {
  const env = process.env.DS_ENFORCER_STATE_DIR;
  return env ? resolve(env) : projectPath('.ds-enforcer');
}

/** The parsed file, or the fallback when it is missing or not valid JSON. */
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** The temp file sits beside the target: rename is only atomic within one filesystem. */
export function writeJsonAtomic(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/* Hooks share a 500 ms budget, so waiting is capped; a lock older than STALE_MS is taken to
   belong to a killed hook. */
const WAIT_CAP_MS = 200;
const STALE_MS = 2000;
const POLL_MS = 3;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** mkdir is an exclusive create on every filesystem. False means the cap was hit: proceed unlocked. */
function lock(path) {
  const start = Date.now();
  for (;;) {
    try { mkdirSync(path); return true; } catch (error) {
      if (error.code !== 'EEXIST') return false;
    }
    if (Date.now() - start >= WAIT_CAP_MS) return false;
    let stale;
    try { stale = Date.now() - statSync(path).mtimeMs > STALE_MS; } catch { continue; }
    if (stale) { try { rmdirSync(path); } catch { /* another hook reclaimed it first */ } continue; }
    pause(POLL_MS);
  }
}

/** Run fn holding the directory lock at lockPath, since each hook and tool call is a separate process. */
export function withFileLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const held = lock(lockPath);
  try { return fn(); } finally {
    if (held) try { rmdirSync(lockPath); } catch { /* already reclaimed as stale */ }
  }
}
