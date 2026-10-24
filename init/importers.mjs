/**
 * Importers: read a project's existing, code-based design system into the
 * enforcer's catalog format (the shape Workshopr's generate-catalog.php writes).
 *
 *   importCss(files)   CSS custom properties (:root, themes, Tailwind v4 @theme)
 *   importDtcg(files)  W3C design tokens JSON (DTCG $value) and Style Dictionary (value)
 *   importReact(dirs)  React components: exports, props, cva variants, union-typed props
 *
 * Each returns plain objects; build.mjs merges them and writes the files.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { parseColor, toHex as colourHex } from '../colour.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', '.ds-enforcer', '.turbo', '.cache', 'storybook-static', 'DerivedData', 'Pods', '.build', 'Carthage']);

export function walk(dir, { maxDepth = 8, accept = () => true, limit = 20000 } = {}, depth = 0, out = []) {
  if (depth > maxDepth || out.length >= limit) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p, { maxDepth, accept, limit }, depth + 1, out); }
    else if (e.isFile() && accept(p)) out.push(p);
  }
  return out;
}

const stripCssComments = css => css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
const slug = s => String(s).trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/** A token's group, from its name and value: Colors, Spacing, Radius, Shadows, Typography or Other. */
/* shadcn writes colours as bare HSL channels ("222.2 47.4% 11.2%") used as hsl(var(--x)). */
export const HSL_CHANNELS = /^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*[\d.]+%?)?$/;

export function hslToHex(value) {
  const m = String(value).trim().match(HSL_CHANNELS);
  if (!m) return null;
  const h = ((+m[1] % 360) + 360) % 360 / 360, s = +m[2] / 100, l = +m[3] / 100;
  const k = n => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function categorize(name, value) {
  const n = name.toLowerCase(), v = String(value || '').trim().toLowerCase();
  if (HSL_CHANNELS.test(v) || /^(oklch|oklab|hsla?|hwb|lab|lch)\(/.test(v)) return 'Colors';
  if (/radius|rounded/.test(n)) return 'Radius';
  if (/shadow|elevation/.test(n)) return 'Shadows';
  if (/font|text-size|line-height|letter|leading|tracking|weight|family/.test(n)) return 'Typography';
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/.test(v) || /colou?r|bg|background|foreground|border|ink|surface|brand|accent/.test(n)) return 'Colors';
  if (/space|spacing|gap|gutter|inset|padding|margin|size|width|height/.test(n) && /^-?[\d.]+(px|rem|em)?$/.test(v)) return 'Spacing';
  return 'Other';
}

/** Follow var(--x) chains to a final value; unresolvable references stay as written. */
function resolveValue(name, tokens, seen = new Set()) {
  const t = tokens[name];
  if (!t) return null;
  if (seen.has(name)) return t.value;
  seen.add(name);
  return t.value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (all, ref, fallback) => {
    if (tokens[ref]) return resolveValue(ref, tokens, seen) ?? all;
    return fallback !== undefined ? fallback.trim() : all;
  });
}

export function finishTokens(tokens) {
  for (const [name, t] of Object.entries(tokens)) {
    t.resolved = resolveValue(name, tokens);
    if (t.resolved === t.value) delete t.resolved;
    const hex = hslToHex(t.resolved ?? t.value);
    if (hex) { t.channels = true; t.hex = hex; }
    else if (/^(oklch|hsla?)\(/i.test(String(t.resolved ?? t.value).trim())) {
      // oklch()/hsl() colours get a hex twin, so a hard-coded colour can be matched to them.
      const c = parseColor(t.resolved ?? t.value);
      if (c) t.hex = colourHex(c) + (c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, '0').toUpperCase() : '');
    }
    t.tier ||= /var\(/.test(t.value) ? 'semantic' : 'primitive';
    t.group ||= categorize(name, t.resolved ?? t.value);
    t.purpose ??= null;
  }
  return tokens;
}

// ─── CSS custom properties ───

export function importCss(files, root) {
  const tokens = {};
  for (const file of files) {
    const css = stripCssComments(readFileSync(file, 'utf8'));
    for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?:;|(?=}))/g)) {
      if (tokens[m[1]]) continue; // the first declaration (usually :root) wins over themes and media queries
      tokens[m[1]] = { value: m[2].trim(), source: relative(root, file) };
    }
  }
  return finishTokens(tokens);
}

export const countCssVars = file => {
  try { return new Set([...stripCssComments(readFileSync(file, 'utf8')).matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])).size; } catch { return 0; }
};

// ─── W3C design tokens (DTCG) and Style Dictionary JSON ───

const isTokenNode = node => node && typeof node === 'object' && !Array.isArray(node)
  && ('$value' in node || ('value' in node && !Object.values(node).some(v => v && typeof v === 'object' && !Array.isArray(v) && ('value' in v || '$value' in v))));

const toHex = n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0').toUpperCase();
const alias = s => String(s).replace(/\{([^}]+)\}/g, (_, path) => `var(--${path.split('.').map(slug).join('-')})`);
const dim = d => (d && typeof d === 'object' ? `${d.value}${d.unit}` : d);

/** A DTCG value as a CSS value, or null for composites CSS custom properties can't hold (typography). */
export function dtcgToCss(value, type) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return alias(value);
  if (typeof value === 'number') return ['dimension', 'spacing', 'sizing', 'borderRadius', 'borderWidth', 'fontSize'].includes(type) ? `${value}px` : String(value);
  if (Array.isArray(value)) {
    if (type === 'fontFamily') return value.map(f => (/\s/.test(f) ? `"${f}"` : f)).join(', ');
    if (type === 'cubicBezier') return `cubic-bezier(${value.join(', ')})`;
    if (type === 'shadow') return value.map(v => dtcgToCss(v, 'shadow')).filter(Boolean).join(', ');
    return null;
  }
  if (type === 'color' || 'colorSpace' in value || 'hex' in value) {
    if (value.hex) return value.hex.toUpperCase();
    if (value.colorSpace === 'srgb' && Array.isArray(value.components)) {
      const a = value.alpha ?? 1;
      return `#${value.components.map(toHex).join('')}${a < 1 ? toHex(a) : ''}`;
    }
    return null;
  }
  if (type === 'shadow' || 'offsetX' in value) {
    return [value.inset ? 'inset' : '', dim(value.offsetX), dim(value.offsetY), dim(value.blur), dim(value.spread), dtcgToCss(value.color, 'color')]
      .filter(v => v !== '' && v !== undefined && v !== null).map(alias).join(' ');
  }
  if ('value' in value && 'unit' in value) return `${value.value}${value.unit}`;
  return null;
}

export function importDtcg(files, root) {
  const tokens = {};
  const skipped = [];
  const visit = (node, path, type, source) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const here = node.$type || node.type || type;
    if (isTokenNode(node)) {
      const name = `--${path.map(slug).join('-')}`;
      const css = dtcgToCss('$value' in node ? node.$value : node.value, here);
      if (css === null) { skipped.push(name); return; }
      if (!tokens[name]) tokens[name] = { value: css, source, purpose: node.$description || node.description || null, ...(here ? { type: here } : {}) };
      return;
    }
    for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) visit(v, [...path, k], here, source);
  };
  for (const file of files) visit(JSON.parse(readFileSync(file, 'utf8')), [], undefined, relative(root, file));
  return { tokens: finishTokens(tokens), skipped };
}

export function countDtcg(file) {
  let n = 0;
  const visit = node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (isTokenNode(node)) { n++; return; }
    for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) visit(v);
  };
  try { visit(JSON.parse(readFileSync(file, 'utf8'))); } catch { return 0; }
  return n;
}

// ─── React components ───

const COMPONENT_FILE = /\.(tsx|jsx|vue|svelte)$/;
const NOT_COMPONENT = /\.(test|spec|stories|story)\.|(^|\/)index\.(tsx|jsx)$|(^|\/)\+[\w.-]+\.svelte$/;

/** The framework a component file is written in. */
export const frameworkOf = file => (file.endsWith('.vue') ? 'vue' : file.endsWith('.svelte') ? 'svelte' : 'react');
const pascal = s => s.replace(/(^|[-_ ]+)(\w)/g, (_, __, c) => c.toUpperCase());

/** Script blocks of a single-file component, joined. */
const scriptOf = src => [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/**
 * A Vue or Svelte component: one per file, named after the file. Props come from
 * defineProps<{...}>() or defineProps({...}) (Vue), or a Props type with $props()
 * and `export let` (Svelte); string-union types and validator lists give variants.
 */
function sfcComponent(file, src, root) {
  const framework = frameworkOf(file);
  const name = pascal(basename(file, extname(file)));
  const script = scriptOf(src);
  const props = [], optionSpec = {};
  const addTyped = body => {
    for (const line of body.split(/[;\n]/)) {
      const p = line.match(/^\s*(?:readonly\s+)?["']?([\w-]+)["']?(\?)?\s*:\s*(.+?)\s*,?\s*$/);
      if (!p) continue;
      props.push({ name: p[1], type: p[2] ? `${p[3]} (optional)` : p[3], desc: p[2] ? 'optional' : 'required' });
      const literals = [...p[3].matchAll(/["']([^"']+)["']/g)].map(x => x[1]);
      if (literals.length > 1 && /^(\s*\|?\s*["'][^"']+["']\s*)+$/.test(p[3])) optionSpec[p[1]] = { type: 'string', values: literals };
    }
  };
  // Vue: defineProps<{ ... }>() or defineProps<Props>() with interface Props { ... }
  let m = script.match(/defineProps\s*<\s*{/);
  if (m) addTyped(block(script, script.indexOf('{', m.index)));
  m = script.match(/defineProps\s*<\s*(\w+)\s*>/) || script.match(/:\s*(\w+)\s*=\s*\$props\(\)/);
  if (m) {
    const decl = script.match(new RegExp(`(?:interface|type)\\s+${m[1]}\\b[^{]*{`));
    if (decl) addTyped(block(script, decl.index + decl[0].length - 1));
  }
  // Vue runtime props: defineProps({ variant: { type: String, default: 'primary', validator: v => ['a','b'].includes(v) } })
  m = script.match(/defineProps\s*\(\s*{/);
  if (m) {
    for (const { key, value } of entries(block(script, script.indexOf('{', m.index)))) {
      props.push({ name: key, type: (value.match(/type\s*:\s*(\w+)/) || [, value.split(/[,}]/)[0]])[1], desc: '' });
      const values = value.match(/\[([^\]]+)\]\s*\.includes/);
      if (values) optionSpec[key] = { type: 'string', values: [...values[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1]) };
      const def = value.match(/default\s*:\s*["']([^"']+)["']/);
      if (def) (optionSpec[key] ||= { type: 'string' }).default = def[1];
    }
  }
  // Svelte 5 defaults: let { variant = 'primary' } = $props();  Svelte 4: export let variant = 'primary';
  m = script.match(/let\s*{([^}]*)}\s*(?::\s*\w+\s*)?=\s*\$props\(\)/);
  if (m) for (const part of m[1].split(',')) {
    const d = part.match(/^\s*(\w+)\s*(?:=\s*["']([^"']+)["'])?/);
    if (!d || d[1] === 'children') continue;
    if (!props.some(p => p.name === d[1])) props.push({ name: d[1], type: '', desc: '' });
    if (d[2]) (optionSpec[d[1]] ||= { type: 'string' }).default = d[2];
  }
  for (const e of script.matchAll(/export\s+let\s+(\w+)\s*(?::\s*([^=;\n]+))?(?:=\s*["']([^"']+)["'])?/g)) {
    if (!props.some(p => p.name === e[1])) props.push({ name: e[1], type: (e[2] || '').trim(), desc: '' });
    const literals = [...(e[2] || '').matchAll(/["']([^"']+)["']/g)].map(x => x[1]);
    if (literals.length > 1) optionSpec[e[1]] = { type: 'string', values: literals };
    if (e[3]) (optionSpec[e[1]] ||= { type: 'string' }).default = e[3];
  }
  const doc = (src.match(/^\s*<!--([\s\S]*?)-->/) || [])[1]?.replace(/\s+/g, ' ').trim()
    || docBefore(script, script.search(/defineProps|\$props|export\s+let/))
    || (script.match(/\/\*\*([\s\S]*?)\*\//) || [])[1]?.split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim()).filter(l => l && !l.startsWith('@')).join(' ') || null;
  const attrs = Object.entries(optionSpec).filter(([, o]) => o.values).map(([k, o]) => `${k}="${o.values.slice(0, 4).join('|')}"`).join(' ');
  const source = relative(root, file);
  return [name, { signature: `<${name}${attrs ? ' ' + attrs : ''} />`, summary: doc || `${name} (${basename(file)})`, context: null, scope: 'component', source, params: props, optionSpec, framework, importFrom: source }];
}

/** The text between the brace at `open` and its match. */
function block(src, open) {
  let depth = 0, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}

/** [{ key, value }] for the top-level entries of an object literal's body. */
function entries(body) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  const flush = end => {
    const part = body.slice(start, end).trim();
    const m = part.match(/^(?:["']([^"']+)["']|([\w$-]+))\s*:\s*([\s\S]*)$/);
    if (m) out.push({ key: m[1] ?? m[2], value: m[3].trim() });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { flush(i); start = i + 1; }
  }
  flush(body.length);
  return out;
}

function cvaVariants(src) {
  const byVar = {};
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*cva\s*\(/g)) {
    const after = src.slice(m.index);
    const v = after.search(/\bvariants\s*:\s*{/);
    if (v < 0) continue;
    const vOpen = after.indexOf('{', v);
    const spec = {};
    for (const { key, value } of entries(block(after, vOpen))) {
      if (!value.startsWith('{')) continue;
      spec[key] = { type: 'string', values: entries(block(value, 0)).map(e => e.key) };
    }
    const d = after.search(/\bdefaultVariants\s*:\s*{/);
    if (d >= 0) {
      for (const { key, value } of entries(block(after, after.indexOf('{', d)))) {
        if (spec[key]) spec[key].default = value.replace(/^["'`]|["'`]$/g, '');
      }
    }
    byVar[m[1]] = spec;
  }
  return byVar;
}

function propsOf(src, name) {
  const m = src.match(new RegExp(`(?:interface|type)\\s+${name}Props\\b[^{=]*(?:=\\s*)?[^{]*{`));
  if (!m) return { props: [], optionSpec: {} };
  const body = block(src, m.index + m[0].length - 1);
  const props = [], optionSpec = {};
  for (const line of body.split(/[;\n]/)) {
    const p = line.match(/^\s*(?:readonly\s+)?["']?([\w-]+)["']?(\?)?\s*:\s*(.+?)\s*$/);
    if (!p) continue;
    props.push({ name: p[1], type: p[3], desc: p[2] ? 'optional' : 'required' });
    const literals = [...p[3].matchAll(/["']([^"']+)["']/g)].map(x => x[1]);
    if (literals.length > 1 && /^(\s*\|?\s*["'][^"']+["']\s*)+$/.test(p[3])) optionSpec[p[1]] = { type: 'string', values: literals };
  }
  return { props, optionSpec };
}

function docBefore(src, index) {
  const before = src.slice(0, index).trimEnd();
  if (!before.endsWith('*/')) return null;
  const start = before.lastIndexOf('/**');
  if (start < 0) return null;
  return before.slice(start + 3, -2).split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim())
    .filter(l => l && !l.startsWith('@')).join(' ') || null;
}

export function importReact(dirs, root) {
  const components = {};
  const files = dirs.flatMap(d => walk(d, { accept: p => COMPONENT_FILE.test(p) && !NOT_COMPONENT.test(p) }));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (/\.(vue|svelte)$/.test(file)) {
      const [name, entry] = sfcComponent(file, src, root);
      if (!components[name]) components[name] = entry;
      continue;
    }
    const names = new Map();
    for (const m of src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z]\w*)/g)) names.set(m[1], m.index);
    for (const m of src.matchAll(/export\s+(?:const|let)\s+([A-Z]\w*)\s*[:=]/g)) names.set(m[1], m.index);
    for (const m of src.matchAll(/export\s*{([^}]*)}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (n && /^[A-Z]/.test(n) && !names.has(n)) {
          const decl = src.search(new RegExp(`(?:function|const|let)\\s+${n}\\b`));
          names.set(n, decl >= 0 ? decl : m.index);
        }
      }
    }
    if (!names.size) continue;
    const variants = cvaVariants(src);
    const source = relative(root, file);
    for (const [name, at] of names) {
      if (components[name]) continue;
      const { props, optionSpec } = propsOf(src, name);
      const cva = variants[`${name[0].toLowerCase()}${name.slice(1)}Variants`] || {};
      const spec = { ...optionSpec, ...cva };
      const attrs = Object.entries(spec).map(([k, o]) => `${k}="${(o.values || []).slice(0, 4).join('|')}"`).join(' ');
      components[name] = {
        signature: `<${name}${attrs ? ' ' + attrs : ''} />`,
        summary: docBefore(src, at) || `${name} (${basename(file, extname(file))})`,
        context: null,
        scope: 'component',
        source,
        params: props,
        optionSpec: spec,
        framework: 'react',
        importFrom: source.replace(/\.(tsx|jsx)$/, ''),
      };
    }
  }
  return { components, files: files.length };
}

export function countComponents(dir) {
  return walk(dir, { maxDepth: 4, accept: p => COMPONENT_FILE.test(p) && !NOT_COMPONENT.test(p) }).length;
}

/** "react", "vue" or "svelte": whichever most of a folder's component files are. */
export function folderFramework(dir) {
  const counts = {};
  for (const f of walk(dir, { maxDepth: 4, accept: p => COMPONENT_FILE.test(p) && !NOT_COMPONENT.test(p) })) counts[frameworkOf(f)] = (counts[frameworkOf(f)] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'react';
}

export const COMPONENT_TYPES = ['react', 'vue', 'svelte'];

// ─── Figma variables ───

/** Is this JSON Figma's variables format (REST API /variables/local, or a plugin export of it)? */
export const isFigmaVariables = j => Boolean(j && typeof j === 'object' && (j.meta?.variables || j.variables) && (j.meta?.variableCollections || j.variableCollections));

const LENGTH_SCOPES = /CORNER_RADIUS|GAP|WIDTH_HEIGHT|FONT_SIZE|LINE_HEIGHT|STROKE_FLOAT|PARAGRAPH_SPACING|LETTER_SPACING|EFFECT_FLOAT/;
const toHex2 = n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0').toUpperCase();

/**
 * Figma variables as tokens, in each collection's default mode. A variable's name
 * comes from its Web code syntax when the designer set one (var(--color-brand) gives
 * --color-brand), else from its path (color/brand/primary gives --color-brand-primary).
 */
export function importFigma(files, root) {
  const tokens = {};
  const skipped = [];
  for (const file of files) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const meta = json.meta || json;
    const variables = meta.variables || {};
    const collections = meta.variableCollections || {};
    const source = relative(root, file);
    const nameOf = v => {
      const web = v.codeSyntax?.WEB && String(v.codeSyntax.WEB).match(/--[\w-]+/);
      return web ? web[0] : `--${String(v.name).split('/').map(slug).filter(Boolean).join('-')}`;
    };
    for (const v of Object.values(variables)) {
      if (v.remote && !v.valuesByMode) continue;
      const mode = collections[v.variableCollectionId]?.defaultModeId ?? Object.keys(v.valuesByMode || {})[0];
      const raw = v.valuesByMode?.[mode];
      const name = nameOf(v);
      let value = null;
      if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
        const target = variables[raw.id];
        value = target ? `var(${nameOf(target)})` : null;
      } else if (v.resolvedType === 'COLOR' && raw && typeof raw === 'object') {
        value = `#${[raw.r, raw.g, raw.b].map(toHex2).join('')}${raw.a !== undefined && raw.a < 1 ? toHex2(raw.a) : ''}`;
      } else if (v.resolvedType === 'FLOAT' && typeof raw === 'number') {
        const isLength = (v.scopes || []).some(sc => LENGTH_SCOPES.test(sc)) || /space|spacing|radius|size|gap|padding|margin|width|height/i.test(v.name);
        value = isLength ? `${raw}px` : String(raw);
      } else if (v.resolvedType === 'STRING' && typeof raw === 'string') {
        value = raw;
      }
      if (value === null) { skipped.push(name); continue; }
      if (!tokens[name]) tokens[name] = { value, source, purpose: v.description || null, figma: v.name };
    }
  }
  return { tokens: finishTokens(tokens), skipped };
}

export function countFigma(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return isFigmaVariables(j) ? Object.keys((j.meta || j).variables).length : 0;
  } catch { return 0; }
}

// ─── SwiftUI theme files ───

const SWIFT_COLOUR = /\b(?:Color|UIColor|NSColor)\s*\(\s*(?:hex\s*:|red\s*:|#colorLiteral|\.sRGB|displayP3|white\s*:)|#colorLiteral\(/g;

/** How many colour literals a Swift file declares. */
export function countSwiftColours(file) {
  try { return (readFileSync(file, 'utf8').match(SWIFT_COLOUR) || []).length; } catch { return 0; }
}

/**
 * The app a Swift file belongs to: its root is the nearest folder holding an
 * .xcodeproj, Package.swift or project.yml, and its source the first folder under
 * that root on the way to the file (Sources/<Target> for a Swift package).
 */
export function swiftAppFor(root, file) {
  const parts = relative(root, file).split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = join(root, ...parts.slice(0, i));
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    if (names.some(n => n.endsWith('.xcodeproj') || n === 'Package.swift' || n === 'project.yml')) {
      const appRoot = parts.slice(0, i).join('/') || '.';
      const rest = parts.slice(i);
      const sourceParts = rest[0] === 'Sources' && rest.length > 2 ? rest.slice(0, 2) : rest.slice(0, 1);
      const source = [...parts.slice(0, i), ...sourceParts].join('/');
      const name = (names.find(n => n.endsWith('.xcodeproj')) || '').replace(/\.xcodeproj$/, '') || sourceParts[sourceParts.length - 1] || basename(dir);
      const platform = /mac/i.test(appRoot + name) || readdirSafe(dir).includes('Package.swift') && /\.macOS\(/.test(readSafe(join(dir, 'Package.swift'))) ? 'macos' : 'ios';
      return { key: slug(name) || 'app', name, root: appRoot, source, platform };
    }
  }
  return null;
}
const readdirSafe = d => { try { return readdirSync(d); } catch { return []; } };
const readSafe = f => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
