/**
 * Which files the component gate covers, and whether a write adds markup to
 * one. Writes are compared as token sets, not text: a write adds markup only
 * when it brings an element or class name the text it replaces lacked.
 */
import { extname } from 'node:path';
import { DEFAULTS } from '../config.js';

/* The file types componentGate.files names (gateSettings gated and detected); these when settings carry none.
   A detected type (by default JavaScript and plain HTML, which cannot call a helper) is never gated. */
const GATED = new Set(DEFAULTS.componentGate.files.gate);
const DETECTED = new Set(DEFAULTS.componentGate.files.detect);

/** 'gate' needs a consult before adding markup, 'detect' is checked but never refused, null is not UI. */
export function gateKind(rel, settings) {
  if ((settings?.skip ?? []).some(re => re.test(rel))) return null;
  const ext = extname(rel).toLowerCase();
  if ((settings?.gated ?? GATED).has(ext)) return 'gate';
  return (settings?.detected ?? DETECTED).has(ext) ? 'detect' : null;
}

const PHP_BLOCK = /<\?(?:php\b|=)[\s\S]*?(?:\?>|$)/gi;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const TAG = /<([a-z][a-z0-9-]*)(?=[\s/>]|$)/gi;
const CLASS_ATTR = /(?<![\w-])class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;
const CSS_STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const CSS_CLASS = /\.(-?[_a-zA-Z][\w-]*)/g;

/** An Edit's text can start inside a PHP block: a close tag with no "<?" before it means everything up to it is PHP. */
function stripPhp(text) {
  const close = text.indexOf('?>');
  const open = text.indexOf('<?');
  if (close !== -1 && (open === -1 || close < open)) text = text.slice(close + 2);
  return text.replace(PHP_BLOCK, ' ');
}

/** A selector is the text before a "{" since the last "{", "}" or ";", which skips declarations and copes with nesting. */
function cssClasses(css) {
  const src = css.replace(CSS_COMMENT, ' ').replace(CSS_STRING, '""');
  const out = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      const selector = src.slice(start, i).trim();
      if (!selector.startsWith('@')) for (const m of selector.matchAll(CSS_CLASS)) out.push(m[1]);
    }
    if (ch === '{' || ch === '}' || ch === ';') start = i + 1;
  }
  return out;
}

export function markupTokens(text, ext) {
  const src = String(text ?? '');
  const elements = new Set();
  const classes = new Set();
  if (/^\.?css$/i.test(String(ext))) {
    for (const c of cssClasses(src)) classes.add(c);
    return { elements, classes };
  }
  // PHP goes first: a PHP string can hold "<!--", and PHP runs before the browser reads any comment.
  const html = stripPhp(src).replace(HTML_COMMENT, ' ');
  for (const m of html.matchAll(TAG)) elements.add(m[1].toLowerCase());
  for (const m of html.matchAll(CLASS_ATTR)) {
    for (const c of (m[1] ?? m[2]).split(/\s+/)) if (c) classes.add(c);
  }
  return { elements, classes };
}

export function addsMarkup(before, after, ext) {
  const old = markupTokens(before, ext);
  const now = markupTokens(after, ext);
  for (const e of now.elements) if (!old.elements.has(e)) return true;
  for (const c of now.classes) if (!old.classes.has(c)) return true;
  return false;
}
