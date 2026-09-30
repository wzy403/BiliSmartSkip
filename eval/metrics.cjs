const { createHash } = require('node:crypto');

function creatorKey(record) {
  const creator = record.creator;
  if (creator && typeof creator === 'object') {
    if (creator.mid != null || creator.id != null) return `id:${creator.mid ?? creator.id}`;
    if (creator.name) return `name:${String(creator.name).trim()}`;
  }
  return creator != null && String(creator).trim() ? `creator:${String(creator).trim()}` : 'unknown-creator';
}

function splitForCreator(record, holdoutPercent = 20, seed = 'bilismartskip-eval-v1') {
  const hash = createHash('sha256').update(`${seed}\0${creatorKey(record)}`).digest();
  return hash.readUInt32BE(0) / 0x100000000 < holdoutPercent / 100 ? 'holdout' : 'train';
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.map(r => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

const overlapSeconds = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const iou = (a, b) => overlapSeconds(a, b) / (Math.max(a.end, b.end) - Math.min(a.start, b.start));

function reviewedRanges(record) {
  if (record.annotations?.status !== 'reviewed') return [];
  return mergeRanges(record.annotations.reviewedRanges ?? [{ start: 0, end: record.duration }]);
}

// Maximum-cardinality one-to-one matching, preferring larger IoU on each augmenting path.
function matchSegments(predictions, truth, threshold) {
  const edges = predictions.map(prediction => truth.map((segment, index) => ({ index, iou: iou(prediction, segment) }))
    .filter(edge => edge.iou >= threshold).sort((a, b) => b.iou - a.iou || a.index - b.index));
  const truthOwners = new Map();
  const visit = (prediction, seen) => {
    for (const edge of edges[prediction]) {
      if (seen.has(edge.index)) continue;
      seen.add(edge.index);
      if (!truthOwners.has(edge.index) || visit(truthOwners.get(edge.index), seen)) {
        truthOwners.set(edge.index, prediction);
        return true;
      }
    }
    return false;
  };
  predictions.forEach((_, index) => visit(index, new Set()));
  return [...truthOwners].map(([truthIndex, predictionIndex]) => ({
    predictionIndex, truthIndex, iou: iou(predictions[predictionIndex], truth[truthIndex]),
    startError: predictions[predictionIndex].start - truth[truthIndex].start,
    endError: predictions[predictionIndex].end - truth[truthIndex].end
  }));
}

module.exports = { creatorKey, splitForCreator, mergeRanges, reviewedRanges, matchSegments };
