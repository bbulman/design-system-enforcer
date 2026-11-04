/**
 * Validators: scan CSS, PHP, JS and Swift files for design system violations.
 * Each validator returns an array of violation objects.
 */
import { findSmallIcons } from './icon-size.js';
import { config, rawControlSkip, fillText, escapeRe } from './config.js';
import { checkTailwind, tailwindVersion } from './tailwind.js';
import { nearestColorToken, closeness, plainestColorToken } from './colour.js';
import { gateSettings } from './gate/settings.mjs';
import { componentRootMap, findBespokeLookalikes, findHandCopied } from './gate/lookalikes.mjs';

/* var(--x), or hsl(var(--x)) for a token holding bare HSL channels (shadcn). */
const tokenRef = (tokenParser, name) => (tokenParser.info?.get(name)?.channels ? `hsl(var(${name}))` : `var(${name})`);

/** Advice for a colour no token holds exactly: the nearest token and how close it is. */
function nearestAdvice(tokenParser, value) {
  const near = nearestColorToken(tokenParser, value);
  if (!near) return 'No colour token exists yet: add one to the design system';
  // Of tokens sharing the colour, the parser's pick (colorTokenChoice "semantic") or the plainest name: --foreground before --card-foreground.
  const name = config.colorTokenChoice === 'semantic' ? near.name : plainestColorToken(near.names);
  return `No token has exactly this value. Nearest: ${tokenRef(tokenParser, name)} (${near.hex}), ${closeness(near.distance)}`;
}

/** Advice for a spacing value no token holds: the nearest token, else Tailwind's scale, else a note that none exists. */
function spacingFallback(tokenParser, px) {
  const near = nearestSpacingAdvice(tokenParser, px);
  if (near) return near;
  if (tailwindVersion(tokenParser)) {
    const step = Math.round(px / 2) / 2;
    return step * 4 === px ? `Use a Tailwind spacing class instead of a raw value (${px}px is step ${step}, e.g. p-${step})`
      : `Use a Tailwind spacing class instead of a raw value (nearest step: ${step}, ${step * 4}px, e.g. p-${step})`;
  }
  return 'The design system has no spacing tokens yet: add a spacing scale and use it here';
}

/* "a, b or c" */
const orList = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list.join(''));

/* The advice below names the project's own scales: its tokens, and what 1rem paints (config rootPx). */

/** The radius tokens' steps in px, a pill radius as "full": "4 / 8 / full". */
const radiusScale = tokenParser => [...(tokenParser.radiusToToken?.keys() || [])].sort((a, b) => a - b)
  .map(px => (px >= 999 ? 'full' : String(px))).join(' / ');

/** The shadow tokens to use for a hand-written box-shadow: var(--shadow-sm|md), from the --shadow-* tokens. */
function shadowAdvice(tokenParser) {
  const names = [...(tokenParser.tokens?.keys() || [])].filter(n => n.startsWith('--shadow-'));
  if (!names.length) return 'The design system has no shadow tokens yet: add them and use one here';
  return names.length === 1 ? `Use var(${names[0]}) instead` : `Use var(--shadow-${names.map(n => n.slice('--shadow-'.length)).join('|')}) instead`;
}

const GENERIC_FAMILY = /(?:^|,)\s*(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded)\s*$/i;
/** The font-family tokens to use, each by the generic family its stack ends in: var(--font-body) for sans-serif. */
function fontFamilyAdvice(tokenParser) {
  const stacks = [...(tokenParser.tokens || [])].map(([name, value]) => [name, GENERIC_FAMILY.exec(String(value))?.[1]]).filter(([, generic]) => generic);
  return stacks.length ? `Use ${orList(stacks.map(([name, generic]) => `var(${name}) for ${generic.toLowerCase()}`))}`
    : 'The design system has no font-family tokens yet: add them and use one here';
}

/** A font-size literal's advice. Under a root other than 16px a rem token paints at a fraction of its nominal size, so the advice says so. */
function fontSizeAdvice(sizeToken) {
  const root = Number(config.rootPx) || 16;
  if (root === 16) {
    return sizeToken ? `var(${sizeToken}) is this exact size; check its name fits the role before swapping`
      : 'No token has this size. Decide the scale, do not find-and-replace.';
  }
  const pct = +(root / 16 * 100).toFixed(2);
  const factor = +(root / 16).toFixed(3);
  const an = /^(8|11(\D|$)|18(\D|$))/.test(String(pct)) ? 'an' : 'a';
  return sizeToken
    ? `var(${sizeToken}) paints this exact size — but check its NAME fits the role before swapping; the scale is rem under ${an} ${pct}% root, so nominal and painted sizes differ`
    : `No token paints this size. html{font-size:${pct}%} makes every rem token render at ${factor}x nominal, so a px literal is rarely equal to the token that shares its nominal value. Decide the scale, do not find-and-replace.`;
}

/** The spacing token nearest a px value, as advice, or null when the system has none. */
function nearestSpacingAdvice(tokenParser, px) {
  let best = null;
  for (const [value, name] of tokenParser.spacingToToken || []) {
    if (!best || Math.abs(value - px) < Math.abs(best.value - px)) best = { value, name };
  }
  return best ? `Nearest spacing token: var(${best.name}) (${best.value}px)` : null;
}
import {
  getNative, relPath, appFor, scanSwift, colorLiterals, parseThemeConstants, groupConstants,
  annotationTokens, isSanctioned, tokenForHex, nearestToken, stopsMatch, describeStops,
} from './native.js';

/* Files that ARE the source of truth (config exemptFiles, by name) and directories
   to skip (config exemptDirs), read on each call so a reloaded config applies. */
function isExempt(filePath) {
  const name = filePath.split('/').pop();
  if (config.exemptFiles.includes(name)) return true;
  return config.exemptDirs.some(d => filePath.includes(d));
}

/**
 * Blank out comment spans while preserving every newline, so line
 * numbers stay exact. Without this, continuation lines of a block comment that
 * don't happen to start with '*' were scanned as if they were code — which is
 * why documentation prose describing a hex value was reported as drift.
 */
function stripBlockComments(content) {
  let out = '';
  let inComment = false;
  for (let i = 0; i < content.length; i++) {
    const two = content.substr(i, 2);
    if (!inComment && two === '/*') { inComment = true; out += '  '; i++; continue; }
    if (inComment && two === '*/') { inComment = false; out += '  '; i++; continue; }
    if (inComment) { out += content[i] === '\n' ? '\n' : ' '; continue; }
    out += content[i];
  }
  return out;
}

/**
 * The codebase already carries 62 deliberate suppressions written as
 * `ds-lint-disable-line` and `ds-lint-disable-next-line`. Honour them.
 */
function buildSuppressions(rawLines) {
  const skip = new Set();
  rawLines.forEach((line, i) => {
    if (line.includes('ds-lint-disable-line')) skip.add(i + 1);
    if (line.includes('ds-lint-disable-next-line')) skip.add(i + 2);
  });
  return skip;
}

/**
 * var(--legacy-alias) references, as warnings naming the --brand* token to use.
 * Runs over every line, including those the CSS rules skip for already using var().
 */
function findLegacyTokenViolations(content, filePath, tokenParser) {
  if (!tokenParser.aliasReplacement) return [];
  const violations = [];
  const rawLines = content.split('\n');
  const suppressed = buildSuppressions(rawLines);
  stripBlockComments(content).split('\n').forEach((line, i) => {
    if (suppressed.has(i + 1)) return;
    for (const m of line.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const use = tokenParser.aliasReplacement(m[1]);
      if (!use) continue;
      violations.push({
        type: 'legacy-token',
        severity: 'low',
        warning: true,
        line: i + 1,
        match: `var(${m[1]})`,
        message: `Warning: ${m[1]} is a legacy alias of ${use}`,
        suggestion: `Use var(${use}) instead`,
        autoFixable: false,
        file: filePath,
      });
    }
  });
  return violations;
}

/**
 * Validate CSS file for design system violations.
 */
export function validateCSS(content, filePath, tokenParser) {
  if (isExempt(filePath)) return [];
  const violations = findLegacyTokenViolations(content, filePath, tokenParser);
  const rawLines = content.split('\n');
  const suppressed = buildSuppressions(rawLines);
  const lines = stripBlockComments(content).split('\n');

  lines.forEach((line, i) => {
    const lineNum = i + 1;
    if (suppressed.has(lineNum)) return;
    const trimmed = line.trim();

    // Skip line comments and empty lines (block comments are already blanked)
    if (trimmed.startsWith('//') || !trimmed) return;

    /* A line may hold several declarations (compact one-rule-per-line CSS is
       common in this codebase). Check each declaration on its own: skipping the
       whole line because ONE of its declarations uses var() hid 14 of the 17
       hardcoded font sizes in app/css/prove-report.css. */
    const decls = trimmed
      .replace(/^[^{]*\{/, '')   // drop a leading selector
      .replace(/\}\s*$/, '')      // drop a trailing brace
      .split(';')
      .map(d => d.trim())
      .filter(Boolean);

    for (const decl of decls) {
      // Declarations that already use a token are compliant
      if (decl.includes('var(--')) continue;
      // Custom property declarations ARE tokens
      if (/^--[\w-]+\s*:/.test(decl)) continue;

      const prop = (decl.split(':')[0] || '').trim().toLowerCase();
      const column = line.indexOf(decl) + 1;

      // 1. Hardcoded hex colors
      /* Mask gradients need an opaque stop; #000 there is an alpha channel,
         not a color choice, so it is not drift. */
      const isMask = prop.endsWith('mask-image') || prop.endsWith('mask');
      if (!isMask) {
        const hexMatches = decl.matchAll(/#([0-9a-fA-F]{3,8})\b/g);
        for (const match of hexMatches) {
          const hex = `#${match[1]}`;
          const tokens = tokenParser.findColorToken(hex);
          const bestToken = tokenParser.pickBestColorToken(tokens);
          violations.push({
            type: 'hardcoded-color',
            severity: 'high',
            line: lineNum,
            column,
            match: hex,
            message: `Hardcoded color ${hex}`,
            suggestion: bestToken
              ? `Use var(${bestToken}) instead`
              : config.text.noColorToken || nearestAdvice(tokenParser, hex),
            autoFixable: !!bestToken,
            fix: bestToken ? { from: hex, to: `var(${bestToken})` } : null,
            file: filePath,
          });
        }
      }

      // 2. Hardcoded rgba/rgb colors
      if (!isMask) {
        const rgbaMatches = decl.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/g);
        for (const match of rgbaMatches) {
          const rgbaStr = match[0];
          const tokens = tokenParser.colorToToken.get(rgbaStr) || [];
          const bestToken = tokenParser.pickBestColorToken(tokens);
          if (bestToken) {
            violations.push({
              type: 'hardcoded-color',
              severity: 'high',
              line: lineNum,
              column,
              match: rgbaStr,
              message: `Hardcoded color ${rgbaStr}`,
              suggestion: `Use var(${bestToken}) instead`,
              autoFixable: true,
              fix: { from: rgbaStr, to: `var(${bestToken})` },
              file: filePath,
            });
          }
        }
      }

      // 3. Hardcoded spacing
      /* [\d.]+ not \d+ : a bare \d+ matched the decimal tail of 12.5px and
         reported it as spacing "5px", suggesting var(--space-5) — advice that
         would have set a 20px value. */
      if (/^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/.test(prop)) {
        const pxValues = decl.matchAll(/([\d.]+)px/g);
        for (const pxMatch of pxValues) {
          const px = parseFloat(pxMatch[1]);
          if (px <= 2) continue; // border/hairline values
          const spacingToken = Number.isInteger(px) ? tokenParser.findSpacingToken(px) : null;
          if (spacingToken) {
            violations.push({
              type: 'hardcoded-spacing', severity: 'high', line: lineNum, column,
              match: `${px}px`,
              message: `Hardcoded spacing ${px}px`,
              suggestion: `Use var(${spacingToken}) instead`,
              autoFixable: true,
              fix: { from: `${pxMatch[1]}px`, to: `var(${spacingToken})` },
              file: filePath,
            });
          } else if (px >= 4) {
            violations.push({
              type: 'hardcoded-spacing', severity: 'medium', line: lineNum, column,
              match: `${px}px`,
              message: `Hardcoded spacing ${px}px — not in spacing scale`,
              suggestion: config.text.spacingOffScale || spacingFallback(tokenParser, px),
              autoFixable: false,
              file: filePath,
            });
          }
        }
      }

      // 4. Hardcoded border-radius
      if (prop === 'border-radius' || prop.startsWith('border-') && prop.endsWith('-radius')) {
        const pxValues = decl.matchAll(/([\d.]+)px/g);
        for (const pxMatch of pxValues) {
          const px = parseFloat(pxMatch[1]);
          const radiusToken = Number.isInteger(px) ? tokenParser.findRadiusToken(px) : null;
          if (radiusToken) {
            violations.push({
              type: 'hardcoded-radius', severity: 'medium', line: lineNum, column,
              match: `${px}px`,
              message: `Hardcoded radius ${px}px`,
              suggestion: `Use var(${radiusToken}) instead`,
              autoFixable: true,
              fix: { from: `${pxMatch[1]}px`, to: `var(${radiusToken})` },
              file: filePath,
            });
          } else if (px >= 3) {
            /* Reporting only the values a token already matches hid every value
               that is genuinely off the scale, which is the drift worth knowing
               about. The spacing rule already had this branch; radius did not. */
            violations.push({
              type: 'hardcoded-radius', severity: 'low', line: lineNum, column,
              match: `${px}px`,
              message: radiusScale(tokenParser) ? `Radius ${px}px is not on the radius scale (${radiusScale(tokenParser)})` : `Radius ${px}px: the design system has no radius tokens yet`,
              suggestion: radiusScale(tokenParser) ? `Round to the nearest step, or add a token if this radius is deliberate` : 'Add a radius scale and use it here',
              autoFixable: false,
              file: filePath,
            });
          }
        }
      }

      // 5. Hardcoded font-size
      /* A fluid ramp — clamp(20px, 2.4vw, 26px) — is a deliberate responsive
         type decision, not a hardcoded size. Flagging it produces advice no one
         can act on without breaking the ramp. */
      if (prop === 'font-size' && !/(clamp|calc|min|max)\s*\(/.test(decl)) {
        const remMatch = decl.match(/([\d.]+)rem/);
        const pxMatch = decl.match(/([\d.]+)px/);
        if (remMatch || pxMatch) {
          const px = pxMatch ? parseFloat(pxMatch[1]) : parseFloat(remMatch[1]) * 16;
          const sizeToken = tokenParser.findFontSizeToken ? tokenParser.findFontSizeToken(px) : null;
          violations.push({
            type: 'hardcoded-font-size',
            severity: 'medium',
            line: lineNum,
            column,
            match: remMatch ? `${remMatch[1]}rem` : `${pxMatch[1]}px`,
            message: `Hardcoded font-size ${remMatch ? remMatch[1] + 'rem' : pxMatch[1] + 'px'} — use type scale token`,
            suggestion: fontSizeAdvice(sizeToken),
            autoFixable: !!sizeToken,
            fix: sizeToken ? { from: remMatch ? `${remMatch[1]}rem` : `${pxMatch[1]}px`, to: `var(${sizeToken})` } : null,
            file: filePath,
          });
        }
      }

      // 6. Hardcoded box-shadow ('none' is a reset, not a shadow)
      if (prop === 'box-shadow') {
        const value = decl.slice(decl.indexOf(':') + 1).trim();
        if (value && value !== 'none' && !value.startsWith('inset 0 0 0 0')) {
          violations.push({
            type: 'hardcoded-shadow', severity: 'low', line: lineNum, column,
            match: decl.substring(0, 60),
            message: 'Hardcoded box-shadow',
            suggestion: shadowAdvice(tokenParser),
            autoFixable: false,
            file: filePath,
          });
        }
      }

      // 7. Hardcoded font-family
      if (prop === 'font-family') {
        violations.push({
          type: 'hardcoded-font-family', severity: 'medium', line: lineNum, column,
          match: decl.substring(0, 60),
          message: 'Hardcoded font-family',
          suggestion: fontFamilyAdvice(tokenParser),
          autoFixable: false,
          file: filePath,
        });
      }

      // 8. Pure black / pure white (mask stops already excluded above)
      const { pureBlack, pureWhite } = config.rules;
      if (pureBlack.enabled && !isMask && /^(color|background|background-color|border-color)$/.test(prop)
          && /:\s*(?:#000(?:000)?|black)\b/.test(decl)) {
        violations.push({
          type: 'design-rule', severity: pureBlack.severity, line: lineNum, column,
          match: decl.substring(0, 60),
          message: pureBlack.message,
          suggestion: pureBlack.suggestion,
          autoFixable: false,
          file: filePath,
        });
      }
      if (pureWhite.enabled && !isMask && /^(background|background-color)$/.test(prop)
          && /:\s*(?:#fff(?:fff)?|white)\b/.test(decl)) {
        violations.push({
          type: 'design-rule', severity: pureWhite.severity, line: lineNum, column,
          match: decl.substring(0, 60),
          message: pureWhite.message,
          suggestion: pureWhite.suggestion,
          autoFixable: false,
          file: filePath,
        });
      }
    }
  });

  return violations;
}

/* check-page.php's SKIP_PATTERNS, matched against the project-relative path:
   keep the two lists the same, or the rule reports pages the page check never counts. */
// config rawControlSkip, compiled on each call so a reloaded config applies

/** The helper that renders a raw control, named from the catalog so it never offers an option the helper lacks. */
function rawControlSuggestion(tag, type, registry) {
  const fp = config.components.functionPrefix;
  const n = concept => `${fp}${concept}`;
  const has = name => registry?.components?.has(name);
  const call = name => `${name}(${(registry?.components?.get(name)?.params || []).map(p => (/\$\w+/.exec(p) || [''])[0]).join(', ')})`;
  const inputTypes = registry?.components?.get(n('input'))?.optionSpec?.type?.values || [];
  const buttonTypes = registry?.components?.get(n('button'))?.optionSpec?.type?.values || [];
  if (tag === 'button') return `Use ${call(n('button'))}${has(n('icon_button')) ? `, or ${n('icon_button')}() for an icon-only control` : ''}`;
  if (tag === 'select') return `Use ${call(n('select'))}`;
  if (tag === 'textarea') {
    return inputTypes.includes('textarea')
      ? `Use ${n('input')}($name, ['type' => 'textarea'])`
      : `No ${fp}* helper renders a textarea; ask whether one should exist`;
  }
  if (buttonTypes.includes(type)) return `Use ${n('button')}($text, ['type' => '${type}'])`;
  if (type === 'checkbox') {
    return `Use ${call(n('toggle'))} for an on/off setting${has(n('checkbox_card_group')) ? `, or ${n('checkbox_card_group')}() for a set of choices` : ''}`;
  }
  if (type === 'radio' && has(n('radio_card_group'))) return `Use ${call(n('radio_card_group'))}`;
  if (inputTypes.includes(type)) return type === 'text' ? `Use ${n('input')}($name, $options)` : `Use ${n('input')}($name, ['type' => '${type}'])`;
  return `No ${fp}* helper renders <input type="${type}">; ask whether one should exist`;
}

/**
 * <button>, <select>, <textarea> and any <input> whose type is not hidden,
 * matched as check-page.php's rule 3 counts them (raw source, comments included)
 * over the files it scans. Two differences remain: a ds-lint-disable marker hides
 * every rule on its line here, raw-control included, where check-page.php reads no
 * markers; and a <button> on a line the registry reports as raw-button (a
 * btn-classed button) is left to that rule, where rule 3 still counts it.
 */
function findRawControls(content, filePath, registry) {
  const violations = [];
  const lineOf = at => content.substring(0, at).split('\n').length;
  const add = (index, tag, type, text) => violations.push({
    type: 'raw-control',
    severity: 'medium',
    tag,
    line: lineOf(index),
    match: text.replace(/\s+/g, ' ').substring(0, 80),
    message: `Raw <${tag}${tag === 'input' ? ` type="${type}"` : ''}> where a ${config.components.functionPrefix}* helper exists`,
    suggestion: rawControlSuggestion(tag, type, registry),
    autoFixable: false,
    file: filePath,
  });
  for (const m of content.matchAll(/<(button|select|textarea)\b[^>]*>?/gi)) add(m.index, m[1].toLowerCase(), null, m[0]);
  for (const m of content.matchAll(/<input\b[^>]*>/gi)) {
    if (/type\s*=\s*["']?hidden/i.test(m[0])) continue;
    const type = (/\btype\s*=\s*["']?([\w-]+)/i.exec(m[0])?.[1] || 'text').toLowerCase();
    add(m.index, 'input', type, m[0]);
  }
  return violations;
}

/**
 * The widened lookalike rules, only with the component gate on, so other projects see no change,
 * and never in a file componentGate.skip names (email templates, tests, design-system demos).
 */
function findLookalikes(content, filePath) {
  const gate = gateSettings();
  if (!gate.enabled) return [];
  const rel = relPath(filePath);
  if (gate.skip.some(re => re.test(rel))) return [];
  const suppressed = buildSuppressions(content.split('\n'));
  return [...findBespokeLookalikes(content, filePath), ...findHandCopied(content, filePath, componentRootMap())]
    .filter(v => !suppressed.has(v.line));
}

/**
 * Validate PHP file for design system violations.
 */
export function validatePHP(content, filePath, tokenParser, componentRegistry) {
  if (isExempt(filePath)) return [];
  const violations = [];
  const lines = content.split('\n');
  const suppressed = buildSuppressions(lines);
  /* The registry scans whole-file content, so it never saw the per-line
     ds-lint-disable markers. Filter its results through them too. */
  const keep = v => !suppressed.has(v.line);

  // 1. Component pattern violations
  violations.push(...componentRegistry.findComponentViolations(content, filePath).filter(keep));

  // 2. Inline styles
  violations.push(...componentRegistry.findInlineStyleViolations(content, filePath).filter(keep));

  // 2b. Warnings from the catalog: legacy lookalike classes, option names and
  //     values it does not list, and legacy alias tokens in inline styles or <style> blocks.
  if (componentRegistry.findLegacyClassViolations) {
    violations.push(...componentRegistry.findLegacyClassViolations(content, filePath).filter(keep));
    violations.push(...componentRegistry.findOptionValueViolations(content, filePath).filter(keep));
    violations.push(...componentRegistry.findUnknownOptionViolations(content, filePath).filter(keep));
  }
  violations.push(...findLegacyTokenViolations(content, filePath, tokenParser));

  // 2c. Raw controls, check-page.php's raw-component rule (3), for a project whose helpers have a prefix to name them by.
  const rel = relPath(filePath);
  if (config.components.functionPrefix && !rawControlSkip().some(p => p.test(rel))) {
    const btnClassLines = new Set(violations.filter(v => v.id === 'raw-button').map(v => v.line));
    violations.push(...findRawControls(content, filePath, componentRegistry)
      .filter(v => keep(v) && !(v.tag === 'button' && btnClassLines.has(v.line))));
  }

  // 2d. Bespoke component names and hand-copied component markup (ws-* in Workshopr).
  violations.push(...findLookalikes(content, filePath));

  // 3. Hardcoded colors in PHP (inline styles, echo'd HTML)
  lines.forEach((line, i) => {
    if (suppressed.has(i + 1)) return;
    const lineNum = i + 1;

    // Check for hardcoded hex in style attributes or echo'd CSS
    const hexInPHP = line.matchAll(/#([0-9a-fA-F]{3,6})\b/g);
    for (const match of hexInPHP) {
      // Only flag if it's inside a style attribute, CSS string, or HTML output
      const context = line.substring(Math.max(0, match.index - 30), match.index);
      if (context.includes('style') || context.includes('color') || context.includes('background') ||
          context.includes('border') || context.includes('echo') || context.includes('<?=')) {
        const hex = `#${match[1]}`;
        const tokens = tokenParser.findColorToken(hex);
        const bestToken = tokenParser.pickBestColorToken(tokens);
        if (bestToken) {
          violations.push({
            type: 'hardcoded-color-in-php',
            severity: 'high',
            line: lineNum,
            match: hex,
            message: `Hardcoded color ${hex} in PHP output`,
            suggestion: `Use CSS class with var(${bestToken}) instead of inline color`,
            autoFixable: false,
            file: filePath,
          });
        }
      }
    }
  });

  return violations;
}

/**
 * Validate JS file for design system violations.
 */
export function validateJS(content, filePath, tokenParser) {
  if (isExempt(filePath)) return [];
  const violations = [...findLegacyTokenViolations(content, filePath, tokenParser), ...findLookalikes(content, filePath)];
  const lines = content.split('\n');
  const suppressed = buildSuppressions(lines);
  const classPrefix = config.components.classPrefix;
  const classAddRe = classPrefix
    ? new RegExp(`\\.classList\\.add\\(\\s*['"](?!${escapeRe(classPrefix)}|is-|has-)(btn|modal|card|alert|badge|tab)[-\\w]*['"]\\s*\\)`)
    : null;

  lines.forEach((line, i) => {
    if (suppressed.has(i + 1)) return;
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    // 1. Hardcoded colors in JS (setting styles programmatically)
    const styleSetters = trimmed.matchAll(/\.(style\.\w+|backgroundColor|color|borderColor)\s*=\s*['"]#([0-9a-fA-F]{3,6})['"]/g);
    for (const match of styleSetters) {
      const hex = `#${match[2]}`;
      const tokens = tokenParser.findColorToken(hex);
      const bestToken = tokenParser.pickBestColorToken(tokens);
      violations.push({
        type: 'hardcoded-color-in-js',
        severity: 'high',
        line: lineNum,
        match: hex,
        message: `Hardcoded color ${hex} in JavaScript`,
        suggestion: bestToken
          ? `Use CSS class or getComputedStyle with var(${bestToken})`
          : `Move color to CSS using design tokens`,
        autoFixable: false,
        file: filePath,
      });
    }

    // 2. Hardcoded colors in template literals or innerHTML
    const hexInTemplate = trimmed.matchAll(/(?:innerHTML|template|html)\s*[+=]+\s*[`'"]*[^`'"]*#([0-9a-fA-F]{3,6})/g);
    for (const match of hexInTemplate) {
      const hex = `#${match[1]}`;
      violations.push({
        type: 'hardcoded-color-in-js',
        severity: 'high',
        line: lineNum,
        match: hex,
        message: `Hardcoded color ${hex} in JS template/innerHTML`,
        suggestion: `Use CSS classes instead of inline colors in JS-generated HTML`,
        autoFixable: false,
        file: filePath,
      });
    }

    // 3. Hardcoded px in JS style manipulation
    const pxInStyle = trimmed.matchAll(/\.style\.(\w+)\s*=\s*['"](\d+)px['"]/g);
    for (const match of pxInStyle) {
      const prop = match[1];
      const px = parseInt(match[2]);
      if (px <= 2) continue;
      if (['padding', 'margin', 'gap', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
           'marginTop', 'marginBottom', 'marginLeft', 'marginRight'].includes(prop)) {
        const spacingToken = tokenParser.findSpacingToken(px);
        violations.push({
          type: 'hardcoded-spacing-in-js',
          severity: 'medium',
          line: lineNum,
          match: `${px}px`,
          message: `Hardcoded spacing ${px}px in JS style.${prop}`,
          suggestion: spacingToken
            ? `Use CSS class or CSS variable var(${spacingToken})`
            : `Move spacing to CSS using design tokens`,
          autoFixable: false,
          file: filePath,
        });
      }
    }

    // 4. Direct DOM class manipulation with a component-ish class outside the project's class prefix (components.classPrefix, e.g. ws-)
    const addClassMatch = classAddRe && trimmed.match(classAddRe);
    if (addClassMatch) {
      violations.push({
        type: 'non-ds-class-in-js',
        severity: 'low',
        line: lineNum,
        match: addClassMatch[0].substring(0, 60),
        message: `Adding non-design-system class "${addClassMatch[1]}..." via JS`,
        suggestion: `Use ${classPrefix}* prefixed classes from the component library`,
        autoFixable: false,
        file: filePath,
      });
    }
  });

  return violations;
}

const FONT_NAME = /(?:\.custom|\b(?:UI|NS)Font(?:Descriptor)?)\(\s*(?:name:\s*)?"((?:[^"\\]|\\.)*)"/g;
const PURE_BLACK = /\.foreground(?:Style|Color)\(\s*(?:Color)?\.black\s*[,)]/g;
const SYSTEM_SIZE = /\.system\(\s*size:[^)\n]*\)?/g;
const squash = s => s.replace(/\s+/g, ' ').trim();
const fontKey = s => s.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Each `.custom(...)` call: { index, text, fixedSize }. Found in `skel` (strings
 * blanked, so a string is never read as a call), with its text read from `code`,
 * which keeps the font names.
 */
function customFontCalls(code, skel) {
  const calls = [];
  for (const m of skel.matchAll(/\.custom\(/g)) {
    let depth = 0, end = m.index + m[0].length, fixed = false;
    for (; end < skel.length; end++) {
      const ch = skel[end];
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (depth === 0 && skel.startsWith('fixedSize:', end)) fixed = true;
    }
    calls.push({ index: m.index, text: code.slice(m.index, end + 1), fixedSize: fixed });
  }
  return calls;
}

/**
 * What a view should use instead of a colour literal: the app's theme constant
 * with the same value, or a new named constant in the theme file, with the web
 * token the value is (or is nearest to).
 */
function literalSuggestion(native, hit, hex) {
  const exact = tokenForHex(native, hex);
  const web = exact ? `it is web ${exact}` : (() => {
    const near = nearestToken(native, hex);
    return near ? `nearest web token ${near.name} ${near.hex}` : 'no web token is near it';
  })();
  if (!hit) return `Name it in the app's theme file instead (${web})`;
  const same = native.byHex.get(hit.key)?.get(hex) || [];
  const plain = same.filter(g => !g.sanctioned);
  if (plain.length) return `Use ${plain.slice(0, 3).map(g => g.expr).join(' or ')} (same value)`;
  const add = `Add a named constant to ${(hit.app.themeFiles || [])[0] || 'the theme file'} (${web})`;
  // A sanctioned scope's hue (a content-type colour) shares the value but not the role.
  return same.length ? `${add}; ${same[0].expr} has the same value but is a sanctioned ${same[0].scope.split('.')[0]} hue, so use it only in that role` : add;
}

/**
 * Validate a Swift file against the native contract. The manifest app the path
 * belongs to decides which rules apply: theme files are checked for drift from
 * the web tokens, other files for colour literals, and every file for fonts and
 * pure black. A Swift file outside every app gets the generic rules, with
 * web-token suggestions. Comments are blanked before matching; annotations are
 * read from them. String contents are blanked too, except where a rule reads a
 * font name.
 */
export function validateSwift(content, filePath, tokenParser, native = getNative()) {
  if (isExempt(filePath)) return [];
  const rel = relPath(filePath);
  const hit = appFor(native, rel);
  const app = hit?.app ?? null;
  const isTheme = !!app && (app.themeFiles || []).includes(rel);
  const suppressed = buildSuppressions(content.split('\n'));
  const { code, skel, comments } = scanSwift(content);
  const lines = code.split('\n');
  const skelLines = skel.split('\n');
  const lineOf = at => code.substring(0, at).split('\n').length;
  const violations = [];
  const push = (line, type, severity, match, message, suggestion) => {
    if (suppressed.has(line)) return;
    violations.push({ type, severity, line, match, message, suggestion, autoFixable: false, file: filePath });
  };

  if (isTheme) {
    for (const [li, comment] of comments) {
      for (const name of annotationTokens(comment) || []) {
        if (native.tokens.has(name)) continue;
        push(li + 1, 'native-unknown-token', 'medium', `// ${name}`,
          `${name} names no token in the catalog`,
          'Name the web token this value mirrors (list_tokens with platform "swift"), or drop the annotation');
      }
    }
    for (const g of groupConstants(parseThemeConstants(content))) {
      const constLabel = describeStops(g.stops, 'opacity');
      if (g.annotation) {
        for (const name of g.annotation) {
          const value = native.tokens.get(name)?.value;
          if (!value || stopsMatch(g.stops, value)) continue;
          // The value is in the match, so a baselined drift that moves again is a new finding.
          push(g.line, 'native-token-drift', 'high', `${g.display} ${constLabel} vs ${name}`,
            `${g.display} is ${constLabel} but ${name} is ${describeStops(value.stops)}`,
            `Set it to the token's value (${describeStops(value.stops)}), or annotate the token it really mirrors`);
        }
        continue;
      }
      if (isSanctioned(app, g.scope)) continue;
      for (const s of g.stops) {
        if (native.hexTokens.has(s.hex)) continue;
        const near = nearestToken(native, s.hex);
        push(s.line, 'native-off-system', 'medium', `${g.display} ${s.hex}`,
          `${g.display} ${s.hex} matches no web token`,
          near ? `Nearest web token: ${near.name} ${near.hex}. Use a token's value, or sanction the scope in the manifest` : 'Use a web token\'s value');
      }
    }
  } else {
    // The whole file at once, so a call split over lines is one literal.
    for (const lit of colorLiterals(skel)) {
      push(lineOf(lit.index), 'native-hex-in-view', 'high', squash(lit.text),
        `Colour literal ${lit.hex}${lit.opacity < 1 ? ` at ${Math.round(lit.opacity * 100)}%` : ''} outside the theme file`,
        literalSuggestion(native, hit, lit.hex));
    }
  }

  const allowed = [...(native.manifest.brandFonts || []), ...(native.manifest.iconFonts || [])].map(fontKey);
  // Pure black only as the house rule the project switched on, for Swift (rules.pureBlack.native) or, when
  // that is unset, as on the web; fonts only when the manifest names brand fonts.
  const checkBlack = typeof config.rules.pureBlack.native === 'boolean' ? config.rules.pureBlack.native : config.rules.pureBlack.enabled;
  const checkFonts = (native.manifest.brandFonts || []).length > 0;
  // The project's own wording (text.native) where it has some, with {ink}, {brandFonts} and {iconFonts} filled in.
  const said = config.text.native || {};
  const inkHex = said.inkHex ? String(said.inkHex).toUpperCase() : null;
  const ink = hit && inkHex ? native.byHex.get(hit.key)?.get(inkHex)?.[0]?.expr : null;
  const placeholders = {
    ink: ink ?? 'the theme\'s ink constant',
    brandFonts: (native.manifest.brandFonts || []).join(' or '),
    iconFonts: (native.manifest.iconFonts || []).join(', '),
  };
  const blackMessage = said.pureBlack || config.rules.pureBlack.message;
  const blackFix = said.pureBlackFix ? fillText(said.pureBlackFix, placeholders) : (config.rules.pureBlack.suggestion || 'Use the theme\'s ink colour');
  const fontFix = fillText(said.font || 'Use {brandFonts} through the theme\'s font helpers', placeholders);
  const systemFontFix = fillText(said.systemFont || 'Use the theme\'s {brandFonts} helper; .system(size:) is for sizing an SF Symbol image', placeholders);
  lines.forEach((line, i) => {
    const bare = skelLines[i];
    if (checkBlack) for (const m of bare.matchAll(PURE_BLACK)) {
      push(i + 1, 'native-pure-black', 'high', squash(m[0]).replace(/,$/, ')'), blackMessage, blackFix);
    }
    if (!checkFonts) return;
    for (const m of line.matchAll(FONT_NAME)) {
      // A call that starts inside a string is text, not a font.
      if (bare[m.index] !== line[m.index]) continue;
      if (allowed.some(a => fontKey(m[1]).startsWith(a))) continue;
      push(i + 1, 'native-off-brand-font', 'high', squash(m[0]),
        `Font "${m[1]}" is not a brand font`,
        fontFix);
    }
    if (bare.includes('Text(')) {
      for (const m of bare.matchAll(SYSTEM_SIZE)) {
        push(i + 1, 'native-system-font', 'medium', squash(m[0]),
          'Text set in the system font',
          systemFontFix);
      }
    }
  });

  if (app?.platform === 'ios') {
    // An icon glyph is sized to its frame, and scaling it would clip it, so only text fonts must follow Dynamic Type.
    const icons = (native.manifest.iconFonts || []).map(fontKey);
    for (const call of customFontCalls(code, skel)) {
      if (!call.fixedSize) continue;
      const families = [...call.text.matchAll(/"([^"\\]*)"/g)].map(m => m[1]);
      if (families.length && families.every(f => icons.some(a => fontKey(f).startsWith(a)))) continue;
      push(lineOf(call.index), 'native-fixed-font', 'medium', squash(call.text).substring(0, 80),
        'fixedSize: ignores Dynamic Type',
        'Use .custom(name, size:, relativeTo:) so the text scales with the reader\'s text size');
    }
  }

  return violations.sort((a, b) => a.line - b.line);
}

/**
 * Vue and Svelte single-file components: <style> blocks get the CSS checks (and
 * Tailwind's @apply); the rest (template or markup, and script) gets the same checks
 * as JSX: colours, inline-style spacing, Tailwind classes and raw controls. Each
 * pass sees the file with the other regions blanked, so line numbers stay exact.
 */
export function validateSFC(content, filePath, tokenParser, componentRegistry) {
  if (isExempt(filePath)) return [];
  const blank = s => s.replace(/[^\n]/g, ' ');
  const styles = [...content.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g)];
  let styleOnly = blank(content);
  let rest = content.replace(/<!--[\s\S]*?-->/g, blank);
  for (const m of styles) {
    const start = m.index + m[1].length;
    styleOnly = styleOnly.slice(0, start) + m[2] + styleOnly.slice(start + m[2].length);
    rest = rest.slice(0, m.index) + blank(m[0]) + rest.slice(m.index + m[0].length);
  }
  const markup = validateJSX(rest, filePath, tokenParser, componentRegistry);
  const css = validateCSS(styleOnly.split('\n').map(l => (/@apply\b/.test(l) ? '' : l)).join('\n'), filePath, tokenParser);
  const applyLines = stripBlockComments(styleOnly).split('\n').map(l => (/@apply\b/.test(l) ? l : ''));
  const apply = checkTailwind(applyLines, filePath, tokenParser, buildSuppressions(content.split('\n')));
  return [...markup, ...css, ...apply].sort((a, b) => (a.line || 0) - (b.line || 0));
}

/**
 * Run all validators on a file based on its extension.
 */
/* Raw elements a design system usually wraps, and how its component tends to be named. */
const RAW_ELEMENTS = { button: 'Button', input: 'Input', select: 'Select', textarea: 'Textarea', dialog: 'Dialog' };
const WRAPPER_NAMES = { button: /button$/i, input: /(input|textfield|text-field)$/i, select: /select$/i, textarea: /textarea$/i, dialog: /(dialog|modal)$/i };

/** The design system's component for a raw element: Button, else the shortest name ending like one (BaseButton, TextInput). */
function wrapperFor(tag, known) {
  const exact = known.get(RAW_ELEMENTS[tag].toLowerCase());
  if (exact) return exact;
  const candidates = [...known.values()].filter(n => WRAPPER_NAMES[tag].test(n) && !/^(Alert|Icon)/.test(n));
  return candidates.sort((a, b) => a.length - b.length)[0] || null;
}
const COLOR_PROP = /(color|background|border|fill|stroke|shadow|outline)/i;
const SPACING_PROP = /^(padding|margin|gap|rowGap|columnGap)(Top|Right|Bottom|Left|Inline|Block|X|Y)?$/;
const camel = s => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

/**
 * React files (.jsx, .tsx, .ts): hardcoded colours in style objects and colour
 * strings, hardcoded spacing in style objects (numbers are px in React), and raw
 * <button>/<input>/<select>/<textarea>/<dialog> where the catalog has a component
 * of that name. A component's own source folder may use the raw element it wraps.
 */
export function validateJSX(content, filePath, tokenParser, componentRegistry) {
  if (isExempt(filePath)) return [];
  const violations = [];
  const rawLines = content.split('\n');
  const suppressed = buildSuppressions(rawLines);
  const componentDirs = (config.sources || []).filter(s => ['react', 'vue', 'svelte'].includes(s.type)).map(s => s.path.replace(/\/$/, '') + '/');
  const rel = relPath(filePath);
  const inComponentSource = componentDirs.some(d => rel.startsWith(d));
  const known = new Map([...(componentRegistry?.components?.keys() || [])].map(n => [n.toLowerCase(), n]));
  const colorSuggestion = hex => {
    const best = tokenParser.pickBestColorToken(tokenParser.findColorToken(hex));
    if (!best) return nearestAdvice(tokenParser, hex);
    return `Use ${tokenRef(tokenParser, best)}`;
  };

  stripBlockComments(content).split('\n').forEach((line, i) => {
    const lineNum = i + 1;
    if (suppressed.has(lineNum) || /^\s*\/\//.test(line)) return;
    const code = line.replace(/\s\/\/.*$/, '');

    // 1. Colours: a string that is only a colour, or a colour after a colour-ish key.
    const seen = new Set();
    const colorHits = [
      ...code.matchAll(/(["'`])\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))\s*\1/g),
      ...[...code.matchAll(/(\w+)\s*:\s*["'`]?[^"'`,}]*?(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g)].filter(m => COLOR_PROP.test(m[1])),
    ];
    const { pureBlack, pureWhite } = config.rules;
    for (const m of colorHits) {
      const value = m[2];
      const key = /^["'`]$/.test(m[1]) ? '' : m[1];
      if (seen.has(value) || /^#[0-9a-fA-F]{5}$|^#[0-9a-fA-F]{7}$/.test(value)) continue;
      seen.add(value);
      if (pureBlack.enabled && /^#000(000)?$/i.test(value)) {
        violations.push({ type: 'design-rule', severity: pureBlack.severity, line: lineNum, match: value, message: pureBlack.message, suggestion: pureBlack.suggestion, autoFixable: false, file: filePath });
      }
      if (pureWhite.enabled && /background/i.test(key) && /^#fff(fff)?$/i.test(value)) {
        violations.push({ type: 'design-rule', severity: pureWhite.severity, line: lineNum, match: value, message: pureWhite.message, suggestion: pureWhite.suggestion, autoFixable: false, file: filePath });
      }
      violations.push({
        type: 'hardcoded-color-in-jsx', severity: 'high', line: lineNum, match: value,
        message: `Hardcoded colour ${value}`,
        suggestion: colorSuggestion(value),
        autoFixable: false, file: filePath,
      });
    }

    // 2. Spacing in style objects: style={{ padding: 16 }} or padding: '16px'.
    // style={{ padding: 16 }} in JSX, style="padding-top: 16px;" in templates.
    for (const m of code.matchAll(/([\w-]+)\s*:\s*["'`]?(\d+(?:\.\d+)?)(px)?["'`]?\s*(?=[,};"']|$)/g)) {
      if (!SPACING_PROP.test(camel(m[1]))) continue;
      const px = parseFloat(m[2]);
      if (px <= 2) continue;
      const token = Number.isInteger(px) ? tokenParser.findSpacingToken(px) : null;
      violations.push({
        type: 'hardcoded-spacing', severity: token ? 'high' : 'medium', line: lineNum, match: `${m[1]}: ${m[2]}${m[3] || ''}`,
        message: `Hardcoded spacing ${px}px`,
        suggestion: token ? `Use var(${token})` : spacingFallback(tokenParser, px),
        autoFixable: false, file: filePath,
      });
    }

  });

  // Tailwind classes (arbitrary values, default-palette colours), outside the components' own source.
  if (!inComponentSource) {
    const codeLines = stripBlockComments(content).split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l.replace(/\s\/\/.*$/, '')));
    violations.push(...checkTailwind(codeLines, filePath, tokenParser, suppressed));
  }

  // 3. Raw elements the design system already wraps, read as whole tags (attributes span lines).
  // A raw element styled with the system's own variants (className={buttonVariants()}) is using it.
  if (!inComponentSource) {
    const stripped = stripBlockComments(content);
    for (const m of stripped.matchAll(/<(button|input|select|textarea|dialog)\b([^>]*)>/g)) {
      const lineNum = stripped.slice(0, m.index).split('\n').length;
      if (suppressed.has(lineNum)) continue;
      const component = wrapperFor(m[1], known);
      if (!component) continue;
      const variants = `${component[0].toLowerCase()}${component.slice(1)}Variants`;
      if (m[2].includes(`${variants}(`)) continue;
      violations.push({
        type: 'raw-control', severity: 'medium', line: lineNum, match: `<${m[1]}`,
        message: `Raw <${m[1]}> where the design system has <${component}>`,
        suggestion: `Use <${component}> (list_components shows its props and variants)`,
        autoFixable: false, file: filePath,
      });
    }
  }
  return violations;
}

/** Every check for one file: its type's rules, then the 24px icon floor (icon-size.js). */
export function validateFile(content, filePath, tokenParser, componentRegistry, native) {
  return validateByType(content, filePath, tokenParser, componentRegistry, native)
    .concat(findSmallIcons(content, filePath, tokenParser));
}

function validateByType(content, filePath, tokenParser, componentRegistry, native) {
  const ext = filePath.split('.').pop().toLowerCase();
  switch (ext) {
    case 'css': {
      // Without Tailwind (config tailwind, or the catalog's meta) an @apply line is plain CSS.
      if (!tailwindVersion(tokenParser)) return validateCSS(content, filePath, tokenParser);
      // @apply lines are Tailwind classes, checked below, not CSS declarations.
      const found = validateCSS(content.split('\n').map(l => (/@apply\b/.test(l) ? '' : l)).join('\n'), filePath, tokenParser);
      if (config.exemptDirs.some(d => filePath.includes(d))) return found;
      // Tailwind classes written with @apply, including in the token file itself (in Tailwind v4
      // the one CSS file often holds both the @theme tokens and the styles that use them).
      const lines = stripBlockComments(content).split('\n').map(l => (/@apply\b/.test(l) ? l : ''));
      return found.concat(checkTailwind(lines, filePath, tokenParser, buildSuppressions(content.split('\n'))));
    }
    case 'php':
      return validatePHP(content, filePath, tokenParser, componentRegistry);
    case 'js':
      return validateJS(content, filePath, tokenParser);
    case 'html':
      return isExempt(filePath) ? [] : findLookalikes(content, filePath);
    case 'swift':
      return validateSwift(content, filePath, tokenParser, native ?? getNative());
    case 'vue':
    case 'svelte':
      return ['vue', 'svelte', 'react'].includes(config.framework) || config.checkJsx ? validateSFC(content, filePath, tokenParser, componentRegistry) : [];
    case 'jsx':
    case 'tsx':
    case 'ts':
      // React checks run for projects init connected to React components (framework "react"),
      // or any project that sets checkJsx; Workshopr's Sidekick .tsx stays as it was until it opts in.
      return config.framework === 'react' || config.checkJsx ? validateJSX(content, filePath, tokenParser, componentRegistry) : [];
    default:
      return [];
  }
}
