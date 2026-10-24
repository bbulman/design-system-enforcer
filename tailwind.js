/**
 * Tailwind class checks, for projects that use Tailwind (config `tailwind`: "v3" or
 * "v4", which init detects). Three kinds of finding:
 *
 *   arbitrary colours   bg-[#1a1a1a], text-[rgb(0,0,0)]      high
 *   arbitrary spacing   p-[13px], gap-[0.8rem], rounded-[7px] medium (text-[13px] low)
 *   default palette     bg-blue-500 when the project has its own colour tokens  medium
 *
 * Each names the design system's own class for the same or nearest colour. The
 * project's own colours are the colour tokens the catalog holds; a class is the
 * token name without "--" or a leading "color-" (--primary is bg-primary, v4's
 * --color-brand is bg-brand).
 */
import { readFileSync } from 'fs';
import { config } from './config.js';
import { parseColor, nearestColorToken, closeness, distance } from './colour.js';

const PALETTES = JSON.parse(readFileSync(new URL('./data/tailwind-colors.json', import.meta.url), 'utf8'));
const COLOR_PREFIX = '(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration|shadow)';
// Padding, margin and gaps; positioning (top, left, inset) is layout, not the spacing scale.
const SPACE_PREFIX = '(?:p[xytrblse]?|m[xytrblse]?|-m[xytrblse]?|gap(?:-[xy])?|space-[xy]|-space-[xy]|scroll-[mp][xytrblse]?)';
// v3's spacing steps (v4 accepts any multiple of 0.25rem).
const V3_STEPS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96];
const RADIUS_PREFIX = '(?:rounded(?:-(?:[trblse]|tl|tr|bl|br|ss|se|es|ee))?)';
const BOUNDARY = '(?<![\\w\\-\\[\\]])';
const LENGTH = '(-?[\\d.]+)(px|rem)';

export function tailwindVersion(tokenParser) {
  if (config.tailwind !== undefined) return config.tailwind || false;
  return tokenParser?.data?.catalog?.meta?.tailwind || false;
}

/** Colour tokens as Tailwind colour names: [{ name, token, colour }]. */
function systemColours(tokenParser) {
  const out = [];
  for (const [hex, names] of tokenParser.colorToToken || []) {
    const colour = parseColor(hex);
    if (!colour) continue;
    for (const token of names) out.push({ name: token.replace(/^--/, '').replace(/^color-/, ''), token, colour });
  }
  return out;
}

const classFor = (prefix, token) => `${prefix}-${token.replace(/^--/, '').replace(/^color-/, '')}`;
const TEXTISH = /^(text|fill|stroke|decoration|placeholder|caret)$/;

/**
 * Of several tokens with the same colour, the one that reads right for this utility:
 * a "foreground" name for text, a plain one for backgrounds and borders, then the shortest.
 */
function pickForPrefix(prefix, names, tokenParser) {
  if (!names?.length) return null;
  if (config.framework === 'php') return tokenParser.pickBestColorToken(names);
  const fg = n => /foreground|text|ink/.test(n);
  const canonical = n => (/^--(color-)?(background|foreground|primary|border)$/.test(n) ? 0 : 1);
  const segments = n => n.replace(/^--(color-)?/, '').split('-').length;
  const score = n => (TEXTISH.test(prefix) ? (fg(n) ? 0 : 1) : (fg(n) ? 1 : 0)) * 10000 + canonical(n) * 1000 + segments(n) * 100 + n.length;
  return [...names].sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0];
}

/** The system class for exactly this colour (bg-brand), or null when no token holds it. */
function exactClass(prefix, value, tokenParser) {
  const exact = pickForPrefix(prefix, tokenParser.findColorToken(value), tokenParser);
  return exact ? classFor(prefix, exact) : null;
}

function colourAdvice(prefix, value, tokenParser) {
  const exact = pickForPrefix(prefix, tokenParser.findColorToken(value), tokenParser);
  if (exact) return `Use ${classFor(prefix, exact)} (${exact})`;
  const near = nearestColorToken(tokenParser, value);
  if (!near) return 'Use one of the design system\'s colour classes';
  const name = pickForPrefix(prefix, near.names, tokenParser);
  return `Nearest system colour: ${classFor(prefix, name)} (${name}, ${near.hex}), ${closeness(near.distance)}`;
}

/**
 * Findings for the Tailwind classes on each line. `lines` are the file's lines with
 * comments already blanked; `skip` is a Set of suppressed line numbers.
 */
export function checkTailwind(lines, filePath, tokenParser, skip = new Set()) {
  const version = tailwindVersion(tokenParser);
  if (!version) return [];
  const palette = PALETTES[version] || PALETTES.v3;
  const own = systemColours(tokenParser);
  const ownNames = new Set(own.map(c => c.name));
  const hasOwnColours = own.length >= 3;
  const { pureBlack, pureWhite } = config.rules;
  const rootPx = config.rootPx || 16;
  const out = [];
  const seen = new Set();
  // One finding per class per line: hover:bg-zinc-700 and focus:bg-zinc-700 are the same problem.
  // A fix ({ from, to }) is attached only when the swap has exactly one right answer.
  const push = (line, type, severity, match, message, suggestion, to = null) => {
    const key = `${line}|${type}|${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, severity, line, match, message, suggestion, autoFixable: Boolean(to), ...(to ? { fix: { from: match, to } } : {}), file: filePath });
  };

  const arbitraryColour = new RegExp(`${BOUNDARY}(${COLOR_PREFIX})-\\[(#[0-9a-fA-F]{3,8}|rgba?\\([^\\]]*\\)|hsla?\\([^\\]]*\\))\\]`, 'g');
  const arbitrarySpace = new RegExp(`${BOUNDARY}(${SPACE_PREFIX})-\\[${LENGTH}\\]`, 'g');
  const arbitraryRadius = new RegExp(`${BOUNDARY}(${RADIUS_PREFIX})-\\[${LENGTH}\\]`, 'g');
  const arbitraryText = new RegExp(`${BOUNDARY}(text)-\\[${LENGTH}\\]`, 'g');
  const names = Object.keys(palette).map(n => n.replace(/[-]/g, '\\-')).sort((a, b) => b.length - a.length).join('|');
  const paletteClass = new RegExp(`${BOUNDARY}(${COLOR_PREFIX})-(${names})(?:\\/(\\d{1,3}|\\[[^\\]]+\\]))?(?![\\w-])`, 'g');

  lines.forEach((code, i) => {
    const lineNum = i + 1;
    if (skip.has(lineNum)) return;

    for (const m of code.matchAll(arbitraryColour)) {
      const value = m[2].replace(/_/g, ' ');
      const colour = parseColor(value);
      if (pureBlack.enabled && colour && colour.r + colour.g + colour.b === 0) push(lineNum, 'design-rule', pureBlack.severity, m[0], pureBlack.message, pureBlack.suggestion);
      if (pureWhite.enabled && m[1] === 'bg' && colour && colour.r + colour.g + colour.b === 765) push(lineNum, 'design-rule', pureWhite.severity, m[0], pureWhite.message, pureWhite.suggestion);
      push(lineNum, 'tailwind-arbitrary-color', 'high', m[0], `Arbitrary colour ${m[0]}`, colourAdvice(m[1], value, tokenParser), exactClass(m[1], value, tokenParser));
    }

    for (const [re, kind] of [[arbitrarySpace, 'spacing'], [arbitraryRadius, 'radius'], [arbitraryText, 'font size']]) {
      for (const m of code.matchAll(re)) {
        const px = m[3] === 'rem' ? parseFloat(m[2]) * rootPx : parseFloat(m[2]);
        if (kind === 'spacing' && Math.abs(px) <= 1) continue;
        let suggestion, to = null;
        if (kind === 'spacing') {
          const token = Number.isInteger(px) ? tokenParser.findSpacingToken(Math.abs(px)) : null;
          const step = Math.abs(px) / 4;
          const onScale = version === 'v3' ? V3_STEPS.includes(step) : Number.isInteger(step * 2);
          const nearest = version === 'v3'
            ? V3_STEPS.reduce((a, b) => (Math.abs(b - step) < Math.abs(a - step) ? b : a))
            : Math.round(step * 2) / 2; // v4: the nearest whole or half step
          suggestion = token && version === 'v4' && token.startsWith('--spacing-') ? `Use ${m[1]}-${token.slice('--spacing-'.length)} (${token} is ${Math.abs(px)}px)`
            : token ? `Use ${m[1]}-[var(${token})] (${token} is ${Math.abs(px)}px)`
            : onScale ? `Use ${m[1]}-${step} (${Math.abs(px)}px on the spacing scale)`
            : `Use the nearest step on the spacing scale: ${m[1]}-${nearest} (${nearest * 4}px)`;
          // Exact equivalents only; rounding to the nearest step changes the layout, so that's a judgment call.
          to = token && version === 'v4' && token.startsWith('--spacing-') ? `${m[1]}-${token.slice('--spacing-'.length)}`
            : token ? `${m[1]}-[var(${token})]`
            : onScale && px >= 0 ? `${m[1]}-${step}` : null;
        } else if (kind === 'radius') {
          const token = Number.isInteger(px) ? tokenParser.findRadiusToken(px) : null;
          suggestion = !token ? 'Use a rounded-* step from the design system'
            : version === 'v4' && token.startsWith('--radius-') ? `Use ${m[1]}-${token.slice('--radius-'.length)} (${token} is ${px}px)`
            : `Use rounded-[var(${token})] (${token} is ${px}px), or the rounded-* step mapped to it`;
          to = !token ? null : version === 'v4' && token.startsWith('--radius-') ? `${m[1]}-${token.slice('--radius-'.length)}` : `${m[1]}-[var(${token})]`;
        } else {
          suggestion = 'Use a text-* size from the type scale (text-sm is 14px, text-base 16px)';
        }
        push(lineNum, `tailwind-arbitrary-${kind.replace(' ', '-')}`, kind === 'font size' ? 'low' : 'medium', m[0], `Arbitrary ${kind} ${m[0]}`, suggestion, to);
      }
    }

    if (hasOwnColours) {
      for (const m of code.matchAll(paletteClass)) {
        const [whole, prefix, name] = m;
        if (ownNames.has(name)) continue; // the project defines this colour itself
        const hex = palette[name];
        if ((name === 'black' && pureBlack.enabled) || (name === 'white' && prefix === 'bg' && pureWhite.enabled)) {
          const rule = name === 'black' ? pureBlack : pureWhite;
          push(lineNum, 'design-rule', rule.severity, whole, rule.message, `${rule.suggestion ? rule.suggestion + ': ' : ''}${colourAdvice(prefix, hex, tokenParser)}`);
          continue; // the house rule already says it; one finding per class
        }
        push(lineNum, 'tailwind-default-palette', name === 'black' || name === 'white' ? 'low' : 'medium', whole,
          `Tailwind's default ${name} (${hex}) is not one of the design system's colours`, colourAdvice(prefix, hex, tokenParser),
          m[3] ? null : exactClass(prefix, hex, tokenParser)); // an opacity modifier (/50) needs a person
      }
    }
  });
  return out;
}

export { distance };

/**
 * The colour a Tailwind colour utility's value names: a design-system colour (primary,
 * brand), a default-palette colour (blue-500), or an arbitrary one ([#123456]).
 * Returns { colour, label } or null; a value with an opacity modifier returns null,
 * since what shows through it is unknown.
 */
export function classColour(value, tokenParser) {
  if (!value || /\//.test(value)) return null;
  const arb = value.match(/^\[(.+)\]$/);
  if (arb) { const c = parseColor(arb[1].replace(/_/g, ' ')); return c && c.a === 1 ? { colour: c, label: arb[1] } : null; }
  for (const token of [`--${value}`, `--color-${value}`]) {
    const raw = tokenParser.tokens?.get(token);
    if (!raw) continue;
    const c = parseColor(resolveVar(raw, tokenParser));
    if (c && c.a === 1) return { colour: c, label: token };
  }
  const version = tailwindVersion(tokenParser) || 'v3';
  const hex = (PALETTES[version] || PALETTES.v3)[value];
  return hex ? { colour: parseColor(hex), label: `${value} ${hex}` } : null;
}

/** Follow var(--x) through the token set to a literal value. */
export function resolveVar(value, tokenParser, depth = 0) {
  const m = String(value).trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (!m || depth > 10) return value;
  const next = tokenParser.tokens?.get(m[1]);
  return next !== undefined ? resolveVar(next, tokenParser, depth + 1) : (m[2] ?? value);
}
