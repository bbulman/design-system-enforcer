/**
 * search.mjs: the bundled copy of Workshopr's scripts/ds-search.mjs, reading the
 * catalog and synonyms that enforcer.config.json names. Keep the ranking in step
 * with the original.
 *
 * ds-search.mjs: one ranking for every agent-facing finder.
 *
 * ds:find (scripts/ds-find.mjs) and the design-system-enforcer MCP both import
 * this, so a request ranks the same way whichever one an agent asks. Everything
 * it knows comes from design-system/components.generated.json (components,
 * tokens, legacy) and design-system/synonyms.json; there is no keyword list in
 * code to drift from the catalog.
 *
 * A synonym phrase matches when all its words appear in the request, and only
 * the most specific phrase that matches counts, so "border on soft red" beats
 * the looser "soft red" for a border request.
 *
 * Screen recipes (catalog.recipes) are offered only when the page, screen or flow
 * is what the request asks for: "a confirm dialog" wants ws_modal, "the
 * confirmation flow before deleting" wants the recipe. A screen word that only
 * says where something goes ("a toggle on the settings page") or that qualifies
 * a component ("the page header") asks for the component. Even then a recipe
 * needs a synonym or two distinct words of its own in the request, and it leads
 * only when it scores at least as high as the best component: "an empty page
 * with no workshops" shares one word with the workshop-list recipe and wants
 * ws_empty_state.
 */
import { readFileSync, existsSync } from 'node:fs';
import { config, projectPath } from './config.js';

export function loadCatalog() {
    const catalog = JSON.parse(readFileSync(projectPath(config.catalog), 'utf8'));
    const synPath = config.synonyms && projectPath(config.synonyms);
    const synonyms = synPath && existsSync(synPath) ? JSON.parse(readFileSync(synPath, 'utf8')) : {};
    catalog.components ||= {};
    catalog.tokens ||= {};
    return { catalog, synonyms };
}

const STOP = new Set(['a', 'an', 'the', 'for', 'with', 'to', 'of', 'i', 'need', 'show', 'use', 'on', 'in', 'at',
    'my', 'that', 'this', 'is', 'it', 'and', 'or', 'like', 'some', 'our', 'we', 'user', 'users', 'page', 'want',
    'make', 'add', 'thing', 'something', 'which', 'what', 'when', 'where', 'from', 'by', 'be', 'has', 'have',
    'no', 'not', 'yet', 'are', 'was', 'were', 'been', 'there', 'their', 'they', 'them', 'you', 'your', 'its', 'us',
    'so', 'as', 'than', 'then', 'if', 'but', 'about', 'into', 'can', 'will', 'would', 'should', 'could', 'do', 'does',
    'someone', 'shown']);

/* Function words that still make a synonym phrase specific: "no results" is not "results". */
const PHRASE_KEEP = new Set(['no', 'not', 'yet']);

/* A request for a whole screen rather than one component. */
const SCREEN = new Set(['page', 'pages', 'screen', 'screens', 'flow', 'flows', 'layout', 'layouts', 'recipe', 'recipes']);

/* A request asking how to style something, rather than which component to use. */
const STYLING = new Set(['colour', 'color', 'background', 'fill', 'border', 'padding', 'spacing', 'margin', 'radius',
    'shadow', 'font', 'token', 'red', 'tint', 'wash', 'ring', 'hex', 'ink', 'gap', 'corner', 'corners']);

const stem = word => (word.length > 4 && word.endsWith('ies') ? word.slice(0, -3) + 'y'
    : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

export function words(text, keep = null) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9/]+/g, ' ').split(' ')
        .map(w => w.replace(/\//g, ''))
        .filter(w => w && (!STOP.has(w) || (keep && keep.has(w))))
        .map(stem);
}

/** Best synonym phrase score: every word of the phrase must be in the request (words(request, PHRASE_KEEP)). */
function phraseScore(phrases, requestWords) {
    let best = 0;
    for (const phrase of phrases || []) {
        const pw = words(phrase, PHRASE_KEEP);
        if (pw.length && pw.every(w => requestWords.has(w))) best = Math.max(best, 10 + 10 * pw.length);
    }
    return best;
}

function textHits(text, requestWords, weight) {
    const have = new Set(words(text));
    let n = 0;
    for (const w of requestWords) if (have.has(w)) n += weight;
    return n;
}

const SCOPE_WEIGHT = { component: 1, page: 1, 'app-local': 0.4 };
const TIER_BONUS = { brand: 4, semantic: 1, primitive: 0, alias: -6 };
/* A helper that returns data rather than markup (ws_workshop_list_fetch) is never what a UI request asks for. */
const RETURNS_DATA = /\):\s*\??(?:array|bool|int|float)\b/;

/** Components ranked for a request: [{ name, score, reason, ...entry }]. */
export function rankComponents(query, { catalog, synonyms }, limit = 5) {
    const q = String(query || '').trim().toLowerCase();
    const requestWords = new Set(words(q));
    const phraseWords = new Set(words(q, PHRASE_KEEP));
    const out = [];
    for (const [name, c] of Object.entries(catalog.components)) {
        const title = words(name.replace(/^ws_/, '').replaceAll('_', ' '));
        let score = name === q ? 100 : 0;
        const phrase = phraseScore(synonyms.components?.[name], phraseWords);
        score += phrase;
        score += title.filter(w => requestWords.has(w)).length * 8;
        score += textHits(c.summary, requestWords, 3);
        score += textHits(`${c.context || ''} ${c.whenToUse || ''}`, requestWords, 1);
        score *= SCOPE_WEIGHT[c.scope] ?? 1;
        if (RETURNS_DATA.test(c.signature || '')) score *= 0.25;
        if (score <= 0) continue;
        out.push({ name, score, reason: phrase ? 'matches how people describe it' : 'matches its name or usage', ...c });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Tokens ranked for a styling request: [{ name, score, ...token }]. Legacy aliases rank last. */
export function rankTokens(query, { catalog, synonyms }, limit = 5) {
    const q = String(query || '').trim().toLowerCase();
    const requestWords = new Set(words(q));
    const phraseWords = new Set(words(q, PHRASE_KEEP));
    const out = [];
    for (const [name, t] of Object.entries(catalog.tokens || {})) {
        let score = name === q ? 100 : 0;
        const phrase = phraseScore(synonyms.tokens?.[name], phraseWords);
        score += phrase;
        score += words(name.replace(/^--/, '').replaceAll('-', ' ')).filter(w => requestWords.has(w)).length * 4;
        score += textHits(t.purpose, requestWords, 2);
        if (score <= 0) continue;
        score += TIER_BONUS[t.tier] ?? 0;
        if (score <= 0) continue;
        out.push({ name, score, ...t });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/* Words that put a screen word in a place phrase: "on the settings page", "top of a page". */
const LOCATIVE = new Set(['on', 'in', 'at', 'inside', 'within', 'onto', 'into', 'across', 'throughout', 'of', 'for',
    'from', 'to', 'under', 'above', 'below', 'beside', 'near', 'atop']);

/* Words that end the noun phrase in front of a screen word, so no place word further back reaches it. */
const PHRASE_BREAK = new Set(['with', 'where', 'that', 'which', 'who', 'when', 'and', 'or', 'but', 'before', 'after', 'while', 'need', 'want', 'build', 'make', 'show', 'add', 'is', 'are']);

/** The last word of each component name ("header" for ws_header, "card" for ws_listing_card). */
function componentHeads(catalog) {
    const heads = new Set();
    for (const [name, c] of Object.entries(catalog?.components || {})) {
        if (c.scope === 'app-local') continue;
        const parts = name.replace(/^ws_/, '').replace(/_(start|end)$/, '').split('_');
        heads.add(stem(parts[parts.length - 1]));
    }
    return heads;
}

/**
 * Is a page, screen or flow the thing the request asks for? Only when a screen
 * word heads its own phrase: not after a place word ("a modal on the settings
 * page") and not before a component it qualifies ("the page header").
 */
export function isScreenRequest(query, data) {
    const raw = String(query || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const heads = componentHeads(data?.catalog);
    return raw.some((w, i) => {
        if (!SCREEN.has(w)) return false;
        if (raw[i + 1] && heads.has(stem(raw[i + 1]))) return false;
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
            if (PHRASE_BREAK.has(raw[j])) break;
            if (LOCATIVE.has(raw[j])) return false;
        }
        return true;
    });
}

/* A screen word heading the request is the evidence a one-word synonym gives that a screen, not a component, is wanted. */
const SCREEN_HEAD = 20;

/**
 * Recipes ranked for a screen-level request: [{ name: 'recipe:<id>', id, score, ...recipe }].
 * Empty for any other request. The screen word scores SCREEN_HEAD for every
 * recipe alike, so it never separates one recipe from another, and each other
 * word counts once: 8 when the title has it, else 2 when the usage does.
 */
export function rankRecipes(query, { catalog, synonyms }, limit = 2) {
    if (!isScreenRequest(query, { catalog })) return [];
    const requestWords = new Set(words(query).filter(w => !SCREEN.has(w)));
    const phraseWords = new Set(words(query, PHRASE_KEEP).filter(w => !SCREEN.has(w)));
    const out = [];
    for (const [id, r] of Object.entries(catalog.recipes || {})) {
        const phrase = phraseScore(synonyms.recipes?.[id], phraseWords);
        const title = new Set(words(r.title));
        const usage = new Set(words(r.whenToUse));
        const shared = [...requestWords].filter(w => title.has(w) || usage.has(w));
        // One shared word ("workshop", "section") is coincidence; a synonym or two distinct words is a match.
        if (!phrase && shared.length < 2) continue;
        const score = SCREEN_HEAD + phrase + shared.reduce((n, w) => n + (title.has(w) ? 8 : 2), 0);
        out.push({ name: `recipe:${id}`, id, score, ...r });
    }
    return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Recipes merged into a ranking of components (and tokens): a recipe leads only
 * when it scores at least as high as the best component, and otherwise takes its
 * place by score. Items are sorted by score, then name.
 */
export function placeRecipes(recipes, ranked) {
    const top = Math.max(0, ...ranked.filter(x => x.kind === 'component').map(x => x.score));
    const key = x => x.name ?? x.component ?? '';
    const lead = recipes.filter(r => r.score >= top);
    const rest = [...ranked, ...recipes.filter(r => r.score < top)].sort((a, b) => b.score - a.score || key(a).localeCompare(key(b)));
    return [...lead, ...rest];
}

/** Does the request ask about styling (a token) rather than a component? */
export function isStylingRequest(query) {
    return words(query).some(w => STYLING.has(w));
}

/**
 * Components and tokens in one ranking, for ds:find. Tokens only lead a styling
 * request; a matching recipe leads a screen-level one when it outscores the
 * components.
 */
export function search(query, data = loadCatalog(), limit = 5) {
    const recipes = rankRecipes(query, data).map(r => ({ kind: 'recipe', ...r }));
    const styling = isStylingRequest(query);
    const comps = rankComponents(query, data, limit).map(c => ({ kind: 'component', ...c }));
    // Outside a styling request a token needs a synonym phrase match to appear at all.
    const toks = rankTokens(query, data, limit)
        .filter(t => styling || t.score >= 30)
        .map(t => ({ kind: 'token', ...t, score: styling ? t.score : t.score * 0.25 }));
    const ranked = [...comps, ...toks].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return placeRecipes(recipes, ranked).slice(0, limit);
}

/** The legacy lookalike a component replaces, if the catalog lists one. */
export function legacyFor(name, { catalog }) {
    return (catalog.legacy?.classes || []).filter(l => l.use === name);
}

const ORDINAL = ['1st', '2nd', '3rd'];

/**
 * The values and defaults the catalog documents, one line per option
 * ("variant: a | b (default \"a\")"), led by any positional argument with a
 * fixed set of values ("$status, 2nd argument: success | info (default \"info\")").
 */
export function optionSummary(entry) {
    const line = (label, o) => {
        const values = Array.isArray(o.values) ? o.values.join(' | ') : null;
        const def = o.default !== undefined && o.default !== null ? JSON.stringify(o.default) : null;
        const notes = [!values && o.type ? o.type : null, def !== null ? `default ${def}` : null].filter(Boolean);
        return `${label}${values ? `: ${values}` : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    };
    const positional = (entry.params || [])
        .filter(p => Array.isArray(p.values) && Number.isInteger(p.position))
        .map(p => line(`${p.name}, ${ORDINAL[p.position] || `${p.position + 1}th`} argument`, p));
    // Every option, including those with no default: dropping them hid ws_agent_proposal's
    // title, why, adjust and returnFocus, and builders had to dig them out of the JSON.
    const options = Object.entries(entry.optionSpec || {}).map(([key, o]) => line(key, o));
    return [...positional, ...options];
}
