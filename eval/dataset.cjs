'use strict';
// Shared corpus input and availability checks; no detector or evaluation runtime dependencies.
const fs = require('node:fs');
const path = require('node:path');
const { reviewedRanges } = require('./metrics.cjs');

function inputFiles(input) {
  if (!fs.statSync(input).isDirectory()) return [input];
  return fs.readdirSync(input, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? inputFiles(path.join(input, entry.name))
      : /\.(json|jsonl)$/i.test(entry.name) && entry.name !== 'collection-summary.json' ? [path.join(input, entry.name)] : []);
}

function readDataset(input) {
  const records = [];
  for (const filename of inputFiles(path.resolve(input))) {
    const text = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.jsonl')) {
      text.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        try { records.push(JSON.parse(line)); }
        catch (error) { throw new Error(`${filename}:${index + 1}: ${error.message}`); }
      });
    } else {
      const value = JSON.parse(text);
      records.push(...(Array.isArray(value) ? value : Array.isArray(value.videos) ? value.videos : [value]));
    }
  }
  return records;
}

function validateRecord(record) {
  if (!record || typeof record.bvid !== 'string' || !record.bvid || !record.cid) throw new Error('bvid and cid are required');
  if (!Number.isFinite(record.duration) || record.duration <= 0) throw new Error('duration must be positive seconds');
  for (const key of ['subtitles', 'danmaku', 'chapters', 'references']) {
    if (record[key] != null && !Array.isArray(record[key])) throw new Error(`${key} must be an array`);
  }
  const annotations = record.annotations;
  if (annotations && !['unreviewed', 'reviewed'].includes(annotations.status)) throw new Error('unknown annotations.status');
  if (annotations?.status === 'reviewed' && !Array.isArray(annotations.segments)) {
    throw new Error('reviewed annotations must explicitly provide segments (possibly [])');
  }
  for (const key of ['segments', 'reviewedRanges']) {
    if (annotations?.[key] != null && !Array.isArray(annotations[key])) throw new Error(`annotations.${key} must be an array`);
    for (const segment of annotations?.[key] || []) {
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)
        || segment.start < 0 || segment.end <= segment.start || segment.end > record.duration) {
        throw new Error(`invalid annotations.${key} interval`);
      }
    }
  }
  if (annotations?.status === 'reviewed' && annotations.reviewedRanges != null) {
    const ranges = reviewedRanges(record);
    for (const segment of annotations.segments) {
      if (!ranges.some(range => segment.start >= range.start && segment.end <= range.end)) {
        throw new Error(`annotations.segments interval [${segment.start}, ${segment.end}] must be fully contained in the reviewedRanges union; extend the reviewed ranges or leave the record unreviewed`);
      }
    }
  }
}

function sourceAvailability(record) {
  const sourceStatus = {};
  for (const source of ['metadata', 'danmaku', 'chapters', 'subtitles']) {
    sourceStatus[source] = record.acquisition?.[source]
      || (source === 'metadata' || Array.isArray(record[source]) ? 'provided' : 'not-provided');
  }
  const replayEligible = !record.acquisition
    || (sourceStatus.metadata === 'available' && sourceStatus.danmaku === 'available');
  return {
    acquisition: record.acquisition || null, sourceStatus, replayEligible,
    sourcesAvailable: Object.keys(sourceStatus).filter(source => ['available', 'provided'].includes(sourceStatus[source])),
    replayProfile: record.subtitles?.length ? 'provided-source replay including subtitles' : 'danmaku/public-source replay',
    incompleteReason: replayEligible ? null : 'metadata or danmaku acquisition was not available'
  };
}

module.exports = { readDataset, validateRecord, sourceAvailability };
