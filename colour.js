/**
 * Colour helpers shared by the checks: parse a CSS colour to sRGB, measure how far
 * apart two colours look (OKLab distance, x100, where under 2 is hard to tell
 * apart), and find a design system's nearest colour token.
 */

export function parseColor(value) {
  const v = String(value || '').trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)%?\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/);
  if (m) {
    const L = m[2] ? +m[1] / 100 : +m[1], C = +m[3], H = +m[4] * Math.PI / 180;
    const a = m[5] === undefined ? 1 : m[6] ? +m[5] / 100 : +m[5];
    return { ...fromOklab(L, C * Math.cos(H), C * Math.sin(H)), a };
  }
  m = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4];
    return { ...fromHsl(+m[1], +m[2] / 100, +m[3] / 100), a };
  }
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  return null;
}

function fromOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const g = x => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  const c = x => Math.max(0, Math.min(255, g(Math.max(0, x))));
  return { r: c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b: c(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s) };
}

function fromHsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const k = n => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  const f = n => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return { r: f(0), g: f(8), b: f(4) };
}

export const toHex = c => '#' + [c.r, c.g, c.b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase();

function toOklab({ r, g, b }) {
  const lin = x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

/** Perceptual distance x100 (0 = identical; under 2 hard to tell apart; over 10 clearly different). */
export function distance(a, b) {
  const [L1, a1, b1] = toOklab(a), [L2, a2, b2] = toOklab(b);
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2) * 100;
}

export function closeness(d) {
  return d < 2 ? 'practically identical' : d < 5 ? 'very close' : d < 10 ? 'close' : 'the nearest, but clearly different';
}

/**
 * The design system's colour token nearest to a colour, or null when it has none.
 * Returns { name, hex, distance }. Opaque colours only: a translucent value is
 * compared on its colour alone.
 */
export function nearestColorToken(tokenParser, value) {
  const target = parseColor(value);
  if (!target || !tokenParser?.colorToToken?.size) return null;
  let best = null;
  for (const [hex, names] of tokenParser.colorToToken) {
    const c = parseColor(hex);
    if (!c) continue;
    const d = distance(target, c);
    if (!best || d < best.distance) best = { hex: toHex(c), distance: d, names };
  }
  if (!best) return null;
  return { name: tokenParser.pickBestColorToken(best.names), names: best.names, hex: best.hex, distance: best.distance };
}

/** WCAG 2.x contrast ratio between two opaque colours (1 to 21). */
export function contrast(a, b) {
  const lum = ({ r, g, b: bl }) => {
    const ch = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
