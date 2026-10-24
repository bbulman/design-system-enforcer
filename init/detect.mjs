/**
 * Find the design system a project already has: CSS variable files, W3C/Style
 * Dictionary token JSON, and React component folders (shadcn's components.json
 * included). Returns candidates with a suggested default selection.
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative, dirname, basename, resolve } from 'path';
import { walk, countCssVars, countDtcg, countComponents, countFigma, countSwiftColours, swiftAppFor, folderFramework, COMPONENT_TYPES } from './importers.mjs';

const NOT_TOKEN_JSON = /(^|\/)(package(-lock)?|tsconfig[\w.-]*|jsconfig|components|composer(\.lock)?|manifest|vercel|turbo|\.?eslintrc[\w.]*|catalog|synonyms)\.json$/;

export function detect(root) {
  const found = [];
  const files = walk(root, { accept: p => /\.(css|scss|pcss|json|swift|tsx|jsx|vue|svelte)$/.test(p) });

  for (const f of files.filter(p => /\.(css|scss|pcss)$/.test(p))) {
    const count = countCssVars(f);
    const theme = /@theme\b/.test(readFileSync(f, 'utf8'));
    // A file that is plainly a token file counts even when the system is young.
    const tokenFile = theme || /(token|theme|variable|global)/i.test(basename(f));
    if (count < (tokenFile ? 3 : 8)) continue;
    found.push({ type: 'css', path: relative(root, f), count, note: `${count} CSS variables${theme ? ' (Tailwind v4 @theme)' : ''}` });
  }

  for (const f of files.filter(p => p.endsWith('.json'))) {
    const rel = relative(root, f);
    if (NOT_TOKEN_JSON.test(rel)) continue;
    if (!/token|variable|figma/i.test(rel) && !/(^|\/)(design|theme|style)/i.test(rel)) continue;
    const figma = countFigma(f);
    if (figma >= 1) { found.push({ type: 'figma', path: rel, count: figma, note: `${figma} Figma variables` }); continue; }
    const count = countDtcg(f);
    if (count >= 5) found.push({ type: 'dtcg', path: rel, count, note: `${count} design tokens (W3C / Style Dictionary)` });
  }

  // SwiftUI: a theme file is a Swift file declaring several colours, named or placed like a theme.
  for (const f of files.filter(p => p.endsWith('.swift'))) {
    const rel = relative(root, f);
    if (!/(theme|palette|colou?r|token|design|style)/i.test(rel)) continue;
    const count = countSwiftColours(f);
    if (count < 3) continue;
    const app = swiftAppFor(root, f);
    if (!app) continue;
    found.push({ type: 'swift', path: rel, count, app, note: `${count} colours in a SwiftUI theme (${app.name})` });
  }

  // React: shadcn's components.json names its ui folder; otherwise folders called components or ui.
  const dirs = new Map();
  const shadcn = join(root, 'components.json');
  if (existsSync(shadcn)) {
    try {
      const aliases = JSON.parse(readFileSync(shadcn, 'utf8')).aliases || {};
      for (const [alias, how] of [[aliases.ui, 'shadcn'], [aliases.components, 'folder']].filter(([a]) => a)) {
        const bare = alias.replace(/^[@~]\//, '');
        for (const guess of [join('src', bare), bare]) {
          const abs = resolve(root, guess);
          if (existsSync(abs) && statSync(abs).isDirectory()) { if (!dirs.has(abs)) dirs.set(abs, how); break; }
        }
      }
    } catch { /* an unreadable components.json is just not a hint */ }
  }
  for (const f of files.filter(p => /\.(tsx|jsx|vue|svelte)$/.test(p))) {
    let d = dirname(f);
    while (d.startsWith(root) && d !== root) {
      if (/^(components|ui)$/i.test(basename(d)) && !dirs.has(d)) dirs.set(d, 'folder');
      d = dirname(d);
    }
  }
  for (const [abs, how] of dirs) {
    const count = countComponents(abs);
    if (count < (how === 'shadcn' || /(^|\/)ui$/i.test(abs) ? 1 : 2)) continue;
    const fw = folderFramework(abs);
    const label = { react: 'React', vue: 'Vue', svelte: 'Svelte' }[fw];
    found.push({ type: fw, path: relative(root, abs), count, note: `${count} ${label} component files${how === 'shadcn' ? ' (shadcn)' : ''}` });
  }

  const ranked = [
    ...found.filter(s => s.type === 'css').sort((a, b) => b.count - a.count).slice(0, 8),
    ...found.filter(s => s.type === 'dtcg').sort((a, b) => b.count - a.count).slice(0, 8),
    ...found.filter(s => s.type === 'figma').sort((a, b) => b.count - a.count).slice(0, 4),
    ...found.filter(s => COMPONENT_TYPES.includes(s.type)).sort((a, b) => a.path.length - b.path.length).slice(0, 8),
    ...found.filter(s => s.type === 'swift').sort((a, b) => b.count - a.count).slice(0, 8),
  ].map((s, i) => ({ id: i + 1, ...s }));

  // Default: the largest CSS variable file (plus any Tailwind @theme file), every token JSON file
  // (they are often split by category), and the outermost component folders (shadcn's ui folder if there is one).
  const css = ranked.filter(s => s.type === 'css');
  const cssPick = [...new Set([css[0], ...css.filter(s => s.note.includes('@theme'))].filter(Boolean))];
  const react = ranked.filter(s => COMPONENT_TYPES.includes(s.type));
  // A folder called ui is the design system; its parent usually also holds app screens.
  const shadcnPick = react.find(s => s.note.includes('shadcn'));
  const uiPicks = react.filter(s => /(^|\/)ui$/i.test(s.path));
  const outer = react.filter(s => !react.some(o => o !== s && s.path.startsWith(o.path + '/')));
  const defaults = [
    ...cssPick,
    ...ranked.filter(s => s.type === 'dtcg' || s.type === 'figma'),
    ...(shadcnPick ? [shadcnPick] : uiPicks.length ? uiPicks : outer),
    ...ranked.filter(s => s.type === 'swift'),
  ].map(s => s.id);
  return { root, sources: ranked, defaults };
}
