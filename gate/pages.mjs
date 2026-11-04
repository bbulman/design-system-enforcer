/**
 * Where an entry's markup is hand-written, and how many pages that is. The one rule for the bar a
 * suggested component has to clear: the scan stores each entry's page count with it, the review
 * page shows only the entries at or over the bar, and harvest (scripts/ds-harvest.mjs) neither
 * emails nor builds one under it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findConfig } from '../config-file.js';
import { DEFAULTS, merge, pageRules } from '../config-defaults.js';

/** Pages a pattern has to be hand-written on before it is worth a component. */
export const MIN_PAGES = 3;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The class as a whole token, but not as a CSS selector (".cls" in a style block defines it, it is not markup). */
export const tokenRe = (cls) => new RegExp(`(?<![\\w.-])${escapeRe(cls)}(?![\\w-])`);
const QUOTED = /"[^"\n]*"|'[^'\n]*'/g;
/** Markup carries its classes in quotes (an HTML attribute, a PHP string); a comment that names the class does not. */
const writesClass = (src, re) => (src.match(QUOTED) || []).some((q) => re.test(q));
export const classesOf = (entry) => (Array.isArray(entry.classes) && entry.classes.length ? entry.classes : [entry.name]).filter((c) => /^[a-z][\w-]*$/i.test(c));

/* The project this process works on when a function is given no root, found as config.js finds it. */
const processRoot = () => resolve(process.env.ENFORCER_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());

/*
 * The page rules (componentGate.pages) for a root: its own config when it has one, found the way every
 * command finds it; else, as for no root at all, the config of the project this process works on (a
 * harvest's scratch checkout has none of its own and is held to the project's rules). Read again only
 * when the file changes. Nothing is read when this module loads, so a config that cannot be read never
 * stops an import: the default rules apply, with a note on stderr.
 */
const loaded = new Map();
function rulesFor(root) {
  const at = resolve(root ?? processRoot());
  let path = null, stamp = 'none', componentGate = {};
  try {
    path = findConfig(at) ?? findConfig(processRoot());
    if (path) stamp = `${path}:${statSync(path).mtimeMs}`;
    if (loaded.get(at)?.stamp === stamp) return loaded.get(at).rules;
    if (path) componentGate = JSON.parse(readFileSync(path, 'utf8')).componentGate || {};
  } catch (error) {
    stamp = `broken:${path}`;
    if (loaded.get(at)?.stamp === stamp) return loaded.get(at).rules;
    process.stderr.write(`ds-enforcer: the config for ${at} could not be read (${error.message}), so the default page rules apply.\n`);
    componentGate = {};
  }
  const { types, skip, included, notPages } = pageRules(merge(DEFAULTS.componentGate, componentGate));
  const syncCopy = types.length ? new RegExp(` \\d(?:${types.map(escapeRe).join('|')})$`) : null;
  const any = (res, f) => res.some((re) => re.test(f));
  const rules = {
    isType: (f) => types.some((t) => f.endsWith(t)),
    // The copies and archives that are neither markup nor pages (a sync copy such as "page 2.php" always is one),
    skipped: (f) => Boolean(syncCopy?.test(f)) || any(skip, f),
    // the files another file includes, and markup never counted as a page.
    included: (f) => any(included, f),
    notPage: (f) => any(notPages, f),
  };
  loaded.set(at, { stamp, rules });
  return rules;
}

const isPage = (f, r) => typeof f === 'string' && r.isType(f) && !r.skipped(f) && !r.included(f) && !r.notPage(f);

/** A routable page of the project this process works on: a file of a page type that is not included by another, not one never counted, not an archive or sync copy. */
export const isPageFile = (f) => isPage(f, rulesFor());

/**
 * An entry's files as harvest sees them. markupFiles: the page-type files that write the markup,
 * include partials among them (migrating a partial fixes every page that uses it). pages: the
 * routable ones, neither included by another file nor never counted. CSS is cleaned up alongside
 * the markup; JavaScript copies cannot call a PHP helper.
 */
export function pagesFor(entry, root) {
    const r = rulesFor(root);
    const res = classesOf(entry).map(tokenRe);
    const markupFiles = [];
    for (const f of [...new Set(entry.files || [])]) {
        if (!r.isType(f) || r.skipped(f) || !existsSync(join(root, f))) continue;
        const src = readFileSync(join(root, f), 'utf8');
        if (res.some((re) => writesClass(src, re))) markupFiles.push(f);
    }
    markupFiles.sort();
    const pages = markupFiles.filter((f) => !r.included(f) && !r.notPage(f));
    return { markupFiles, pages };
}

/**
 * Pages the entry is hand-written on. A note an agent described in words names no class to look
 * for, so it counts the pages it was noted on instead.
 */
export const pageCount = (entry, root) => (classesOf(entry).length
    ? pagesFor(entry, root).pages.length
    : [...new Set(entry.files || [])].filter((f) => isPage(f, rulesFor(root))).length);

/** The bar: hand-written on MIN_PAGES pages, or one the reviewer marked should-become, whatever its count. */
export const clearsBar = (entry, pages) => pages >= MIN_PAGES || (Array.isArray(entry?.sources) && entry.sources.includes('bill'));
