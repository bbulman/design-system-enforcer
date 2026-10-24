/**
 * Accessibility review: what can be seen in the code itself.
 *
 *   names       images without alt, icon-only buttons and links with no label,
 *               form fields with no label
 *   keyboard    clickable divs and spans with no role or keyboard support,
 *               positive tabindex, aria-hidden on focusable elements, autofocus
 *   structure   skipped heading levels, links without href, <html> without lang
 *   contrast    WCAG ratios for text and background colours used together (Tailwind
 *               classes, inline styles, CSS rules), and for the design system's own
 *               colour pairs (primary / primary-foreground)
 *
 * It can't see the rendered page: focus order, focus visibility, target size,
 * zoom and screen-reader output need the browser's accessibility tree.
 */
import { parseColor, contrast, toHex } from './colour.js';
import { classColour, resolveVar } from './tailwind.js';

const blankKeep = s => s.replace(/[^\n]/g, ' ');
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const attr = (attrs, ...names) => names.some(n => new RegExp(`(?:^|[\\s:@])${n}\\s*=`, 'i').test(attrs) || new RegExp(`(?:^|\\s)(?::|v-bind:)${n}\\s*=`, 'i').test(attrs));
const NAMED = ['aria-label', 'aria-labelledby', 'title'];

/** Large text per WCAG: 24px, or 18.66px bold; from Tailwind classes. */
function isLargeText(classes) {
  const big = /(^|\s)(?:[\w-]+:)?text-(2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/.test(classes);
  const bold = /(^|\s)(?:[\w-]+:)?font-(bold|extrabold|black|semibold)\b/.test(classes);
  return big || (bold && /(^|\s)(?:[\w-]+:)?text-(lg|xl)\b/.test(classes));
}

function ratioFinding(line, fg, bg, large, where, filePath) {
  const ratio = contrast(fg.colour, bg.colour);
  const need = large ? 3 : 4.5;
  if (ratio >= need) return null;
  return {
    type: 'a11y-contrast', severity: ratio < 3 ? 'high' : 'medium', line, match: `${fg.label} on ${bg.label}`,
    message: `Contrast ${ratio.toFixed(2)}:1 for ${fg.label} on ${bg.label}${where}; WCAG AA needs ${need}:1${large ? ' for large text' : ''} (1.4.3)`,
    suggestion: 'Use a darker text colour or a lighter background from the design system (list_tokens or a11y_review with tokens shows the pairs that pass)',
    autoFixable: false, file: filePath,
  };
}

const cssColour = (value, tokenParser) => {
  const v = resolveVar(String(value).trim(), tokenParser);
  const c = parseColor(v);
  return c && c.a === 1 ? { colour: c, label: value.trim().startsWith('var(') ? value.trim().match(/--[\w-]+/)[0] : toHex(c) } : null;
};

export function reviewA11y(content, filePath, tokenParser) {
  const out = [];
  const push = (line, type, severity, match, message, suggestion) => out.push({ type, severity, line, match, message, suggestion, autoFixable: false, file: filePath });
  // Blank comments (JS and HTML) but keep every newline, so line numbers stay exact.
  const text = content.replace(/<!--[\s\S]*?-->/g, blankKeep).replace(/\/\*[\s\S]*?\*\//g, blankKeep).replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p) => p + blankKeep(m.slice(p.length)));
  const isMarkup = /\.(jsx|tsx|vue|svelte|html?|php)$/i.test(filePath);
  const isCss = /\.(css|scss|vue|svelte|html?)$/i.test(filePath);

  if (isMarkup) {
    // Names: images
    for (const m of text.matchAll(/<(img|Image)\b([^>]*?)\/?>/g)) {
      if (attr(m[2], 'alt') || /\{\.\.\.\w+\}/.test(m[2])) continue;
      push(lineAt(text, m.index), 'a11y-img-alt', 'high', `<${m[1]}>`, 'Image without alt text (1.1.1)', 'Add alt describing the image, or alt="" if it is decorative');
    }
    // Names: icon-only buttons and links
    for (const m of text.matchAll(/<(button|a|Button|Link|IconButton)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const [, tag, attrs, inner] = m;
      if (attr(attrs, ...NAMED) || /\{\.\.\.\w+\}|v-bind="/.test(attrs)) continue;
      const textInside = inner.replace(/<(svg)\b[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
      if (textInside) continue; // visible text or an expression like {label}
      if (/aria-label|sr-only|visually-hidden|VisuallyHidden/.test(inner)) continue;
      // An image inside with real alt text names the button or link.
      if (/<(img|Image)\b[^>]*\balt\s*=\s*("[^"]+"|'[^']+'|\{[^}]+\})/.test(inner)) continue;
      push(lineAt(text, m.index), 'a11y-name', 'high', `<${tag}>`, `${tag === 'a' || tag === 'Link' ? 'Link' : 'Button'} with no accessible name: it holds only an icon or nothing (4.1.2)`,
        'Add aria-label, or visually hidden text (class="sr-only") describing what it does');
    }
    // Names: form fields
    const labelled = new Set([...text.matchAll(/(?:for|htmlFor)\s*=\s*["'{]?\s*["']?([\w-]+)/g)].map(m => m[1]));
    for (const m of text.matchAll(/<(input|select|textarea)\b([^>]*?)\/?>/g)) {
      const attrs = m[2];
      if (/type\s*=\s*["'](hidden|submit|button|reset|image)["']/i.test(attrs)) continue;
      if (attr(attrs, 'aria-label', 'aria-labelledby', 'title') || /\{\.\.\.\w+\}|v-bind="/.test(attrs)) continue;
      const id = attrs.match(/\bid\s*=\s*["'{]?\s*["']?([\w-]+)/);
      if (id && labelled.has(id[1])) continue;
      const before = text.slice(0, m.index);
      if ((before.match(/<label\b/g) || []).length > (before.match(/<\/label>/g) || []).length) continue;
      push(lineAt(text, m.index), 'a11y-label', 'medium', `<${m[1]}>`, `Form field without a label (1.3.1, 4.1.2)${/placeholder/.test(attrs) ? '; a placeholder is not a label' : ''}`,
        'Wrap it in <label>, point a label at it with for/htmlFor, or add aria-label');
    }
    // Keyboard: clickable things that aren't interactive
    for (const m of text.matchAll(/<(div|span|li|td|tr|p|section|article|img|svg)\b([^>]*?)(?:\/?)>/g)) {
      const attrs = m[2];
      if (!/(?:onClick|@click|on:click|onclick|v-on:click)\s*=/.test(attrs)) continue;
      const role = attrs.match(/\brole\s*=\s*["']?(\w+)/);
      const focusable = /tabIndex|tabindex/.test(attrs);
      const keys = /(onKeyDown|onKeyUp|onKeyPress|@keydown|@keyup|on:keydown|on:keyup|onkeydown)/.test(attrs);
      if (role && focusable && keys) continue;
      push(lineAt(text, m.index), 'a11y-keyboard', 'high', `<${m[1]} onClick>`, `Clickable <${m[1]}> that keyboard users can't reach or press (2.1.1)`,
        role || focusable ? 'Add the missing role, tabIndex={0} and a key handler, or use a <button>' : 'Use a <button> (or the design system\'s Button) instead');
    }
    for (const m of text.matchAll(/tab[iI]ndex\s*=\s*["'{]?\s*([1-9]\d*)/g)) {
      push(lineAt(text, m.index), 'a11y-tabindex', 'medium', m[0], 'Positive tabindex reorders the keyboard path (2.4.3)', 'Use 0 or -1 and order the markup instead');
    }
    for (const m of text.matchAll(/<(button|a|input|select|textarea|Button)\b([^>]*aria-hidden\s*=\s*["'{]?\s*true[^>]*)>/g)) {
      if (/tab[iI]ndex\s*=\s*["'{]?\s*-1/.test(m[2])) continue;
      push(lineAt(text, m.index), 'a11y-hidden-focusable', 'high', `<${m[1]} aria-hidden>`, 'A focusable element is hidden from screen readers (4.1.2)', 'Remove aria-hidden, or take it out of the tab order with tabIndex={-1}');
    }
    for (const m of text.matchAll(/\b(autoFocus|autofocus)\b(?!\s*=\s*\{?\s*false)/g)) {
      push(lineAt(text, m.index), 'a11y-autofocus', 'low', m[1], 'Autofocus moves screen-reader and keyboard users without warning (3.2.1)', 'Remove it unless the page has one obvious first task, like a dialog\'s first field');
    }
    // Structure
    let last = 0;
    for (const m of text.matchAll(/<h([1-6])\b/g)) {
      const level = +m[1];
      if (last && level > last + 1) push(lineAt(text, m.index), 'a11y-heading-order', 'low', `<h${level}>`, `Heading jumps from h${last} to h${level} (1.3.1)`, `Use h${last + 1}, and style it with classes if it should look smaller`);
      last = level;
    }
    for (const m of text.matchAll(/<a\b([^>]*)>/g)) {
      const attrs = m[1];
      if (/\{\.\.\.\w+\}|v-bind="/.test(attrs)) continue;
      if (!attr(attrs, 'href') && !/\brole\s*=/.test(attrs)) push(lineAt(text, m.index), 'a11y-link', 'low', '<a>', 'Link without href is not focusable or announced as a link (2.1.1)', 'Give it an href, or use a <button> for an action');
      else if (/href\s*=\s*["']#["']/.test(attrs) && /(onClick|@click|on:click)/.test(attrs)) push(lineAt(text, m.index), 'a11y-link', 'medium', 'href="#"', 'A link used as a button (4.1.2)', 'Use a <button> for actions; links are for going somewhere');
    }
    const html = text.match(/<html\b([^>]*)>/);
    if (html && !attr(html[1], 'lang')) push(lineAt(text, html.index), 'a11y-lang', 'medium', '<html>', 'Page language not set (3.1.1)', 'Add lang="en" (or the page\'s language) to <html>');

    // Contrast: Tailwind text-* and bg-* on the same element
    for (const m of text.matchAll(/(?:class|className)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\}|\{\s*"([^"]*)"\s*\})/g)) {
      const classes = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      const plain = classes.split(/\s+/).filter(c => !c.includes(':')); // base state only; hover:/dark: are other states
      const textCls = plain.map(c => c.match(/^text-(.+)$/)?.[1]).filter(v => v && !/^(xs|sm|base|lg|xl|\dxl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(v));
      const bgCls = plain.map(c => c.match(/^bg-(.+)$/)?.[1]).filter(Boolean);
      if (!textCls.length || !bgCls.length) continue;
      const fg = classColour(textCls[textCls.length - 1], tokenParser), bg = classColour(bgCls[bgCls.length - 1], tokenParser);
      if (!fg || !bg) continue;
      const f = ratioFinding(lineAt(text, m.index), { ...fg, label: `text-${textCls[textCls.length - 1]}` }, { ...bg, label: `bg-${bgCls[bgCls.length - 1]}` }, isLargeText(classes), '', filePath);
      if (f) out.push(f);
    }
    // Contrast: inline styles
    for (const m of text.matchAll(/style\s*=\s*(?:"([^"]*)"|\{\{([^}]*)\}\})/g)) {
      const s = m[1] ?? m[2];
      const color = s.match(/(?:^|[;,{\s])color\s*:\s*["']?([^;,"'}]+)/);
      const background = s.match(/background(?:-color|Color)?\s*:\s*["']?([^;,"'}]+)/);
      if (!color || !background) continue;
      const fg = cssColour(color[1], tokenParser), bg = cssColour(background[1], tokenParser);
      if (fg && bg) { const f = ratioFinding(lineAt(text, m.index), fg, bg, false, ' (inline style)', filePath); if (f) out.push(f); }
    }
  }

  // Contrast: CSS rules that set both colour and background
  if (isCss) {
    const css = /\.(css|scss)$/i.test(filePath) ? text : text.replace(/[\s\S]*?(<style\b[^>]*>)|<\/style>[\s\S]*?(?=<style\b|$)/g, blankKeep);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2];
      const color = body.match(/(?:^|[;\s])color\s*:\s*([^;]+)/);
      const background = body.match(/background(?:-color)?\s*:\s*([^;]+)/);
      if (!color || !background) continue;
      const fg = cssColour(color[1], tokenParser), bg = cssColour(background[1].trim().split(/\s+/).length === 1 ? background[1] : '', tokenParser);
      if (fg && bg) { const f = ratioFinding(lineAt(css, m.index + m[1].length), fg, bg, false, ` in ${m[1].trim().split('\n').pop().trim()}`, filePath); if (f) out.push(f); }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * The design system's own colour pairs, checked before anyone uses them: every token
 * with a matching -foreground token (shadcn's primary / primary-foreground), and
 * background with foreground. Returns [{ bg, fg, ratio, passes, large }].
 */
export function tokenPairs(tokenParser) {
  const names = [...(tokenParser.tokens?.keys() || [])];
  const has = new Set(names);
  const pairs = [];
  for (const n of names) {
    const fgName = `${n}-foreground`;
    if (!has.has(fgName)) continue;
    // Tailwind v4 mirrors --primary as --color-primary; check the pair once.
    if (n.startsWith('--color-') && has.has(`--${n.slice('--color-'.length)}`) && has.has(`--${n.slice('--color-'.length)}-foreground`)) continue;
    pairs.push([n, fgName]);
  }
  if (has.has('--background') && has.has('--foreground')) pairs.unshift(['--background', '--foreground']);
  if (has.has('--color-background') && has.has('--color-foreground')) pairs.unshift(['--color-background', '--color-foreground']);
  const out = [];
  for (const [bgName, fgName] of pairs) {
    const bg = parseColor(resolveVar(tokenParser.tokens.get(bgName), tokenParser));
    const fg = parseColor(resolveVar(tokenParser.tokens.get(fgName), tokenParser));
    if (!bg || !fg || bg.a < 1 || fg.a < 1) continue;
    const ratio = contrast(fg, bg);
    out.push({ bg: bgName, fg: fgName, bgHex: toHex(bg), fgHex: toHex(fg), ratio, passes: ratio >= 4.5, largeOnly: ratio >= 3 && ratio < 4.5 });
  }
  return out;
}
