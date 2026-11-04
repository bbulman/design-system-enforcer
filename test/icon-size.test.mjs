import './helpers/kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSmallIcons } from '../icon-size.js';
import { TokenParser } from '../token-parser.js';
import { validateFile } from '../validators.js';
import { ComponentRegistry } from '../component-registry.js';
import { projectPath, config } from '../config.js';

const tokens = new TokenParser().load();
const found = (text, file) => findSmallIcons(text, projectPath(file), tokens).map(v => [v.line, v.match]);

test('a glyph or SVG icon rule under 24px is reported, with the size it resolves to', () => {
  const css = [
    '.a .glyphs-outlined { font-size: 14px; }',
    '.b .icon { width: 16px; height: 16px; }',
    '.c .glyphs-rounded { font-size: 1rem; }',
    '.d .icon { font-size: var(--glyph-sm); }',
  ].join('\n');
  assert.deepEqual(found(css, 'css/x.css'), [[1, 'font-size: 14px'], [2, 'width: 16px'], [2, 'height: 16px'], [3, 'font-size: 1rem'], [4, 'font-size: var(--glyph-sm)']]);
  const [v] = findSmallIcons('.c .glyphs-rounded { font-size: 1rem; }', projectPath('css/x.css'), tokens);
  assert.equal(v.type, 'small-icon');
  assert.equal(v.severity, 'medium');
  assert.match(v.message, /14px/);
  assert.equal(v.message, 'Icon drawn at 14px; an icon is at least 24px (STYLE.md §3)');
  assert.equal(v.suggestion, 'Use var(--glyph-lg) or larger; a size that follows its text: max(var(--glyph-lg), 1em)');
});

test('24px and up, relative sizes, and selectors that are not icons are left alone', () => {
  const css = [
    '.a .glyphs-outlined { font-size: 24px; }',
    '.b .icon { width: var(--glyph-lg, 24px); height: var(--glyph-xl); }',
    '.c .icon { width: max(var(--glyph-lg, 24px), 1em); }',
    '.d .glyphs-outlined { font-size: 0.8em; }',
    '.energy-chart svg { height: 12px; }',
    '.status-dot svg { width: 8px; }',
    '.card__title { font-size: 14px; }',
    '.btn { width: 16px; }',
    '/* .x .icon { width: 12px } */',
  ].join('\n');
  assert.deepEqual(found(css, 'css/x.css'), []);
});

test('the retired icon tokens are reported wherever they are used, once per line', () => {
  const css = '.a { gap: var(--glyph-sm); }\n.b .icon { width: var(--glyph-md); }\n.c { gap: var(--glyph-xl); }';
  assert.deepEqual(found(css, 'css/x.css'), [[2, 'width: var(--glyph-md)'], [1, 'var(--glyph-sm)']]);
  const [retired] = findSmallIcons('.a { gap: var(--glyph-sm); }', projectPath('css/x.css'), tokens);
  assert.equal(retired.message, '--glyph-sm is retired for icons; an icon is at least 24px (STYLE.md §3)');
});

test('in markup: a small inline icon SVG on the 24-unit grids, and an inline glyph size', () => {
  const php = [
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20"></svg>',
    '<svg width="24" height="24" viewBox="0 0 24 24" stroke-width="1.5"></svg>',
    '<svg width="12" viewBox="0 0 100 20"></svg>',
    '<span class="glyphs-outlined" style="font-size:18px">add</span>',
    '<span class="glyphs-outlined" style="font-size: 24px">add</span>',
  ].join('\n');
  assert.deepEqual(found(php, 'app/x.php'), [[1, 'width="16"'], [2, 'height="20"'], [5, 'font-size: 18px']]);
  // In a JavaScript string, with escaped quotes.
  const js = 'el.innerHTML = "<svg width=\\"18\\" height=\\"18\\" viewBox=\\"0 0 24 24\\"></svg>";';
  assert.deepEqual(found(js, 'js/x.js'), [[1, 'width="18"']]);
});

test("a PHP page's <style> block is read as a stylesheet, with the page's line numbers", () => {
  const php = '<p>Hello</p>\n<style>\n.x .glyphs-outlined {\n  font-size: 18px;\n}\n</style>';
  assert.deepEqual(found(php, 'app/x.php'), [[4, 'font-size: 18px']]);
});

test('an inline SVG sized in em, rem or % follows its text and is left alone; px and unitless are pixels', () => {
  const php = [
    '<svg viewBox="0 0 24 24" width="1em" height="1em"></svg>',
    '<svg viewBox="0 0 24 24" width="1.25rem"></svg>',
    '<svg viewBox="0 0 24 24" width="100%"></svg>',
    '<svg viewBox="0 0 24 24" width="16px"></svg>',
  ].join('\n');
  assert.deepEqual(found(php, 'app/x.php'), [[4, 'width="16"']]);
});

test('a rule after an @import, and an icon pseudo-element, are read', () => {
  const css = '@import url("x.css");\n.a .icon { width: 12px; }\n.b .icon::before { width: 10px; }';
  assert.deepEqual(found(css, 'css/x.css'), [[2, 'width: 12px'], [3, 'width: 10px']]);
});

test('ds-lint-disable markers keep a deliberate exception', () => {
  const css = '.a .icon { width: 16px; } /* ds-lint-disable-line */\n/* ds-lint-disable-next-line */\n.b .icon { width: 16px; }';
  assert.deepEqual(found(css, 'css/x.css'), []);
});

test('the token file is never graded, and validateFile carries the rule for every caller', () => {
  assert.deepEqual(found(':root { --glyph-sm: 16px; } .a .icon { width: var(--glyph-sm); }', 'ds/tokens.css'), []);
  const registry = new ComponentRegistry().load();
  const all = validateFile('.a .glyphs-outlined { font-size: 12px; }', projectPath('css/x.css'), tokens, registry);
  assert.equal(all.filter(v => v.type === 'small-icon').length, 1);
});

/* The rule as a project sets it (config iconSize), for one call. */
function withIconSize(settings, fn) {
  const saved = config.iconSize;
  config.iconSize = settings;
  try { return fn(); } finally { config.iconSize = saved; }
}

test('the rule is off unless the project switches it on', () => {
  const css = '.a .glyphs-outlined { font-size: 12px; }\n.b .icon { width: 16px; }\n.c { gap: var(--glyph-sm); }';
  for (const off of [undefined, {}, { enabled: false, min: 24, glyphClasses: ['glyphs'] }]) {
    assert.deepEqual(withIconSize(off, () => found(css, 'css/x.css')), [], JSON.stringify(off));
  }
  assert.equal(found(css, 'css/x.css').length, 3);
});

test('the minimum, the token, the retired tokens, the glyph classes and the document are the project\'s', () => {
  const css = '.a .fa { font-size: 18px; }\n.b .icon { width: 30px; }\n.c { gap: var(--size-tiny); }\n.d .glyphs-outlined { font-size: 12px; }';
  const got = withIconSize({ enabled: true, min: 32, glyphClasses: ['fa'], retired: ['--size-tiny'] },
    () => findSmallIcons(css, projectPath('css/x.css'), tokens));
  assert.deepEqual(got.map(v => [v.line, v.match]), [[1, 'font-size: 18px'], [2, 'width: 30px'], [3, 'var(--size-tiny)']]);
  // No token named: the suggestion names the minimum in px; no document: the message cites none.
  assert.equal(got[0].suggestion, 'Use 32px or larger; a size that follows its text: max(32px, 1em)');
  assert.equal(got[0].message, 'Icon drawn at 18px; an icon is at least 32px');
  // Inline glyph classes default to the glyph classes.
  const markup = '<i class="fa fa-close" style="font-size:20px"></i>\n<span class="glyphs-outlined" style="font-size:12px">x</span>';
  assert.deepEqual(withIconSize({ enabled: true, min: 32, glyphClasses: ['fa'] }, () => found(markup, 'pages/x.php')), [[1, 'font-size: 20px']]);
  assert.deepEqual(withIconSize({ enabled: true, glyphClasses: ['fa'], inlineGlyphClasses: [] }, () => found(markup, 'pages/x.php')), []);
});
