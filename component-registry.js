/**
 * Component Registry: reads the agent contract, design-system/components.generated.json,
 * for every ws_* function, its option values and the legacy lookalikes, and ranks
 * requests with the same scripts/ds-search.mjs that ds:find uses. Nothing here
 * re-parses helpers.php or keeps its own keyword list.
 */
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { search } from './catalog-search.js';

/** Index just past a PHP string literal or comment starting at i, or i when there is none. */
function skipPhpLiteral(src, i) {
  const ch = src[i];
  if (ch === "'" || ch === '"') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === ch) return j + 1;
    }
    return src.length;
  }
  if ((ch === '/' && src[i + 1] === '/') || (ch === '#' && src[i + 1] !== '[')) {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl;
  }
  if (ch === '/' && src[i + 1] === '*') {
    const close = src.indexOf('*/', i + 2);
    return close < 0 ? src.length : close + 2;
  }
  return i;
}

/**
 * The top-level argument spans of a call whose "(" ends just before `from`,
 * as [{ start, end }], or null when the parentheses never balance.
 */
function phpCallArguments(src, from) {
  const args = [];
  let depth = 0, start = from;
  for (let i = from; i < src.length;) {
    const next = skipPhpLiteral(src, i);
    if (next > i) { i = next; continue; }
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        if (ch !== ')') return null;
        if (src.slice(start, i).trim() !== '') args.push({ start, end: i });
        return args;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      args.push({ start, end: i });
      start = i + 1;
    }
    i++;
  }
  return null;
}

/**
 * [start, end) spans of comments in a PHP template: // # and block comments in
 * PHP code, and HTML comments outside it. A source with no PHP open tag is read
 * as PHP throughout, the way a check_snippet fragment usually arrives.
 */
function commentSpans(src) {
  const spans = [];
  let php = !src.includes('<?');
  for (let i = 0; i < src.length;) {
    if (!php) {
      if (src.startsWith('<!--', i)) {
        const close = src.indexOf('-->', i + 4);
        const end = close < 0 ? src.length : close + 3;
        spans.push([i, end]);
        i = end;
      } else if (src.startsWith('<?', i)) {
        php = true;
        i += src.startsWith('<?php', i) ? 5 : src.startsWith('<?=', i) ? 3 : 2;
      } else i++;
      continue;
    }
    if (src.startsWith('?>', i)) { php = false; i += 2; continue; }
    const ch = src[i];
    if (ch === "'" || ch === '"') { i = skipPhpLiteral(src, i); continue; }
    if ((ch === '/' && src[i + 1] === '/') || (ch === '#' && src[i + 1] !== '[')) {
      let end = i;
      while (end < src.length && src[end] !== '\n' && !src.startsWith('?>', end)) end++;  // a line comment stops at ?>
      spans.push([i, end]);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      spans.push([i, end]);
      i = end;
      continue;
    }
    i++;
  }
  return spans;
}

/** A whole-argument string or number literal as { value, raw }, or null for anything computed. */
function phpScalarLiteral(src, { start, end }) {
  const raw = src.slice(start, end).trim();
  let m;
  if ((m = /^'((?:[^'\\]|\\.)*)'$/.exec(raw))) return { value: m[1].replace(/\\(['\\])/g, '$1'), raw };
  if ((m = /^"([^"\\$]*)"$/.exec(raw))) return { value: m[1], raw };
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { value: raw, raw };
  return null;
}

/** Is a written value one of the catalog's? '2' and 2.0 are the catalog's 2. */
function valueListed(values, value) {
  const numeric = v => String(v).trim() !== '' && !Number.isNaN(Number(v));
  return values.some(v => String(v) === String(value) || (numeric(v) && numeric(value) && Number(v) === Number(value)));
}

/**
 * Literal 'key' => 'value' pairs at the top level of the array literal in
 * src[start, end): [{ key, value, raw, index }]. The value is a plain string or
 * a number; one that is not a whole literal ('a' . $b, "x{$y}", a call) is not a pair.
 */
function phpArrayPairs(src, { start, end }) {
  let i = start;
  while (i < end && /\s/.test(src[i])) i++;
  let open;
  if (src[i] === '[') open = i + 1;
  else {
    const m = /^array\s*\(/i.exec(src.slice(i, end));
    if (!m) return [];
    open = i + m[0].length;
  }
  const tokens = [];
  let depth = 0;
  for (let j = open; j < end;) {
    const ch = src[j];
    const next = skipPhpLiteral(src, j);
    if (next > j) {
      if (depth === 0 && (ch === "'" || ch === '"')) tokens.push({ str: src.slice(j + 1, next - 1), quote: ch, index: j });
      j = next;
      continue;
    }
    if ('([{'.includes(ch)) { if (depth++ === 0) tokens.push({ other: true }); }
    else if (')]}'.includes(ch)) { if (--depth < 0) break; }
    else if (depth === 0) {
      if (ch === '=' && src[j + 1] === '>') { tokens.push({ arrow: true }); j += 2; continue; }
      const num = /^-?\d+(?:\.\d+)?(?![\w.])/.exec(src.slice(j, end));
      if (num && tokens[tokens.length - 1]?.arrow) { tokens.push({ num: num[0], index: j }); j += num[0].length; continue; }
      if (ch === ',') tokens.push({ comma: true });
      else if (!/\s/.test(ch)) tokens.push({ other: true });
    }
    j++;
  }
  const pairs = [];
  const plain = t => t && t.str !== undefined && !/\\/.test(t.str) && !(t.quote === '"' && /\$/.test(t.str));
  for (let t = 0; t < tokens.length; t++) {
    const v = tokens[t + 2];
    if (!plain(tokens[t]) || !tokens[t + 1]?.arrow || !(plain(v) || v?.num !== undefined)) continue;
    if (t > 0 && !tokens[t - 1].comma) continue;
    if (tokens[t + 3] && !tokens[t + 3].comma) continue;
    if (!/^[A-Za-z_]\w*$/.test(tokens[t].str)) continue;
    const value = v.num !== undefined ? v.num : v.str;
    pairs.push({ key: tokens[t].str, value, raw: v.num !== undefined ? v.num : `'${v.str}'`, index: tokens[t].index });
  }
  return pairs;
}

/**
 * Literal 'key' => keys at the top level of the array literal in src[start, end),
 * whatever their values: [{ key, index }]. A computed key is not one.
 */
function phpArrayKeys(src, { start, end }) {
  let i = start;
  while (i < end && /\s/.test(src[i])) i++;
  let open;
  if (src[i] === '[') open = i + 1;
  else {
    const m = /^array\s*\(/i.exec(src.slice(i, end));
    if (!m) return [];
    open = i + m[0].length;
  }
  const keys = [];
  let depth = 0, atItemStart = true, pending = null;
  for (let j = open; j < end;) {
    const ch = src[j];
    const next = skipPhpLiteral(src, j);
    if (next > j) {
      if (depth === 0 && (ch === "'" || ch === '"')) {
        pending = atItemStart ? { key: src.slice(j + 1, next - 1), index: j, quote: ch } : null;
        atItemStart = false;
      }
      j = next;
      continue;
    }
    if ('([{'.includes(ch)) { depth++; if (depth === 1) { pending = null; atItemStart = false; } }
    else if (')]}'.includes(ch)) { if (--depth < 0) break; }
    else if (depth === 0) {
      if (ch === '=' && src[j + 1] === '>') {
        if (pending && /^[A-Za-z_]\w*$/.test(pending.key) && !(pending.quote === '"' && /\$/.test(pending.key))) keys.push({ key: pending.key, index: pending.index });
        pending = null;
        j += 2;
        continue;
      }
      if (ch === ',') { atItemStart = true; pending = null; }
      else if (!/\s/.test(ch)) { atItemStart = false; pending = null; }
    }
    j++;
  }
  return keys;
}

export class ComponentRegistry {
  constructor() {
    this.components = new Map(); // function name -> catalog entry + { params, phpCall }
    this.htmlPatterns = [];      // anti-patterns that should use ws_* components
    this.legacyClasses = [];     // catalog.legacy.classes with compiled regexes
    this.data = null;            // { catalog, synonyms }
    this.loaded = false;
  }

  load() {
    this.data = search.loadCatalog();
    for (const [name, entry] of Object.entries(this.data.catalog.components || {})) {
      const m = String(entry.signature || '').match(/^ws_\w+\((.*)\)(?::\s*\S+)?$/);
      const rawParams = m ? m[1].trim() : '';
      const params = rawParams ? rawParams.split(/,(?![^\[]*\])/).map(p => p.trim()) : [];
      this.components.set(name, { ...entry, name, params, docParams: entry.params || [], phpCall: `${name}(${params.join(', ')})` });
    }
    this.legacyClasses = (this.data.catalog.legacy?.classes || []).map(l => ({ ...l, regex: new RegExp(l.match, 'g') }));
    this._buildHtmlPatterns();
    this.loaded = true;
    return this;
  }

  /**
   * A call with the option values the catalog documents, so a suggestion can
   * never name a variant the template does not render.
   */
  exampleCall(name, firstArg = "'...'") {
    const entry = this.components.get(name);
    if (!entry) return `${name}()`;
    const spec = entry.optionSpec || {};
    const pairs = ['variant', 'size', 'position']
      .filter(key => spec[key] && typeof spec[key].default === 'string' && spec[key].default !== '')
      .map(key => `'${key}' => '${spec[key].default}'`);
    const takesArg = entry.params.length > 0 && !/\$(options|opts)\b/.test(entry.params[0]);
    const opts = pairs.length ? `[${pairs.join(', ')}]` : '';
    const args = [takesArg ? firstArg : null, opts || null].filter(Boolean);
    if (!takesArg && opts) return `${name}(${opts})`;
    return `${name}(${args.join(', ')})`;
  }

  _buildHtmlPatterns() {
    // Map raw HTML patterns to the ws_* component they should use
    this.htmlPatterns = [
      {
        id: 'raw-button',
        pattern: /<button[^>]*class="[^"]*(?<![\w-])btn(?![\w-])[^"]*"/gi,
        description: 'Raw HTML button with "btn" class',
        suggestion: this.exampleCall('ws_button', '$text'),
        component: 'ws_button',
        severity: 'medium',
      },
      {
        id: 'raw-modal',
        pattern: /<div[^>]*class="[^"]*(?<![\w-])modal[-_]?(overlay|content|wrapper)\b[^"]*"/gi,
        description: 'Raw HTML modal structure',
        suggestion: `${this.exampleCall('ws_modal_start')} / ws_modal_end()`,
        component: 'ws_modal',
        severity: 'medium',
      },
      {
        id: 'raw-card',
        pattern: /<div[^>]*class="[^"]*(?<![\w-])card(?![\w-])(?!.*ws-)[^"]*"/gi,
        description: 'Raw HTML card (not using ws-card)',
        suggestion: `${this.exampleCall('ws_card_start')} / ws_card_end()`,
        component: 'ws_card',
        severity: 'low',
      },
      {
        id: 'raw-alert',
        pattern: /<div[^>]*class="[^"]*(?<![\w-])(alert|notification|message)(?![\w-])(?!.*ws-)[^"]*"/gi,
        description: 'Raw alert/notification markup',
        suggestion: this.exampleCall('ws_alert', '$message'),
        component: 'ws_alert',
        severity: 'medium',
      },
      {
        id: 'raw-badge',
        pattern: /<span[^>]*class="[^"]*(?<![\w-])badge(?![\w-])(?!.*ws-)[^"]*"/gi,
        description: 'Raw badge markup',
        suggestion: this.exampleCall('ws_badge', '$text'),
        component: 'ws_badge',
        severity: 'low',
      },
      {
        id: 'raw-tabs',
        pattern: /<(div|nav|ul)[^>]*class="[^"]*\btab(s|[-_]nav|[-_]list)\b(?!.*ws-)[^"]*"/gi,
        description: 'Raw tab navigation markup',
        suggestion: this.exampleCall('ws_tabs', '$items'),
        component: 'ws_tabs',
        severity: 'medium',
      },
      {
        id: 'raw-input-group',
        pattern: /<div[^>]*class="[^"]*\b(form[-_]group|input[-_]group)\b(?!.*ws-)[^"]*"/gi,
        description: 'Raw form group markup',
        suggestion: this.exampleCall('ws_form_row', '$content'),
        component: 'ws_form_row',
        severity: 'low',
      },
      {
        id: 'raw-progress',
        pattern: /<div[^>]*class="[^"]*\bprogress\b(?!.*ws-)[^"]*"/gi,
        description: 'Raw progress bar markup',
        suggestion: this.exampleCall('ws_progress', '$value'),
        component: 'ws_progress',
        severity: 'low',
      },
      {
        id: 'raw-tooltip',
        pattern: /<(span|div)[^>]*class="[^"]*\btooltip\b(?!.*ws-)[^"]*"/gi,
        description: 'Raw tooltip markup',
        suggestion: this.exampleCall('ws_tooltip', '$text'),
        component: 'ws_tooltip',
        severity: 'low',
      },
      {
        id: 'raw-accordion',
        pattern: /<div[^>]*class="[^"]*\b(accordion|collapsible|expandable)\b(?!.*ws-)[^"]*"/gi,
        description: 'Raw accordion/collapsible markup',
        suggestion: this.exampleCall('ws_accordion', '$items'),
        component: 'ws_accordion',
        severity: 'low',
      },
      {
        id: 'raw-skeleton',
        pattern: /<div[^>]*class="[^"]*\b(skeleton|placeholder|shimmer)\b(?!.*ws-)[^"]*"/gi,
        description: 'Raw skeleton/loading markup',
        suggestion: this.exampleCall('ws_skeleton'),
        component: 'ws_skeleton',
        severity: 'low',
      },
      {
        id: 'raw-empty-state',
        pattern: /<div[^>]*class="[^"]*\b(empty[-_]state|no[-_]results|no[-_]data)\b(?!.*ws-)[^"]*"/gi,
        description: 'Raw empty state markup',
        suggestion: this.exampleCall('ws_empty_state', '$title'),
        component: 'ws_empty_state',
        severity: 'low',
      },
    ];
  }

  /**
   * Check a file's content for raw HTML that should use ws_* components.
   */
  findComponentViolations(content, filePath) {
    const violations = [];
    const lines = content.split('\n');

    for (const patternDef of this.htmlPatterns) {
      // Reset regex lastIndex
      patternDef.pattern.lastIndex = 0;
      let match;
      while ((match = patternDef.pattern.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        violations.push({
          type: 'component',
          id: patternDef.id,
          severity: patternDef.severity,
          line: lineNum,
          match: match[0].substring(0, 80),
          message: patternDef.description,
          suggestion: `Use ${patternDef.suggestion} instead`,
          component: patternDef.component,
          file: filePath,
        });
      }
    }

    return violations;
  }

  /**
   * Check for inline style attributes in PHP files.
   */
  findInlineStyleViolations(content, filePath) {
    const violations = [];
    const styleRegex = /\bstyle\s*=\s*"([^"]*)"/gi;
    let match;
    while ((match = styleRegex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const styleValue = match[1];
      // Skip very short styles that might be dynamic display toggles
      if (styleValue === 'display: none' || styleValue === 'display:none') continue;
      violations.push({
        type: 'inline-style',
        severity: 'medium',
        line: lineNum,
        match: `style="${styleValue.substring(0, 60)}${styleValue.length > 60 ? '...' : ''}"`,
        message: 'Inline style attribute — move to CSS class or use ws_* component',
        file: filePath,
      });
    }
    return violations;
  }

  /**
   * Suggest which ws_* component to use for a description, ranked against the
   * catalog summary, usage and design-system/synonyms.json. Each suggestion's
   * example call takes its option values from the catalog. A request whose head
   * noun is a page, screen or flow gets the matching screen recipe, as component
   * "recipe:<id>" with kind "recipe", first when it outscores the components.
   */
  suggestComponent(description, limit = 5) {
    const recipes = search.rankRecipes(description, this.data).map(r => ({
      kind: 'recipe',
      component: r.name,
      recipe: r.id,
      title: r.title,
      reason: r.whenToUse,
      score: r.score,
      components: r.components,
      states: r.states,
      preview: r.preview,
      previews: r.previews,
      source: r.source,
      stylesheet: r.stylesheet,
      guide: r.guide,
      mobile: r.mobile,
      why: r.why,
      options: [],
      legacy: [],
    }));
    const components = search.rankComponents(description, this.data, limit).map(entry => ({
      kind: 'component',
      component: entry.name,
      reason: entry.whenToUse || entry.summary || entry.reason,
      score: entry.score,
      scope: entry.scope,
      example: entry.example || (entry.framework === 'react' ? entry.signature : this.exampleCall(entry.name)),
      options: search.optionSummary(entry),
      legacy: search.legacyFor(entry.name, this.data),
      demo: entry.demo,
      preview: entry.preview || null,
      previewKind: entry.previewKind || (entry.preview ? 'curated' : 'none'),
      insteadOf: entry.insteadOf || [],
    }));
    return search.placeRecipes(recipes, components).slice(0, limit);
  }

  /**
   * Legacy lookalike classes from the catalog's legacy section, as warnings. A
   * ws-/wl- class is the component itself (ws-modal-overlay is ws_modal's own
   * markup), so it is never read as the lookalike its tail resembles.
   */
  findLegacyClassViolations(content, filePath) {
    const violations = [];
    for (const legacy of this.legacyClasses) {
      const classAttr = /class\s*=\s*["']([^"']*)["']/g;
      let match;
      while ((match = classAttr.exec(content)) !== null) {
        const foreign = match[1].split(/\s+/).filter(c => c && !/^(ws|wl)-/.test(c)).join(' ');
        legacy.regex.lastIndex = 0;
        if (!legacy.regex.test(foreign)) continue;
        violations.push({
          type: 'legacy-class',
          severity: 'low',
          warning: true,
          line: content.substring(0, match.index).split('\n').length,
          match: match[0].substring(0, 80),
          message: `Warning: legacy lookalike ${legacy.pattern}`,
          suggestion: `Use ${legacy.use}() instead. ${legacy.why}`,
          component: legacy.use,
          file: filePath,
        });
      }
    }
    return violations;
  }

  /**
   * Option values the catalog does not list, e.g. ws_progress(40, ['variant' => 'brand']).
   * Only literal pairs at the top level of the argument the signature names
   * $options / $opts count: a pair inside a nested call or a nested array
   * belongs to something else (ws_card(['content' => ws_skeleton(['variant' => 'text'])])).
   * A positional argument the catalog gives values (ws_status's $status) is
   * checked when it is a literal. A call inside a PHP or HTML comment is skipped.
   */
  findOptionValueViolations(content, filePath) {
    const violations = [];
    const spans = commentSpans(content);
    const inComment = at => spans.some(([a, b]) => at >= a && at < b);
    const lineOf = at => content.substring(0, at).split('\n').length;
    const callRe = /\b(ws_[a-z0-9_]+)\s*\(/g;
    let call;
    while ((call = callRe.exec(content)) !== null) {
      const entry = this.components.get(call[1]);
      if (!entry || inComment(call.index)) continue;
      const args = phpCallArguments(content, call.index + call[0].length);
      if (!args) continue;
      for (const p of entry.docParams || []) {
        if (!Array.isArray(p.values) || !Number.isInteger(p.position) || p.position >= args.length) continue;
        const lit = phpScalarLiteral(content, args[p.position]);
        if (!lit || valueListed(p.values, lit.value)) continue;
        violations.push({
          type: 'option-value',
          severity: 'low',
          warning: true,
          line: lineOf(args[p.position].start + Math.max(0, content.slice(args[p.position].start, args[p.position].end).search(/\S/))),
          match: `${call[1]}(… ${lit.raw} …)`,
          message: `Warning: ${call[1]}() argument ${p.position + 1} (${p.name}) has no value "${lit.value}"`,
          suggestion: `Use one of: ${p.values.join(', ')}${p.default !== undefined ? ` (default ${JSON.stringify(p.default)})` : ''}`,
          component: call[1],
          file: filePath,
        });
      }
      if (!entry.optionSpec) continue;
      const at = entry.params.findIndex(p => /\$(options|opts)\b/.test(p));
      if (at < 0 || at >= args.length) continue;
      for (const pair of phpArrayPairs(content, args[at])) {
        const spec = entry.optionSpec[pair.key];
        if (!spec || !Array.isArray(spec.values) || valueListed(spec.values, pair.value)) continue;
        violations.push({
          type: 'option-value',
          severity: 'low',
          warning: true,
          line: lineOf(pair.index),
          match: `'${pair.key}' => ${pair.raw}`,
          message: `Warning: ${call[1]}() has no ${pair.key} "${pair.value}"`,
          suggestion: `Use one of: ${spec.values.join(', ')}${spec.default !== undefined ? ` (default ${JSON.stringify(spec.default)})` : ''}`,
          component: call[1],
          file: filePath,
        });
      }
    }
    return violations;
  }

  /**
   * Option names the catalog does not list, e.g. ws_input('q', ['icon' => 'search']):
   * a literal key at the top level of the argument the signature names $options /
   * $opts that is not in the helper's optionSpec, so the template never reads it.
   * A call inside a PHP or HTML comment is skipped.
   */
  findUnknownOptionViolations(content, filePath) {
    const violations = [];
    const spans = commentSpans(content);
    const inComment = at => spans.some(([a, b]) => at >= a && at < b);
    const lineOf = at => content.substring(0, at).split('\n').length;
    const callRe = /\b(ws_[a-z0-9_]+)\s*\(/g;
    let call;
    while ((call = callRe.exec(content)) !== null) {
      const entry = this.components.get(call[1]);
      if (!entry || !entry.optionSpec || inComment(call.index)) continue;
      const at = entry.params.findIndex(p => /\$(options|opts)\b/.test(p));
      if (at < 0) continue;
      const args = phpCallArguments(content, call.index + call[0].length);
      if (!args || at >= args.length) continue;
      const known = Object.keys(entry.optionSpec);
      for (const { key, index } of phpArrayKeys(content, args[at])) {
        if (known.includes(key)) continue;
        violations.push({
          type: 'option-name',
          severity: 'low',
          warning: true,
          line: lineOf(index),
          match: `${call[1]}(… '${key}' => …)`,
          message: `Warning: ${call[1]}() has no option "${key}"; the template never reads it`,
          suggestion: `Its options are: ${known.join(', ')}`,
          component: call[1],
          file: filePath,
        });
      }
    }
    return violations;
  }

  getComponentList() {
    return Array.from(this.components.entries()).map(([name, data]) => ({
      name,
      params: data.params,
      phpCall: data.phpCall,
      summary: data.summary,
      scope: data.scope,
      framework: data.framework,
      signature: data.signature,
      source: data.source,
      importFrom: data.importFrom,
    }));
  }
}
