/**
 * small-icon: an icon drawn under the project's minimum (config iconSize: the
 * rule is off until the project switches it on, with its minimum, the size token
 * to suggest, its retired size tokens, its icon font's classes and the document
 * the rule comes from).
 *
 * In a stylesheet, and in a PHP or HTML page's <style> blocks:
 *   - a font-size under the minimum on a rule that sizes an icon-font glyph
 *     (a selector naming one of iconSize.glyphClasses);
 *   - a width, height or font-size under the minimum on a rule whose selector ends in
 *     an SVG icon (.icon, or svg in anything that is not a chart, ring, logo,
 *     dot and the like);
 *   - var() of a token iconSize.retired names.
 * In markup (PHP, JS, HTML):
 *   - an inline icon SVG on the 24-unit grids (viewBox "0 0 24 24" or
 *     "0 -960 960 960") whose width or height attribute is under the minimum;
 *   - an inline font-size under the minimum on an icon-font glyph (iconSize.inlineGlyphClasses).
 * A relative size (em, %, calc, max) follows its text and is left alone, as is
 * a line marked ds-lint-disable-line or under ds-lint-disable-next-line.
 */
import { config, projectPath, escapeRe } from './config.js';
import { relPath } from './native.js';

const SVG_ICON = /(\.icon|\bsvg)(\[[^\]]*\])?(::?[\w-]+(\([^)]*\))?)*\s*$/;
const NOT_ICON = /chart|spark|ring|\barc\b|arc__|arc-|graph|logo|wave|divider|meter|progress|shape|timeline|illustr|avatar|flag|\bdot|__dot|-dot|loader|spinner|skeleton|map|hero__visual|\bbg\b|background|pattern|confetti|\bqr\b/i;
const ICON_GRID = /viewBox=\\?["'](?:0 0 24 24|0 -960 960 960)\\?["']/;

/** The rule as the config sets it, read on each call so a reloaded config applies; null when it is off. */
function rule() {
  const s = config.iconSize || {};
  if (s.enabled !== true) return null;
  const names = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);
  const alternatives = list => list.map(escapeRe).join('|');
  const glyph = names(s.glyphClasses);
  const inline = Array.isArray(s.inlineGlyphClasses) ? names(s.inlineGlyphClasses) : glyph;
  const retired = names(s.retired);
  const min = typeof s.min === 'number' && s.min > 0 ? s.min : 24;
  const size = s.token ? `var(${s.token})` : `${min}px`;
  return {
    min,
    glyph: glyph.length ? new RegExp(alternatives(glyph)) : null,
    inlineGlyph: inline.length ? new RegExp(`<[a-z][\\w-]*\\b[^<>]*?(?:${alternatives(inline)})[^<>]*>`, 'g') : null,
    retired: retired.length ? new RegExp(`var\\(\\s*(${alternatives(retired)})\\b`, 'g') : null,
    atLeast: `an icon is at least ${min}px${s.doc ? ` (${s.doc})` : ''}`,
    suggestion: `Use ${size} or larger; a size that follows its text: max(${size}, 1em)`,
  };
}

/** A CSS length in px, following var() through the tokens; null when it is relative or unknown. */
function px(value, tokenParser, depth = 0) {
  const v = String(value).replace(/!important/i, '').trim();
  let m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (m) {
    if (depth > 5) return null;
    const token = tokenParser?.tokens?.get(m[1]);
    if (token != null) return px(token, tokenParser, depth + 1);
    return m[2] != null ? px(m[2], tokenParser, depth + 1) : null;
  }
  if ((m = /^(\d*\.?\d+)px$/.exec(v))) return Number(m[1]);
  if ((m = /^(\d*\.?\d+)rem$/.exec(v))) return Number(m[1]) * (config.rootPx || 16);
  return null;
}

/** Comments blanked, every other character kept, so offsets and lines stay exact. */
const blankComments = css => css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, s => s.replace(/[^\n]/g, ' '));

function suppressions(text) {
  const skip = new Set();
  text.split('\n').forEach((line, i) => {
    if (line.includes('ds-lint-disable-line')) skip.add(i + 1);
    if (line.includes('ds-lint-disable-next-line')) skip.add(i + 2);
  });
  return skip;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return at => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

function finding(r, filePath, line, match, message) {
  return { type: 'small-icon', severity: 'medium', line, match, message, suggestion: r.suggestion, autoFixable: false, file: filePath };
}

/** The rules in one stylesheet's text, which starts at offset in the file. */
function scanCss(r, css, offset, lineOf, filePath, tokenParser, out) {
  const text = blankComments(css);
  const flagged = new Set();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // A statement ahead of the first rule (@import …; @charset …;) is not part of its selector.
    const parts = m[1].split(';').pop().split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length || parts.some(p => p.startsWith('@'))) continue;
    const glyph = !!r.glyph && parts.some(p => r.glyph.test(p));
    const svg = parts.some(p => SVG_ICON.test(p) && !NOT_ICON.test(p));
    if (!glyph && !svg) continue;
    const bodyAt = m.index + m[1].length + 1;
    for (const d of m[2].matchAll(/(?<![\w-])(font-size|width|height)\s*:\s*([^;}]+)/g)) {
      if (d[1] !== 'font-size' && !svg) continue;
      const size = px(d[2], tokenParser);
      if (size == null || size >= r.min) continue;
      const line = lineOf(offset + bodyAt + d.index);
      flagged.add(line);
      out.push(finding(r, filePath, line, `${d[1]}: ${d[2].trim()}`, `Icon drawn at ${+size.toFixed(1)}px; ${r.atLeast}`));
    }
  }
  if (!r.retired) return;
  for (const m of text.matchAll(r.retired)) {
    const line = lineOf(offset + m.index);
    if (flagged.has(line)) continue;
    flagged.add(line);
    out.push(finding(r, filePath, line, `var(${m[1]})`, `${m[1]} is retired for icons; ${r.atLeast}`));
  }
}

/** Inline icon SVGs and glyph styles in markup, a template string or a PHP echo. */
function scanMarkup(r, text, lineOf, filePath, out) {
  for (const m of text.matchAll(/<svg\b[^>]*>/g)) {
    const tag = m[0];
    if (!ICON_GRID.test(tag)) continue;
    // Pixels only: a size in em, rem or % follows its text and is not drawn at that number.
    const small = [...tag.matchAll(/(?<![\w-])(width|height)=\\?["']?(\d*\.?\d+)(px)?(?=\\?["'\s/>])/g)].find(a => Number(a[2]) < r.min);
    if (small) out.push(finding(r, filePath, lineOf(m.index), `${small[1]}="${small[2]}"`, `Inline icon SVG drawn at ${small[2]}px; ${r.atLeast}`));
  }
  if (!r.inlineGlyph) return;
  for (const m of text.matchAll(r.inlineGlyph)) {
    const fs = /(?<![\w-])font-size\s*:\s*(\d*\.?\d+)(px|rem)\b/.exec(m[0]);
    if (!fs) continue;
    const size = Number(fs[1]) * (fs[2] === 'rem' ? (config.rootPx || 16) : 1);
    if (size < r.min) out.push(finding(r, filePath, lineOf(m.index + fs.index), `font-size: ${fs[1]}${fs[2]}`, `Icon glyph drawn at ${+size.toFixed(1)}px by an inline style; ${r.atLeast}`));
  }
}

/** Every small-icon finding in a file, by its type. */
export function findSmallIcons(content, filePath, tokenParser) {
  const r = rule();
  if (!r) return [];
  const name = filePath.split('/').pop();
  // The token file itself (config tokensCss, by its path in the project) defines the icon sizes; an exempt directory is never checked.
  if (config.tokensCss && relPath(filePath) === relPath(projectPath(config.tokensCss))) return [];
  if ((config.exemptDirs || []).some(d => filePath.includes(d))) return [];
  const ext = name.split('.').pop().toLowerCase();
  if (!['css', 'php', 'html', 'js'].includes(ext)) return [];
  const lineOf = lineIndex(content);
  const out = [];
  if (ext === 'css') {
    scanCss(r, content, 0, lineOf, filePath, tokenParser, out);
  } else {
    if (ext !== 'js') {
      for (const m of content.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) scanCss(r, m[2], m.index + m[1].length, lineOf, filePath, tokenParser, out);
    }
    scanMarkup(r, content, lineOf, filePath, out);
  }
  const skip = suppressions(content);
  return out.filter(v => !skip.has(v.line));
}
