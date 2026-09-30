/* Shared label semantics. Content type and the decision to skip are independent. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LabelSemantics = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const has = (value, field) => Object.prototype.hasOwnProperty.call(value, field);
  function check(value, field, allowed) {
    if (has(value, field) && !allowed.includes(value[field])) throw new Error(`Invalid ${field}: ${String(value[field])}`);
  }

  function normalizeSegment(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A label segment must be an object');
    check(value, 'label', ['ad', 'normal', 'uncertain']);
    check(value, 'confidence', ['high', 'uncertain']);
    check(value, 'contentType', ['ad', 'non_ad', 'uncertain']);
    check(value, 'contentConfidence', ['high', 'uncertain']);
    check(value, 'skipDecision', ['skip', 'keep', 'uncertain']);
    check(value, 'skipConfidence', ['high', 'uncertain']);
    const legacyLabel = value.label || 'uncertain';
    const legacyConfidence = value.confidence || 'uncertain';
    const contentType = has(value, 'contentType') ? value.contentType : legacyLabel === 'ad' ? 'ad' : 'uncertain';
    const contentConfidence = has(value, 'contentConfidence') ? value.contentConfidence
      : has(value, 'contentType') ? 'uncertain' : legacyLabel === 'ad' ? legacyConfidence : 'uncertain';
    const skipDecision = has(value, 'skipDecision') ? value.skipDecision
      : ({ ad: 'skip', normal: 'keep', uncertain: 'uncertain' })[legacyLabel];
    const skipConfidence = has(value, 'skipConfidence') ? value.skipConfidence
      : has(value, 'skipDecision') ? 'uncertain' : legacyConfidence;
    // Reasons remain provenance only. In particular, keep does not imply that
    // the content is noncommercial, and content uncertainty does not weaken keep.
    return { ...value, contentType, contentConfidence, skipDecision, skipConfidence,
      label: ({ skip: 'ad', keep: 'normal', uncertain: 'uncertain' })[skipDecision], confidence: skipConfidence };
  }
  return { normalizeSegment, targetSegment: normalizeSegment };
});
