import './helpers/kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateKind, markupTokens, addsMarkup } from '../gate/markup.mjs';
import { gateSettings } from '../gate/settings.mjs';

const s = gateSettings();

test('gateKind', () => {
  assert.equal(gateKind('pages/team.php', s), 'gate');
  assert.equal(gateKind('css/styles.css', s), 'gate');
  assert.equal(gateKind('js/app.js', s), 'detect');
  assert.equal(gateKind('api/plans.php', s), null);
  assert.equal(gateKind('lib/components/badge.php', s), null);
  assert.equal(gateKind('README.md', s), null);
});

test('gateKind only detects html, which cannot call a helper, and skips what settings.skip names', () => {
  assert.equal(gateKind('pages/hybrid.html', s), 'detect');
  assert.equal(gateKind('pages/team.php', { skip: [/^pages\//] }), null);
});

test('the gated and detected file types come from componentGate.files, the defaults when settings carry none', () => {
  const twig = { skip: [], gated: new Set(['.twig']), detected: new Set(['.vue']) };
  assert.equal(gateKind('templates/team.twig', twig), 'gate');
  assert.equal(gateKind('pages/team.php', twig), null);
  assert.equal(gateKind('src/App.vue', twig), 'detect');
  assert.equal(gateKind('js/app.js', twig), null);
  assert.equal(gateKind('pages/team.php', {}), 'gate');
  assert.equal(gateKind('css/site.css', {}), 'gate');
  assert.equal(gateKind('js/app.js', {}), 'detect');
  assert.equal(gateKind('pages/hybrid.html', {}), 'detect');
  assert.deepEqual([...s.gated], ['.php', '.css']);
  assert.deepEqual([...s.detected], ['.js', '.html']);
});

test('a wording change adds no markup', () => {
  assert.equal(addsMarkup('<p class="x">Hi</p>', '<p class="x">Hello</p>', 'php'), false);
});

test('a new class adds markup', () => {
  assert.equal(addsMarkup('<p class="x">Hi</p>', '<p class="x status-badge">Hi</p>', 'php'), true);
});

test('a new element adds markup', () => {
  assert.equal(addsMarkup('<p>Hi</p>', '<p>Hi</p><dialog></dialog>', 'php'), true);
});

test('PHP logic only adds no markup', () => {
  assert.equal(addsMarkup('<?php $a = 1; ?><p>x</p>', '<?php $a = 2; if ($a) { echo 1; } ?><p>x</p>', 'php'), false);
});

test('a new CSS selector adds markup, a property change does not', () => {
  assert.equal(addsMarkup('.a{color:red}', '.a{color:red}.b{}', 'css'), true);
  assert.equal(addsMarkup('.a{color:red}', '.a{color:blue}', 'css'), false);
});

test('a write to an empty file with markup adds markup', () => {
  assert.equal(addsMarkup('', '<div class="card"></div>', 'php'), true);
});

test('markupTokens collects tag names and every class token, single or double quoted', () => {
  const t = markupTokens(`<DIV class="a  b"><span class='c'>x</span></DIV><img src="i.png"/>`, 'php');
  assert.deepEqual([...t.elements].sort(), ['div', 'img', 'span']);
  assert.deepEqual([...t.classes].sort(), ['a', 'b', 'c']);
});

test('html is read as markup', () => {
  const t = markupTokens('<section class="hero"></section>', 'html');
  assert.deepEqual([...t.elements], ['section']);
  assert.deepEqual([...t.classes], ['hero']);
});

test('markup PHP builds inside strings is not counted', () => {
  assert.equal(addsMarkup('<?php $a = 1; ?>', `<?php echo '<div class="x">'; ?>`, 'php'), false);
  assert.equal(addsMarkup('<p></p>', `<p><?= '<span class="pill">' ?></p>`, 'php'), false);
  const t = markupTokens(`<p class="lead <?= $extra ?>">x</p>`, 'php');
  assert.deepEqual([...t.classes], ['lead']);
});

test('an unclosed PHP block runs to the end of the text', () => {
  assert.equal(addsMarkup('<p></p><?php', `<p></p><?php echo '<dialog class="m">';`, 'php'), false);
});

test('a fragment that starts inside a PHP block ignores the PHP part', () => {
  assert.equal(addsMarkup(`$a = 1; ?><p></p>`, `echo '<div class="x">'; ?><p></p>`, 'php'), false);
  assert.equal(addsMarkup(`$a = 1; ?><p></p>`, `$a = 1; ?><p class="new"></p>`, 'php'), true);
});

test('markup inside an HTML comment is not counted', () => {
  assert.equal(addsMarkup('<p></p>', '<p></p><!-- <div class="later"></div> -->', 'php'), false);
});

test('a data-class attribute is not a class', () => {
  assert.deepEqual([...markupTokens('<p data-class="x"></p>', 'php').classes], []);
});

test('CSS class names come from selectors only, with comments stripped', () => {
  const css = `/* .ghost { } */
@media (min-width: 37.5em) { .a, .b:hover > .c:not(.d) { color: red; } }
a[href$=".pdf"] { background: url("x.png"); }
@layer framework.layout { .e { margin: .5rem; .f { color: #fff; } } }`;
  const t = markupTokens(css, 'css');
  assert.deepEqual([...t.classes].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual([...t.elements], []);
  assert.deepEqual([...markupTokens('.a{}', '.css').classes], ['a']);
});
