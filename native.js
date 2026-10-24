/**
 * Native apps: the `native` block of design-system/workshopr-design-system.json,
 * each app's theme constants, and the web token each constant mirrors.
 *
 * A web token's value comes from the catalog (components.generated.json,
 * tokens[name].resolved ?? value), never from platform-tokens.css: the CSS
 * redeclares some tokens under @media (prefers-contrast: more), so its last
 * declaration is not the root value.
 *
 * Nothing loads at import time: validators.js imports this module, and callers
 * that never see a .swift file should not pay for reading the apps.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, relative, isAbsolute, sep } from 'path';

import { PROJECT_ROOT, config, projectPath } from './config.js';
export { PROJECT_ROOT };
/* Read per call: init can connect a project after the server started. No manifest means no native apps. */
const MANIFEST = () => (config.nativeManifest ? projectPath(config.nativeManifest) : null);
const CATALOG = () => projectPath(config.catalog);

/** Project-relative, forward-slashed path for an absolute or project-relative one. */
export function relPath(filePath) {
  const abs = isAbsolute(filePath) ? filePath : resolve(PROJECT_ROOT, filePath);
  return relative(PROJECT_ROOT, abs).split(sep).join('/');
}

// ─── Swift source scanning ───

/**
 * Swift source with comments blanked (newlines kept, so lines stay exact) as
 * `code`; the same with string literals and their interpolations blanked too as
 * `skel`, for counting braces; and each line's `//` comment as { text, afterCode }.
 * Handles nested block comments, multi-line and raw (#"..."#) strings.
 */
export function scanSwift(src) {
  let code = '', skel = '';
  const comments = new Map();
  const n = src.length;
  let line = 0, hasCode = false, inString = 0;

  const emit = (ch, comment = false) => {
    if (ch === '\n') { code += '\n'; skel += '\n'; line++; hasCode = false; return; }
    if (comment) { code += ' '; skel += ' '; return; }
    code += ch;
    skel += inString ? ' ' : ch;
    if (!/\s/.test(ch)) hasCode = true;
  };

  function comment(i) {
    if (src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      if (!inString) comments.set(line, { text: src.slice(i + 2, end), afterCode: hasCode });
      for (let j = i; j < end; j++) emit(src[j], true);
      return end;
    }
    let depth = 0, j = i;
    while (j < n) {
      if (src.startsWith('/*', j)) { depth++; emit('/', true); emit('*', true); j += 2; continue; }
      if (src.startsWith('*/', j)) { depth--; emit('*', true); emit('/', true); j += 2; if (depth === 0) break; continue; }
      emit(src[j], true);
      j++;
    }
    return j;
  }

  function string(i) {
    let hashes = 0;
    while (src[i + hashes] === '#') hashes++;
    const q = i + hashes;
    const multi = src.startsWith('"""', q);
    const close = (multi ? '"""' : '"') + '#'.repeat(hashes);
    const esc = '\\' + '#'.repeat(hashes);
    inString++;
    let j = i;
    for (; j < q + (multi ? 3 : 1); j++) emit(src[j]);
    while (j < n) {
      if (src.startsWith(esc, j)) {
        const after = j + esc.length;
        for (let k = j; k <= after && k < n; k++) emit(src[k]);
        j = src[after] === '(' ? scan(after + 1, true) : after + 1;
        continue;
      }
      if (src.startsWith(close, j)) {
        for (let k = 0; k < close.length; k++) emit(src[j + k]);
        j += close.length;
        break;
      }
      if (!multi && src[j] === '\n') break;
      emit(src[j]);
      j++;
    }
    inString--;
    return j;
  }

  function scan(i, untilParen) {
    let depth = 0;
    while (i < n) {
      const ch = src[i];
      if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = comment(i); continue; }
      if (ch === '"' || (ch === '#' && /^#+"/.test(src.slice(i, i + 6)))) { i = string(i); continue; }
      if (untilParen) {
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) { emit(ch); return i + 1; }
          depth--;
        }
      }
      emit(ch);
      i++;
    }
    return i;
  }

  scan(0, false);
  return { code, skel, comments };
}

/** The `--token` names a trailing comment opens with, e.g. "// --bg-surface / --card-bg". */
export function annotationTokens(comment) {
  if (!comment || !comment.afterCode) return null;
  const m = /^\s*(--[A-Za-z0-9-]+(?:\s*\/\s*--[A-Za-z0-9-]+)*)/.exec(comment.text);
  return m ? m[1].split('/').map(s => s.trim()) : null;
}

// ─── Colour literals ───

const NUM = String.raw`\d+(?:\.\d+)?`;
const CH = String.raw`(${NUM})(?:\s*\/\s*(${NUM}))?`;
// `Color(`, `Color.init(`, or an implicit `.init(` (as in .foregroundStyle(.init(hex: ...))).
const INIT = String.raw`(?:\b(?:Color|UIColor|NSColor)(?:\s*\.\s*init)?|(?<![\w)\]])\.init)\(\s*`;
// Only the colour arguments: the rest of the call is found by its closing paren, so an
// argument that is not a literal (opacity: dim) cannot hide the colour.
const HEX_OPEN = new RegExp(String.raw`${INIT}hex:\s*0x([0-9A-Fa-f]{6})\b(?=\s*[,)])`, 'g');
const RGB_OPEN = new RegExp(String.raw`(?:${INIT}|#colorLiteral\(\s*)(?:\.(?:sRGB|displayP3)\s*,\s*)?red:\s*${CH}\s*,\s*green:\s*${CH}\s*,\s*blue:\s*${CH}(?=\s*[,)])`, 'g');
const OPACITY_ARG = new RegExp(String.raw`^\s*,\s*(?:opacity|alpha):\s*(${NUM})\s*$`);
const OPACITY_CALL = new RegExp(String.raw`^\s*\.opacity\(\s*(${NUM})\s*\)`);
const BARE_HEX = /\b0x([0-9A-Fa-f]{6})\b/g;
const WHITE = new RegExp(String.raw`(?:=|:)\s*(Color\.white)\b(?:\s*\.opacity\(\s*(${NUM})\s*\))?\s*,?\s*$`);

const toHex = (r, g, b) => '#' + [r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('').toUpperCase();
const channel = (v, d) => (d !== undefined ? (+v / +d) * 255 : (+v <= 1 ? +v * 255 : +v));
const opacityOf = (...parts) => parts.reduce((o, p) => (p === undefined ? o : o * +p), 1);

const tidy = s => s.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();

/**
 * A colour initializer whose opening `m` matched in `text`, completed by its
 * closing paren and any `.opacity(n)` after it. An opacity is read only when it is
 * a numeric literal; a call left open (a theme line read alone) keeps opacity 1.
 */
function callLiteral(text, m, hex) {
  let depth = 0, close = -1;
  for (let i = m.index + m[0].length; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { if (depth === 0) { close = i; break; } depth--; }
  }
  if (close < 0) return { index: m.index, end: text.length, hex, opacity: 1, text: tidy(text.slice(m.index)), call: true };
  const arg = OPACITY_ARG.exec(text.slice(m.index + m[0].length, close));
  const after = OPACITY_CALL.exec(text.slice(close + 1));
  return {
    index: m.index,
    end: close + 1 + (after ? after[0].length : 0),
    hex,
    opacity: opacityOf(arg?.[1], after?.[1]),
    text: tidy(text.slice(m.index, close + 1) + (after ? after[0] : '')),
    call: true,
  };
}

/**
 * Colour literals in comment-stripped code, one line or a whole file (a call may
 * span lines): [{ index, end, hex, opacity, text, call }]. `call` is false for a
 * bare 0xRRGGBB (a theme's UInt32 tuple) and for a constant whose whole value is
 * Color.white; `bare` adds those two forms, which only a theme file reads, one line at a time.
 */
export function colorLiterals(line, { bare = false } = {}) {
  const out = [];
  for (const m of line.matchAll(HEX_OPEN)) out.push(callLiteral(line, m, '#' + m[1].toUpperCase()));
  for (const m of line.matchAll(RGB_OPEN)) {
    out.push(callLiteral(line, m, toHex(channel(m[1], m[2]), channel(m[3], m[4]), channel(m[5], m[6]))));
  }
  if (bare) {
    const inside = at => out.some(l => at >= l.index && at < l.end);
    for (const m of line.matchAll(BARE_HEX)) {
      if (!inside(m.index)) out.push({ index: m.index, end: m.index + m[0].length, hex: '#' + m[1].toUpperCase(), opacity: 1, text: m[0], call: false });
    }
    const w = WHITE.exec(line);
    if (w) {
      const at = line.indexOf(w[1], w.index);
      out.push({ index: at, end: line.length, hex: '#FFFFFF', opacity: opacityOf(w[2]), text: w[0].replace(/^[=:]\s*/, '').trim(), call: false });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ─── Theme constants ───

const TYPE_DECL = /\b(?:enum|struct|class|extension|actor|protocol)\s+(?!func\b|var\b|let\b)([A-Za-z_][\w.]*)/g;
const FUNC_DECL = /\bfunc\s+([A-Za-z_]\w*)/g;
const VAR_DECL = /\bvar\s+([A-Za-z_]\w*)\s*:[^={]*\{/g;
const STATIC_NAME = /\bstatic\s+(?:let|var)\s+([A-Za-z_]\w*)/g;
const CASE_NAME = /\bcase\s+\.([A-Za-z_]\w*)/g;

/**
 * Every colour constant in a theme file: [{ name, scope, path, expr, hex,
 * opacity, line, annotation, decl }]. `scope` is the enclosing enum / struct /
 * extension / property path tracked by brace depth (Tone.accent), `path` adds the
 * name, `expr` is the Swift expression a view would write (Palette.ghost,
 * Tone.icebreaker.accent) or null, `annotation` the token names of a trailing
 * `// --token` on the literal's line or its declaration's, and `decl` groups the
 * literals of one declaration (a gradient's stops).
 */
export function parseThemeConstants(content) {
  const { code, skel, comments } = scanSwift(content);
  const codeLines = code.split('\n');
  const skelLines = skel.split('\n');
  const root = { name: null, kind: null, last: null };
  const stack = [root];
  let pending = null;
  let declSeq = 0;
  const constants = [];

  for (let li = 0; li < codeLines.length; li++) {
    const c = codeLines[li], s = skelLines[li];
    const events = [];
    for (const m of s.matchAll(TYPE_DECL)) events.push({ at: m.index, type: 'decl', name: m[1], kind: 'type' });
    for (const m of s.matchAll(FUNC_DECL)) events.push({ at: m.index, type: 'decl', name: m[1], kind: 'func' });
    for (const m of s.matchAll(VAR_DECL)) events.push({ at: m.index, type: 'decl', name: m[1], kind: 'var' });
    for (const m of s.matchAll(STATIC_NAME)) events.push({ at: m.index, type: 'name', name: m[1], from: 'let' });
    for (const m of s.matchAll(CASE_NAME)) events.push({ at: m.index, type: 'name', name: m[1], from: 'case' });
    for (const lit of colorLiterals(s, { bare: true })) events.push({ at: lit.index, type: 'lit', lit });
    for (let k = 0; k < s.length; k++) if (s[k] === '{' || s[k] === '}') events.push({ at: k, type: s[k] });
    events.sort((a, b) => a.at - b.at);

    for (const e of events) {
      if (e.type === 'decl') pending = { name: e.name, kind: e.kind };
      else if (e.type === '{') { stack.push({ name: pending?.name ?? null, kind: pending?.kind ?? null, last: null }); pending = null; }
      else if (e.type === '}') { if (stack.length > 1) stack.pop(); }
      else if (e.type === 'name') stack[stack.length - 1].last = { name: e.name, from: e.from, line: li, decl: ++declSeq };
      else if (e.type === 'lit') {
        let named = stack.filter(f => f.name);
        const last = [...stack].reverse().find(f => f.last)?.last ?? null;
        // A computed `static var accent: Color { ... }` is the constant itself, not a scope holding one.
        const inner = named[named.length - 1];
        if (inner?.kind === 'var' && last?.from === 'let' && inner.name === last.name) named = named.slice(0, -1);
        const scope = named.map(f => f.name).join('.');
        let expr = null;
        if (last?.from === 'let' && named.every(f => f.kind === 'type')) expr = [...named.map(f => f.name), last.name].join('.');
        if (last?.from === 'case' && named.length > 1 && named[named.length - 1].kind === 'var' && named.slice(0, -1).every(f => f.kind === 'type')) {
          expr = [...named.slice(0, -1).map(f => f.name), last.name, named[named.length - 1].name].join('.');
        }
        const annotation = annotationTokens(comments.get(li)) ?? (last ? annotationTokens(comments.get(last.line)) : null);
        constants.push({
          name: last?.name ?? null,
          scope,
          path: [scope, last?.name].filter(Boolean).join('.'),
          expr,
          hex: e.lit.hex,
          opacity: e.lit.opacity,
          line: li + 1,
          annotation,
          decl: last ? last.decl : `line${li}`,
        });
      }
    }
  }
  return constants;
}

/**
 * Theme constants grouped by declaration: [{ display, path, expr, scope, line,
 * stops: [{ hex, opacity }], annotation }]. A gradient's stops are one group.
 */
export function groupConstants(constants) {
  const groups = new Map();
  for (const c of constants) {
    const key = `${c.decl}|${c.path}`;
    if (!groups.has(key)) groups.set(key, { display: c.expr ?? c.path, path: c.path, expr: c.expr, scope: c.scope, line: c.line, stops: [], annotation: null });
    const g = groups.get(key);
    g.stops.push({ hex: c.hex, opacity: c.opacity, line: c.line });
    if (!g.annotation && c.annotation) g.annotation = c.annotation;
  }
  return [...groups.values()];
}

// ─── Web tokens ───

/** A token value as colour stops: { stops: [{ hex, alpha }], gradient }, or null when it is not a colour. */
export function parseColorValue(raw) {
  const v = String(raw ?? '').trim();
  let m;
  if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v))) {
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    return { stops: [{ hex: '#' + h.slice(0, 6).toUpperCase(), alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 }], gradient: false };
  }
  const RGBA = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i;
  if ((m = new RegExp(`^${RGBA.source}$`, 'i').exec(v))) {
    return { stops: [{ hex: toHex(+m[1], +m[2], +m[3]), alpha: m[4] === undefined ? 1 : +m[4] }], gradient: false };
  }
  if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(v) && !/var\(/.test(v)) {
    const stops = [...v.matchAll(new RegExp(`#([0-9a-f]{6})\\b|${RGBA.source}`, 'gi'))].map(s => (s[1]
      ? { hex: '#' + s[1].toUpperCase(), alpha: 1 }
      : { hex: toHex(+s[2], +s[3], +s[4]), alpha: s[5] === undefined ? 1 : +s[5] }));
    return stops.length ? { stops, gradient: true } : null;
  }
  return null;
}

const pct = a => `${Math.round(a * 100)}%`;
/** "#E54D4D", "#FFFFFF at 85%", or "#E54D4D to #C73E3E". */
export function describeStops(stops, alphaKey = 'alpha') {
  return stops.map(s => (s[alphaKey] !== undefined && s[alphaKey] < 1 ? `${s.hex} at ${pct(s[alphaKey])}` : s.hex)).join(' to ');
}

const APP_PREFIX = /^--(coach|tips|podcasts|planner|mainsite|dna|training|phase|intervention|strategist|synth|sidekick|academy|prove|reflect|facilitat|companion)/;
const CORE_PREFIX = /^--(brand|text-|bg-|color-|gray-|border)/;
const TIER_RANK = { brand: 0, semantic: 1, primitive: 2, alias: 3 };
const tokenRank = (n, native) => [TIER_RANK[native.tokens.get(n)?.tier] ?? 2, APP_PREFIX.test(n) ? 1 : 0, CORE_PREFIX.test(n) ? 0 : 1, n.length];
const compareRanks = (ra, rb) => {
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return 0;
};

/**
 * The token to name for a value several tokens share: brand first, then the
 * text / bg / colour / grey families; legacy aliases and app-specific names last.
 */
export function preferredToken(names, native) {
  return [...names].sort((a, b) => compareRanks(tokenRank(a, native), tokenRank(b, native)) || a.localeCompare(b))[0] ?? null;
}

/** The web token whose value is exactly this opaque hex, or null. */
export function tokenForHex(native, hex) {
  const names = native.hexTokens.get(hex);
  return names ? preferredToken(names, native) : null;
}

const NEAR_TIE = 1.1;

/**
 * The nearest web token to a hex by plain RGB distance: { name, hex, distance }.
 * Another app's tokens are never suggested. Distances within 10% of the nearest
 * are a tie, settled by tier first (brand, then semantic), so a closer primitive
 * does not beat the token a native app should mirror.
 */
export function nearestToken(native, hex) {
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(hex);
  const candidates = [];
  for (const [candidate, names] of native.hexTokens) {
    const [cr, cg, cb] = rgb(candidate);
    const distance = Math.sqrt((r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2);
    for (const name of names) if (!APP_PREFIX.test(name)) candidates.push({ name, hex: candidate, distance, rank: tokenRank(name, native) });
  }
  if (!candidates.length) return null;
  const nearest = Math.min(...candidates.map(c => c.distance));
  const [best] = candidates
    .filter(c => c.distance <= nearest * NEAR_TIE)
    .sort((a, b) => a.rank[0] - b.rank[0] || a.distance - b.distance || compareRanks(a.rank, b.rank) || a.name.localeCompare(b.name));
  return { name: best.name, hex: best.hex, distance: best.distance };
}

/** Does a constant's stops carry a token's value? A token with alpha also needs the constant's opacity. */
export function stopsMatch(stops, value, { exactOpacity = false } = {}) {
  if (!value || stops.length !== value.stops.length) return false;
  return stops.every((s, i) => {
    const t = value.stops[i];
    if (s.hex !== t.hex) return false;
    if (t.alpha < 1 || exactOpacity) return Math.abs(s.opacity - t.alpha) < 0.01;
    return true;
  });
}

// ─── The manifest and its apps ───

export function isSanctioned(app, scope) {
  return Object.keys(app?.sanctionedScopes || {}).some(s => scope === s || scope.startsWith(`${s}.`));
}

/** The manifest app a project-relative path belongs to, as { key, app }, or null. External apps never match. */
export function appFor(native, rel) {
  for (const [key, app] of Object.entries(native.apps)) {
    if (app.external) continue;
    for (const dir of [app.source, app.root].filter(Boolean)) {
      if (rel === dir || rel.startsWith(`${dir}/`)) return { key, app };
    }
  }
  return null;
}

/** Theme files plus every .swift under the app's source, project-relative and sorted. */
export function appFiles(app) {
  const files = new Set(app.themeFiles || []);
  const walk = rel => {
    let entries;
    try { entries = readdirSync(resolve(PROJECT_ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'build' || e.name === 'DerivedData') continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.swift')) files.add(child);
    }
  };
  if (app.source) walk(app.source);
  return [...files].sort();
}

/** Absolute paths whose change means the native context is stale: the manifest, the catalog, every theme file. */
export function nativeSources(native) {
  const themes = Object.values(native?.apps || {}).filter(a => !a.external).flatMap(a => a.themeFiles || []);
  return [MANIFEST(), CATALOG(), ...themes.map(f => resolve(PROJECT_ROOT, f))].filter(Boolean);
}

/**
 * Read the manifest, the catalog's tokens and every non-external app's theme
 * files. `groups` holds each app's theme constants by declaration, `byHex` the
 * single-colour constants a view could use instead of a literal.
 */
export function loadNative() {
  const manifestPath = MANIFEST();
  const manifest = (manifestPath && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf-8')).native : null) || { apps: {} };
  const catalog = JSON.parse(readFileSync(CATALOG(), 'utf-8'));
  const tokens = new Map();
  const hexTokens = new Map();
  for (const [name, t] of Object.entries(catalog.tokens || {})) {
    const raw = t.resolved ?? t.value;
    const value = parseColorValue(raw);
    tokens.set(name, { name, raw, value, tier: t.tier, use: t.use, purpose: t.purpose });
    if (value && !value.gradient && value.stops[0].alpha === 1) {
      const hex = value.stops[0].hex;
      if (!hexTokens.has(hex)) hexTokens.set(hex, []);
      hexTokens.get(hex).push(name);
    }
  }
  const native = { manifest, apps: manifest.apps || {}, tokens, hexTokens, groups: new Map(), byHex: new Map(), missing: [] };
  for (const [key, app] of Object.entries(native.apps)) {
    if (app.external) continue;
    const groups = [];
    for (const file of app.themeFiles || []) {
      const abs = resolve(PROJECT_ROOT, file);
      if (!existsSync(abs)) { native.missing.push(file); continue; }
      for (const g of groupConstants(parseThemeConstants(readFileSync(abs, 'utf-8')))) {
        groups.push({ ...g, app: key, file, sanctioned: isSanctioned(app, g.scope) });
      }
    }
    native.groups.set(key, groups);
    const byHex = new Map();
    for (const g of groups) {
      if (g.stops.length !== 1 || !g.expr || g.stops[0].opacity !== 1) continue;
      const hex = g.stops[0].hex;
      if (!byHex.has(hex)) byHex.set(hex, []);
      byHex.get(hex).push(g);
    }
    native.byHex.set(key, byHex);
  }
  return native;
}

let cached = null;
/** The native context, loaded once per process. The MCP server reloads its own through ensureFresh. */
export function getNative() {
  if (!cached) cached = loadNative();
  return cached;
}

/**
 * The app constants that mirror a token: by annotation (an annotated alias counts
 * for the token it stands for), else by equal value. [{ app, display, drift, via }].
 */
export function mirrorsOf(native, tokenName, appKey = null) {
  const token = native.tokens.get(tokenName);
  const out = [];
  for (const [key, groups] of native.groups) {
    if (appKey && key !== appKey) continue;
    for (const g of groups) {
      if (g.annotation) {
        const via = g.annotation.find(a => a === tokenName || native.tokens.get(a)?.use === tokenName);
        if (!via) continue;
        const value = native.tokens.get(via)?.value;
        out.push({ app: key, display: g.display, drift: value ? !stopsMatch(g.stops, value) : false, stops: g.stops, via: via === tokenName ? null : via });
      } else if (token?.value && stopsMatch(g.stops, token.value, { exactOpacity: true })) {
        out.push({ app: key, display: g.display, drift: false, stops: g.stops, via: null });
      }
    }
  }
  return out;
}

/** A token's value as Swift: Color(hex: 0xC73E3E), with opacity, or a gradient's colours; a px length as CGFloat. */
export function swiftValue(token) {
  if (token?.value) {
    const color = s => `Color(hex: 0x${s.hex.slice(1)}${s.alpha < 1 ? `, opacity: ${s.alpha}` : ''})`;
    return token.value.gradient ? `LinearGradient(colors: [${token.value.stops.map(color).join(', ')}], ...)` : color(token.value.stops[0]);
  }
  const px = /^(-?\d+(?:\.\d+)?)px$/.exec(String(token?.raw ?? '').trim());
  return px ? `CGFloat = ${px[1]}` : '';
}

// ─── The native check and its baseline ───

/**
 * Run `validate(content, absPath)` over the native apps and return findings as
 * [{ app, file, rule, severity, line, match, message, suggestion }]. With `files`
 * only those (a .swift outside every app is checked as app "none"); otherwise
 * every non-external app, or only `app`. `skipped` lists each file argument not
 * checked, with why: { file, reason }.
 */
export function runNativeCheck(native, validate, { app = null, files = null } = {}) {
  const targets = [];
  const skipped = [];
  if (files && files.length) {
    for (const f of files) {
      const rel = relPath(f);
      if (!rel.endsWith('.swift')) { skipped.push({ file: rel, reason: 'not a .swift file' }); continue; }
      if (!existsSync(resolve(PROJECT_ROOT, rel))) { skipped.push({ file: rel, reason: 'no such file' }); continue; }
      const hit = appFor(native, rel);
      if (app && hit?.key !== app) { skipped.push({ file: rel, reason: `outside --app ${app} (${hit ? `it is ${hit.key}` : 'it is in no app'})` }); continue; }
      targets.push({ app: hit?.key ?? 'none', rel });
    }
  } else {
    for (const [key, a] of Object.entries(native.apps)) {
      if (a.external || (app && key !== app)) continue;
      for (const rel of appFiles(a)) targets.push({ app: key, rel });
    }
  }
  const findings = [];
  for (const t of targets) {
    const abs = resolve(PROJECT_ROOT, t.rel);
    if (!existsSync(abs)) continue;
    for (const v of validate(readFileSync(abs, 'utf-8'), abs)) {
      findings.push({ app: t.app, file: t.rel, rule: v.type, severity: v.severity, line: v.line, match: v.match, message: v.message, suggestion: v.suggestion });
    }
  }
  return { findings, files: targets.length, skipped };
}

export const baselineKey = f => `${f.app}|${f.rule}|${f.file}|${f.match}`;

export function baselinePath(native) {
  return resolve(PROJECT_ROOT, String(native.manifest.baseline || '/design-system/native-baseline.json').replace(/^\//, ''));
}

/** The baseline's counts by key, or null when there is no baseline file. Throws when the file exists but does not parse. */
export function readBaseline(native) {
  const path = baselinePath(native);
  if (!existsSync(path)) return null;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf-8')); } catch (error) {
    throw new Error(`${relPath(path)} failed to parse: ${error.message}`);
  }
  if (!doc || typeof doc.findings !== 'object' || doc.findings === null || Array.isArray(doc.findings)) {
    throw new Error(`${relPath(path)} failed to parse: it has no "findings" object`);
  }
  return doc.findings;
}

/**
 * Split findings into new and baselined against the baseline counts. `inScope`
 * says which baseline keys this run checked, so `remaining` and `fixed` only count those.
 */
export function compareToBaseline(findings, counts, inScope = () => true) {
  const seen = new Map();
  const fresh = [], baselined = [];
  for (const f of findings) {
    const key = baselineKey(f);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    (n <= (counts[key] || 0) ? baselined : fresh).push(f);
  }
  let fixed = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (!inScope(key)) continue;
    fixed += Math.max(0, count - (seen.get(key) || 0));
  }
  return { fresh, baselined, fixed };
}
