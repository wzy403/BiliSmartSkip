// Frozen content scoring with a finite, predeclared heatmap policy comparison.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadBenchmark } = require('../../content-benchmark.cjs');
const { loadProduction } = require('../../runner.cjs');
const { assess, summarize } = require('../../compare-release-markings.cjs');
const { detectorInput } = require('../../evaluate-segments.cjs');
const dir = __dirname;
const sourceDir = process.argv[2];
if (!sourceDir) throw Error('Supply the production scr directory');
const verifier = require(path.resolve(sourceDir, 'heatmap-verifier.js'));
const saved = JSON.parse(fs.readFileSync(path.join(dir, 'development-replay.json')));
const replayById = new Map(saved.rows.map(row => [row.bvid, row]));
const benchmark = loadBenchmark();
if (saved.benchmarkSha256 !== benchmark.manifestSha256) throw Error('Frozen benchmark changed');
const acquisition = JSON.parse(fs.readFileSync(path.join(dir, 'acquisition.json')));
const records = new Map(acquisition.records.map(row => [row.bvid, row]));
const hash = value => createHash('sha256').update(value).digest('hex');
const h = loadProduction('b25cfdfdaa6dd18b8683c5aaf8cacacdc7c84963').createHarness();
const helpers = { getSubtitleEvidence: h.context.getSubtitleEvidence };
const policyNames = Object.keys(verifier.POLICIES);
const rows = [], decisions = [];
const incomplete = [];
for (const row of benchmark.rows.filter(row => row.item.split === 'development')) {
  const previous = replayById.get(row.item.bvid);
  if (!previous || previous.cid !== row.item.cid) throw Error('Replay identity mismatch');
  const entry = records.get(row.item.bvid);
  if (!entry || entry.cid !== row.item.cid) throw Error('Acquisition identity mismatch');
  let heatmap = null, unavailableReason = entry.error || entry.status;
  const responseFile = path.join(dir, 'responses', row.item.bvid + '.json');
  if (entry.sha256 && fs.existsSync(responseFile)) {
    const bytes = fs.readFileSync(responseFile);
    if (hash(bytes) !== entry.sha256) throw Error('Heatmap snapshot hash mismatch');
    // Different current video length means the newly observed heatmap is not
    // safely aligned to the fixed content snapshot; keep original decisions.
    if (entry.currentPageDuration !== undefined && entry.currentPageDuration !== row.source.duration) unavailableReason = 'duration-changed';
    else heatmap = JSON.parse(bytes);
  } else if (!entry.error && !['complete', 'completed', 'reused', 'failed'].includes(entry.status)) {
    incomplete.push(row.item.bvid);
  }
  const scored = { bvid: row.item.bvid, cid: row.item.cid, title: row.source.title, split: 'development', versions: {} };
  const inputs = detectorInput(row.source);
  for (const policy of policyNames) {
    const result = verifier.verify(previous.replay.candidates, inputs, heatmap, policy, helpers);
    const automaticSegments = result.segments.filter(segment => segment.requiresConfirmation === false
      && previous.replay.automaticSegments.some(item => item.start === segment.start && item.end === segment.end));
    scored.versions[policy] = { ...assess(row.ref, result.segments, row.quality),
      automatic: assess(row.ref, automaticSegments, row.quality), automaticSegments };
    if (policy !== 'off') decisions.push({ bvid: row.item.bvid, policy, available: result.available,
      unavailableReason: result.available ? null : unavailableReason || 'no-usable-curve', decisions: result.decisions });
  }
  rows.push(scored);
}
if (incomplete.length) throw Error(`Acquisition still pending for ${incomplete.length} development videos`);
const grouped = Object.fromEntries(policyNames.map(policy => {
  const summary = summarize(rows, policy);
  const auto = rows.flatMap(row => row.versions[policy].automatic.markings);
  return [policy, { ...summary,
    extraKeepSeconds: rows.flatMap(row => row.versions[policy].markings).reduce((n, m) => n + m.extraKeepSeconds, 0),
    automatic: { count: auto.length, correct: auto.filter(m => m.status === 'correct').length,
      wrongKeep: auto.filter(m => m.status === 'wrong-keep').length } }];
}));
const report = { kind: 'development-heatmap-policy-comparison', benchmarkSha256: benchmark.manifestSha256,
  verifierSha256: hash(fs.readFileSync(path.resolve(sourceDir, 'heatmap-verifier.js'))),
  planSha256: hash(fs.readFileSync(path.join(dir, 'POLICY-PLAN.txt'))),
  acquisitionSha256: hash(fs.readFileSync(path.join(dir, 'acquisition.json'))),
  scope: 'development', note: 'Automatic results here are retained baseline intervals; final selected policy requires full real-player seek replay.',
  grouped, rows, decisions };
fs.writeFileSync(path.join(dir, 'development-comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(grouped, null, 2));
