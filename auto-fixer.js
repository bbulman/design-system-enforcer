/**
 * Auto-Fixer — applies safe, reversible fixes for design system violations.
 * Only fixes issues where the replacement is unambiguous.
 */

/**
 * Apply all auto-fixable violations to file content.
 * Returns { fixed: string, appliedFixes: array, skippedFixes: array }
 */
export function autoFix(content, violations) {
  const fixable = violations.filter(v => v.autoFixable && v.fix);
  const skipped = violations.filter(v => !v.autoFixable);

  if (fixable.length === 0) {
    return { fixed: content, appliedFixes: [], skippedFixes: skipped };
  }

  // Group fixes by line to apply them in order
  // Sort by line (desc) and column (desc) so we can replace from end to start
  const sorted = [...fixable].sort((a, b) => {
    if (b.line !== a.line) return b.line - a.line;
    return (b.column || 0) - (a.column || 0);
  });

  let fixed = content;
  const appliedFixes = [];

  // Deduplicate fixes: same from -> to on the same line should only apply once
  const seen = new Set();

  for (const violation of sorted) {
    const { fix, line, type, match: violationMatch } = violation;
    const key = `${line}:${fix.from}:${fix.to}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const lines = fixed.split('\n');
    const lineIdx = line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const originalLine = lines[lineIdx];

    // For color fixes, we need careful replacement
    if (type === 'hardcoded-color' || type === 'hardcoded-spacing' || type === 'hardcoded-radius') {
      // Replace the specific value in this line
      // Use a targeted approach: only replace the exact match
      const newLine = replaceInLine(originalLine, fix.from, fix.to);
      if (newLine !== originalLine) {
        lines[lineIdx] = newLine;
        fixed = lines.join('\n');
        appliedFixes.push({
          line,
          type,
          from: fix.from,
          to: fix.to,
          originalLine: originalLine.trim(),
          fixedLine: newLine.trim(),
        });
      }
    }
  }

  return { fixed, appliedFixes, skippedFixes: skipped };
}

/**
 * Replace a specific value in a line, being careful about context.
 * For colors: replace #hex with var(--token)
 * For spacing: replace Npx with var(--space-N)
 */
function replaceInLine(line, from, to) {
  // Escape special regex characters in `from`
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // For hex colors, ensure we match word boundaries
  if (from.startsWith('#')) {
    const regex = new RegExp(escaped + '\\b', 'gi');
    return line.replace(regex, to);
  }

  // For px values, replace with word boundary on both sides
  if (from.endsWith('px')) {
    const regex = new RegExp('\\b' + escaped + '\\b', 'g');
    return line.replace(regex, to);
  }

  // Generic replacement
  return line.replace(from, to);
}

/**
 * Generate a diff-like preview of all fixes that would be applied.
 */
export function previewFixes(content, violations) {
  const fixable = violations.filter(v => v.autoFixable && v.fix);
  if (fixable.length === 0) return 'No auto-fixable violations found.';

  const lines = content.split('\n');
  const preview = [];

  // Group by line number
  const byLine = new Map();
  for (const v of fixable) {
    if (!byLine.has(v.line)) byLine.set(v.line, []);
    byLine.get(v.line).push(v);
  }

  for (const [lineNum, lineViolations] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const original = lines[lineNum - 1];
    if (!original) continue;

    let fixed = original;
    for (const v of lineViolations) {
      fixed = replaceInLine(fixed, v.fix.from, v.fix.to);
    }

    if (fixed !== original) {
      preview.push(`Line ${lineNum}:`);
      preview.push(`  - ${original.trim()}`);
      preview.push(`  + ${fixed.trim()}`);
      preview.push('');
    }
  }

  return preview.join('\n');
}

/**
 * Generate a summary report from violations.
 */
export function generateReport(violations, filePath) {
  const summary = {
    file: filePath,
    totalViolations: violations.length,
    bySeverity: { high: 0, medium: 0, low: 0 },
    byType: {},
    autoFixable: 0,
    violations: [],
  };

  for (const v of violations) {
    summary.bySeverity[v.severity] = (summary.bySeverity[v.severity] || 0) + 1;
    summary.byType[v.type] = (summary.byType[v.type] || 0) + 1;
    if (v.autoFixable) summary.autoFixable++;
    summary.violations.push({
      line: v.line,
      severity: v.severity,
      type: v.type,
      match: v.match,
      message: v.message,
      suggestion: v.suggestion,
      autoFixable: v.autoFixable,
    });
  }

  return summary;
}
