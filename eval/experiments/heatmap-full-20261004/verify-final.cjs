// Acceptance invariants, separate from the unchanged content scorer.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadBenchmark } = require('../../content-benchmark.cjs');
const { loadProduction, runVideo } = require('../../runner.cjs');
const { detectorInput, normalizeReplay } = require('../../evaluate-segments.cjs');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const withoutHeatEvidence = segments => segments.map(({ heatmapEvidence, ...segment }) => segment);
const key = segment => JSON.stringify([segment.start, segment.end, segment.source]);

async function main(sourceDir) {
  const report = read('all-comparison.json'), selection = read('selection.json');
  const release = read('../../benchmarks/content-438-v1/release-baselines.json');
  const dev = read('development-comparison.json');
  const benchmark = loadBenchmark();
  const production = loadProduction(null, { sourceDir });
  assert.equal(production.sourceSha256, report.versions.current.sourceSha256);
  assert.equal(benchmark.manifestSha256, report.benchmarkSha256);
  assert.equal(report.evaluatorSha256, release.evaluatorSha256);
  assert.equal(hash(fs.readFileSync(path.join(__dirname, 'development-comparison.json'))), selection.comparisonSha256);
  assert.equal(hash(fs.readFileSync(path.join(__dirname, 'POLICY-PLAN.txt'))), selection.policyPlanSha256);
  const frozenById = new Map(release.rows.map(row => [row.bvid, row]));
  const sourceById = new Map(benchmark.rows.map(row => [row.item.bvid, row]));
  const identities = new Map(read('acquisition.json').records.map(row => [row.bvid, row]));
  const removed = [];
  let correctRetained = 0, automaticUnchanged = 0, validationUnchanged = 0, fallbackUnchanged = 0;
  for (const row of report.rows) {
    for (const version of ['2.0.1', '2.1.0']) {
      for (const field of ['markings', 'boundaries', 'matched', 'allAdsCorrect', 'automaticSegments', 'seekDestinations']) {
        assert.deepEqual(row.versions[version][field], frozenById.get(row.bvid).versions[version][field], `${row.bvid} ${version} ${field}`);
      }
    }
    const before = row.versions.before, current = row.versions.current;
    const keepKeys = new Set(current.candidates.map(key));
    const remaining = before.candidates.filter(segment => keepKeys.has(key(segment)));
    assert.deepEqual(withoutHeatEvidence(current.candidates), remaining, `${row.bvid}: no additions or boundary changes`);
    assert.deepEqual(current.markings.filter(mark => mark.status === 'correct'), before.markings.filter(mark => mark.status === 'correct'), `${row.bvid}: all correct matches retained`);
    correctRetained += current.markings.filter(mark => mark.status === 'correct').length;
    for (const segment of before.candidates.filter(segment => !keepKeys.has(key(segment)))) {
      const mark = before.markings.find(mark => key(mark) === key(segment));
      assert.equal(mark.status, 'wrong-keep');
      assert.equal(segment.requiresConfirmation, true);
      assert.equal(segment.source, 'danmaku-keywords');
      assert.equal(row.split, 'development');
      removed.push({ bvid: row.bvid, ...mark });
    }
    assert.deepEqual(withoutHeatEvidence(current.automaticSegments), before.automaticSegments, `${row.bvid}: automatic boundaries unchanged`);
    assert.deepEqual(current.seekDestinations, before.seekDestinations, `${row.bvid}: actual seeks unchanged`);
    automaticUnchanged += current.automaticSegments.length;
    if (row.split === 'validation') {
      assert.deepEqual(current.markings, before.markings);
      assert.deepEqual(current.boundaries, before.boundaries);
      validationUnchanged++;
    }
    const input = detectorInput(sourceById.get(row.bvid).source);
    input.aid = identities.get(row.bvid).aid;
    const fallback = normalizeReplay(input, await runVideo(input, production, { heatmap: null }));
    for (const field of ['candidates', 'automaticSegments', 'seekDestinations']) {
      assert.deepEqual(fallback[field], before[field], `${row.bvid}: missing-heatmap fallback ${field}`);
    }
    fallbackUnchanged++;
  }
  assert.equal(removed.length, 4);
  assert.equal(correctRetained, 113);
  assert.equal(automaticUnchanged, 97);
  assert.equal(validationUnchanged, 25);
  assert.equal(fallbackUnchanged, 438);
  for (const field of ['correctMarkings', 'totalMarkings', 'wrongKeepMarkings', 'partialOrBoundary', 'unknown', 'videosWithAllAdsCorrect']) {
    assert.equal(report.grouped.development.current[field], dev.grouped[selection.policy][field], `final replay matches selected development ${field}`);
  }
  const result = { checkedAt: new Date().toISOString(), sourceSha256: production.sourceSha256,
    reportSha256: hash(fs.readFileSync(path.join(__dirname, 'all-comparison.json'))),
    benchmarkSha256: benchmark.manifestSha256, scorerUnchanged: true,
    releaseRowsReproduced: 438, correctRetained, automaticUnchanged, validationUnchanged,
    missingHeatmapFallbackUnchanged: fallbackUnchanged, removed,
    extraKnownKeepSecondsRemoved: removed.reduce((n, mark) => n + mark.extraKeepSeconds, 0),
    note: 'Removed manual prompts only; known-keep seconds are potential marked overlap, not automatically saved viewing time.' };
  fs.writeFileSync(path.join(__dirname, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
