// Interval-level evaluation: a shorter prediction must not masquerade as better recall.
// Only explicitly labelled seconds are scored; unknown time is never a negative.
const { mergeRanges, matchSegments } = require('./metrics.cjs');
const { normalizeSegment } = require('./labels/semantics.js');

const seconds = ranges => ranges.reduce((sum, range) => sum + range.end - range.start, 0);
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const intersection = (a, b) => a.reduce((total, x) => total + b.reduce((sum, y) => sum + overlap(x, y), 0), 0);

function validRange(range, duration) {
  return range && Number.isFinite(range.start) && Number.isFinite(range.end)
    && range.start >= 0 && range.end > range.start && range.end <= duration;
}

function coverage(labels, predictions, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid duration');
  for (const range of [...labels, ...predictions]) {
    if (!validRange(range, duration)) throw new Error('Invalid interval');
  }
  // Uncertain boundaries can still supply known ad/normal interior seconds, but
  // never full-boundary metrics. Match the training exclusion band at both ends.
  const normalized = labels.map(normalizeSegment);
  const eligible = normalized.filter(label => label.skipConfidence === 'high' && ['skip', 'keep'].includes(label.skipDecision))
    .map(label => label.boundaryConfidence === 'high' ? label : { ...label, start: label.start + 5, end: label.end - 5 })
    .filter(label => label.end > label.start);
  const ads = mergeRanges(eligible.filter(label => label.skipDecision === 'skip'));
  const normal = mergeRanges(eligible.filter(label => label.skipDecision === 'keep'));
  const boundedAds = mergeRanges(eligible.filter(label => label.skipDecision === 'skip' && label.boundaryConfidence === 'high'));
  if (intersection(ads, normal) > 0) throw new Error('Contradictory skip/keep labels (legacy ad/normal)');
  const predicted = mergeRanges(predictions);
  const labelledAdSeconds = seconds(ads), labelledNormalSeconds = seconds(normal);
  const coveredAdSeconds = intersection(ads, predicted);
  const coveredNormalSeconds = intersection(normal, predicted);
  const matches = matchSegments(predicted, boundedAds, 0.1);
  return {
    target: 'skipDecision',
    labelledAdSeconds, labelledNormalSeconds, coveredAdSeconds,
    missedAdSeconds: labelledAdSeconds - coveredAdSeconds,
    coveredNormalSeconds,
    unlabelledPredictionSeconds: Math.max(0, seconds(predicted) - coveredAdSeconds - coveredNormalSeconds),
    adSegments: boundedAds.length,
    // Count continuous intervals covering at least 90% of the ad; separate from seconds recall.
    substantiallyCoveredAds: boundedAds.filter(ad => predicted.some(p => overlap(ad, p) >= 0.9 * (ad.end - ad.start))).length,
    boundaryMatches: matches.map(match => ({
      ...match, ad: boundedAds[match.truthIndex], predicted: predicted[match.predictionIndex]
    }))
  };
}

function aggregateCoverage(results) {
  const fields = ['labelledAdSeconds', 'labelledNormalSeconds', 'coveredAdSeconds', 'missedAdSeconds',
    'coveredNormalSeconds', 'unlabelledPredictionSeconds', 'adSegments', 'substantiallyCoveredAds'];
  const totals = Object.fromEntries(fields.map(field => [field, results.reduce((sum, result) => sum + result[field], 0)]));
  const matches = results.flatMap(result => result.boundaryMatches);
  const mean = values => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  const tp = totals.coveredAdSeconds, fp = totals.coveredNormalSeconds;
  const fn = totals.missedAdSeconds, tn = Math.max(0, totals.labelledNormalSeconds - fp);
  const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
  return {
    ...totals,
    target: 'skipDecision',
    legacyFieldNames: 'ad means should skip; normal means should keep, not a claim about commercial content',
    skipMetrics: {
      target: 'skipDecision', unit: 'seconds', knownSeconds: tp + fp + fn + tn,
      truePositiveSeconds: tp, falsePositiveSeconds: fp, falseNegativeSeconds: fn, trueNegativeSeconds: tn,
      precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn),
      accuracy: ratio(tp + tn, tp + fp + fn + tn), specificity: ratio(tn, tn + fp),
      unknownPredictionSeconds: totals.unlabelledPredictionSeconds
    },
    adSecondsRecall: totals.labelledAdSeconds ? totals.coveredAdSeconds / totals.labelledAdSeconds : null,
    labelledSecondsPrecision: totals.coveredAdSeconds + totals.coveredNormalSeconds
      ? totals.coveredAdSeconds / (totals.coveredAdSeconds + totals.coveredNormalSeconds) : null,
    normalSecondsCoverageRate: totals.labelledNormalSeconds ? totals.coveredNormalSeconds / totals.labelledNormalSeconds : null,
    ad90CoverageRate: totals.adSegments ? totals.substantiallyCoveredAds / totals.adSegments : null,
    boundaryErrors: {
      matches: matches.length,
      meanAbsoluteStartSeconds: mean(matches.map(m => Math.abs(m.startError))),
      meanAbsoluteEndSeconds: mean(matches.map(m => Math.abs(m.endError))),
      meanSignedStartSeconds: mean(matches.map(m => m.startError)),
      meanSignedEndSeconds: mean(matches.map(m => m.endError))
    }
  };
}

module.exports = { validRange, coverage, aggregateCoverage };
