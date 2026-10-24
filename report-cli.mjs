/** `ds-enforcer report` and `ds-enforcer apply`, the command-line side of report.mjs. */
import { resolve } from 'path';

const option = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const VALUED = new Set(['--out', '--min', '--report', '--tick', '--root']);

export async function runReportCli(cmd, argv) {
  const root = option(argv, '--root');
  if (root) process.env.ENFORCER_PROJECT_ROOT = resolve(root);
  const { writeReport, applyReport } = await import('./report.mjs');
  try {
    if (cmd === 'report') {
      const targets = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
      const r = await writeReport({ targets, base: root ? resolve(root) : process.cwd(), out: option(argv, '--out'), min: option(argv, '--min') || 'low', a11y: argv.includes('--a11y') });
      console.log(r.total
        ? `Report written to ${r.rel}: ${r.total} finding${r.total === 1 ? '' : 's'} in ${r.files} file${r.files === 1 ? '' : 's'} (${r.auto} the enforcer can fix itself, ${r.total - r.auto} for Claude).\nTick the ones you want, then run: ds-enforcer apply`
        : `Report written to ${r.rel}: nothing to fix.`);
      return 0;
    }
    const tick = (option(argv, '--tick') || '').split(',').map(s => s.trim()).filter(Boolean);
    const r = await applyReport({ report: option(argv, '--report'), select: tick, acceptRest: argv.includes('--accept-rest') });
    console.log(`Fixed ${r.fixed} (the enforcer applied ${r.appliedAuto} itself).`);
    for (const s of r.stillThere) console.log(`  ⚠️ ${s.id} ${s.file}:${s.line} still there: ${s.why}`);
    if (r.forClaude.length) {
      console.log(`${r.forClaude.length} ticked item${r.forClaude.length === 1 ? ' needs' : 's need'} Claude. Ask Claude to "apply the design system report", or fix them by hand and run apply again to check:`);
      for (const c of r.forClaude) console.log(`  🛠 ${c.id} ${c.file}:${c.line}  ${c.message}. ${c.suggestion || ''}`);
    }
    if (r.accepted) console.log(`${r.accepted} unticked item${r.accepted === 1 ? '' : 's'} recorded in the baseline.`);
    console.log(`The report (${r.report}) is updated with what was done.`);
    return r.stillThere.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}
