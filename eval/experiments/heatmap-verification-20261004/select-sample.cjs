// Fixed, diagnostic development sample. This does not change or rerun labels.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const directory = __dirname;
const root = path.resolve(directory, '../../..');
const reportPath = 'eval/experiments/content-438-optimization-20261004/all-markings.json';
const manifestPath = 'eval/benchmarks/content-438-v1/manifest.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const reportBytes = fs.readFileSync(path.join(root, reportPath));
const manifestBytes = fs.readFileSync(path.join(root, manifestPath));
// These existing files contain both splits. Discard validation entries before
// inspecting predictions, labels, metadata, or eligible sample counts.
const rows = JSON.parse(reportBytes).rows.filter(row => row.split === 'development');
const metadata = new Map(JSON.parse(manifestBytes).records
  .filter(row => row.split === 'development').map(row => [row.bvid, row]));
const ordered = rows.slice().sort((a, b) => hash(a.bvid).localeCompare(hash(b.bvid)));
const selected = new Set();
const videos = [];
const groups = {};
// Reserve the smaller wrong-keep stratum first so overlapping videos cannot
// consume it. Each video contributes exactly one selected candidate.
for (const status of ['wrong-keep', 'correct']) {
  const eligible = ordered.filter(row => row.versions.current.markings.some(mark => mark.status === status));
  const chosen = eligible.filter(row => !selected.has(row.bvid)).slice(0, 12);
  if (chosen.length !== 12) throw new Error(`Insufficient development videos for ${status}`);
  groups[status] = { eligibleVideos: eligible.length, selectedVideos: chosen.length };
  for (const row of chosen) {
    const meta = metadata.get(row.bvid);
    if (!meta || meta.cid !== row.cid) throw new Error(`Development identity mismatch: ${row.bvid}`);
    const index = row.versions.current.markings.findIndex(mark => mark.status === status);
    videos.push({
      bvid: row.bvid, cid: row.cid, duration: meta.duration, split: 'development',
      title: row.title, sampleOrderSha256: hash(row.bvid), selectedReason: status,
      selectedPredictionId: `${row.bvid}:current:${index}`,
      predictions: row.versions.current.markings.map((mark, predictionIndex) => ({
        predictionId: `${row.bvid}:current:${predictionIndex}`, predictionIndex,
        selectedForComparison: predictionIndex === index, ...mark
      }))
    });
    selected.add(row.bvid);
  }
}

const sample = {
  schemaVersion: 1,
  kind: 'development-only-stratified-heatmap-diagnostic',
  selection: {
    reportPath, reportSha256: hash(reportBytes), manifestPath, manifestSha256: hash(manifestBytes),
    version: 'current', developmentVideos: rows.length, perStratum: 12,
    order: 'Ascending sha256(bvid); wrong-keep first, then correct excluding selected videos; first matching prediction in existing order.',
    groups,
    thresholdsFrozenBeforeHeatmapFetch: [0.25, 0.5, 0.75],
    validationPredictionsInspected: false,
    labelFilesOpened: false,
    caveat: 'Outcome-stratified diagnostic sample; not a population estimate or a new benchmark. Existing labels only select/evaluate the sample and never enter a detector.'
  },
  videos,
  auxiliaryCases: [{
    bvid: 'BV1r1421r7am', cid: 1583131909, duration: 407,
    selectedReason: 'User-reported earlier false prompt; separate from the fixed 438 benchmark.',
    predictions: [
      { predictionId: 'BV1r1421r7am:historical-fp', start: 294.089, end: 326,
        status: 'historical-user-fp', selectedForComparison: false },
      { predictionId: 'BV1r1421r7am:current-anonymous-replay', start: 349.262, end: 370,
        status: 'current-anonymous-replay', selectedForComparison: false }
    ],
    caveat: 'The user previously corrected the real ad to about 351–372 seconds. Current logged-in input and the latest earlier prompt are not reproduced by this anonymous snapshot.'
  }]
};
fs.writeFileSync(path.join(directory, 'sample.json'), JSON.stringify(sample, null, 2) + '\n');
console.log(JSON.stringify({ videos: videos.length, groups, auxiliaryCases: sample.auxiliaryCases.length }));
