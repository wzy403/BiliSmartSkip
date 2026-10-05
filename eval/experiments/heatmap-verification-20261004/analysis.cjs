// Offline hypothesis check only. No detector, label rewrite, or validation read.
const fs = require('node:fs');
const path = require('node:path');

const THRESHOLDS = [0.25, 0.5, 0.75];
const round = n => Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};

function parseCurve(response, duration) {
  // This is the schema actually observed on the public page's PBP request.
  // Do not reinterpret unrelated payloads or guessed wrappers as a curve.
  if (response?.code !== undefined && response.code !== 0) return { status: 'api-error', code: response.code };
  const modules = response?.modules;
  if (!Array.isArray(modules)) return { status: 'invalid-schema' };
  const pbp = modules.filter(module => module?.name === 'pbp');
  if (pbp.length !== 1) return { status: 'missing-or-ambiguous-pbp-module' };
  const data = pbp[0]?.params?.data;
  const step = data?.step_sec, values = data?.events?.default;
  if (data && (!Array.isArray(values) || values.length === 0)) {
    let reason = 'no-default-events';
    try { reason = JSON.parse(data.debug)?.err_msg || reason; } catch (_) {}
    return { status: 'unavailable', reason };
  }
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(step) || step <= 0
    || !Array.isArray(values) || !values.length
    || values.some(value => !Number.isFinite(value) || value < 0)) return { status: 'invalid-data' };
  const bins = values.map((value, index) => ({ start: index * step, end: Math.min((index + 1) * step, duration), value }))
    .filter(bin => bin.start < duration);
  if (!bins.length) return { status: 'invalid-data' };
  const validValues = bins.map(bin => bin.value);
  const minimum = Math.min(...validValues), maximum = Math.max(...validValues);
  return {
    status: maximum === minimum ? 'flat' : 'available', step, bins,
    coveredUntil: bins.at(-1).end,
    video: { bins: bins.length, minimum, maximum,
      mean: round(mean(validValues)), median: round(quantile(validValues, 0.5)),
      p25: round(quantile(validValues, 0.25)), p75: round(quantile(validValues, 0.75)),
      p90: round(quantile(validValues, 0.9)) }
  };
}

function windowMetrics(curve, start, end) {
  if (!curve.bins || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  const overlapping = curve.bins.filter(bin => bin.start < end && bin.end > start);
  if (!overlapping.length) return null;
  const weighted = overlapping.map(bin => ({ value: bin.value,
    seconds: Math.max(0, Math.min(end, bin.end) - Math.max(start, bin.start)) }));
  const seconds = weighted.reduce((sum, bin) => sum + bin.seconds, 0);
  const maximum = Math.max(...overlapping.map(bin => bin.value));
  const average = weighted.reduce((sum, bin) => sum + bin.value * bin.seconds, 0) / seconds;
  const percentile = value => curve.bins.filter(bin => bin.value <= value).length / curve.bins.length;
  return {
    start, end, bins: overlapping.length, coveredSeconds: round(seconds),
    coverageFraction: round(seconds / (end - start)),
    maximum, mean: round(average),
    maxRelativeToVideoMax: curve.video.maximum > 0 ? round(maximum / curve.video.maximum) : null,
    meanRelativeToVideoMax: curve.video.maximum > 0 ? round(average / curve.video.maximum) : null,
    maxVideoPercentile: round(percentile(maximum)), meanVideoPercentile: round(percentile(average))
  };
}

function measureCandidate(curve, prediction, duration) {
  const interval = windowMetrics(curve, prediction.start, prediction.end);
  const endWindow = windowMetrics(curve, Math.max(0, prediction.end - 10), Math.min(duration, prediction.end + 10));
  const decisionAvailable = curve.status === 'available' && !!interval
    && curve.coveredUntil >= prediction.end && prediction.end <= duration;
  // Exactly-at-threshold candidates are retained. Missing/flat/partial curves
  // cannot reject a candidate; diagnostics never become an inferred zero heat.
  const rejectAtThreshold = Object.fromEntries(THRESHOLDS.map(threshold => [String(threshold),
    !!decisionAvailable && interval.maximum / curve.video.maximum < threshold]));
  return {
    ...prediction, interval, endWindow, decisionAvailable,
    abstentionReason: decisionAvailable ? null : curve.status !== 'available' ? curve.status : 'partial-or-invalid-interval',
    rejectAtThreshold
  };
}

function summarizeMetrics(predictions) {
  const summary = {};
  for (const window of ['interval', 'endWindow']) {
    summary[window] = {};
    for (const metric of ['maxRelativeToVideoMax', 'meanRelativeToVideoMax', 'maxVideoPercentile', 'meanVideoPercentile']) {
      const values = predictions.filter(item => item.decisionAvailable)
        .map(item => item[window]?.[metric]).filter(Number.isFinite);
      summary[window][metric] = { count: values.length, mean: round(mean(values)), median: round(quantile(values, 0.5)),
        p25: round(quantile(values, 0.25)), p75: round(quantile(values, 0.75)) };
    }
  }
  return summary;
}

function analyze(sample, responsesDirectory) {
  if (sample.selection.thresholdsFrozenBeforeHeatmapFetch.join(',') !== THRESHOLDS.join(',')) {
    throw new Error('Predeclared thresholds changed');
  }
  const inspectVideo = (record, auxiliary = false) => {
    if (!auxiliary && record.split !== 'development') throw new Error(`Refuse non-development record: ${record.bvid}`);
    let curve;
    try {
      curve = parseCurve(JSON.parse(fs.readFileSync(path.join(responsesDirectory, `${record.bvid}.json`))), record.duration);
    } catch (error) {
      curve = { status: error.code === 'ENOENT' ? 'missing' : 'unreadable-response' };
    }
    const { bins, ...curveSummary } = curve;
    return { bvid: record.bvid, cid: record.cid, duration: record.duration,
      selectedReason: record.selectedReason, auxiliary, curve: curveSummary,
      predictions: record.predictions.map(prediction => measureCandidate(curve, prediction, record.duration)) };
  };
  const videos = sample.videos.map(record => inspectVideo(record));
  const auxiliaryCases = (sample.auxiliaryCases || []).map(record => inspectVideo(record, true));
  const selected = videos.flatMap(video => video.predictions.filter(prediction => prediction.selectedForComparison)
    .map(prediction => ({ bvid: video.bvid, ...prediction })));
  if (selected.length !== 24 || new Set(videos.map(video => video.bvid)).size !== 24) throw new Error('Expected 24 unique selected videos');
  const groups = {};
  for (const status of ['correct', 'wrong-keep']) {
    const predictions = selected.filter(prediction => prediction.status === status);
    if (predictions.length !== 12) throw new Error(`Expected 12 ${status} candidates`);
    groups[status] = {
      sampled: predictions.length, decisionAvailable: predictions.filter(item => item.decisionAvailable).length,
      unavailableKept: predictions.filter(item => !item.decisionAvailable).length,
      metrics: summarizeMetrics(predictions),
      thresholds: Object.fromEntries(THRESHOLDS.map(threshold => {
        const filtered = predictions.filter(item => item.rejectAtThreshold[String(threshold)]);
        return [String(threshold), { filtered: filtered.length, retained: predictions.length - filtered.length,
          filteredPredictionIds: filtered.map(item => item.predictionId) }];
      }))
    };
  }
  return {
    schemaVersion: 1, kind: 'development-only-heatmap-hypothesis-analysis',
    policy: {
      evaluatedCandidates: 'Exactly one preselected current candidate per sampled development video, 12 correct and 12 wrong-keep.',
      rejection: 'Candidate interval maximum / whole-video maximum is strictly below the fixed threshold.',
      thresholds: THRESHOLDS, endWindowSeconds: 10,
      binConvention: 'Exploratory approximation: treat each events.default sample as a flat window [i * step_sec, (i + 1) * step_sec), clipped to duration. This is not a reconstruction of the smoothed player graphic.',
      mean: 'Overlap-duration-weighted within the candidate interval; percentile is the fraction of video bins <= the statistic.',
      missingPolicy: 'Missing, invalid, flat, or incomplete candidate coverage is retained (abstain).',
      limits: [
        'Stratified small diagnostic sample, not an estimate of population precision or recall.',
        'Published curve semantics and collection dates may differ from viewer seek activity and stored detector inputs.',
        'The player renders normalized points; nominal step windows here do not verify frame-accurate ad boundaries.',
        'The ending ±10 second window is descriptive only, not used to select or tune the rejection thresholds.',
        'Auxiliary user cases are displayed separately and excluded from correct/wrong-keep totals.',
        'No production code, fixed labels, evaluator, or validation predictions are changed or run.'
      ]
    },
    groups, videos, auxiliaryCases
  };
}

if (require.main === module) {
  const directory = __dirname;
  const sample = JSON.parse(fs.readFileSync(path.join(directory, 'sample.json')));
  const result = analyze(sample, process.argv[2] ? path.resolve(process.argv[2]) : path.join(directory, 'responses'));
  fs.writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result.groups).map(([status, group]) => [status,
    { sampled: group.sampled, decisionAvailable: group.decisionAvailable, unavailableKept: group.unavailableKept,
      filtered: Object.fromEntries(Object.entries(group.thresholds).map(([threshold, values]) => [threshold, values.filtered])) }
  ]))));
}

module.exports = { parseCurve, windowMetrics, measureCandidate, analyze };
