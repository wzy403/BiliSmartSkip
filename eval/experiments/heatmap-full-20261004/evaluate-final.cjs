// Run only after a policy was locked using development. Scorer is imported unchanged.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadBenchmark } = require('../../content-benchmark.cjs');
const { loadProduction, runVideo } = require('../../runner.cjs');
const { assess, summarize } = require('../../compare-release-markings.cjs');
const { detectorInput, normalizeReplay } = require('../../evaluate-segments.cjs');
const directory = __dirname;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function main(sourceDir, outputFile = path.join(directory, 'all-comparison.json')) {
  const selection = JSON.parse(fs.readFileSync(path.join(directory, 'selection.json')));
  const verifierFile = path.resolve(sourceDir, 'heatmap-verifier.js');
  assert.equal(hash(fs.readFileSync(verifierFile)), selection.verifierSha256, 'Selected policy implementation changed');
  const verifier = require(verifierFile);
  assert.equal(verifier.DEFAULT_POLICY, selection.policy, 'Production policy must match locked selection');
  const benchmark = loadBenchmark();
  const acquisition = JSON.parse(fs.readFileSync(path.join(directory, 'acquisition.json')));
  const entries = new Map(acquisition.records.map(item => [item.bvid, item]));
  const versions = {
    '2.0.1': loadProduction('88652cdd6152f7652a7b21731d53c0942264ca86'),
    '2.1.0': loadProduction('3ce86faffab16a881640fc27dea5f53bf7b219ee'),
    before: loadProduction('b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963'), current: loadProduction(null, { sourceDir })
  };
  const rows = [], coverage = { usable: 0, unavailable: 0, durationChanged: 0 };
  for (const row of benchmark.rows) {
    const entry = entries.get(row.item.bvid);
    assert.equal(entry?.cid, row.item.cid, 'Heatmap identity mismatch');
    let heatmap = null;
    if (entry.sha256) {
      const bytes = fs.readFileSync(path.join(directory, 'responses', row.item.bvid + '.json'));
      assert.equal(hash(bytes), entry.sha256);
      if (entry.currentPageDuration !== undefined && entry.currentPageDuration !== row.source.duration) coverage.durationChanged++;
      else heatmap = JSON.parse(bytes);
    }
    coverage[verifier.parseCurve(heatmap, row.source.duration) ? 'usable' : 'unavailable']++;
    const scored = { bvid: row.item.bvid, cid: row.item.cid, split: row.item.split, title: row.source.title, versions: {} };
    for (const [version, production] of Object.entries(versions)) {
      const input = detectorInput(row.source);
      // Public aid is sidecar identity metadata, never a label or model feature.
      if (version === 'current') input.aid = entry.aid;
      const replay = normalizeReplay(input, await runVideo(input, production, version === 'current' ? { heatmap } : {}));
      scored.versions[version] = { ...assess(row.ref, replay.candidates, row.quality),
        automatic: assess(row.ref, replay.automaticSegments, row.quality),
        candidates: replay.candidates, automaticSegments: replay.automaticSegments, seekDestinations: replay.seekDestinations,
        detectionMs: replay.detectionMs };
    }
    rows.push(scored);
  }
  const grouped = {};
  for (const split of ['all', 'development', 'validation']) {
    const members = rows.filter(row => split === 'all' || row.split === split);
    grouped[split] = Object.fromEntries(Object.keys(versions).map(version => {
      const automatic = members.flatMap(row => row.versions[version].automatic.markings);
      return [version, { ...summarize(members, version),
        extraKeepSeconds: members.flatMap(row => row.versions[version].markings).reduce((n, mark) => n + mark.extraKeepSeconds, 0),
        automatic: { total: automatic.length, correct: automatic.filter(mark => mark.status === 'correct').length,
          wrongKeep: automatic.filter(mark => mark.status === 'wrong-keep').length } }];
    }));
  }
  const result = { kind: 'full-438-selected-heatmap-policy-replay', createdAt: new Date().toISOString(), selection,
    benchmarkSha256: benchmark.manifestSha256,
    evaluatorSha256: hash(fs.readFileSync(path.resolve(directory, '../../compare-release-markings.cjs'))),
    acquisitionSha256: hash(fs.readFileSync(path.join(directory, 'acquisition.json'))),
    versions: Object.fromEntries(Object.entries(versions).map(([name, production]) => [name,
      { commit: production.commit, sourceSha256: production.sourceSha256, codeSize: production.codeSize }])),
    coverage, grouped, rows };
  fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ coverage, grouped }, null, 2));
}
main(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
