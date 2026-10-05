// Identity/provenance/availability audit only; no labels or predictions read.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseCurve } = require('../heatmap-verification-20261004/analysis.cjs');
const { initialize, readStoredBytes } = require('./collect.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function verifyCollection() {
  // Includes frozen manifest and every stored response hash verification.
  const report = initialize();
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../benchmarks/content-438-v1/manifest.json')));
  const identities = new Map(manifest.records.map(({ bvid, cid, duration, split }) => [bvid, { cid, duration, split }]));
  const totals = { total: 0, fetched: 0, reused: 0, available: 0, unavailable: 0, flat: 0,
    incompleteOrError: 0, partialVideoCoverage: 0, changedPageDuration: 0 };
  const splits = {};
  const details = [];
  for (const record of report.records) {
    const identity = identities.get(record.bvid);
    if (!identity || identity.cid !== record.cid || identity.duration !== record.duration) throw new Error(`Identity mismatch: ${record.bvid}`);
    const counts = splits[identity.split] ||= Object.fromEntries(Object.keys(totals).map(key => [key, 0]));
    const count = key => { totals[key] += 1; counts[key] += 1; };
    count('total');
    if (!['complete', 'reused'].includes(record.status)) {
      count('incompleteOrError');
      details.push({ bvid: record.bvid, status: record.status, error: record.error ?? null });
      continue;
    }
    const endpoint = new URL(record.url);
    if (endpoint.origin !== 'https://bvc.bilivideo.com' || endpoint.pathname !== '/pbp/data'
      || endpoint.searchParams.get('bvid') !== record.bvid || endpoint.searchParams.get('cid') !== String(record.cid)
      || endpoint.searchParams.get('aid') !== String(record.aid) || endpoint.searchParams.get('r') !== 'loader'
      || !Number.isSafeInteger(record.aid) || record.metadataStatus !== 200 || record.heatStatus !== 200) {
      throw new Error(`PBP provenance mismatch: ${record.bvid}`);
    }
    if (record.metadataFile) {
      const metadata = JSON.parse(readStoredBytes(record, 'metadataFile'));
      if (metadata.code !== 0 || metadata.data?.aid !== record.aid
        || (metadata.data.bvid && metadata.data.bvid !== record.bvid)
        || !metadata.data.pages?.some(page => page.cid === record.cid)) throw new Error(`Metadata identity mismatch: ${record.bvid}`);
    } else if (record.status !== 'reused' || !record.reusedFrom) {
      throw new Error(`Unverifiable metadata provenance: ${record.bvid}`);
    }
    count(record.status === 'reused' ? 'reused' : 'fetched');
    const response = JSON.parse(fs.readFileSync(path.join(__dirname, record.responseFile)));
    const curve = parseCurve(response, record.duration);
    if (['available', 'unavailable', 'flat'].includes(curve.status)) count(curve.status);
    else count('incompleteOrError');
    const partial = Number.isFinite(curve.coveredUntil) && curve.coveredUntil < record.duration;
    if (partial) count('partialVideoCoverage');
    const durationChanged = Number.isFinite(record.currentPageDuration) && Math.abs(record.currentPageDuration - record.duration) > 2;
    if (durationChanged) count('changedPageDuration');
    if (curve.status !== 'available' || partial || durationChanged) {
      details.push({ bvid: record.bvid, status: curve.status, reason: curve.reason ?? null,
        partial, coveredUntil: curve.coveredUntil ?? null, frozenDuration: record.duration,
        currentPageDuration: record.currentPageDuration ?? null });
    }
  }
  return { schemaVersion: 1, kind: 'identity-and-coverage-only-pbp-audit',
    checkedAt: new Date().toISOString(), manifestSha256: report.manifestSha256,
    collectorSha256: sha(fs.readFileSync(path.join(__dirname, 'collect.cjs'))),
    acquisitionSha256: sha(fs.readFileSync(path.join(__dirname, 'acquisition.json'))),
    acquisitionStartedAt: report.capturedAt, acquisitionCompletedAt: report.completedAt ?? null,
    stoppedEarly: !!report.stoppedEarly, totals, splits, details,
    limits: 'Existing 24 responses retain original hashes/dates; their original view response bodies were not retained. No label/prediction inspection. Available curves still need candidate-specific coverage checks. Current curves are side data acquired after the frozen detector input snapshots.' };
}

if (require.main === module) {
  const result = verifyCollection();
  fs.writeFileSync(path.join(__dirname, 'collection-coverage.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ totals: result.totals, splits: result.splits, stoppedEarly: result.stoppedEarly }));
}
module.exports = { verifyCollection };
