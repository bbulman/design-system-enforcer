/**
 * The consult: each UI piece an agent is about to build, in its own words,
 * matched against the component inventory with the ranking suggest_component
 * and ds:find use. A piece whose best match scores under minScore has nothing
 * fitting. A piece's id depends only on the file and its words, so the hook
 * that records a consult can re-run it and arrive at the ids the agent saw.
 */
import { createHash } from 'node:crypto';
import { rankComponents } from '../search.mjs';
import { config } from '../config.js';

const MAX_CANDIDATES = 5;

export function pieceId(file, description) {
  const key = `${file}|${String(description).trim().toLowerCase()}`;
  return 'P-' + createHash('sha1').update(key).digest('hex').slice(0, 6);
}

/* Repeated --piece flags, read by hand: a description may start with a dash. The hook that records
   a shell consult reads the command's words with this too, so it sees what the command saw. */
export function consultArgs(argv) {
  let file = null;
  const pieces = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') file = argv[++i] ?? null;
    else if (argv[i] === '--piece') pieces.push(argv[++i] ?? '');
  }
  return { file: file?.trim() || null, pieces: pieces.map(p => p.trim()).filter(Boolean) };
}

export function consult({ file, pieces }, { data, minScore }) {
  const floor = minScore ?? 0;
  return {
    file,
    pieces: pieces.map(raw => {
      const description = String(raw).trim();
      const candidates = rankComponents(description, data, MAX_CANDIDATES)
        .filter(c => c.score >= floor)
        .map(c => ({
          helper: c.name,
          score: c.score,
          // A helper with no catalog example still shows its call through its signature.
          example: c.example || c.signature || null,
          whenToUse: c.whenToUse || c.summary || null,
          whenNotToUse: c.whenNotToUse || null,
          preview: c.preview || null,
          js: c.js || null,
        }));
      return { id: pieceId(file, description), description, candidates, nothingFitting: candidates.length === 0 };
    }),
  };
}

/** The top helper when it is alone or at least margin ahead of the next, else null. */
export function clearWinner(candidates, margin) {
  const [top, next] = [...(candidates || [])].sort((a, b) => b.score - a.score);
  if (!top) return null;
  return !next || top.score - next.score >= margin ? top.helper : null;
}

/* The catalog's prose uses em and en dashes; the gate's output uses none. The catalog itself is left as written. */
const plain = text => String(text)
  .replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
  .replace(/\s*[—–]\s*/g, ', ');

export function formatConsult(result) {
  const lines = [`Components that could build each piece in ${result.file}:`, ''];
  for (const piece of result.pieces) {
    lines.push(`${piece.id}  ${plain(piece.description)}`);
    if (piece.nothingFitting) lines.push('  Nothing in the inventory fits this piece.');
    for (const c of piece.candidates) {
      lines.push(`  - ${c.helper}`);
      if (c.example) lines.push(`    Example: ${plain(c.example)}`);
      if (c.js) lines.push(`    In JavaScript: ${c.js}${config.components.js?.file ? `, from ${config.components.js.file}` : ''}`);
      if (c.whenToUse) lines.push(`    When to use: ${plain(c.whenToUse)}`);
      if (c.whenNotToUse) lines.push(`    When not to: ${plain(c.whenNotToUse)}`);
      if (c.preview) lines.push(`    Preview: ${c.preview}`);
    }
    lines.push('');
  }
  lines.push('Build each piece with one of its candidates, or call record_case (shell: ds-enforcer record-case) with the piece id and your reason.');
  return lines.join('\n');
}
