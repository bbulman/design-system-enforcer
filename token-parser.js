/**
 * Token Parser — reads platform-tokens.css and builds lookup maps
 * for colors, spacing, typography, shadows, radii, etc. Meaning (purpose, tier,
 * and the --brand* token a legacy alias stands for) comes from the tokens
 * section of design-system/components.generated.json.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { config, projectPath } from './config.js';
import { search } from './catalog-search.js';

export class TokenParser {
  /* platform-tokens.css: html { font-size: 80% } => 16 * 0.8 */
  /* The page's root font size in px, for rem values: config rootPx
     (Workshopr's html { font-size: 80% } => 16 * 0.8 = 12.8). */
  static get ROOT_PX() { return config.rootPx; }

  constructor() {
    this.tokens = new Map();         // token name -> value
    this.colorToToken = new Map();   // hex color -> token name(s)
    this.spacingToToken = new Map(); // px value -> token name
    this.radiusToToken = new Map();  // px value -> token name
    this.shadowToToken = new Map();  // shadow value -> token name
    this.fontToToken = new Map();    // font value -> token name
    this.info = new Map();           // token name -> { value, purpose, group, tier, use? } from the catalog
    this.data = null;                // { catalog, synonyms }
    this.loaded = false;
  }

  load() {
    const cssPath = projectPath(config.tokensCss);
    const css = readFileSync(cssPath, 'utf-8');
    this._parse(css);
    this.data = search.loadCatalog();
    for (const [name, t] of Object.entries(this.data.catalog.tokens || {})) this.info.set(name, t);
    this.loaded = true;
    return this;
  }

  /**
   * Tokens for a plain-language role, e.g. "red text on light" -> --brand-ink.
   * Legacy aliases rank last.
   */
  findByRole(role, limit = 5) {
    return search.rankTokens(role, this.data, limit);
  }

  /** The --brand* token a legacy alias stands for, or null. */
  aliasReplacement(name) {
    const t = this.info.get(name);
    return t && t.tier === 'alias' && t.use ? t.use : null;
  }

  _parse(css) {
    // Extract all CSS custom property declarations
    const varRegex = /--([\w-]+)\s*:\s*([^;]+)/g;
    let match;
    while ((match = varRegex.exec(css)) !== null) {
      const name = `--${match[1]}`;
      const value = match[2].trim();
      this.tokens.set(name, value);

      // Build reverse maps
      this._indexColor(name, value);
      this._indexSpacing(name, value);
      this._indexRadius(name, value);
      this._indexShadow(name, value);
      this._indexFont(name, value);
    }
  }

  _indexColor(name, value) {
    // Match hex colors
    const hexMatch = value.match(/^#([0-9a-fA-F]{3,8})$/);
    if (hexMatch) {
      const normalized = this._normalizeHex(value);
      if (!this.colorToToken.has(normalized)) {
        this.colorToToken.set(normalized, []);
      }
      this.colorToToken.get(normalized).push(name);
      return;
    }
    // Match rgba colors
    const rgbaMatch = value.match(/^rgba?\([\d\s,.]+\)$/);
    if (rgbaMatch) {
      if (!this.colorToToken.has(value)) {
        this.colorToToken.set(value, []);
      }
      this.colorToToken.get(value).push(name);
    }
  }

  _indexSpacing(name, value) {
    if (!name.startsWith('--space-')) return;
    const pxMatch = value.match(/^(\d+)px$/);
    if (pxMatch) {
      this.spacingToToken.set(parseInt(pxMatch[1]), name);
    }
  }

  _indexRadius(name, value) {
    if (!name.startsWith('--radius-')) return;
    const pxMatch = value.match(/^(\d+)px$/);
    if (pxMatch) {
      this.radiusToToken.set(parseInt(pxMatch[1]), name);
    } else if (value === '9999px') {
      this.radiusToToken.set(9999, name);
    }
  }

  _indexShadow(name, value) {
    if (!name.startsWith('--shadow-')) return;
    this.shadowToToken.set(value, name);
  }

  _indexFont(name, value) {
    if (name.startsWith('--font-') || name.startsWith('--text-') || name.startsWith('--leading-')) {
      this.fontToToken.set(value, name);
    }
  }

  _normalizeHex(hex) {
    hex = hex.toLowerCase().replace('#', '');
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    return `#${hex}`;
  }

  /**
   * Look up the best token name for a hardcoded hex color.
   * Returns array of matching token names, or empty array if none.
   */
  findColorToken(hex) {
    const normalized = this._normalizeHex(hex);
    return this.colorToToken.get(normalized) || [];
  }

  /**
   * Look up the best spacing token for a px value.
   */
  findSpacingToken(px) {
    return this.spacingToToken.get(px) || null;
  }

  /**
   * Look up the best radius token for a px value.
   */
  findRadiusToken(px) {
    return this.radiusToToken.get(px) || null;
  }

  /**
   * Look up a type-scale token for a font-size in px.
   *
   * platform-tokens.css sets `html { font-size: 80% }` platform-wide, so the
   * root is 12.8px and every rem token PAINTS at 0.8x its nominal value:
   * --text-small (0.875rem, nominally 14px) renders 11.2px. Matching against
   * the nominal size would tell a caller that a 14px literal is --text-small,
   * and taking that advice shrinks the text by 20%. Match what it paints.
   * Only --text-* size tokens count; --text-dark and friends are colors.
   */
  findFontSizeToken(px) {
    if (!Number.isFinite(px)) return null;
    if (!this._fontSizePx) {
      this._fontSizePx = new Map();
      for (const [value, name] of this.fontToToken.entries()) {
        if (!name.startsWith('--text-')) continue;
        const m = String(value).trim().match(/^([\d.]+)(rem|px)$/);
        if (!m) continue;
        /* round: 0.875 * 12.8 is 11.200000000000001 in binary floating point */
        const asPx = Math.round((m[2] === 'rem' ? parseFloat(m[1]) * TokenParser.ROOT_PX : parseFloat(m[1])) * 100) / 100;
        if (!this._fontSizePx.has(asPx)) this._fontSizePx.set(asPx, name);
      }
    }
    return this._fontSizePx.get(Math.round(px * 100) / 100) || null;
  }

  /**
   * Get all known hex colors (for violation detection).
   */
  getAllKnownColors() {
    return new Map(this.colorToToken);
  }

  /**
   * Get all spacing values in the scale.
   */
  getSpacingScale() {
    return new Map(this.spacingToToken);
  }

  /**
   * Pick the best token from a list of matches.
   * Prefers semantic tokens over raw color names.
   */
  pickBestColorToken(tokens) {
    if (!tokens || tokens.length === 0) return null;
    // The five brand reds come first: the per-app and category tokens that share
    // a hex (#E54D4D is also --tips-cat-4) mean something else.
    const brand = tokens.find(t => /^--brand(-|$)/.test(t));
    if (brand) return brand;
    // Prefer semantic tokens (--color-*, --text-*, --bg-*, --button-*, --card-*)
    const semantic = tokens.find(t =>
      t.startsWith('--color-') || t.startsWith('--text-') ||
      t.startsWith('--bg-') || t.startsWith('--button-') ||
      t.startsWith('--card-') || t.startsWith('--input-')
    );
    if (semantic) return semantic;
    // Then prefer app-specific tokens
    const app = tokens.find(t =>
      t.startsWith('--mainsite-') || t.startsWith('--planner-') ||
      t.startsWith('--coach-') || t.startsWith('--tips-') ||
      t.startsWith('--podcasts-') || t.startsWith('--intervention-') ||
      t.startsWith('--dna-') || t.startsWith('--training-')
    );
    if (app) return app;
    // Then phase tokens
    const phase = tokens.find(t => t.startsWith('--phase-'));
    if (phase) return phase;
    // Then gray scale
    const gray = tokens.find(t => t.startsWith('--gray-'));
    if (gray) return gray;
    // Fallback to first
    return tokens[0];
  }

  getStats() {
    return {
      totalTokens: this.tokens.size,
      colors: this.colorToToken.size,
      spacing: this.spacingToToken.size,
      radii: this.radiusToToken.size,
      shadows: this.shadowToToken.size,
    };
  }
}
