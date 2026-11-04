/**
 * The kit fixture's shell parser (componentGate.shellParser): the project files a shell command
 * writes, as project-relative paths. A small stand-in for a real one, enough for the tests:
 * redirects (> and >>, heredocs included), tee, sed -i, perl -pi, cp and touch, after any cd.
 */
import { resolve, relative, isAbsolute } from 'node:path';

/** The command's words, quotes removed; a heredoc's body is not part of the command. */
function words(command) {
  const lines = command.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const end = /<<-?\s*['"]?(\w+)['"]?/.exec(lines[i])?.[1];
    if (end) while (i + 1 < lines.length && lines[++i].trim() !== end) { /* the body */ }
  }
  const out = [];
  let word = null, quote = null;
  const text = kept.join('\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; else word += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; word ??= ''; continue; }
    if (/\s/.test(ch)) { if (word !== null) out.push(word); word = null; continue; }
    if ('|;&<>'.includes(ch)) {
      if (word !== null) out.push(word);
      word = null;
      let op = ch;
      while ('|&>'.includes(text[i + 1]) && op.length < 2) op += text[++i];
      out.push({ op });
      continue;
    }
    word = (word ?? '') + ch;
  }
  if (word !== null) out.push(word);
  return out;
}

export function writeTargets(command, root, { cwd = root } = {}) {
  const found = [];
  let dir = cwd;
  const add = file => {
    const abs = isAbsolute(file) ? file : resolve(dir, file);
    const rel = relative(root, abs);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) found.push(rel.split('\\').join('/'));
  };
  const list = words(String(command));
  let simple = [];
  const flush = () => {
    const [tool, ...args] = simple;
    const operands = args.filter(a => !a.startsWith('-'));
    if (tool === 'cd' && operands[0]) dir = resolve(dir, operands[0]);
    else if (tool === 'touch' || tool === 'tee') operands.forEach(add);
    else if (tool === 'cp' && operands.length > 1) add(operands.at(-1));
    else if (tool === 'sed' && args.some(a => a.startsWith('-i'))) {
      // sed -i '' 's/a/b/' file: the first operand after the script is a file, the empty suffix aside.
      const rest = args.filter(a => a !== '-i' && a !== '');
      rest.slice(1).filter(a => !a.startsWith('-')).forEach(add);
    } else if (tool === 'perl' && args.some(a => /^-\w*i/.test(a))) {
      const at = args.indexOf('-e');
      (at >= 0 ? args.slice(at + 2) : operands).filter(a => !a.startsWith('-')).forEach(add);
    }
    simple = [];
  };
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (typeof w === 'string') { simple.push(w); continue; }
    if (w.op === '>' || w.op === '>>') {
      const target = list[i + 1];
      if (typeof target === 'string') { add(target); i++; }
      continue;
    }
    if (w.op === '<' || w.op === '<<') { if (typeof list[i + 1] === 'string') i++; continue; }
    flush();
  }
  flush();
  return [...new Set(found)];
}
