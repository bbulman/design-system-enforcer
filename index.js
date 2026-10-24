#!/usr/bin/env node
/**
 * Workshopr Design System Enforcer — MCP Server
 *
 * Ensures all code follows the Workshopr design system:
 * - Token usage (colors, spacing, typography, shadows, radii)
 * - Component usage (ws_* helpers instead of raw HTML)
 * - Design rules (no pure black, warm neutrals, etc.)
 * - Native apps (Swift): values only in the theme files, mirroring the web tokens
 *
 * Tools:
 *   validate_file:     Scan a CSS, PHP, JS or Swift file for violations
 *   fix_file:          Auto-fix simple violations (color/spacing/radius swaps); never Swift
 *   audit_page:        Full compliance report for a file
 *   list_components:   List all ws_* components with signatures
 *   list_tokens:       List design tokens by category or role, as CSS or as Swift
 *   suggest_component: Suggest which ws_* component to use
 *   check_snippet:     Validate a code snippet inline (no file needed), Swift included
 *   native_apps:       The native apps' bindings, commands and live findings
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, relative, isAbsolute, sep } from 'path';

import { TokenParser } from './token-parser.js';
import { ComponentRegistry } from './component-registry.js';
import { validateFile, validateCSS, validatePHP, validateJS, validateJSX, validateSFC, validateSwift } from './validators.js';
import { autoFix, previewFixes, generateReport } from './auto-fixer.js';
import {
  loadNative, nativeSources, mirrorsOf, swiftValue, describeStops, nearestToken, runNativeCheck,
  readBaseline, compareToBaseline,
} from './native.js';

import { config, PROJECT_ROOT, PROJECT_DIR, CONFIG_PATH, connected, reloadConfig, projectPath, insideProject } from './config.js';
import { loadSearch } from './catalog-search.js';
import { loadBaseline, splitByBaseline, relOf } from './baseline.js';
import { driftFindings } from './drift.js';
import { reviewA11y, tokenPairs } from './a11y.js';
import { writeReport, applyReport, DEFAULT_REPORT } from './report.mjs';
import { detect } from './init/detect.mjs';
import { countFigma, folderFramework } from './init/importers.mjs';
import { connect, generate, sourceStamp, installHook } from './init/build.mjs';

// Initialize parsers. The server lives as long as the Claude Code session, and the
// catalog is regenerated under it; without a reload it answered from the catalog
// the session started with (a variant added since read as "not an option").
const SOURCES = () => [config.catalog, config.synonyms, config.tokensCss].map(projectPath);
let tokenParser = null;
let componentRegistry = null;
let loadError = null;

/* A project connected by init names its sources; the generated catalog is rebuilt
   from them when one changes, or when it is missing (a fresh clone that ignores it). */
let sourceState = null;
function syncSources(force = false) {
  if (!config.sources?.length) return;
  const stamp = sourceStamp(PROJECT_ROOT, config.sources);
  if (!force && stamp === sourceState && existsSync(projectPath(config.catalog))) return;
  try {
    generate(PROJECT_ROOT, config);
    sourceState = stamp;
    console.error('Resynced the catalog from the connected sources');
  } catch (error) {
    console.error(`Resync from sources failed, still serving the previous catalog: ${error.message}`);
  }
}

function loadWeb() {
  const tokens = new TokenParser().load();
  const registry = new ComponentRegistry().load();
  tokenParser = tokens;
  componentRegistry = registry;
  loadError = null;
}

if (connected) {
  syncSources();
  try { loadWeb(); } catch (error) {
    loadError = error.message;
    console.error(`Design system not loaded: ${error.message}`);
  }
}
// A manifest that fails to parse must not take the web checks down with it.
let nativeCtx;
try { nativeCtx = connected && !loadError ? loadNative() : (() => { throw new Error('not connected'); })(); } catch (error) {
  console.error(`Native manifest not loaded, Swift checks are off until it parses: ${error.message}`);
  nativeCtx = { manifest: { apps: {} }, apps: {}, tokens: new Map(), hexTokens: new Map(), groups: new Map(), byHex: new Map(), missing: [] };
}
const stampOf = paths => paths.map(p => { try { return statSync(p).mtimeMs; } catch { return 0; } }).join(':');
const webStamp = () => stampOf(SOURCES());
// The manifest names the theme files, so the watched list is read from the loaded context.
const nativeStamp = () => stampOf(nativeSources(nativeCtx));
const loaded = { web: webStamp(), native: nativeStamp() };
const failed = { web: null, native: null };

/**
 * Reload when a source changed since the last load. The web catalog and the native
 * manifest reload separately, as at startup, so a manifest that fails to parse never
 * holds back a regenerated catalog. A half-written or missing source keeps the old
 * copy and is retried on every call, but reported once per change.
 */
function ensureFresh() {
  if (!connected) return;
  syncSources();
  const web = webStamp();
  if (web !== loaded.web) {
    try {
      const tokens = new TokenParser().load();
      const registry = new ComponentRegistry().load();
      tokenParser = tokens;
      componentRegistry = registry;
      loaded.web = webStamp();
      failed.web = null;
      console.error(`Reloaded: ${tokenParser.getStats().totalTokens} tokens, ${componentRegistry.components.size} components`);
    } catch (error) {
      if (web !== failed.web) console.error(`Reload failed, still serving the previous catalog: ${error.message}`);
      failed.web = web;
    }
  }
  const nat = nativeStamp();
  if (nat !== loaded.native) {
    try {
      nativeCtx = loadNative();
      loaded.native = nativeStamp();
      failed.native = null;
      console.error(`Reloaded the native manifest: ${nativeCtx.groups.size} native apps`);
    } catch (error) {
      if (nat !== failed.native) console.error(`Native manifest reload failed, still serving the previous one: ${error.message}`);
      failed.native = nat;
    }
  }
}

// Claude Code injects this into every session that has the server, so it stays short.
// Workshopr's own text (framework "php") is kept word for word; init-connected projects get the generic one.
const WORKSHOPR_INSTRUCTIONS = [
  'Workshopr design system enforcer.',
  'Before writing UI, find what exists. Web (PHP, CSS, JS): suggest_component names the ws_* helper and its options, list_tokens the token for a role.',
  'Native (Swift): native_apps gives an app\'s theme files, build and screenshot commands; list_tokens with platform "swift" and app gives each token as Color(hex:) and the theme constant that already mirrors it. Swift values live only in the app\'s theme files.',
  'After writing, check: validate_file on every changed .php, .css, .js or .swift file, or check_snippet with code and language (css, php, js or swift; for Swift pass file_path so it knows the app and whether the file is a theme file). npm run lint:ds:native checks every native app against its baseline.',
  'No check sees accessible names, roles, focus order or target size (44pt): read the rendered accessibility tree. Of Dynamic Type, native-fixed-font catches fixed text sizes only.',
  `The contract: ${config.docs.web || 'see the project docs'} (web)${config.docs.native ? ` and ${config.docs.native} (native)` : ''}.`,
].join(' ');

const GENERIC_INSTRUCTIONS = () => [
  `${config.name ? `${config.name} d` : 'D'}esign system enforcer.`,
  'Before writing UI, find what exists: suggest_component names the component, its props and the only variant values that exist; list_tokens gives the token for a role ("danger text", "card padding").',
  'After writing, check: validate_file on every changed .css, .jsx, .tsx or .ts file, or check_snippet with code and language.',
  'No check sees accessible names, roles, focus order or target size: read the rendered accessibility tree.',
  'The design system is read from the sources in enforcer.config.json and resyncs when they change; init reconnects or adds sources.',
].join(' ');

const UNCONNECTED_INSTRUCTIONS = [
  'Design system enforcer, not connected to this project yet.',
  'Call init (action "detect") to find the tokens and components the project already has, ask the user which to connect, then init with action "connect".',
].join(' ');

const INSTRUCTIONS = !connected ? UNCONNECTED_INSTRUCTIONS
  : config.framework === 'php' ? WORKSHOPR_INSTRUCTIONS : GENERIC_INSTRUCTIONS();

// Create MCP server
const server = new Server(
  { name: config.name ? `${config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-design-system-enforcer` : 'design-system-enforcer', version: '1.3.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

// ─── Tool Definitions ───

const TOOLS = [
  {
    name: 'init',
    description:
      'Connect this project\'s existing, code-based design system: CSS variable files (Tailwind v4 @theme included), W3C design tokens / Style Dictionary JSON, and React component folders (shadcn/ui included). action "detect" (the default) scans the project and lists numbered sources, marking the suggested ones, plus the current connection. Show the user that list and ask: which sources to connect, what 1rem equals in px on their pages, and whether to flag pure black or pure white backgrounds. Then call action "connect" with their answers. action "sync" rebuilds the catalog from the connected sources.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['detect', 'connect', 'sync'], description: 'detect (default), connect or sync' },
        sources: {
          type: 'array',
          items: { type: ['number', 'string'] },
          description: 'For connect: numbers from the detect list, and/or project-relative paths the scan missed (a .css/.scss file, a tokens .json file, or a components folder)',
        },
        rootPx: { type: 'number', description: 'For connect: what 1rem equals in px on the pages (default 16)' },
        pureBlack: { type: 'boolean', description: 'For connect: flag pure black (#000) as a house rule' },
        pureWhite: { type: 'boolean', description: 'For connect: flag pure white backgrounds as a house rule' },
        replace: { type: 'boolean', description: 'For connect: replace a hand-written enforcer.config.json. Only with the user\'s say-so.' },
        hook: { type: 'boolean', description: 'For connect: add a Claude Code hook (in .claude/settings.local.json) that checks each file after Claude edits it. Ask the user first.' },
      },
    },
  },
  {
    name: 'validate_file',
    description:
      'Scan a CSS, PHP, JS or Swift file for design system violations. Returns all violations with line numbers, severity, and fix suggestions. A .swift file is checked against its native app in the manifest (theme-file drift from the web tokens, colour literals in views, fonts, pure black, Dynamic Type). Use this before committing code or when reviewing changes.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or project-relative path to the file to validate',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'fix_file',
    description:
      'Auto-fix design system violations in a CSS, PHP or JS file. Replaces hardcoded hex colors with CSS variable tokens, hardcoded spacing with space tokens, and hardcoded radii with radius tokens. Only applies safe, unambiguous fixes. Returns a diff preview and writes the fixed file. Never rewrites Swift: for a .swift file it returns the violations to fix by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or project-relative path to the file to fix',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, show what would be fixed without writing changes (default: false)',
          default: false,
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'audit_page',
    description:
      'Generate a comprehensive compliance report for a CSS, PHP, JS or Swift file. Includes violation count by severity, breakdown by type, auto-fixable count, and every violation with its line and suggestion. Use this for full audits.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or project-relative path to audit',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'list_components',
    description:
      'List all available ws_* design system components with their PHP function signatures. Use this to find the right component for a UI element.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional filter to search component names (e.g., "button", "modal", "card")',
        },
      },
    },
  },
  {
    name: 'list_tokens',
    description:
      config.framework === 'php'
        ? 'List design tokens from platform-tokens.css with their purpose, tier (brand | semantic | primitive | alias) and, for a legacy alias, the --brand* token to use instead. Filter by category, or pass a plain-language role (e.g. "red text on light" gives --brand-ink). With platform "swift", each token is shown as Swift (Color(hex: 0xRRGGBB)) beside the native app constants that mirror it, drifted ones marked; add app to see one app, and with app and no filter its off-system constants too.'
        : 'List the design system\'s tokens with their value, tier and purpose. Filter by category (colors, spacing, typography, shadows, radii), or pass a plain-language role (e.g. "danger text" or "card padding") for the best matches.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['colors', 'spacing', 'typography', 'shadows', 'radii', 'all'],
          description: 'Token category to list (default: all)',
          default: 'all',
        },
        role: {
          type: 'string',
          description: 'Optional plain-language role or text filter, e.g. "soft red chip background" or "card padding". Returns the best-matching tokens, legacy aliases last.',
        },
        platform: {
          type: 'string',
          enum: ['web', 'swift'],
          description: 'web (default) lists CSS values; swift lists Swift values and the native constants that mirror each token',
          default: 'web',
        },
        app: {
          type: 'string',
          description: 'With platform "swift": a native app key from native_apps (back-pocket, field-guide, planner-mac)',
        },
      },
    },
  },
  {
    name: 'suggest_component',
    description:
      'Given a description of what UI element you need, suggest which ws_* component to use, ranked from the generated catalog (summary, when-to-use, synonyms). Each suggestion carries option values and defaults from the catalog, the legacy lookalike to avoid, the alternatives to choose instead and when (insteadOf), and a playground preview URL, labelled curated (a hand-written fixture) or auto (built from the catalog entry). E.g., "a confirm dialog before deleting a workshop" → ws_modal. A request whose head noun is a page, screen or flow also gets the matching screen recipe, a runnable file with default, loading, empty and error previews, first when it outscores the components, e.g. "a page listing workshops with filters" → recipe:filtered-workshop-list.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the UI element you want to build',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'check_snippet',
    description:
      'Validate a code snippet for design system compliance without needing a file. Pass CSS, PHP, JS or Swift code directly and get violations back. For Swift, pass file_path (the file the snippet is for) so the check knows the app and whether it is a theme file. Great for checking code before writing it to a file.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code snippet to validate',
        },
        language: {
          type: 'string',
          enum: ['css', 'php', 'js', 'jsx', 'tsx', 'vue', 'svelte', 'swift'],
          description: 'Language of the snippet (css, php, js, or swift)',
        },
        file_path: {
          type: 'string',
          description: 'Optional, for Swift: the project-relative or absolute path the snippet belongs in, e.g. library-app/WorkshoprLibrary/Screens/Home/HomeView.swift',
        },
      },
      required: ['code', 'language'],
    },
  },
  {
    name: 'a11y_review',
    description:
      'Accessibility review of what the code shows: images without alt, buttons, links and form fields with no accessible name, clickable elements keyboard users can\'t use, positive tabindex, aria-hidden on focusable elements, skipped heading levels, links without href, <html> without lang, and the WCAG contrast ratio of text and background colours used together (Tailwind classes, inline styles, CSS rules). Pass file_path, or code with language. With tokens: true (or no file and no code), it audits the design system\'s own colour pairs (primary with primary-foreground and so on). It can\'t see the rendered page: check focus order, focus visibility, target size and screen-reader output in the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Project-relative or absolute path of a .jsx, .tsx, .vue, .svelte, .html, .php or .css file' },
        code: { type: 'string', description: 'Markup or CSS to review instead of a file' },
        language: { type: 'string', description: 'With code: jsx, tsx, vue, svelte, html, php or css' },
        tokens: { type: 'boolean', description: 'Audit the design system\'s colour pairs (bg with its -foreground)' },
      },
    },
  },
  {
    name: 'report',
    description:
      'Write the design system violations as a checklist: design-system-report.md at the project root, one checkbox per new finding, each marked auto (a swap with one right answer, which the enforcer applies) or Claude (needs judgment). Use when the user wants a report, a to-do list or a review of what to fix. Tell them where it is, how many items are auto, and that they can tick boxes in the file or tell you which to fix (by id, "all auto" or "all"). Then call apply_report.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Folders or files to cover (project-relative). Default: the whole project' },
        min: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Lowest severity to list (default low)' },
        a11y: { type: 'boolean', description: 'Include the accessibility review' },
        out: { type: 'string', description: `Report path (default ${DEFAULT_REPORT})` },
      },
    },
  },
  {
    name: 'apply_report',
    description:
      'Work through the checklist: ticks the items in select (ids like "R4", "auto" or "all") on top of the boxes the user ticked, applies the auto fixes, re-checks the files and marks fixed items done. Ticked Claude items come back as a list: make each change in the file (following its suggestion), then call apply_report again so the enforcer verifies and marks them. With accept_rest, unticked items go into the baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        select: { type: 'array', items: { type: 'string' }, description: 'Items to tick before applying: ids ("R1"), "auto" or "all"' },
        accept_rest: { type: 'boolean', description: 'Record the unticked items in the baseline so they stop coming back. Only with the user\'s say-so' },
        report: { type: 'string', description: `Report path (default ${DEFAULT_REPORT})` },
      },
    },
  },
  {
    name: 'native_apps',
    description:
      'The native apps in the design-system manifest (design-system/workshopr-design-system.json, native.apps). With no app: one line per app. With an app key: its full binding (source, theme files, token namespace, annotation style, how project files are added), build, run and screenshot commands, hazards, sanctioned scopes, and a live count of the native check\'s findings by rule with the drifted constants named. Call it before writing Swift.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Optional app key: back-pocket, field-guide or planner-mac',
        },
      },
    },
  },
];

// ─── Tool Handlers ───

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'init') return await handleInit(args);
    ensureFresh();
    if (!connected || !tokenParser) {
      return {
        content: [{ type: 'text', text: !connected
          ? 'This project is not connected to a design system yet. Call init (action "detect") to find its tokens and components, ask the user which to connect, then init with action "connect".'
          : `The design system did not load: ${loadError}. Fix the source, or call init with action "sync" or "connect".` }],
        isError: true,
      };
    }
    switch (name) {
      case 'validate_file':
        return handleValidateFile(args);
      case 'fix_file':
        return handleFixFile(args);
      case 'audit_page':
        return handleAuditPage(args);
      case 'list_components':
        return handleListComponents(args);
      case 'list_tokens':
        return handleListTokens(args);
      case 'suggest_component':
        return handleSuggestComponent(args);
      case 'check_snippet':
        return handleCheckSnippet(args);
      case 'native_apps':
        return handleNativeApps(args);
      case 'a11y_review':
        return handleA11y(args);
      case 'report':
        return await handleReport(args);
      case 'apply_report':
        return await handleApplyReport(args);
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ─── Handler Implementations ───

/* Every file tool reads, and fix_file writes, only inside the project. An absolute
   path elsewhere, or a relative one that climbs out with '..', is refused. */
function resolvePath(filePath) {
  const abs = filePath.startsWith('/') ? resolve(filePath) : resolve(PROJECT_ROOT, filePath);
  if (!insideProject(abs)) throw new OutsideProjectError(filePath);
  return abs;
}

class OutsideProjectError extends Error {
  constructor(filePath) {
    super(`Refused: ${filePath} is outside the project (${PROJECT_ROOT}). The enforcer only reads and fixes files inside it.`);
  }
}

function handleValidateFile({ file_path }) {
  const fullPath = resolvePath(file_path);
  if (!existsSync(fullPath)) {
    return { content: [{ type: 'text', text: `File not found: ${fullPath}` }], isError: true };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const violations = [...validateFile(content, fullPath, tokenParser, componentRegistry, nativeCtx), ...(driftFindings(tokenParser.data?.catalog)[relOf(fullPath)] || [])];

  if (violations.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `✅ ${file_path} — No design system violations found. File is compliant.`,
      }],
    };
  }

  const high = violations.filter(v => v.severity === 'high').length;
  const medium = violations.filter(v => v.severity === 'medium').length;
  const low = violations.filter(v => v.severity === 'low').length;
  const fixable = violations.filter(v => v.autoFixable).length;

  let output = `## Design System Violations: ${file_path}\n\n`;
  output += `**${violations.length} violations** found (${high} high, ${medium} medium, ${low} low) | ${fixable} auto-fixable\n\n`;
  // With a baseline, say which findings were already there, so new work is judged on what it added.
  const baseline = loadBaseline();
  const existing = new Set(baseline ? splitByBaseline(relOf(fullPath), violations, baseline).existing : []);
  if (baseline) output += `${violations.length - existing.size} new; ${existing.size} already in the project's baseline (marked *existing*). Fix the new ones.\n\n`;

  // Group by severity
  for (const severity of ['high', 'medium', 'low']) {
    const sevViolations = violations.filter(v => v.severity === severity);
    if (sevViolations.length === 0) continue;

    output += `### ${severity.toUpperCase()} (${sevViolations.length})\n\n`;
    for (const v of sevViolations) {
      output += `- **Line ${v.line}**: ${v.message}`;
      if (v.match) output += ` — \`${v.match}\``;
      output += `\n`;
      output += `  ${v.suggestion}`;
      if (v.autoFixable) output += ` *(auto-fixable)*`;
      if (existing.has(v)) output += ` *(existing)*`;
      output += `\n`;
    }
    output += `\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleFixFile({ file_path, dry_run = false }) {
  const fullPath = resolvePath(file_path);
  if (!existsSync(fullPath)) {
    return { content: [{ type: 'text', text: `File not found: ${fullPath}` }], isError: true };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const violations = validateFile(content, fullPath, tokenParser, componentRegistry, nativeCtx);
  if (fullPath.toLowerCase().endsWith('.swift')) {
    let msg = `No safe automatic fixes for Swift: ${file_path} was not changed.`;
    if (violations.length) {
      msg += ` ${violations.length} violations to fix by hand (values belong in the app's theme file; native_apps names it):\n\n`;
      for (const v of violations) msg += `- Line ${v.line} (${v.type}, ${v.severity}): ${v.message}\n  ${v.suggestion}\n`;
    } else {
      msg += ' It has no violations.';
    }
    return { content: [{ type: 'text', text: msg }] };
  }
  const fixable = violations.filter(v => v.autoFixable);

  if (fixable.length === 0) {
    const manual = violations.filter(v => !v.autoFixable);
    let msg = `No auto-fixable violations in ${file_path}.`;
    if (manual.length > 0) {
      msg += ` ${manual.length} violations require manual fixing.`;
    }
    return { content: [{ type: 'text', text: msg }] };
  }

  if (dry_run) {
    const preview = previewFixes(content, violations);
    return {
      content: [{
        type: 'text',
        text: `## Dry Run: ${file_path}\n\n${fixable.length} fixes would be applied:\n\n\`\`\`diff\n${preview}\n\`\`\``,
      }],
    };
  }

  const { fixed, appliedFixes, skippedFixes } = autoFix(content, violations);

  // Write the fixed file
  writeFileSync(fullPath, fixed, 'utf-8');

  let output = `## Fixed: ${file_path}\n\n`;
  output += `**${appliedFixes.length} fixes applied:**\n\n`;
  for (const fix of appliedFixes) {
    output += `- Line ${fix.line}: \`${fix.from}\` → \`${fix.to}\`\n`;
  }

  if (skippedFixes.length > 0) {
    output += `\n**${skippedFixes.length} issues require manual fixing** (not auto-fixable)\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleAuditPage({ file_path }) {
  const fullPath = resolvePath(file_path);
  if (!existsSync(fullPath)) {
    return { content: [{ type: 'text', text: `File not found: ${fullPath}` }], isError: true };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const violations = validateFile(content, fullPath, tokenParser, componentRegistry, nativeCtx);
  const report = generateReport(violations, file_path);

  let output = `## Compliance Audit: ${file_path}\n\n`;

  if (report.totalViolations === 0) {
    output += `✅ **COMPLIANT** — No violations found.\n`;
    return { content: [{ type: 'text', text: output }] };
  }

  // Score (100 = perfect, 0 = very bad)
  const score = Math.max(0, 100 - (report.bySeverity.high * 10) - (report.bySeverity.medium * 5) - (report.bySeverity.low * 2));

  output += `### Score: ${score}/100\n\n`;
  output += `| Metric | Count |\n|--------|-------|\n`;
  output += `| Total violations | ${report.totalViolations} |\n`;
  output += `| High severity | ${report.bySeverity.high} |\n`;
  output += `| Medium severity | ${report.bySeverity.medium} |\n`;
  output += `| Low severity | ${report.bySeverity.low} |\n`;
  output += `| Auto-fixable | ${report.autoFixable} |\n\n`;

  output += `### By Type\n\n`;
  for (const [type, count] of Object.entries(report.byType)) {
    output += `- **${type}**: ${count}\n`;
  }

  output += `\n### All Violations\n\n`;
  for (const v of report.violations) {
    const icon = v.severity === 'high' ? 'x' : v.severity === 'medium' ? '!' : '-';
    output += `[${icon}] Line ${v.line} (${v.severity}): ${v.message}`;
    if (v.match) output += ` — \`${v.match}\``;
    output += `\n`;
    output += `    ${v.suggestion}`;
    if (v.autoFixable) output += ` [auto-fixable]`;
    output += `\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleListComponents({ filter } = {}) {
  let components = componentRegistry.getComponentList();

  if (filter) {
    const lower = filter.toLowerCase();
    components = components.filter(c => c.name.toLowerCase().includes(lower));
  }

  if (components.length === 0) {
    return { content: [{ type: 'text', text: `No components matching "${filter}".` }] };
  }

  if (config.framework !== 'php') {
    let out = `## ${config.name ? `${config.name} ` : ''}Components (${components.length})\n\n`;
    out += `| Component | Usage | Summary |\n|-----------|-------|---------|\n`;
    for (const c of components) out += `| \`${c.name}\` | \`${(c.signature || c.name).replace(/\|/g, '/')}\` | ${(c.summary || '').replace(/\|/g, '/')} |\n`;
    out += `\nFrom ${(config.sources || []).filter(s => s.type === 'react').map(s => `\`${s.path}\``).join(', ') || 'the catalog'}. suggest_component gives a component's props and variant values.\n`;
    return { content: [{ type: 'text', text: out }] };
  }

  let output = `## Workshopr Design System Components (${components.length})\n\n`;
  output += `| Component | Scope | PHP Signature | Summary |\n|-----------|-------|---------------|---------|\n`;
  for (const c of components) {
    output += `| \`${c.name}\` | ${c.scope} | \`${c.phpCall}\` | ${(c.summary || '').replace(/\|/g, '/')} |\n`;
  }
  output += `\nFrom \`/design-system/components.generated.json\` (components in helpers.php, page-level in includes/components/*.php, app-local in app/includes/workshop-list.php).\n`;
  output += `CSS in \`/includes/components/components.css\`.\n`;
  output += `Demos at \`/design-system/component-library.php\`.\n`;

  return { content: [{ type: 'text', text: output }] };
}

function tokenRow(name, value) {
  const t = tokenParser.info.get(name) || {};
  const purpose = (t.purpose || '').replace(/\|/g, '/');
  return `| \`${name}\` | \`${value}\` | ${t.tier || ''} | ${t.use ? `\`${t.use}\`` : ''} | ${purpose} |\n`;
}
const TOKEN_HEAD = `| Token | Value | Tier | Use instead | Purpose |\n|-------|-------|------|-------------|---------|\n`;
const SWIFT_HEAD = `| Token | Swift | Mirrored by | Tier | Use instead | Purpose |\n|-------|-------|-------------|------|-------------|---------|\n`;

/** One token as Swift, beside the native constants that mirror it: two per app, drifted ones first and marked. */
function swiftTokenRow(name, app) {
  const t = tokenParser.info.get(name) || {};
  const byApp = new Map();
  for (const m of mirrorsOf(nativeCtx, name, app).sort((a, b) => b.drift - a.drift)) {
    if (!byApp.has(m.app)) byApp.set(m.app, []);
    byApp.get(m.app).push(m);
  }
  const shown = [...byApp].map(([key, list]) => {
    const names = list.slice(0, 2).map(m => `\`${m.display}\`${m.drift ? ` DRIFTED (${describeStops(m.stops, 'opacity')})` : ''}${m.via ? ` via ${m.via}` : ''}`);
    if (list.length > 2) names.push(`+${list.length - 2} more`);
    return `${app ? '' : `${key}: `}${names.join(', ')}`;
  });
  const swift = swiftValue(nativeCtx.tokens.get(name));
  return `| \`${name}\` | ${swift ? `\`${swift}\`` : ''} | ${shown.join('; ')} | ${t.tier || ''} | ${t.use ? `\`${t.use}\`` : ''} | ${(t.purpose || '').replace(/\|/g, '/')} |\n`;
}

/** An app's theme constants that match no web token and sit outside its sanctioned scopes. */
function offSystemSection(app) {
  const groups = nativeCtx.groups.get(app) || [];
  const off = groups.filter(g => !g.annotation && !g.sanctioned && g.stops.some(s => !nativeCtx.hexTokens.has(s.hex)));
  const sanctioned = groups.filter(g => g.sanctioned && g.stops.some(s => !nativeCtx.hexTokens.has(s.hex))).length;
  let text = `\n### Off-system constants in ${app} (${off.length})\n\n`;
  if (!off.length) text += 'None.\n';
  for (const g of off) {
    const stops = g.stops.filter(s => !nativeCtx.hexTokens.has(s.hex));
    const near = stops.map(s => { const n = nearestToken(nativeCtx, s.hex); return n ? `${s.hex} nearest ${n.name} ${n.hex}` : s.hex; });
    text += `- \`${g.display}\` (${g.file}:${g.line}): ${near.join('; ')}\n`;
  }
  if (sanctioned) text += `\n${sanctioned} more sit in sanctioned scopes (${Object.keys(nativeCtx.apps[app]?.sanctionedScopes || {}).join(', ')}) and are not findings.\n`;
  return text;
}

function handleListTokens({ category = 'all', role, platform, app } = {}) {
  const swift = platform === 'swift' || (!!app && platform !== 'web');
  if (app && (!nativeCtx.apps[app] || nativeCtx.apps[app].external)) {
    const keys = Object.entries(nativeCtx.apps).filter(([, a]) => !a.external).map(([k]) => k);
    return { content: [{ type: 'text', text: `Unknown or external app "${app}". Checkable apps: ${keys.join(', ')}.` }], isError: true };
  }
  const head = swift ? SWIFT_HEAD : TOKEN_HEAD;
  const row = (name, value) => (swift ? swiftTokenRow(name, app) : tokenRow(name, value));
  const swiftNote = swift
    ? `\nSwift values come from the catalog's resolved values. "Mirrored by" lists the theme constants annotated with the token, else equal in value; DRIFTED means the annotation names this token but the value differs. Write values only in the app's theme file.\n`
    : '';

  if (role) {
    const hits = tokenParser.findByRole(role, 10);
    if (hits.length === 0) {
      return { content: [{ type: 'text', text: `No token matches "${role}". Try list_tokens with a category.` }] };
    }
    let text = `## Tokens for: "${role}"${swift ? ` (Swift${app ? `, ${app}` : ''})` : ''}\n\n` + head;
    for (const t of hits) text += row(t.name, t.value);
    text += `\nLegacy aliases rank last; when one appears, use the token in "Use instead".\n` + swiftNote;
    return { content: [{ type: 'text', text }] };
  }

  let output = `## Design Tokens${swift ? ` (Swift${app ? `, ${app}` : ''})` : ''}`;

  const allTokens = tokenParser.tokens;

  const categories = {
    colors: (name) =>
      name.includes('color') || name.includes('phase-') || name.includes('primary') ||
      name.includes('dark') || name.includes('light') || name.includes('gray') ||
      name.includes('bg-') || name.includes('text-') || name.includes('ink') ||
      name.includes('success') || name.includes('warning') || name.includes('error') ||
      name.includes('info') || name.includes('navy') || name.match(/-cat-\d/),
    spacing: (name) => name.startsWith('--space-'),
    typography: (name) =>
      name.startsWith('--font-') || name.startsWith('--text-') ||
      name.startsWith('--leading-') || name.startsWith('--tracking-'),
    shadows: (name) => name.startsWith('--shadow-'),
    radii: (name) => name.startsWith('--radius-'),
  };
  // An init-connected project's tokens carry their group from the import, so categories follow it.
  if (config.framework !== 'php') {
    const GROUP = { colors: 'Colors', spacing: 'Spacing', typography: 'Typography', shadows: 'Shadows', radii: 'Radius' };
    for (const [key, group] of Object.entries(GROUP)) categories[key] = name => tokenParser.info.get(name)?.group === group;
  }

  const showCategory = (catName, filterFn) => {
    const tokens = [...allTokens.entries()].filter(([name]) => filterFn(name));
    if (tokens.length === 0) return '';
    let text = `\n### ${catName} (${tokens.length})\n\n`;
    text += head;
    for (const [name, value] of tokens) {
      text += row(name, value);
    }
    return text;
  };

  if (category === 'all') {
    output += ` (${allTokens.size} total)\n`;
    for (const [catName, filterFn] of Object.entries(categories)) {
      output += showCategory(catName, filterFn);
    }
    if (swift && app) output += offSystemSection(app);
  } else if (categories[category]) {
    output += `: ${category}\n`;
    output += showCategory(category, categories[category]);
  } else {
    return { content: [{ type: 'text', text: `Unknown category: ${category}` }], isError: true };
  }

  return { content: [{ type: 'text', text: output + swiftNote }] };
}

function handleSuggestComponent({ description }) {
  const suggestions = componentRegistry.suggestComponent(description);

  if (suggestions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: config.framework === 'php'
          ? `No matching ws_* component found for: "${description}"\n\nYou may need to create a new component. Add it as a ws_* function in /includes/components/helpers.php with a demo in /design-system/components/.`
          : `No matching component found for: "${description}"\n\nIf the design system has one under another name, add the words you used to .ds-enforcer/synonyms.json. Otherwise it may need a new component in ${(config.sources || []).filter(s => s.type === 'react').map(s => s.path).join(', ') || 'your components folder'}.`,
      }],
    };
  }

  let output = `## Component Suggestions for: "${description}"\n\n`;
  for (const s of suggestions) {
    if (s.kind === 'recipe') {
      output += `### Screen recipe: ${s.title} (${s.component})\n`;
      output += `- **Use**: ${s.reason}\n`;
      output += `- **Components**: ${s.components.join(', ')}\n`;
      output += `- **States**: ${Object.entries(s.previews || {}).map(([state, url]) => `${state} \`${url}\``).join('; ')}\n`;
      output += `- **Copy**: \`${s.source}\` (layout rules in \`${s.stylesheet}\`); guide \`${s.guide}\`\n`;
      output += `- **Mobile**: ${s.mobile}\n`;
      output += `- **Why these components**: ${s.why}\n\n`;
      continue;
    }
    const comp = componentRegistry.components.get(s.component);
    output += `### ${s.component}${s.scope && s.scope !== 'component' ? ` (${s.scope})` : ''}\n`;
    output += `- **Reason**: ${s.reason}\n`;
    if (comp && comp.framework === 'react') {
      output += `- **Import**: from \`${comp.importFrom}\`\n`;
    } else if (comp) {
      output += `- **PHP**: \`${comp.phpCall}\`\n`;
    }
    if (s.example) output += `- **Example**: \`${s.example}\`\n`;
    if (s.options.length) output += `- **Options** (only these values exist): ${s.options.join('; ')}\n`;
    if (s.demo) output += `- **Demo**: \`${s.demo}\`\n`;
    if (s.preview) output += `- **Preview**: \`${s.preview}\` (${s.previewKind === 'auto' ? 'auto preview built from the catalog entry, not a curated fixture' : 'curated playground fixture'})\n`;
    for (const alt of s.insteadOf || []) output += `- **Instead**: \`${alt.use}\` ${alt.when}\n`;
    for (const l of s.legacy) output += `- **Legacy lookalike to avoid**: \`${l.pattern}\`. ${l.why}\n`;
    output += `\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleCheckSnippet({ code, language, file_path } = {}) {
  if (typeof code !== 'string' || typeof language !== 'string') {
    return { content: [{ type: 'text', text: 'check_snippet takes two arguments: code (the snippet, as a string) and language (css, php, js or swift), plus file_path for a Swift snippet.' }], isError: true };
  }
  let violations;
  const fakePath = `snippet.${language}`;

  switch (language) {
    case 'swift':
      violations = validateSwift(code, typeof file_path === 'string' && file_path ? file_path : fakePath, tokenParser, nativeCtx);
      break;
    case 'css':
      violations = validateCSS(code, fakePath, tokenParser);
      break;
    case 'php':
      violations = validatePHP(code, fakePath, tokenParser, componentRegistry);
      break;
    case 'js':
      violations = validateJS(code, fakePath, tokenParser);
      break;
    case 'jsx':
    case 'tsx':
      violations = validateJSX(code, fakePath, tokenParser, componentRegistry);
      break;
    case 'vue':
    case 'svelte':
      violations = validateSFC(code, fakePath, tokenParser, componentRegistry);
      break;
    default:
      return { content: [{ type: 'text', text: `Unsupported language: ${language}` }], isError: true };
  }

  const swiftNote = language === 'swift' && !file_path
    ? '\nNo file_path, so this was checked as a view outside every app: no theme constants to suggest, and fixedSize: (an iOS-only rule) was not checked. Pass file_path for the full check.\n'
    : '';

  if (violations.length === 0) {
    return { content: [{ type: 'text', text: `✅ Snippet is design-system compliant.${swiftNote}` }] };
  }

  let output = `## Snippet Violations (${violations.length})\n\n`;
  for (const v of violations) {
    output += `- **Line ${v.line}** (${v.severity}): ${v.message}`;
    if (v.match) output += ` — \`${v.match}\``;
    output += `\n  ${v.suggestion}\n`;
  }

  // Also provide the auto-fixed version if applicable
  const fixable = violations.filter(v => v.autoFixable);
  if (fixable.length > 0) {
    const { fixed } = autoFix(code, violations);
    output += `\n### Auto-fixed version:\n\n\`\`\`${language}\n${fixed}\n\`\`\`\n`;
  }

  return { content: [{ type: 'text', text: output + swiftNote }] };
}

const SIMULATOR = 'iPhone 17 Pro';

/** Build, run and screenshot commands for an app, all from the repo root. */
function nativeCommands(key, app) {
  const lines = [];
  // The check command: Workshopr's npm script, or the enforcer's own CLI everywhere else.
  const checkCmd = nativeCtx.manifest.check || (config.framework === 'php' ? 'npm run lint:ds:native' : null);
  if (app.platform === 'ios') {
    if (app.project && app.scheme) lines.push(`Build: xcodebuild -project ${app.project} -scheme ${app.scheme} -destination 'platform=iOS Simulator,name=${SIMULATOR}' build`);
    if (app.projectSpec) lines.push(`After adding or removing a file: xcodegen generate, run in ${app.root}/ (the project is generated from ${app.projectSpec})`);
    lines.push(`Run: xcrun simctl boot '${SIMULATOR}' (when none is booted), then xcrun simctl install booted <the built .app> and xcrun simctl launch booted ${app.bundleId || '<bundle id>'}`);
    lines.push('Screenshot: xcrun simctl io booted screenshot <file>.png');
    lines.push('Dark appearance: xcrun simctl ui booted appearance dark (light to reset)');
    lines.push('Largest text size: xcrun simctl ui booted content_size accessibility-extra-extra-extra-large (large to reset)');
  } else if (app.platform === 'macos') {
    lines.push(`Build: swift build --package-path ${app.root}`);
    if (app.build) lines.push(`Package the .app: ${app.build}`);
    if (app.run) lines.push(`Run: ${app.run}`);
    lines.push('Screenshot: screencapture -x <file>.png (or -w for one window)');
  }
  lines.push(checkCmd ? `Check: ${checkCmd} -- --app ${key}` : `Check: ds-enforcer check ${app.source || app.root}`);
  return lines;
}

function handleNativeApps({ app } = {}) {
  const apps = nativeCtx.apps;
  if (!app) {
    let text = `## Native apps (${Object.keys(apps).length})\n\n`;
    for (const [key, a] of Object.entries(apps)) {
      text += `- **${key}**: ${a.name} (${a.platform}, ${a.ui}${a.external ? ', external: described, never checked' : ''}), source \`${a.source || a.root}\`, theme files ${(a.themeFiles || []).map(f => `\`${f}\``).join(', ')}\n`;
    }
    const guide = nativeCtx.manifest.doc || (config.framework === 'php' ? '/design-system/native.md' : null);
    const check = nativeCtx.manifest.check || (config.framework === 'php' ? 'npm run lint:ds:native' : 'ds-enforcer check');
    text += `\nCall native_apps with an app key for its binding, commands and live findings.${guide ? ` The guide is \`${guide}\`;` : ''} The check is \`${check}\`.\n`;
    return { content: [{ type: 'text', text }] };
  }
  const a = apps[app];
  if (!a) return { content: [{ type: 'text', text: `Unknown app "${app}". Apps: ${Object.keys(apps).join(', ')}.` }], isError: true };

  const field = (label, value) => (value === undefined || value === null || value === '' ? '' : `- **${label}**: ${Array.isArray(value) ? value.map(v => `\`${v}\``).join(', ') : value}\n`);
  let text = `## ${a.name} (${app})\n\n`;
  text += field('Platform', `${a.platform}, ${a.ui}${a.minOS ? `, ${a.minOS}` : ''}`);
  for (const [label, key] of [['Root', 'root'], ['Source', 'source'], ['Project', 'project'], ['Project spec', 'projectSpec'], ['Package', 'package'], ['Scheme', 'scheme'], ['Bundle id', 'bundleId'], ['Readme', 'readme']]) {
    if (a[key]) text += field(label, `\`${a[key]}\``);
  }
  text += field('Theme files', a.themeFiles);
  text += field('Components', a.components);
  text += field('Token namespace', a.tokenNamespace);
  text += field('Annotation', a.annotation);
  text += field('Project files', a.projectFiles);
  if (a.external) {
    text += field('Note', a.note);
    text += field('Doc', a.doc);
    text += `\nThis app lives outside this repo. The native check never reads it; describe it, never check it.\n`;
    return { content: [{ type: 'text', text }] };
  }

  text += `\n### Commands (from the repo root)\n\n${nativeCommands(app, a).map(l => `- ${l}`).join('\n')}\n`;
  text += `\n### Hazards\n\n${(a.hazards || []).length ? a.hazards.map(h => `- ${h}`).join('\n') : '- None recorded.'}\n`;
  const scopes = Object.entries(a.sanctionedScopes || {});
  text += `\n### Sanctioned scopes\n\n${scopes.length ? scopes.map(([s, why]) => `- \`${s}\`: ${why}`).join('\n') : '- None: every constant must equal a web token\'s value.'}\n`;

  const { findings } = runNativeCheck(nativeCtx, (content, abs) => validateSwift(content, abs, tokenParser, nativeCtx), { app });
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  let counts, unreadable = null;
  try { counts = readBaseline(nativeCtx); } catch (error) { counts = null; unreadable = error.message; }
  const { fresh } = compareToBaseline(findings, counts || {}, key => key.startsWith(`${app}|`));
  const against = unreadable ? `not compared: ${unreadable}` : counts ? `${fresh.length} new against the baseline` : 'no baseline yet';
  text += `\n### Native check, live (${findings.length} findings, ${against})\n\n`;
  text += Object.keys(byRule).length ? Object.entries(byRule).sort().map(([rule, n]) => `- ${rule}: ${n}`).join('\n') + '\n' : '- None.\n';
  const drifted = findings.filter(f => f.rule === 'native-token-drift');
  if (drifted.length) text += `\nDrifted constants:\n${drifted.map(f => `- ${f.message} (${f.file}:${f.line})`).join('\n')}\n`;
  text += nativeCtx.manifest.check || config.framework === 'php' ? `\nEvery finding: ${nativeCtx.manifest.check || 'npm run lint:ds:native'} -- --app ${app} --all\n` : `\nEvery finding: ds-enforcer check ${a.source || a.root} --all\n`;
  return { content: [{ type: 'text', text }] };
}

// ─── The checklist report ───

async function handleReport({ paths = [], min, a11y, out } = {}) {
  for (const p of paths) resolvePath(p); // refuses paths outside the project
  const r = await writeReport({ targets: paths, base: PROJECT_ROOT, min, a11y, out });
  const text = r.total
    ? `Wrote \`${r.rel}\`: ${r.total} finding${r.total === 1 ? '' : 's'} in ${r.files} file${r.files === 1 ? '' : 's'}. ${r.auto} are **auto** (the enforcer makes the swap itself); ${r.total - r.auto} are for **Claude** (they need judgment, and the enforcer checks the result).\n\nThe user can tick boxes in the file, or tell you which to fix: ids like R1 and R4, "all auto", or "all". Then call apply_report with those in select.`
    : `Wrote \`${r.rel}\`: nothing to fix.`;
  return { content: [{ type: 'text', text }] };
}

async function handleApplyReport({ select = [], accept_rest = false, report } = {}) {
  const r = await applyReport({ report, select, acceptRest: accept_rest });
  let text = `## Applied \`${r.report}\`\n\n- **Fixed**: ${r.fixed} (${r.appliedAuto} applied by the enforcer)\n`;
  if (r.stillThere.length) text += `- **Still there**: ${r.stillThere.map(s => `${s.id} (${s.file}:${s.line}, ${s.why})`).join('; ')}\n`;
  if (r.accepted) text += `- **Accepted into the baseline**: ${r.accepted}\n`;
  if (r.unticked > 0) text += `- **Not ticked**: ${r.unticked}\n`;
  if (r.forClaude.length) {
    text += `\n### For you to fix (${r.forClaude.length})\n\nMake each change, then call apply_report again to verify and mark it.\n\n`;
    for (const c of r.forClaude) text += `- **${c.id}** \`${c.file}:${c.line}\`: ${c.message}${c.match ? ` (\`${c.match}\`)` : ''}. ${c.suggestion || ''}\n`;
  } else text += `\nEvery ticked item is done or reported above. The report is updated.\n`;
  return { content: [{ type: 'text', text }] };
}

// ─── Accessibility ───

const A11Y_LIMITS = 'Not covered here (needs the rendered page): focus order and visibility, target size (24px minimum, 44pt on iOS), zoom and reflow, and what a screen reader actually announces.';

function handleA11y({ file_path, code, language, tokens } = {}) {
  let out = '';
  if (file_path || typeof code === 'string') {
    let content, label, path;
    if (file_path) {
      path = resolvePath(file_path);
      if (!existsSync(path)) return { content: [{ type: 'text', text: `File not found: ${path}` }], isError: true };
      content = readFileSync(path, 'utf-8');
      label = file_path;
    } else {
      path = `snippet.${language || 'tsx'}`;
      content = code;
      label = 'snippet';
    }
    const found = reviewA11y(content, path, tokenParser);
    out += `## Accessibility: ${label}\n\n`;
    if (!found.length) out += 'No problems found in the code.\n';
    for (const severity of ['high', 'medium', 'low']) {
      const list = found.filter(v => v.severity === severity);
      if (!list.length) continue;
      out += `### ${severity.toUpperCase()} (${list.length})\n\n`;
      for (const v of list) out += `- **Line ${v.line}**: ${v.message}\n  ${v.suggestion}\n`;
      out += '\n';
    }
  }
  if (tokens || (!file_path && typeof code !== 'string')) {
    const pairs = tokenPairs(tokenParser);
    out += `## Colour pairs in the design system\n\n`;
    if (!pairs.length) out += 'No token pairs to check: pairs are found as a token and its -foreground (primary / primary-foreground), and background / foreground.\n';
    else {
      out += `| Background | Text | Ratio | AA normal text (4.5) | AA large text (3) |\n|---|---|---|---|---|\n`;
      for (const p of pairs.sort((a, b) => a.ratio - b.ratio)) out += `| \`${p.bg}\` ${p.bgHex} | \`${p.fg}\` ${p.fgHex} | ${p.ratio.toFixed(2)}:1 | ${p.passes ? 'pass' : '**fail**'} | ${p.ratio >= 3 ? 'pass' : '**fail**'} |\n`;
      const failing = pairs.filter(p => !p.passes);
      out += `\n${failing.length ? `${failing.length} pair${failing.length === 1 ? '' : 's'} fail AA for normal text.` : 'Every pair passes AA for normal text.'}\n`;
    }
  }
  out += `\n${A11Y_LIMITS}\n`;
  return { content: [{ type: 'text', text: out }] };
}

// ─── init ───

const KIND = { css: 'CSS variables', dtcg: 'W3C / Style Dictionary tokens', figma: 'Figma variables', react: 'React components', vue: 'Vue components', svelte: 'Svelte components', swift: 'SwiftUI theme' };

function typeOfPath(abs) {
  if (statSync(abs).isDirectory()) return folderFramework(abs);
  if (/\.(css|scss|pcss)$/i.test(abs)) return 'css';
  if (/\.swift$/i.test(abs)) return 'swift';
  if (/\.json$/i.test(abs)) return countFigma(abs) ? 'figma' : 'dtcg';
  return null;
}

/** Reload everything after the config changed under the running server. */
async function reconnect() {
  reloadConfig();
  await loadSearch();
  sourceState = null;
  syncSources(true);
  loadWeb();
  try { nativeCtx = loadNative(); } catch { /* no native apps */ }
  loaded.web = webStamp();
  loaded.native = nativeStamp();
}

async function handleInit({ action = 'detect', sources, rootPx, pureBlack, pureWhite, replace, hook } = {}) {
  const root = connected ? PROJECT_ROOT : PROJECT_DIR;
  const handWritten = connected && !config.sources?.length;

  if (action === 'sync') {
    if (!config.sources?.length) return { content: [{ type: 'text', text: 'Nothing to sync: this project has no init-connected sources.' }], isError: true };
    await reconnect();
    return { content: [{ type: 'text', text: `Synced: ${tokenParser.getStats().totalTokens} tokens, ${componentRegistry.components.size} components.` }] };
  }

  const found = detect(root);

  if (action === 'detect') {
    let out = `## Design system sources in ${root}\n\n`;
    if (connected) {
      out += handWritten
        ? `Currently connected by a hand-written config (${CONFIG_PATH}). Connecting here would replace it, so only do that if the user asks.\n\n`
        : `Currently connected: ${config.sources.map(s => `${s.path} (${KIND[s.type]})`).join(', ')}.\n\n`;
    }
    if (!found.sources.length) {
      out += 'Found nothing automatically. Ask the user for the path of their tokens file (.css, .scss or tokens .json) and their components folder, then connect with those paths.\n';
    } else {
      for (const type of ['css', 'dtcg', 'figma', 'react', 'vue', 'svelte', 'swift']) {
        const list = found.sources.filter(s => s.type === type);
        if (!list.length) continue;
        out += `**${KIND[type]}**\n`;
        for (const s of list) out += `- [${s.id}] \`${s.path}\` ${s.note}${found.defaults.includes(s.id) ? ' (suggested)' : ''}\n`;
        out += '\n';
      }
      out += `Suggested: ${found.defaults.join(', ') || 'none'}.\n`;
    }
    out += '\nAsk the user: which sources to connect (numbers, or paths the scan missed), what 1rem equals in px on their pages (usually 16), whether to flag pure black text or pure white backgrounds, and whether to check each file automatically after you edit it (a hook). Then call init with action "connect".';
    return { content: [{ type: 'text', text: out }] };
  }

  if (action !== 'connect') return { content: [{ type: 'text', text: `Unknown init action: ${action}` }], isError: true };
  if (handWritten && !replace) {
    return { content: [{ type: 'text', text: `This project is configured by hand in ${CONFIG_PATH}. Connecting would override it; call again with replace: true only if the user wants that.` }], isError: true };
  }
  const chosen = [];
  for (const s of sources || []) {
    if (typeof s === 'number') {
      const hit = found.sources.find(f => f.id === s);
      if (!hit) return { content: [{ type: 'text', text: `No source numbered ${s}. Run init with action "detect" for the list.` }], isError: true };
      chosen.push(hit);
    } else {
      const abs = resolve(root, String(s));
      if (!insideProjectOf(root, abs) || !existsSync(abs)) return { content: [{ type: 'text', text: `Not found inside the project: ${s}` }], isError: true };
      const type = typeOfPath(abs);
      if (!type) return { content: [{ type: 'text', text: `${s} is not a .css/.scss file, a tokens .json file or a components folder.` }], isError: true };
      chosen.push({ type, path: relativeTo(root, abs) });
    }
  }
  const r = connect(root, { sources: chosen, rootPx, rules: { pureBlack, pureWhite }, replace: Boolean(replace) });
  await reconnect();
  let out = `## Connected (${r.framework})\n\n`;
  out += `- **Sources**: ${chosen.map(s => `\`${s.path}\` (${KIND[s.type]})`).join(', ')}\n`;
  out += `- **Tokens**: ${r.tokens} (${Object.entries(r.groups).map(([g, n]) => `${n} ${g.toLowerCase()}`).join(', ') || 'none'})\n`;
  out += `- **Components**: ${r.components}\n`;
  if (r.skipped.length) out += `- **Skipped**: ${r.skipped.length} composite tokens (typography sets have no single CSS value)\n`;
  if (r.tailwind) out += `- **Tailwind ${r.tailwind}**: class names are checked too\n`;
  if (r.drift?.length) out += `- **Drift**: ${r.drift.length} token${r.drift.length === 1 ? ' differs' : 's differ'} between sources, e.g. \`${r.drift[0].token}\`: ${r.drift[0].values.map(v => `${v.value} in ${v.type === 'figma' ? 'Figma' : v.path}`).join(' vs ')}. validate_file on the token file lists them all\n`;
  if (r.nativeApps) out += `- **Native**: ${r.nativeApps} SwiftUI app${r.nativeApps === 1 ? '' : 's'}; native_apps shows each one, and their theme colours are checked against the web tokens\n`;
  if (r.onlyInFigma) out += `- **Figma only**: ${r.onlyInFigma} Figma variable${r.onlyInFigma === 1 ? ' has' : 's have'} no matching code token\n`;
  if (hook) {
    const h = installHook(root);
    out += h.installed ? `- **Hook**: added to \`${relativeTo(root, h.path)}\`; it takes effect once Claude Code restarts\n` : `- **Hook**: not added (${h.reason})\n`;
  }
  out += `\nWrote \`${r.configPath}\` and \`.ds-enforcer/\`. Every tool works now. Tell the user they can teach it their own words in \`.ds-enforcer/synonyms.json\`, and that the catalog resyncs whenever a connected source changes.`;
  return { content: [{ type: 'text', text: out }] };
}

const relativeTo = (root, abs) => relative(root, abs).split(sep).join('/');
const insideProjectOf = (root, abs) => { const rel = relative(root, abs); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

// ─── Start Server ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${config.name ? `${config.name} ` : ''}Design System Enforcer MCP server running`);
  if (tokenParser) console.error(`Loaded: ${tokenParser.getStats().totalTokens} tokens, ${componentRegistry.components.size} components`);
  else console.error(connected ? `Not loaded: ${loadError}` : 'Not connected yet: the init tool connects this project');
}

main().catch(console.error);
