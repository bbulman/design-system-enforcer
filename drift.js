/**
 * Drift findings: tokens that two connected sources (Figma and code, usually) both
 * define with different values. Reported against the code token file, on the line
 * that declares the token, so they show up in check, the hook and pull requests
 * like any other finding, and a baseline can hold the ones a team has accepted.
 */
import { readFileSync, existsSync } from 'fs';
import { projectPath } from './config.js';

/** { rel path: [violation] } from the catalog's drift list. */
export function driftFindings(catalog) {
  const byFile = {};
  for (const d of catalog?.meta?.drift || []) {
    const code = d.values.find(v => v.type !== 'figma') || d.values[0];
    const figma = d.values.find(v => v.type === 'figma');
    let line = 1;
    try {
      const abs = projectPath(code.path);
      if (existsSync(abs)) {
        const i = readFileSync(abs, 'utf8').split('\n').findIndex(l => l.includes(`${d.token}:`) || l.includes(`"${d.token.replace(/^--/, '').split('-').pop()}"`));
        if (i >= 0) line = i + 1;
      }
    } catch { /* line 1 then */ }
    const others = d.values.filter(v => v !== code).map(v => `${v.value} in ${v.type === 'figma' ? `Figma${v.figma ? ` (${v.figma})` : ''}` : v.path}`).join(', ');
    (byFile[code.path] ||= []).push({
      type: 'token-drift', severity: 'medium', line, match: d.token,
      message: `${d.token} is ${code.value} here but ${others}`,
      suggestion: figma ? 'Decide which is right and update the other, in code or in the Figma variable' : 'Decide which is right and make the sources agree',
      autoFixable: false, file: code.path,
    });
  }
  return byFile;
}
