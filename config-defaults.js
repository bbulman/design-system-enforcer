/**
 * The enforcer's default settings, and how a config's component gate lists are read, with no
 * config loaded: config.js merges these with the project's file, and gate/pages.mjs reads the page
 * rules of whichever project it is given, so neither needs the other to have loaded.
 */

export const DEFAULTS = {
  projectRoot: '.',
  framework: 'css',
  tokensCss: '.ds-enforcer/tokens.css',
  catalog: '.ds-enforcer/catalog.json',
  synonyms: '.ds-enforcer/synonyms.json',
  nativeManifest: null,
  searchModule: null,
  rootPx: 16,
  sources: [],
  exemptFiles: [],
  exemptDirs: ['node_modules', 'vendor', '.git', '.ds-enforcer'],
  rawControlSkip: ['^vendor/', '^node_modules/', '^\\.git/'],
  docs: { web: null, native: null },
  homepage: null,
  // Of several colour tokens with one value, which to name: "plainest" or "semantic" (TokenParser.pickBestColorToken).
  colorTokenChoice: 'plainest',
  /* Token names the project gives meaning to, each a list of regular expressions over the name.
     colorOrder: of several colour tokens with one value, which the parser names first (empty: the plainest);
     colorWords: names list_tokens also files under colours; appScoped: tokens one app owns, which a
     native app is never offered and which rank after the rest; nativeCore: the core families a native
     suggestion names before the rest of a tier. */
  tokenNames: { colorOrder: [], colorWords: [], appScoped: [], nativeCore: [] },
  rules: {
    // native: the Swift check's own switch; null follows enabled.
    pureBlack: { enabled: false, severity: 'high', message: 'Pure black (#000) is not allowed', suggestion: '', native: null },
    pureWhite: { enabled: false, severity: 'medium', message: 'Pure white backgrounds are not allowed', suggestion: '' },
  },
  /* The small-icon rule (icon-size.js): an icon drawn under min px. Off until the project switches it on.
     token: the size token to suggest; retired: size tokens an icon may no longer use; glyphClasses: the
     icon font's class names, as a stylesheet selector names them; inlineGlyphClasses: as markup carries
     them with an inline font-size (null: glyphClasses); doc: the rule's source, cited in each message. */
  iconSize: { enabled: false, min: 24, token: null, retired: [], glyphClasses: [], inlineGlyphClasses: null, doc: null },
  /* How a project names its components, for one written as functions (PHP helpers) and drawn
     by hand-written markup. Each is off until the project names it. */
  components: {
    functionPrefix: null,
    classPrefix: null,
    extraClassPrefixes: [],
    helperFile: null,
    sourceDirs: [],
    js: null,
  },
  /* The project's own wording, in place of the generic text. {name} placeholders are filled in. */
  text: {
    instructions: null,
    tools: {},
    componentsFooter: null,
    noComponent: null,
    noColorToken: null,
    spacingOffScale: null,
    native: { pureBlack: null, pureBlackFix: null, inkHex: null, font: null, systemFont: null },
  },
  staged: { checks: [], hint: null, noPhp: null },
  componentGate: {
    enabled: false,
    autoSwap: false,
    minScore: null,
    clearMargin: null,
    skip: ['^vendor/', '^node_modules/', '^\\.git/', '^\\.ds-enforcer/'],
    reviewUrl: null,
    shellParser: null,
    reviewer: 'the reviewer',
    /* The file types the gate holds to a consult before markup is added (gate), and those whose
       lookalikes are only reported (detect): the gate reads markup and stylesheets and knows a
       component by a call to its helper, which a .js or .html file cannot make. */
    files: { gate: ['.php', '.css'], detect: ['.js', '.html'] },
    /* Which pages a suggested component's markup is counted on (gate/pages.mjs). types: the page file
       types (null: the gated types that are not stylesheets); skip: copies and archives, neither markup
       nor pages; included: files another file includes, markup but not pages; notPages: markup that is
       never counted as a page. Each list is regular expressions over the project-relative path. */
    pages: { types: null, skip: [], included: [], notPages: [] },
    /* Files the suggestion scan never reads, beyond skip (regular expressions). */
    scanSkip: [],
  },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

/* One bad pattern is left out on its own: a throw here would take down the tool list, validate_file and every hook. */
export function compilePatterns(patterns) {
  const out = [];
  for (const s of Array.isArray(patterns) ? patterns : []) {
    if (typeof s !== 'string') continue;
    try { out.push(new RegExp(s)); } catch { /* not a regular expression */ }
  }
  return out;
}

/* File types as the config lists them (".php"), lower-cased; anything else is left out. */
export const fileTypes = v => (Array.isArray(v) ? v.filter(e => typeof e === 'string' && /^\.[\w.-]+$/.test(e)).map(e => e.toLowerCase()) : []);
const STYLESHEET = /^\.(css|scss|sass|less)$/;

/**
 * A merged componentGate's page rules: the page file types (types, else the gated types that are not
 * stylesheets), and the skip, included and notPages lists compiled.
 */
export function pageRules(g) {
  const pages = g.pages && typeof g.pages === 'object' ? g.pages : {};
  return {
    types: Array.isArray(pages.types) ? fileTypes(pages.types) : fileTypes(g.files?.gate).filter(e => !STYLESHEET.test(e)),
    skip: compilePatterns(pages.skip),
    included: compilePatterns(pages.included),
    notPages: compilePatterns(pages.notPages),
  };
}
