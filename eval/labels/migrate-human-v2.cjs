#!/usr/bin/env node
'use strict';
// A versioned interpretation of this specific user's notes, not a text classifier.
// Keep the browser export immutable and do not extend any reviewed interval.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeSegment } = require('./semantics.js');
const { mergeRanges } = require('../metrics.cjs');
const SOURCE_SHA = '781ba87a6e8328873ce68467778d224389e4844a9faf1f44856938cfbb064ba9';
const sourcePath = path.join(__dirname, 'human/review-2026-09-30-v1.json');
const outputPath = path.join(__dirname, 'human/review-2026-09-30-v2.json');
const hash = value => createHash('sha256').update(value).digest('hex');

function migrate(sourceText) {
  if (hash(sourceText) !== SOURCE_SHA) throw new Error('This migration only applies to the frozen v1 human export');
  const input = JSON.parse(sourceText), output = structuredClone(input);
  output.labelSemantics = 'content-and-skip-v2';
  output.semanticMigration = {
    source: 'review-2026-09-30-v1.json', sourceBytesSha256: SOURCE_SHA,
    interpreter: 'assistant', authorization: 'User requested separate content type and skip decision using their saved notes.',
    scope: 'Existing reviewed ranges only; no whole-video or unreviewed-range expansion.',
    boundaryMeaning: 'Confidence in the selected skip/keep decision range, not verification of the full visual commercial boundary.',
    policy: 'An advertisement may be kept. Training and skip evaluation use skipDecision; notes are not parsed at runtime.'
  };
  let explicitNoteSegments = 0;
  for (const record of output.records) {
    record.segments = record.segments.map(original => {
      let contentType = original.label === 'ad' ? 'ad' : 'uncertain';
      let contentConfidence = contentType === 'ad' ? original.confidence : 'uncertain';
      let skipDecision = { ad: 'skip', normal: 'keep', uncertain: 'uncertain' }[original.label];
      let skipConfidence = original.confidence;
      let boundaryConfidence = original.boundaryConfidence;
      let basis = 'Existing human button confirmation establishes skip/keep only; legacy normal does not prove non-commercial content.';
      let note = null;
      // The user's whole-video wording establishes a commercial theme for these
      // two already-reviewed ranges, but does not create any additional range.
      if (record.bvid === 'BV1JucQzwEiP') {
        const quoted = record.segments.find(s => s.reason.includes('这是软广整个视频都是在介绍商品'))?.reason;
        if (!quoted || original.label !== 'normal') throw new Error('Product-theme note/decision changed');
        contentType = 'ad'; contentConfidence = 'high'; skipDecision = 'keep'; skipConfidence = 'high';
        note = '这是软广整个视频都是在介绍商品这种算正常不算需要跳过的广告';
        basis = 'User explicitly identified a product-theme soft advertisement that should be kept; applies only to existing reviewed ranges.';
      }
      if (record.bvid === 'BV1F44izREmT' && original.start === 0.4 && original.end === 44.09) {
        if (!original.reason.includes('该视频不是广告只是一个课程的第一个视频介绍这个教学课程')) throw new Error('Course note changed');
        contentType = 'non_ad'; contentConfidence = 'high'; skipDecision = 'keep'; skipConfidence = 'high';
        note = original.reason;
        basis = 'User explicitly says this is an introduction to the course itself, not an advertisement.';
      }
      if (record.bvid === 'BV1TnVb6bEwG' && original.start === 0.08 && original.end === 2.4) {
        if (!original.reason.includes('单句声明单列，可不用跳过')) throw new Error('Short sponsorship note changed');
        contentType = 'ad'; contentConfidence = 'high'; skipDecision = 'keep'; skipConfidence = 'high';
        boundaryConfidence = 'high'; note = original.reason;
        basis = 'User says this isolated sponsorship statement may be kept. The selected 0.08–2.40 s range is explicitly kept; this does not assert verification of the complete visual advertisement boundary.';
      }
      if (note) explicitNoteSegments++;
      return normalizeSegment({ ...original, contentType, contentConfidence, skipDecision, skipConfidence, boundaryConfidence,
        semanticMigration: { interpreter: 'assistant', basis, ...(note ? { userNote: note } : {}),
          original: { label: original.label, confidence: original.confidence, boundaryConfidence: original.boundaryConfidence } } });
    });
    record.reviewedRanges = mergeRanges(record.segments.filter(s => s.skipConfidence === 'high' && s.skipDecision !== 'uncertain'));
    const ranges = record.reviewedRanges;
    record.status = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === record.duration ? 'reviewed' : ranges.length ? 'partial' : 'unreviewed';
  }
  if (explicitNoteSegments !== 4) throw new Error('Expected exactly four note interpretations');
  return output;
}

if (require.main === module) {
  const output = migrate(fs.readFileSync(sourcePath, 'utf8'));
  const text = JSON.stringify(output, null, 2) + '\n';
  if (fs.existsSync(outputPath)) {
    if (fs.readFileSync(outputPath, 'utf8') !== text) throw new Error('Refusing to overwrite a different v2 snapshot');
  } else fs.writeFileSync(outputPath, text, { flag: 'wx' });
  console.log(JSON.stringify({ output: outputPath, bytesSha256: hash(text), videos: output.records.length,
    segments: output.records.flatMap(r => r.segments).length }, null, 2));
}
module.exports = { migrate, SOURCE_SHA };
