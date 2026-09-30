'use strict';
// Timing summaries for local replay measurements.

function stats(values) {
  if (!values.length) return { samples: 0, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}

module.exports = { stats };
