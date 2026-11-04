#!/usr/bin/env node
/**
 * Self-test for the enforcer's catalog-backed behaviour, against the kit fixture (tests/fixtures/kit,
 * copied to a temporary folder by test/helpers/kit.mjs). Imports the modules directly (index.js starts
 * a stdio server on import), so it runs without an MCP client: `node self-test.js` or `npm test`.
 * A project's own checks of its real catalog and pages live in that project.
 */
const { ROOT } = await import('./test/helpers/kit.mjs');
const { config } = await import('./config.js');
const { TokenParser } = await import('./token-parser.js');
const { ComponentRegistry } = await import('./component-registry.js');
const { validateCSS, validatePHP, validateSwift, validateFile } = await import('./validators.js');
const {
  loadNative, appFiles, runNativeCheck, readBaseline, compareToBaseline, baselineKey, parseThemeConstants, nearestToken, tokenForHex, PROJECT_ROOT,
} = await import('./native.js');

const tokens = new TokenParser().load();
const registry = new ComponentRegistry().load();
const native = loadNative();

const THEME = 'apps/pocket/Pocket/Theme/Theme.swift';
const VIEW = 'apps/pocket/Pocket/Screens/HomeView.swift';
const PROBE = 'apps/pocket/Pocket/Screens/Probe.swift';
const MAC_VIEW = 'apps/desk/Sources/Desk/Views/Probe.swift';
const swift = (code, path) => validateSwift(code, path, tokens, native);
const rules = (list, rule) => list.filter(v => v.type === rule);

const themeDrift = swift([
  'enum Kit {',
  '    enum C {',
  '        static let ink = Color(hex: 0x1F2937)       // --color-ink',
  '        static let off = Color(hex: 0x123456)       // --brand',
  '        static let odd = Color(hex: 0x1F2937)       // --no-such-token',
  '        static let veil = Color.white.opacity(0.85) // --overlay-medium',
  '    }',
  '}',
].join('\n'), THEME);
const sanctioned = swift([
  'enum Palette {',
  '    static let odd = Color(hex: 0x123456)',
  '}',
  'enum Tone: Hashable {',
  '    case a',
  '    var accent: Color {',
  '        switch self {',
  '        case .a: Color(hex: 0x654321)',
  '        }',
  '    }',
  '}',
].join('\n'), THEME);
// Any single-colour constant a view could name, so the case follows the theme file.
const appConstant = [...(native.byHex.get('pocket') || new Map()).entries()].map(([hex, list]) => [hex, list.find(g => !g.sanctioned)]).find(([, g]) => g);
const inView = appConstant ? swift(`Text("x").foregroundStyle(Color(hex: 0x${appConstant[0].slice(1)}))`, VIEW) : [];
const generic = swift([
  'let c = Color(hexString: category.color)',
  'Text("a").foregroundStyle(.black)',
  'Text("b").foregroundColor(Color.black)',
  'card.shadow(color: .black.opacity(0.1), radius: 4)',
  'Text("http://x").foregroundStyle(.black) // ds-lint-disable-line',
  '// Text("c").foregroundStyle(Color(hex: 0x123456))',
  '/* Text("d").foregroundStyle(.black) */',
  'Text("e").font(.custom("Helvetica", size: 14))',
  'Text("f").font(.custom("Kitserif-Bold", size: 14)).font(.custom("Kitsans-Regular", size: 12))',
  'let i = UIFontDescriptor(name: "Kit Glyphs", size: 20)',
  'Text("g").font(.custom("KitGlyphs-Regular", size: 20))',
  '// ds-lint-disable-next-line',
  'Text("h").foregroundStyle(.black)',
].join('\n'), VIEW);
const fixed = 'Text("x").font(.custom("Kitsans", fixedSize: 13))';
// A baselined drift keyed with its value: the same constant moved to another wrong value is new.
const driftAt = hex => rules(swift(`enum Kit {\n    enum C {\n        static let off = Color(hex: 0x${hex}) // --brand\n    }\n}`, THEME), 'native-token-drift')
  .map(v => ({ app: 'pocket', file: THEME, rule: v.type, match: v.match }));
const driftBaseline = Object.fromEntries(driftAt('123456').map(f => [baselineKey(f), 1]));
const hexForms = swift([
  'let a = Color(hex: 0xC2410C, opacity: dim)',
  'let b = Color(hex: 0xC2410C, opacity: on ? 1 : 0.4)',
  'let c = Color(',
  '    hex: 0xC2410C',
  ')',
  'let d = Color.init(hex: 0xC2410C)',
  'x.foregroundStyle(.init(hex: 0xC2410C))',
  'let e = Color(hex: 0xC2410C, opacity: 0.5)',
  'let f = Color(hex: 0xC2410C)',
  '    .opacity(0.25)',
  'let g = Color(red: 0.9, green: 0.3, blue: 0.3, opacity: dim)',
  'let h = Color(hexString: "0xC2410C")',
].join('\n'), VIEW);
const hexAt = line => rules(hexForms, 'native-hex-in-view').find(v => v.line === line);
const computedTheme = [
  'enum Kit {',
  '    enum C {',
  '        static var accent: Color { Color(hex: 0x123456) } // --brand',
  '    }',
  '}',
].join('\n');
const inStrings = swift([
  'Text("Color(hex: 0xC2410C)")',
  'Text(".foregroundStyle(.black)")',
  'Text(#".custom("Helvetica", size: 12)"#)',
  'Text(".system(size: 12)")',
  'Text(#"a .custom("Kitsans", fixedSize: 12) b"#)',
  'Text("live").foregroundStyle(.black)',
].join('\n'), PROBE);
const stringInTheme = swift('enum Kit {\n    enum C {\n        static let label = "0x123456"\n    }\n}', THEME);
const rawAt = path => rules(validatePHP('<button type="button">Go</button>', path, tokens, registry), 'raw-control').length;
const RAW_CONTROL_SKIPS = ['internal/_old/top/users.php', 'emails/reset-password.php', 'api/plans.php', 'tests/Unit/X.php',
  'pages/mockups/v2-card.php', 'pages/home.legacy.php', 'pages/print.php', 'ds/demo.php', 'lib/components/x.php',
  `${PROJECT_ROOT}/internal/_old/top/users.php`];
const APP_TOKEN = /^--(promo|shop)-/;
const sweep = [];
for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
  sweep.push('#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase());
}
const raw = validatePHP('<button type="button">Go</button>\n<input type="hidden" name="t">\n<?= kit_button(\'Save\') ?>\n<textarea name="n"></textarea>\n<input type="email" name="e">',
  'pages/probe.php', tokens, registry);
const rawInComponents = validatePHP('<button type="button">Go</button>', 'lib/components/probe.php', tokens, registry);
const nativeRun = runNativeCheck(native, (content, abs) => validateSwift(content, abs, tokens, native));
let baseline = null, baselineError = null;
try { baseline = readBaseline(native); } catch (error) { baselineError = error.message; }
const nativeVsBaseline = compareToBaseline(nativeRun.findings, baseline || {});

const top = description => registry.suggestComponent(description)[0]?.component;
const everySuggestedValueExists = () => {
  const bad = [];
  const calls = [
    ...registry.htmlPatterns.map(p => p.suggestion),
    ...[...registry.components.keys()].map(name => registry.exampleCall(name)),
  ];
  for (const call of calls) {
    const name = call.match(/^(kit_[a-z0-9_]+)/)[1];
    const spec = registry.components.get(name)?.optionSpec || {};
    for (const [, key, value] of call.matchAll(/'(\w+)' => '([^']*)'/g)) {
      if (Array.isArray(spec[key]?.values) && !spec[key].values.includes(value)) bad.push(`${name} ${key}=${value}`);
    }
  }
  return bad;
};

const cssWarnings = validateCSS('.x { color: var(--old-ink); }', 'snippet.css', tokens);
const phpWarnings = validatePHP(
  '<div class="modal-overlay"></div>\n<?= kit_progress(40, [\'variant\' => \'brand\']) ?>\n<?= kit_button(\'Save\', [\'variant\' => \'primary\']) ?>',
  'snippet.php', tokens, registry);
const positional = registry.findOptionValueViolations(
  "<?= kit_status('Done', 'complete') ?>\n<?= kit_status('Done', 'success') ?>\n<?= kit_status('Done', $state) ?>", 'positional.php');
const numeric = registry.findOptionValueViolations(
  "<?= kit_grid($items, ['columns' => '2']) ?>\n<?= kit_grid($items, ['columns' => 3]) ?>\n<?= kit_grid($items, ['columns' => 5]) ?>", 'numeric.php');
const commented = registry.findOptionValueViolations(
  "<?php\n// kit_button('x', ['variant' => 'nope']);\n# kit_status('x', 'nope');\n/* kit_progress(1, ['variant' => 'nope']) */\n?>\n"
  + "<!-- <?= kit_button('x', ['variant' => 'nope']) ?> -->\n<?php $u = 'http://x'; echo kit_button('y', ['variant' => 'bogus']); ?>", 'commented.php');
const ownClass = validatePHP('<div class="kit-modal-overlay" id="m"></div>', 'own.php', tokens, registry);
const nested = registry.findOptionValueViolations(
  "<?= kit_card(kit_skeleton(['variant' => 'text']), ['variant' => 'compact', 'class' => 'x']) ?>\n"
  + "<?= kit_tabs([['label' => 'A', 'variant' => 'weird']], ['variant' => 'pill']) ?>\n"
  + "<?= kit_card(kit_badge('New', ['variant' => 'count']), ['variant' => 'secondary']) ?>", 'nested.php');

const unknownNames = registry.findUnknownOptionViolations(
  "<?= kit_input('q', ['label' => 'Search', 'icon' => 'search']) ?>\n"
  + "<?= kit_header('home', ['nav' => [['label' => 'A', 'bogus' => 1]]]) ?>\n"
  + "<?= kit_card('x', ['attrs' => ['data-x' => '1'], $key => 1, 'class' => 'y']) ?>\n"
  + "<?php // kit_input('q', ['nope' => 1]); ?>\n"
  + "<?= kit_button('Go', [\n  // a comment first\n  'extra_attrs' => ['id' => 'x'],\n]) ?>", 'names.php');
const iconButton = registry.findOptionValueViolations(
  "<?= kit_icon_button('close', ['variant' => 'outline']) ?>\n<?= kit_icon_button('close', ['variant' => 'ghost', 'size' => 'md']) ?>", 'icon-button.php');
const firstRecipe = description => registry.suggestComponent(description).findIndex(s => s.kind === 'recipe');

/* The token parser's pick with the project's colorOrder, and with none. */
const pick = (hex, order = config.tokenNames.colorOrder) => {
  const saved = config.tokenNames;
  config.tokenNames = { ...saved, colorOrder: order };
  try { return tokens.pickBestColorToken(tokens.findColorToken(hex)); } finally { config.tokenNames = saved; }
};
const css = text => validateCSS(text, 'snippet.css', tokens);
const sayFor = (list, type) => list.find(v => v.type === type)?.suggestion;
/* The same CSS under a root of 16px, with a parser that measures its type scale there. */
const at16 = text => {
  const saved = config.rootPx;
  config.rootPx = 16;
  try { return validateCSS(text, 'snippet.css', new TokenParser().load()); } finally { config.rootPx = saved; }
};

const cases = [
  ['the registry reads the catalog, page-level helpers included', registry.components.has('kit_header') && registry.components.get('kit_header').scope === 'page' && registry.components.has('kit_list_fetch')],
  ['"confirm delete dialog" suggests kit_modal first', top('confirm delete dialog') === 'kit_modal'],
  ['"page header" suggests kit_header first', top('the page header') === 'kit_header'],
  ['"status label" suggests kit_badge first, by its synonym, ahead of kit_status', (() => {
    const list = registry.suggestComponent('status label');
    return list[0]?.component === 'kit_badge' && list[0].reason && list.findIndex(s => s.component === 'kit_status') > 0;
  })()],
  ['every suggested option value exists in the catalog', everySuggestedValueExists().length === 0],
  ['kit_progress suggestions never offer a variant the template lacks', !registry.htmlPatterns.find(p => p.component === 'kit_progress').suggestion.includes("'brand'")],
  ['list_tokens role "red text on light" gives --brand-ink first', tokens.findByRole('red text on light')[0]?.name === '--brand-ink'],
  ['every --brand* token has a purpose', ['--brand', '--brand-ink', '--brand-soft', '--brand-tint'].every(n => tokens.info.get(n)?.purpose)],
  ['--old-ink is an alias whose replacement is --brand-ink', tokens.aliasReplacement('--old-ink') === '--brand-ink'],
  ['check_snippet warns on var(--old-ink) and names --brand-ink', cssWarnings.some(v => v.type === 'legacy-token' && v.suggestion.includes('--brand-ink'))],
  ['a legacy .modal-overlay class warns toward kit_modal', phpWarnings.some(v => v.type === 'legacy-class' && v.component === 'kit_modal')],
  ['an option value the catalog lacks warns', phpWarnings.some(v => v.type === 'option-value' && v.match.includes("'brand'"))],
  ['a pair inside a nested call or nested array is not read as the outer call\'s option', !nested.some(v => ['text', 'weird', 'count', 'compact', 'pill'].some(x => v.match.includes(`'${x}'`)))],
  ['an invalid value beside a nested call still warns, on the outer call', nested.length === 1 && nested[0].component === 'kit_card' && nested[0].match.includes("'secondary'") && nested[0].line === 3],
  ['a valid option value does not warn', !phpWarnings.some(v => v.type === 'option-value' && v.component === 'kit_button')],
  ['a screen-level request gets its recipe first, with a preview per state', (() => {
    const s = registry.suggestComponent('a page listing items with filters')[0];
    return s?.kind === 'recipe' && s.component === 'recipe:filtered-list'
      && ['default', 'loading', 'empty', 'error'].every(state => String(s.previews?.[state] || '').includes(`state=${state}`));
  })()],
  ['a component-level request gets no recipe', !registry.suggestComponent('a confirm dialog before deleting an item').some(s => s.kind === 'recipe')],
  ['a suggestion carries its insteadOf alternatives and a preview when a fixture exists', (() => {
    const s = registry.suggestComponent('confirm delete dialog').find(x => x.component === 'kit_modal');
    return s && s.insteadOf.some(a => a.use === 'kit_side_panel') && String(s.preview).includes('component=modal');
  })()],
  ['a helper without a curated fixture carries its auto preview, labelled auto', (() => {
    const s = registry.suggestComponent('card').find(x => x.component === 'kit_card');
    return s && s.previewKind === 'auto' && String(s.preview).includes('component=card');
  })()],
  ['a curated fixture\'s preview is labelled curated', registry.suggestComponent('confirm delete dialog').find(x => x.component === 'kit_modal')?.previewKind === 'curated'],
  ['kit_status with a status the catalog lacks warns on that argument', positional.some(v => v.component === 'kit_status' && v.match.includes("'complete'") && v.line === 1)],
  ['kit_status with a valid or computed status does not warn', !positional.some(v => v.component === 'kit_status' && v.line !== 1)],
  ['"columns" => "2" equals the catalog\'s 2 and 3 equals 3, but 5 warns', numeric.length === 1 && numeric[0].line === 3 && numeric[0].match.includes('5')],
  ['a call inside a PHP or HTML comment is not checked, a live call beside a URL string is', commented.length === 1 && commented[0].match.includes("'bogus'")],
  ['a kit- class is the component, not the legacy lookalike its tail resembles', !ownClass.some(v => v.component === 'kit_modal')],
  ['"status label" lists kit_status\'s status argument, and no options it lacks', (() => {
    const s = registry.suggestComponent('status label').find(x => x.component === 'kit_status');
    return s && s.options.some(o => o.startsWith('$status, 2nd argument') && o.includes('warning')) && !s.options.some(o => /^(variant|size)\b/.test(o));
  })()],
  ['a toggle on the settings page is the toggle, not the settings recipe', top('a toggle switch on the settings page') === 'kit_toggle'],
  ['a modal on the settings page is the modal', top('a modal on the settings page') === 'kit_modal'],
  ['a delete button on the item page is the button', top('a delete button on the item page') === 'kit_button'],
  ['a settings page is still the settings recipe', top('a settings page with a form') === 'recipe:settings-form'],
  ['a hex that is a brand colour suggests the brand token (tokenNames.colorOrder)', pick('#C2410C') === '--brand' && pick('#9A3412') === '--brand-ink'],
  ['with no colorOrder the plainest name is picked: the shortest, a canonical name first', pick('#9A3412', []) === '--old-ink' && pick('#C2410C', []) === '--brand'],
  ['a weak recipe match does not lead: an empty page with no items is the empty state', top('an empty page with no items') === 'kit_empty_state' && firstRecipe('an empty page with no items') !== 0],
  ['"no items yet" is the empty state, not a helper that returns data', top('no items yet') === 'kit_empty_state'
    && !registry.suggestComponent('no items yet').slice(0, 3).some(s => s.component === 'kit_list_fetch')],
  ['a page header with a title and subtitle is the section header, ahead of the site nav bar', (() => {
    const list = registry.suggestComponent('page header with a title and subtitle').map(s => s.component);
    return list[0] === 'kit_section_header' && list.indexOf('kit_header') > 0;
  })()],
  ['an option name the helper never reads warns, on its line', unknownNames.some(v => v.type === 'option-name' && v.component === 'kit_input' && v.match.includes("'icon'") && v.line === 1)
    && unknownNames.some(v => v.component === 'kit_button' && v.match.includes("'extra_attrs'") && v.line === 7)],
  ['listed names, nested keys, computed keys and commented calls do not warn', unknownNames.length === 2],
  ['kit_icon_button has its own variants: outline warns, ghost and md do not', iconButton.length === 1 && iconButton[0].match.includes("'outline'") && iconButton[0].line === 1],
  ['the radius advice names the project\'s own scale', sayFor(css('.a { border-radius: 7px; }'), 'hardcoded-radius') === 'Round to the nearest step, or add a token if this radius is deliberate'
    && css('.a { border-radius: 7px; }')[0].message === 'Radius 7px is not on the radius scale (4 / 8 / full)'],
  ['the shadow and font-family advice name the project\'s own tokens', sayFor(css('.a { box-shadow: 0 1px 2px #000; }'), 'hardcoded-shadow') === 'Use var(--shadow-sm|md) instead'
    && sayFor(css('.a { font-family: Arial; }'), 'hardcoded-font-family') === 'Use var(--font-heading) for serif or var(--font-body) for sans-serif'],
  ['under a 14px root the font-size advice says the rem tokens paint at 87.5%', sayFor(css('.a { font-size: 14px; }'), 'hardcoded-font-size')
    === 'var(--text-body) paints this exact size — but check its NAME fits the role before swapping; the scale is rem under an 87.5% root, so nominal and painted sizes differ'
    && sayFor(css('.a { font-size: 15px; }'), 'hardcoded-font-size').startsWith('No token paints this size. html{font-size:87.5%} makes every rem token render at 0.875x nominal')],
  ['under a 16px root the font-size advice is plain', sayFor(at16('.a { font-size: 16px; }'), 'hardcoded-font-size') === 'var(--text-body) is this exact size; check its name fits the role before swapping'
    && sayFor(at16('.a { font-size: 15px; }'), 'hardcoded-font-size') === 'No token has this size. Decide the scale, do not find-and-replace.'],
  ['with no radius, shadow or font tokens the advice says so', (() => {
    const empty = new TokenParser();
    empty.info = new Map();
    const found = validateCSS('.a { border-radius: 7px; box-shadow: 0 1px 2px #000; font-family: Arial; }', 'snippet.css', empty);
    return sayFor(found, 'hardcoded-shadow') === 'The design system has no shadow tokens yet: add them and use one here'
      && sayFor(found, 'hardcoded-font-family') === 'The design system has no font-family tokens yet: add them and use one here'
      && found.find(v => v.type === 'hardcoded-radius').message === 'Radius 7px: the design system has no radius tokens yet';
  })()],
  ['native: every non-external app has its theme files and Swift sources', ['pocket', 'desk'].every(k => native.apps[k] && appFiles(native.apps[k]).length > native.apps[k].themeFiles.length) && native.missing.length === 0],
  ['native: an annotated constant whose value differs from its token is drift, naming both', (() => {
    const d = rules(themeDrift, 'native-token-drift');
    return d.length === 1 && d[0].match === 'Kit.C.off #123456 vs --brand' && /Kit\.C\.off is #123456 but --brand is #C2410C/.test(d[0].message) && d[0].line === 4;
  })()],
  ['native: a baselined drift whose value moves again is new, and the old key counts as fixed', (() => {
    const same = compareToBaseline(driftAt('123456'), driftBaseline), moved = compareToBaseline(driftAt('654321'), driftBaseline);
    return same.fresh.length === 0 && same.fixed === 0 && moved.fresh.length === 1 && moved.fixed === 1;
  })()],
  ['native: Color(hex:) with a non-literal opacity, split over lines, as Color.init or .init is a literal', rules(hexForms, 'native-hex-in-view').map(v => v.line).join() === '1,2,3,6,7,8,9,11'
    && hexAt(3).match === 'Color(hex: 0xC2410C)' && hexAt(7).match === '.init(hex: 0xC2410C)' && !/ at /.test(hexAt(1).message) && !/ at /.test(hexAt(2).message)],
  ['native: an opacity is read only from a numeric literal, as an argument or a chained .opacity()', /at 50%/.test(hexAt(8).message) && /at 25%/.test(hexAt(9).message)],
  ['native: a computed static var colour is named for itself, not as a scope holding it', (() => {
    const [c] = parseThemeConstants(computedTheme);
    const d = rules(swift(computedTheme, THEME), 'native-token-drift');
    return c.path === 'Kit.C.accent' && c.expr === 'Kit.C.accent' && c.scope === 'Kit.C' && d.length === 1 && d[0].match === 'Kit.C.accent #123456 vs --brand';
  })()],
  ['native: a case inside a computed var keeps its type-path expression (Tone.a.accent)', parseThemeConstants(['enum Tone {', '    case a', '    var accent: Color {', '        switch self {', '        case .a: Color(hex: 0x654321)', '        }', '    }', '}'].join('\n'))[0]?.expr === 'Tone.a.accent'],
  ['native: string contents are never read as a colour, pure black, a font call or a system font', inStrings.map(v => `${v.line}:${v.type}`).join() === '6:native-pure-black'],
  ['native: a hex inside a theme file string is not a constant', stringInTheme.length === 0],
  ['native: a nearest-token suggestion never names a token another app owns (tokenNames.appScoped), and a near tie goes to the brand tier', sweep.every(h => !APP_TOKEN.test(nearestToken(native, h)?.name || ''))
    && nearestToken(native, '#E0E0E0')?.name === '--brand-tint'],
  ['native: of tokens sharing a value in one tier, a core family (tokenNames.nativeCore) is named first, else the shortest', (() => {
    const saved = config.tokenNames;
    const named = tokenForHex(native, '#1F2937');
    config.tokenNames = { ...saved, nativeCore: [] };
    try { return named === '--color-ink' && tokenForHex(native, '#1F2937') === '--ink-1'; } finally { config.tokenNames = saved; }
  })()],
  ['native: a matching annotation, Color.white with opacity against an rgba token, is not drift', !themeDrift.some(v => v.type === 'native-token-drift' && /Kit\.C\.(ink|veil)\b/.test(v.match))],
  ['native: an annotation naming a token the catalog lacks is reported', rules(themeDrift, 'native-unknown-token').length === 1 && rules(themeDrift, 'native-unknown-token')[0].match === '// --no-such-token'],
  ['native: an off-system constant is reported with the nearest token; a sanctioned scope (Tone) is not', (() => {
    const off = rules(sanctioned, 'native-off-system');
    return off.length === 1 && off[0].match === 'Palette.odd #123456' && /Nearest web token: --/.test(off[0].suggestion);
  })()],
  ['native: Color(hex:) in a view suggests the theme constant with the same value', !!appConstant && inView.length === 1 && inView[0].type === 'native-hex-in-view' && inView[0].suggestion.includes(appConstant[1].expr)],
  ['native: Color(hexString:) is API data, never a literal', !generic.some(v => v.line === 1)],
  ['native: pure black text is flagged in the project\'s words, a black shadow is not', rules(generic, 'native-pure-black').map(v => v.line).join() === '2,3'
    && rules(generic, 'native-pure-black')[0].message === 'Pure black text is not a kit colour' && rules(generic, 'native-pure-black')[0].suggestion === 'Use Kit.C.ink (--color-ink #1F2937), never .black'],
  ['native: comments are blanked and suppression markers honoured', !generic.some(v => [5, 6, 7, 13].includes(v.line))],
  ['native: an off-brand font is flagged; the brand and icon fonts are not', rules(generic, 'native-off-brand-font').map(v => v.line).join() === '8'
    && rules(generic, 'native-off-brand-font')[0].suggestion === 'Use Kitserif or Kitsans (icons: Kit Glyphs) through the theme\'s font helpers'],
  ['native: fixedSize: is flagged on iOS and not on macOS', rules(swift(fixed, PROBE), 'native-fixed-font').length === 1 && rules(swift(fixed, MAC_VIEW), 'native-fixed-font').length === 0],
  ['native: a fixed-size icon font is not text, so Dynamic Type does not apply', rules(swift('Text(name).font(.custom(filled ? "KitGlyphs-Filled" : "KitGlyphs-Regular", fixedSize: size))', PROBE), 'native-fixed-font').length === 0
    && rules(swift('Text("x").font(.custom(big ? "Kit Glyphs" : "Kitsans", fixedSize: 13))', PROBE), 'native-fixed-font').length === 1],
  ['native: validateFile routes .swift with a relative or an absolute path', validateFile('Text("a").foregroundStyle(.black)', VIEW, tokens, registry).length === 1
    && validateFile('Text("a").foregroundStyle(.black)', `${PROJECT_ROOT}/${VIEW}`, tokens, registry).length === 1],
  ['raw-control: a raw <button>, <textarea> and visible <input> are flagged, with the helper named', (() => {
    const r = rules(raw, 'raw-control');
    return r.map(v => v.line).join() === '1,4,5' && r[0].suggestion.includes('kit_button') && r[1].suggestion.includes("'textarea'") && r[2].suggestion.includes("'email'");
  })()],
  ['raw-control: a hidden input and a kit_button call are not flagged', !raw.some(v => v.type === 'raw-control' && [2, 3].includes(v.line))],
  ['raw-control: a file under lib/components/ is the component, not flagged', !rules(rawInComponents, 'raw-control').length],
  ['raw-control: every file rawControlSkip names is skipped, by relative or absolute path; a page is not', RAW_CONTROL_SKIPS.every(p => rawAt(p) === 0)
    && ['internal/users.php', 'pages/team.php', 'pages/printable.php', `${PROJECT_ROOT}/internal/users.php`].every(p => rawAt(p) === 1)],
  ['raw-control: a suppression marker hides it', !rules(validatePHP('<button>x</button> <!-- ds-lint-disable-line -->', 'pages/probe.php', tokens, registry), 'raw-control').length],
  ['native: the fixture\'s apps report no finding beyond its native baseline', baseline !== null && nativeRun.findings.length === 0 && nativeVsBaseline.fresh.length === 0],
  ['the project is the fixture copy, not the enforcer\'s folder', PROJECT_ROOT === ROOT],
];

let failed = 0;
for (const [label, ok] of cases) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}
const bad = everySuggestedValueExists();
if (bad.length) console.log(`  invalid suggested values: ${bad.join(', ')}`);
if (baselineError) console.log(`  ${baselineError}`);
for (const f of nativeVsBaseline.fresh) console.log(`  new native finding: ${f.app} ${f.rule} ${f.file}:${f.line} ${f.message}`);
console.log(failed ? `\n${failed} of ${cases.length} checks failed.` : `\nAll ${cases.length} checks passed.`);
process.exit(failed ? 1 : 0);
