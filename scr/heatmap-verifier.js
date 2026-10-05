// Optional, bounded corroboration of existing ad candidates. No boundary inference.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BiliHeatmapVerifier = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_POLICY = 'keyword-context-25';
  const POLICIES = Object.freeze({
    'off': { kind: 'off' },
    'cold-25': { kind: 'cold', threshold: 0.25 },
    'cold-50': { kind: 'cold', threshold: 0.5 },
    'weighted-25': { kind: 'weighted', threshold: 0.25 },
    'weighted-50': { kind: 'weighted', threshold: 0.5 },
    'weighted-50-review': { kind: 'weighted', threshold: 0.5, reviewColdAuto: true },
    'keyword-context-25': { kind: 'context', threshold: 0.25 }
  });

  function parseCurve(response, duration) {
    if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(response?.modules)) return null;
    const modules = response.modules.filter(module => module?.name === 'pbp');
    if (modules.length !== 1) return null;
    const data = modules[0]?.params?.data, values = data?.events?.default, step = data?.step_sec;
    if (!Number.isFinite(step) || step <= 0 || !Array.isArray(values) || values.length < 2
      || values.length > 10000 || values.length * step < duration
      || values.some(value => !Number.isFinite(value) || value < 0)) return null;
    const maximum = Math.max(...values), minimum = Math.min(...values);
    if (maximum <= 0 || maximum === minimum) return null;
    // The official PBP renderer places point i at i / pointCount of the
    // timeline, even when nominal step_sec * count exceeds video duration.
    return { values: values.slice(), step: duration / values.length, sourceStep: step, duration, maximum };
  }

  function windowPeak(curve, start, end) {
    if (!curve || !Number.isFinite(start) || !Number.isFinite(end) || start < 0
      || end <= start || end > curve.duration) return null;
    let peak = 0;
    // The API supplies samples, not exact ad boundaries. Interpolate between
    // neighbouring samples and include both edges of the requested window.
    for (let i = Math.floor(start / curve.step); i < curve.values.length && i * curve.step <= end; i++) {
      const left = i * curve.step, right = Math.min(left + curve.step, curve.duration);
      if (right < start || left > end || right <= left) continue;
      const a = curve.values[i], b = curve.values[i + 1] ?? a;
      const at = time => a + (b - a) * (time - left) / curve.step;
      peak = Math.max(peak, at(Math.max(start, left)), at(Math.min(end, right)));
    }
    return peak / curve.maximum;
  }

  function evidenceLevel(segment, input, helpers) {
    const authorLabel = (['chapters', 'description'].includes(segment.source)
      && segment.requiresConfirmation === false) || segment.reason === 'explicit-ad-chapter';
    const body = (Array.isArray(input.subtitles) ? input.subtitles : []).filter(line => line
      && Number.isFinite(line.from) && Number.isFinite(line.to) && line.from >= 0 && line.to > line.from
      && line.from < segment.end && line.to > segment.start && typeof line.content === 'string');
    const observed = (segment.observedEvidence || []).filter(Boolean);
    const categories = body.map(line => typeof helpers.getSubtitleEvidence === 'function'
      ? helpers.getSubtitleEvidence(line.content)?.categories || [] : []);
    const sponsor = observed.some(line => (line.roles || []).some(role => ['sponsor', 'sponsorIntro', 'supportCredit'].includes(role)))
      || categories.some(roles => roles.includes('sponsor'));
    const commercial = roles => roles.some(role => ['cta', 'offer', 'pitch'].includes(role));
    const commercialLines = new Set(body.filter((line, index) => commercial(categories[index]))
      .map(line => line.content.trim())).size;
    const observedCommercialLines = observed.filter(line => commercial(line.roles || [])).length;
    const explicitAdTime = segment.source === 'danmaku-time'
      && (segment.matchedKeywords || []).some(word => /广告|恰饭|商单|接广|赞助/.test(word));
    const corroboratedTime = segment.source === 'danmaku-time'
      && segment.explicitCount > 0 && segment.adReactionCount >= 2;
    const strong = authorLabel || explicitAdTime || corroboratedTime
      || (sponsor && Math.max(commercialLines, observedCommercialLines) >= 2);
    const hasCommercial = commercialLines > 0 || observedCommercialLines > 0 || sponsor;
    // Unknown/missing subtitles are not proof that advertising context is absent.
    let covered = 0, coveredUntil = segment.start;
    for (const line of body.slice().sort((a, b) => a.from - b.from)) {
      const start = Math.max(segment.start, line.from, coveredUntil), end = Math.min(segment.end, line.to);
      covered += Math.max(0, end - start);
      coveredUntil = Math.max(coveredUntil, end);
    }
    const knownNonCommercial = typeof helpers.getSubtitleEvidence === 'function' && body.length >= 2
      && covered >= (segment.end - segment.start) * 0.5 && !hasCommercial;
    return { level: strong ? 2 : 1, authorLabel, explicitAdTime, corroboratedTime,
      sponsor, commercialLines, observedCommercialLines, knownNonCommercial };
  }

  function evaluate(segment, input, curve, policyName = DEFAULT_POLICY, helpers = {}) {
    const policy = POLICIES[policyName];
    if (!policy) throw new Error('Unknown heatmap verification policy');
    if (policy.kind === 'off' || !curve) return { action: 'keep', reason: 'no-heatmap-veto' };
    const peak = windowPeak(curve, segment.start, segment.end);
    const endPeak = windowPeak(curve, Math.max(0, segment.end - 10), Math.min(input.duration, segment.end + 10));
    if (peak === null || endPeak === null) return { action: 'keep', reason: 'incomplete-heatmap-window' };
    const evidence = evidenceLevel(segment, input, helpers);
    const cold = peak < policy.threshold && (policy.kind === 'cold' || endPeak < policy.threshold);
    // Missing commercial vocabulary is not proof of ordinary content. Use it
    // only to corroborate the weakest, keyword-derived manual proposals;
    // explicit destinations and subtitle proposals keep their existing support.
    const negativeEligible = policy.kind !== 'context'
      || (segment.source === 'danmaku-keywords' && evidence.knownNonCommercial);
    const heatWeight = cold && negativeEligible ? -1 : Math.max(peak, endPeak) >= 0.75 ? 0.5 : 0;
    const score = evidence.level + heatWeight;
    let action = 'keep';
    if (!evidence.authorLabel && segment.requiresConfirmation !== false && cold
      && (policy.kind === 'cold' || score < 1)) action = 'suppress';
    if (policy.reviewColdAuto && !evidence.authorLabel && segment.requiresConfirmation === false
      && segment.source === 'danmaku-time' && evidence.level === 1 && evidence.knownNonCommercial
      && peak < 0.25 && endPeak < 0.25) action = 'review';
    return { action, policy: policyName, peak, endPeak, evidence, heatWeight, score,
      reason: action === 'suppress' ? 'weak-ad-evidence-and-cold-heatmap'
        : action === 'review' ? 'generic-jump-and-cold-heatmap' : 'heatmap-corroboration' };
  }

  function verify(segments, input, response, policyName = DEFAULT_POLICY, helpers = {}) {
    const curve = parseCurve(response, input.duration), decisions = [], retained = [];
    for (const segment of segments) {
      const decision = evaluate(segment, input, curve, policyName, helpers);
      decisions.push({ start: segment.start, end: segment.end, source: segment.source, ...decision });
      if (decision.action === 'suppress') continue;
      if (decision.action === 'review') retained.push({ ...segment, requiresConfirmation: true,
        autoEligible: false, confidence: 'low', reason: decision.reason, heatmapEvidence: decision });
      else retained.push(decision.policy ? { ...segment, heatmapEvidence: decision } : segment);
    }
    return { segments: retained, decisions, available: curve !== null };
  }
  function needsHeatmap(segments, input, helpers = {}) {
    return segments.some(segment => segment.source === 'danmaku-keywords' && segment.requiresConfirmation !== false
      && evidenceLevel(segment, input, helpers).knownNonCommercial);
  }
  return { DEFAULT_POLICY, POLICIES, parseCurve, windowPeak, evidenceLevel, evaluate, verify, needsHeatmap };
});
