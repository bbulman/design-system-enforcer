/**
 * Suggested new components, in <state>/suggestions.json: bespoke patterns the
 * codebase keeps repeating with no component in the inventory, pieces agents
 * built with nothing fitting, and the cases Bill marked "should become a
 * component". The review page writes the same file (Dismiss, Build this) under
 * the same lock; a dismissed id never comes back, and the build and announced
 * lists belong to the page and the end-of-session summary. Each entry carries the
 * number of pages its markup is hand-written on (gate/pages.mjs), and the file
 * carries the bar (minPages) the review page and harvest hold it to.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT, config, escapeRe } from '../config.js';
import { loadCatalog, rankComponents, words } from '../search.mjs';
import { gateSettings, stateDir, readJson, writeJsonAtomic, withFileLock } from './settings.mjs';
import { KIND, loadQueue, staticSample } from './queue.mjs';
import { MIN_PAGES, clearsBar, pageCount } from './pages.mjs';

const WORDS = 'badge|pill|chip|card|tile|toast|modal|dialog|tabs?|empty|toggle|avatar|alert|banner|tooltip|skeleton|stat|stats|meter|stepper|tag|callout|drawer|popover|menu|dropdown|timeline|progress|notice|kpi|rating|counter|hero|panel|sheet|list|row|accordion|breadcrumb|pager|pagination|search|filter|chart';
/* A bespoke class: a component word at the end, and not the project's own prefix (components.classPrefix). */
let bespokeRe = { prefix: undefined, re: null };
function bespokePattern() {
  const prefix = config.components.classPrefix || null;
  if (bespokeRe.prefix !== prefix) bespokeRe = { prefix, re: new RegExp(`^${prefix ? `(?!${escapeRe(prefix)})` : ''}[a-z][a-z0-9-]*-(${WORDS})$`) };
  return bespokeRe.re;
}
const COMPONENT_WORD = new RegExp(`^(${WORDS})$`);
const CLASS_USE = /(?<![\w-])class(?:Name)?\s*=\s*\\?["'`]([^"'`\\]*)/g;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SELECTOR = /(?:^|[\s,}])\.([a-z][a-z0-9-]*)(?=[\s{:,.>+~[])/g;
/* Words that name a layout rather than one piece: test-list, a chart legend's distribution-list and a
   reading-list have nothing in common to build. */
const STRUCTURAL = new Set(['list', 'row', 'panel', 'sheet']);
/* Never a source of suggestions: a sync copy ("page 2.php"), vendored and minified code, and what the project adds (componentGate.scanSkip). */
const NOT_SOURCE = [/ \d\.(php|css|js)$/, /(^|\/)vendor\//, /node_modules/, /\.min\./];

const MIN_FILES = 3;
const MIN_CLASSES = 3;
const EXAMPLES = 5;
const REASONS = 5;
const CLOSEST = 3;
/* A word in a component's usage notes scores one point; its name, summary or synonyms score three or more. */
const CLOSE = 3;
/* A consult lists at most five candidates. A word the catalogue ranks more components for than
   that ("card" ranks 13) does not say which one fits, so the rest of the class name has to. */
const SPECIFIC = 5;
const SOURCES = ['scan', 'case', 'bill'];

export class SuggestInputError extends Error {}

const sid = key => 'S-' + createHash('sha1').update(key).digest('hex').slice(0, 6);
const wordOf = cls => bespokePattern().exec(cls)?.[1] ?? cls.split('-').pop().toLowerCase();
// A modifier (--) or a state (is-open) is never the block that names a piece.
const bespoke = cls => bespokePattern().test(cls) && !cls.includes('--') && !/^(is|has|no)-/.test(cls) && !STRUCTURAL.has(wordOf(cls));
const familyOf = cls => `${cls.split('-')[0]}-*-${wordOf(cls)}`;
const lineAt = (content, at) => content.slice(0, at).split('\n').length;
const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);

function trackedFiles(root, paths, skip) {
  const notSource = [...NOT_SOURCE, ...gateSettings().scanSkip];
  const specs = (paths ?? []).map(p => {
    const rel = relative(root, resolve(root, String(p)));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new SuggestInputError(`Refused: ${p} is outside the project (${root}).`);
    return rel || '.';
  });
  return execFileSync('git', ['ls-files', '-z', '--', ...specs], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\0')
    .filter(f => /\.(php|css|js)$/.test(f) && !notSource.some(re => re.test(f)) && !skip.some(re => re.test(f)));
}

/** class -> file -> { uses, use, def }: markup uses, and the offset of the first use and the first CSS definition. */
function collect(root, files) {
  const found = new Map();
  const at = (cls, file) => {
    const perFile = found.get(cls) ?? found.set(cls, new Map()).get(cls);
    return perFile.get(file) ?? perFile.set(file, { uses: 0, use: null, def: null }).get(file);
  };
  for (const file of files) {
    let src;
    try { src = readFileSync(join(root, file), 'utf8'); } catch { continue; } // deleted since it was tracked
    const isCss = file.endsWith('.css');
    if (!isCss) {
      for (const m of src.matchAll(CLASS_USE)) {
        const start = m.index + m[0].length - m[1].length;
        for (const t of m[1].matchAll(/\S+/g)) {
          if (!bespoke(t[0])) continue;
          const e = at(t[0], file);
          e.uses++;
          e.use ??= start + t.index;
        }
      }
    }
    const sheets = isCss ? [[src, 0]] : [...src.matchAll(STYLE_BLOCK)].map(m => [m[1], m.index + m[0].indexOf('>') + 1]);
    for (const [css, offset] of sheets) {
      for (const m of css.matchAll(SELECTOR)) {
        if (!bespoke(m[1])) continue;
        const e = at(m[1], file);
        e.def ??= offset + m.index + m[0].indexOf('.');
      }
    }
  }
  return found;
}

/* Distinct helpers, a _start and _end pair shown as its helper (ws_card_start as ws_card). */
function closestTo(query, data) {
  const out = [];
  for (const c of rankComponents(query, data, 10)) {
    if (c.score < CLOSE) break;
    const base = c.name.replace(/_(start|end)$/, '');
    const name = data.catalog.components[base] ? base : c.name.replace(/_end$/, '_start');
    if (!out.includes(name)) out.push(name);
    if (out.length === CLOSEST) break;
  }
  return out;
}

/**
 * Bespoke classes no component covers: one defined or used in MIN_FILES files or more, a family of
 * them (named "solo-*-card"), and one component word spread over MIN_CLASSES bespoke classes or more
 * that have no entry of their own (named "-menu"). A class is covered when the catalogue has a
 * component for the rest of its name (stat-card: ws_stat) or, unless the word names too many to
 * choose from, for its word (share-modal: ws_modal); a word, when it ranks any component at all.
 * files are pathspecs under root; with none, every tracked file.
 */
export function scanSuggestions({ root = PROJECT_ROOT, files, data = loadCatalog(), minScore = gateSettings().minScore, skip = gateSettings().skip, now = new Date() } = {}) {
  const found = collect(root, trackedFiles(root, files, skip));
  const floor = minScore ?? 0;
  const ranked = new Map();
  const fits = query => {
    if (!ranked.has(query)) ranked.set(query, rankComponents(query, data, SPECIFIC + 1).filter(c => c.score >= floor).length);
    return ranked.get(query);
  };
  const places = perFile => [...perFile.values()].reduce((n, e) => n + Math.max(e.uses, 1), 0);
  const contents = new Map();
  const read = file => {
    if (!contents.has(file)) { try { contents.set(file, readFileSync(join(root, file), 'utf8')); } catch { contents.set(file, ''); } }
    return contents.get(file);
  };
  // A markup example first: the page renders the first example's sample.
  const example = (cls, file) => {
    const e = found.get(cls).get(file);
    const content = read(file);
    const line = lineAt(content, e.use ?? e.def);
    return { file, line, cls, sample: staticSample(content.split('\n').slice(line - 1, line + 2).join('\n')) };
  };
  const filesOf = cls => [...found.get(cls).entries()].sort(([a, x], [b, y]) => (y.uses > 0) - (x.uses > 0) || a.localeCompare(b)).map(([f]) => f);
  const busiestFirst = classes => [...classes].sort((a, b) => places(found.get(b)) - places(found.get(a)) || a.localeCompare(b));
  const suggestion = (name, word, members) => {
    const classes = busiestFirst(members);
    return {
      id: sid(name),
      name,
      word,
      count: classes.reduce((n, cls) => n + places(found.get(cls)), 0),
      files: [...new Set(classes.flatMap(cls => [...found.get(cls).keys()]))].sort(),
      classes,
      // One class: its first places. Several: each class's first place, the busiest first.
      examples: classes.length === 1
        ? filesOf(classes[0]).slice(0, EXAMPLES).map(f => example(classes[0], f))
        : classes.slice(0, EXAMPLES).map(cls => example(cls, filesOf(cls)[0])),
      closest: closestTo((classes.length > 1 && !name.startsWith('-') ? classes[0] : name).replace(/-/g, ' '), data),
      sources: ['scan'],
      first: now.toISOString(),
    };
  };

  const uncovered = [];
  const byWord = new Map();
  for (const [cls, perFile] of found) {
    const word = wordOf(cls);
    (byWord.get(word) ?? byWord.set(word, []).get(word)).push(cls);
    if (perFile.size < MIN_FILES) continue;
    const forWord = fits(word);
    if (fits(cls.slice(0, -(word.length + 1))) || (forWord && forWord <= SPECIFIC)) continue;
    uncovered.push(cls);
  }

  // A family shares its prefix and its word, and each class shares a page with another:
  // solo-exercise-card and solo-tip-card. Classes that only share pages are different pieces of one page.
  const out = [];
  const owned = new Set();
  const byFamily = new Map();
  for (const cls of uncovered) (byFamily.get(familyOf(cls)) ?? byFamily.set(familyOf(cls), []).get(familyOf(cls))).push(cls);
  for (const [family, classes] of byFamily) {
    const groups = [];
    for (const cls of classes.sort()) {
      const files = new Set(found.get(cls).keys());
      const touching = groups.filter(g => g.some(other => [...found.get(other).keys()].some(f => files.has(f))));
      const merged = [cls, ...touching.flat()];
      for (const g of touching) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
    for (const group of groups) {
      out.push(group.length === 1 ? suggestion(group[0], wordOf(group[0]), group) : suggestion(family, wordOf(group[0]), group));
      for (const cls of group) owned.add(cls);
    }
  }
  // A word entry is the spread a word has beyond the classes listed on their own.
  for (const [word, all] of byWord) {
    const classes = all.filter(cls => !owned.has(cls));
    if (classes.length < MIN_CLASSES || fits(word)) continue;
    out.push(suggestion(`-${word}`, word, classes));
  }
  return out.sort(byCount);
}

/* The class a finding names, else the piece in the agent's words; two wordings of one piece share a key. */
function describe(c) {
  const cls = typeof c.finding === 'string' ? c.finding.split('|').slice(2).join('|') : '';
  if (cls) return { key: cls, name: cls, word: wordOf(cls), cls };
  const description = typeof c.piece?.description === 'string' ? c.piece.description.trim().replace(/\s+/g, ' ') : '';
  if (!description) return null;
  const said = words(description);
  return { key: said.join(' ') || description.toLowerCase(), name: description, word: said.filter(w => COMPONENT_WORD.test(w)).pop() ?? null, cls: null };
}

function caseSuggestions(cases, data, now) {
  const groups = new Map();
  const ordered = [...cases].sort((a, b) => String(a.created).localeCompare(String(b.created)));
  for (const c of ordered) {
    const fromCase = c.kind === KIND.NONE && c.decision !== 'fine';
    const fromBill = c.decision === 'should-become';
    const piece = (fromCase || fromBill) && describe(c);
    if (!piece) continue;
    const g = groups.get(piece.key) ?? groups.set(piece.key, { ...piece, cases: [], from: new Set() }).get(piece.key);
    g.cases.push(c);
    if (fromCase) g.from.add('case');
    if (fromBill) g.from.add('bill');
  }
  return [...groups.values()].map(g => {
    const placed = g.cases.filter(c => typeof c.file === 'string' && c.file);
    return {
      id: sid(g.key),
      name: g.name,
      word: g.word,
      count: g.cases.length,
      files: [...new Set(placed.map(c => c.file))].sort(),
      ...(g.cls ? { classes: [g.cls] } : {}),
      examples: placed.slice(0, EXAMPLES).map(c => ({
        file: c.file,
        line: Number.isInteger(c.line) ? c.line : null,
        cls: g.cls,
        sample: staticSample(typeof c.sample === 'string' && c.sample ? c.sample : c.markup),
      })),
      closest: closestTo(g.cls ? g.cls.replace(/-/g, ' ') : g.name, data),
      sources: SOURCES.filter(s => g.from.has(s)),
      reasons: reasonsOf(g.cases.map(c => c.reason)),
      first: now.toISOString(),
    };
  });
}

const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
const reasonsOf = list => [...new Set(strings(list).map(r => r.trim()).filter(Boolean))].slice(0, REASONS);

/* The page never writes over a file it cannot parse, since it may hold the only copy of Bill's dismissals; nor does this. */
function readStored(path) {
  if (!existsSync(path)) return { raw: {}, lastScan: null, entries: [], dismissed: [], build: [], announced: [] };
  const raw = readJson(path, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} could not be read, so it was left as it is. Fix or remove it, then run the scan again.`);
  const entries = Array.isArray(raw.entries) ? raw.entries.filter(e => e && typeof e === 'object' && typeof e.id === 'string') : [];
  return { raw, lastScan: typeof raw.lastScan === 'string' ? raw.lastScan : null, entries, dismissed: strings(raw.dismissed), build: strings(raw.build), announced: strings(raw.announced) };
}

const sameDay = (iso, now) => {
  const at = new Date(iso ?? NaN);
  return !Number.isNaN(at.getTime()) && at.toDateString() === now.toDateString();
};

/**
 * Merge the scan with the queue's nothing-fitting cases and should-become decisions into
 * suggestions.json, and return the ids that were not listed before, with the entries now listed.
 * The scan runs at most once per calendar day unless force; on a later run that day the day's
 * scan entries are kept as they are. Where a case names a class a scan entry holds, the scan's
 * places and examples stand and the case adds its source and reason. Throws when the file exists but cannot
 * be read, and leaves it untouched.
 */
export function refreshSuggestions({ dir = stateDir(), force = false, root = PROJECT_ROOT, data, minScore = gateSettings().minScore, scan = scanSuggestions, now = new Date() } = {}) {
  const path = join(dir, 'suggestions.json');
  const due = force || !sameDay(readStored(path).lastScan, now);
  data ??= loadCatalog();
  // The scan reads every tracked file, so it runs before the lock the review page also waits on.
  const scanned = due ? scan({ root, data, minScore, now }) : null;
  return withFileLock(join(dir, 'suggestions.lock'), () => {
    const stored = readStored(path);
    const merged = new Map();
    const owner = new Map();
    // A stored entry's reasons came from the cases, which are merged again below.
    for (const { reasons, ...e } of scanned ?? stored.entries.filter(e => strings(e.sources).includes('scan'))) {
      merged.set(e.id, { ...e, sources: ['scan'] });
      for (const cls of strings(e.classes)) owner.set(cls, e.id);
    }
    for (const e of caseSuggestions(loadQueue(dir), data, now)) {
      const id = strings(e.classes).map(cls => owner.get(cls)).find(Boolean) ?? e.id;
      const listed = merged.get(id);
      // An agent's note on its own is one place, not a pattern: it becomes an entry once the piece is
      // noted on MIN_PAGES pages, or when Bill marks it should-become. On a scan entry it adds its reason.
      if (!listed && !clearsBar(e, pageCount(e, root))) continue;
      merged.set(id, listed ? {
        ...listed,
        sources: SOURCES.filter(s => listed.sources.includes(s) || e.sources.includes(s)),
        reasons: reasonsOf([...strings(listed.reasons), ...e.reasons]),
      } : e);
    }
    const dismissed = new Set(stored.dismissed);
    // A family keeps the id of its pattern while its classes come and go, so a dismissal also holds
    // through a family shrinking to one class, and a dismissed class keeps out the family it joins.
    const gone = e => dismissed.has(e.id) || (!e.name.startsWith('-') && strings(e.classes).some(cls => dismissed.has(sid(cls)) || dismissed.has(sid(familyOf(cls)))));
    const before = new Map(stored.entries.map(e => [e.id, e]));
    const entries = [...merged.values()]
      .filter(e => !gone(e))
      .map(e => ({ ...e, pages: pageCount(e, root), first: typeof before.get(e.id)?.first === 'string' ? before.get(e.id).first : e.first }))
      .sort(byCount);
    writeJsonAtomic(path, {
      ...stored.raw,
      lastScan: due ? now.toISOString() : stored.lastScan,
      minPages: MIN_PAGES,
      entries,
      dismissed: stored.dismissed,
      build: stored.build,
      announced: stored.announced,
    });
    return { added: entries.filter(e => !before.has(e.id)).map(e => e.id), entries };
  });
}

/** The ids Bill dismissed, so a scan of named paths does not offer them again; none when the file cannot be read. */
export function dismissedIds(dir = stateDir()) {
  return new Set(strings(readJson(join(dir, 'suggestions.json'), null)?.dismissed));
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
/* 'bill' is the source key the review page writes for a should-become decision; the label is the reviewer's name. */
const foundBy = () => ({ scan: 'the codebase scan', case: "an agent's case", bill: gateSettings().reviewer });
const SHOWN = 20;

/** The entries, the most used first, and where to review them. scope names the paths of a scan that was not saved. */
export function formatSuggestions(entries, { reviewUrl = gateSettings().reviewUrl, scope = null } = {}) {
  // Without a review page link (componentGate.reviewUrl), the lines name the page and stop.
  const at = reviewUrl ? `: ${reviewUrl}?area=suggested` : '.';
  const where = scope ? ` in ${scope}` : '';
  const lines = [];
  if (!entries.length) lines.push(`No new components suggested${where}.`, '');
  else lines.push(`Suggested new components${where}, the most used first:`, '');
  const ranked = [...entries].sort(byCount);
  const FOUND_BY = foundBy();
  for (const e of ranked.slice(0, SHOWN)) {
    const files = Array.isArray(e.files) ? e.files.length : 0;
    const by = strings(e.sources).map(s => FOUND_BY[s]).filter(Boolean);
    // A saved entry carries its page count; one under the bar is not offered on the review page or built.
    const pages = Number.isInteger(e.pages) ? `, on ${plural(e.pages, 'page')}${clearsBar(e, e.pages) ? '' : ' (under the bar)'}` : '';
    lines.push(`${e.id}  ${e.name}: ${plural(e.count, 'place')} in ${plural(files, 'file')}${pages}, found by ${by.join(' and ') || 'the scan'}.`);
    const classes = strings(e.classes);
    if (classes.length > 1) lines.push(`  Classes: ${classes.slice(0, 8).join(', ')}${classes.length > 8 ? ` and ${classes.length - 8} more` : ''}`);
    const closest = strings(e.closest);
    lines.push(closest.length ? `  Closest components: ${closest.join(', ')}` : '  No component ranks clearly above a passing mention.');
    const examples = (Array.isArray(e.examples) ? e.examples : []).filter(x => typeof x?.file === 'string');
    if (examples.length) lines.push(`  Where it appears: ${examples.map(x => (Number.isInteger(x.line) ? `${x.file}:${x.line}` : x.file)).join(', ')}`);
    lines.push('');
  }
  if (ranked.length > SHOWN) lines.push(`${ranked.length - SHOWN} more on the review page.`, '');
  lines.push(scope
    ? `This scan of ${scope} was not saved. Run it with no paths to refresh the list on the review page${at}`
    : `Dismiss them, or mark one on ${MIN_PAGES} pages or more Build this, on the review page${at}`);
  return lines.join('\n');
}
