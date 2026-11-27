import { ROOT } from './helpers/kit.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeReport, applyReport, restToAccept, parseReport } from '../report.mjs';
import { baselinePath } from '../baseline.js';

const report = 'accept-rest-report.md';
const accepted = () => parseReport(readFileSync(`${ROOT}/${report}`, 'utf8')).items.filter(it => it.status === '☑️ accepted').length;

// A yes covers exactly the findings it was asked about, so a fingerprint for any other set moves nothing.
test('accept_rest with a fingerprint for other findings moves nothing into the baseline', async () => {
  const written = await writeReport({ targets: ['pages'], base: ROOT, out: report });
  assert.ok(written.total > 0, 'the kit fixture has no findings to accept');
  const before = readFileSync(baselinePath(), 'utf8');
  const r = await applyReport({ report, acceptRest: true, restFingerprint: '000000000000' });
  assert.equal(r.acceptSkipped, true);
  assert.equal(r.accepted, 0);
  assert.equal(readFileSync(baselinePath(), 'utf8'), before);
  assert.equal(accepted(), 0);
});

// With nothing unticked there is nothing to ask, but the empty set is still all the call covers.
test('accept_rest with the empty set\'s fingerprint moves nothing unticked after it was taken', async () => {
  await writeReport({ targets: ['pages'], base: ROOT, out: report });
  const path = `${ROOT}/${report}`;
  const unticked = readFileSync(path, 'utf8');
  writeFileSync(path, unticked.replaceAll('- [ ]', '- [x]'));
  const rest = await restToAccept({ report });
  assert.equal(rest.items.length, 0);
  writeFileSync(path, unticked);
  const before = readFileSync(baselinePath(), 'utf8');
  const r = await applyReport({ report, acceptRest: true, restFingerprint: rest.fingerprint });
  assert.equal(r.acceptSkipped, true);
  assert.equal(r.accepted, 0);
  assert.equal(readFileSync(baselinePath(), 'utf8'), before);
  assert.equal(accepted(), 0);
});

test('accept_rest with the fingerprint of the findings it was asked about moves them', async () => {
  await writeReport({ targets: ['pages'], base: ROOT, out: report });
  const rest = await restToAccept({ report });
  const r = await applyReport({ report, acceptRest: true, restFingerprint: rest.fingerprint });
  assert.equal(r.acceptSkipped, false);
  assert.equal(r.accepted, rest.items.length);
  assert.equal(accepted(), rest.items.length);
});
