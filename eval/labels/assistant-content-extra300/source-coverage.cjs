#!/usr/bin/env node
'use strict';
// Descriptive source quality metadata only. No content inference or status edits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const base = __dirname;
const root = path.resolve(base, '../../..');
if (cp.execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() !== 'test-branch') throw Error('Write only on test-branch.');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const round = n => Number(n.toFixed(6));
const indexBytes = fs.readFileSync(path.join(base, 'source-index.json'));
const entries = JSON.parse(indexBytes).records;
const rows = entries.map(entry => {
  const sourceBytes = fs.readFileSync(path.join(base, 'sources', `${entry.bvid}.json`));
  const source = JSON.parse(sourceBytes);
  const record = JSON.parse(fs.readFileSync(path.join(base, 'records', `${entry.bvid}.json`))).record;
  const duration = source.duration;
  const subtitles = source.subtitles || [];
  const invalidTimeIndices = [];
  const valid = subtitles.map((row, index) => ({ row, index })).filter(({ row, index }) => {
    const okay = Number.isFinite(row.from) && Number.isFinite(row.to) && row.from >= 0 && row.to > row.from && row.to <= duration;
    if (!okay) invalidTimeIndices.push(index);
    return okay;
  });
  const nonempty = valid.filter(({ row }) => typeof row.content === 'string' && row.content.trim().length);
  const intervals = nonempty.map(({ row }) => [row.from, row.to]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const gaps = [];
  if (!merged.length) gaps.push({ from: 0, to: duration, seconds: duration, location: 'entire-video' });
  else {
    if (merged[0][0] > 0) gaps.push({ from: 0, to: merged[0][0], seconds: round(merged[0][0]), location: 'leading' });
    for (let i = 1; i < merged.length; i++) gaps.push({ from: merged[i - 1][1], to: merged[i][0], seconds: round(merged[i][0] - merged[i - 1][1]), location: 'internal' });
    if (merged.at(-1)[1] < duration) gaps.push({ from: merged.at(-1)[1], to: duration, seconds: round(duration - merged.at(-1)[1]), location: 'trailing' });
  }
  const covered = merged.reduce((sum, interval) => sum + interval[1] - interval[0], 0);
  const sortedGaps = [...gaps].sort((a, b) => b.seconds - a.seconds || a.from - b.from);
  return {
    inputLine: entry.inputLine, bvid: source.bvid, cid: source.cid, duration,
    sourceFile: path.relative(root, path.join(base, 'sources', `${entry.bvid}.json`)), sourceSha256: sha(sourceBytes),
    subtitleRows: subtitles.length, nonemptyValidSubtitleRows: nonempty.length, invalidTimeIndices,
    firstSubtitleFrom: valid.length ? Math.min(...valid.map(({ row }) => row.from)) : null,
    lastSubtitleTo: valid.length ? Math.max(...valid.map(({ row }) => row.to)) : null,
    firstNonemptySubtitleFrom: merged[0]?.[0] ?? null, lastNonemptySubtitleTo: merged.at(-1)?.[1] ?? null,
    nonemptySubtitleUnionSeconds: round(covered), nonemptySubtitleUnionFraction: duration > 0 ? round(covered / duration) : null,
    uncoveredSeconds: round(duration - covered), mergedNonemptyIntervalCount: merged.length,
    longestUncoveredInterval: sortedGaps[0] ?? null,
    longestInternalGap: sortedGaps.find(gap => gap.location === 'internal') ?? null,
    leadingGapSeconds: round(merged.length ? merged[0][0] : duration),
    trailingGapSeconds: round(merged.length ? duration - merged.at(-1)[1] : duration),
    largestTenUncoveredIntervals: sortedGaps.slice(0, 10),
    acquisition: { metadata: source.acquisition?.metadata, subtitles: source.acquisition?.subtitles, subtitleReason: source.acquisition?.subtitleReason },
    reviewSnapshot: { reviewStatus: record.reviewStatus, fullTranscriptRead: record.fullTranscriptRead }
  };
});
const report = {
  kind: 'assistant-content-subtitle-temporal-coverage', generatedAt: new Date().toISOString(), sourceIndexSha256: sha(indexBytes),
  scope: 'Descriptive temporal coverage of safe source subtitles only; no algorithm output, community labels, transcript text, advertisement inference or review-status changes.',
  definitions: {
    covered: 'Union of valid, nonempty subtitle time intervals. Overlaps count once. This measures timestamps, not intelligibility or actual viewing.',
    uncovered: 'Time outside that union. Includes silence, music, purely visual action, ASR omissions and missing source; the cause is not inferred.',
    emptySource: 'When no valid nonempty rows exist, the entire duration is uncovered. Leading and trailing gaps each report duration and are not additive.',
    interpretation: 'No threshold or fraction establishes completeness, advertisement presence/absence, or a completed review. Review snapshots are informational and can become stale.'
  },
  counts: { expected: entries.length, withNonemptySubtitles: rows.filter(row => row.nonemptyValidSubtitleRows).length, fullTranscriptRead: rows.filter(row => row.reviewSnapshot.fullTranscriptRead).length },
  records: rows
};
fs.writeFileSync(path.join(base, 'source-coverage.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.counts));
