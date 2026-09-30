'use strict';
// Label validation and corpus split policy are independent of model training.
const { normalizeSegment } = require('./semantics.js');
const { splitForCreator } = require('../metrics.cjs');
const key = record => `${record.bvid}:${record.cid}`;

function validateLabels(document) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.records)
    || !['assistant-provisional', 'human-review', 'mixed-provisional-and-human-review'].includes(document.kind)) throw new Error('Unsupported label document');
  const identities = new Set();
  for (const record of document.records) {
    if (!record.bvid || !record.cid || !Array.isArray(record.segments)) throw new Error('Label records require bvid, cid and segments');
    if (identities.has(key(record))) throw new Error(`Duplicate label record identity: ${key(record)}`);
    identities.add(key(record));
    if (document.kind === 'human-review' && (!Number.isFinite(record.duration) || record.duration <= 0)) throw new Error(`Human review duration required: ${key(record)}`);
    for (const segment of record.segments) {
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)
        || segment.start < 0 || segment.end <= segment.start) throw new Error(`Invalid label interval: ${key(record)}`);
      if (document.kind === 'human-review') {
        if (Object.hasOwn(segment, 'label') && !['ad', 'normal', 'uncertain'].includes(segment.label)) throw new Error('Unknown human review label');
        if (segment.origin !== 'human') throw new Error('Human review segments must have origin human');
        if (segment.end > record.duration) throw new Error(`Human review interval outside duration: ${key(record)}`);
      }
      normalizeSegment(segment); // Validate either schema without mutating the source document.
    }
  }
}

function splitOf(record, label) {
  const declared = [record.evaluationSplit?.split, typeof record.evaluationSplit === 'string' ? record.evaluationSplit : null,
    record.split].filter(Boolean);
  const corpusSplit = declared[0] || splitForCreator(record);
  return declared.includes('holdout') || label?.split === 'holdout' || corpusSplit === 'holdout' ? 'holdout' : corpusSplit;
}

module.exports = { validateLabels, splitOf };
