(function (global) {
  'use strict';
  const S = typeof module === 'object' && module.exports ? require('../labels/semantics.js') : global.LabelSemantics;
  const axisFields = ['contentType', 'contentConfidence', 'skipDecision', 'skipConfidence'];
  const hasAxes = value => axisFields.some(field => Object.prototype.hasOwnProperty.call(value || {}, field));
  const axes = value => {
    const normalized = S.normalizeSegment(value);
    return Object.fromEntries([...axisFields, 'label', 'confidence'].map(field => [field, normalized[field]]));
  };
  const fail = message => { throw new Error(message); };
  const key = record => `${record.bvid}:${record.cid}`;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = (value, limit = 5000) => typeof value === 'string' ? value.slice(0, limit) : '';
  function identity(record) {
    if (!record || !/^BV[0-9A-Za-z]{10}$/.test(record.bvid || '')) fail('视频 BV 号格式无效');
    if (!((typeof record.cid === 'number' && Number.isSafeInteger(record.cid) && record.cid > 0)
      || (typeof record.cid === 'string' && /^[1-9]\d*$/.test(record.cid) && Number.isSafeInteger(Number(record.cid))))) fail(`${record.bvid} 的 CID 无效`);
    if (!finite(record.duration) || record.duration <= 0) fail(`${record.bvid} 的视频时长无效`);
  }
  function range(value, duration) {
    if (!value || !finite(value.start) || !finite(value.end) || value.start < 0
      || value.end <= value.start || value.end > duration + 0.001) fail('区间必须满足 0 ≤ 起点 < 终点 ≤ 视频时长');
    return { start: value.start, end: Math.min(value.end, duration) };
  }
  function proposal(value, duration, label = 'ad') {
    const result = { ...range(value, duration), label: ['ad', 'normal', 'uncertain'].includes(value.label) ? value.label : label,
      confidence: value.confidence === 'high' ? 'high' : 'uncertain',
      boundaryConfidence: value.boundaryConfidence === 'high' ? 'high' : 'uncertain', reason: text(value.reason),
      source: text(value.source, 200), requiresConfirmation: true };
    if (finite(value.score)) result.score = value.score;
    result.matchedKeywords = Array.isArray(value.matchedKeywords) ? value.matchedKeywords.map(word => text(word, 100)).slice(0, 100) : [];
    for (const field of ['explicitCount', 'referenceCount']) if (finite(value[field])) result[field] = value[field];
    result.automatic = value.automatic === true || value.requiresConfirmation === false;
    // Legacy bundles must retain their exact normalized bytes and storage hash.
    // Infer axes at display time; only explicit dual-axis proposals add fields.
    if (hasAxes(value)) Object.assign(result, axes(value));
    return result;
  }
  function normalizeBundle(input) {
    if (!input || input.schemaVersion !== 1 || input.kind !== 'review-bundle' || !Array.isArray(input.records)) fail('需要 schemaVersion=1、kind=review-bundle 的审核文件');
    if (!input.records.length || input.records.length > 10000) fail('审核记录数量必须为 1–10000');
    const seen = new Set();
    const records = input.records.map(record => {
      identity(record);
      if (seen.has(key(record))) fail(`重复 BV/CID：${key(record)}`);
      seen.add(key(record));
      if (record.subtitles != null && !Array.isArray(record.subtitles)) fail(`${record.bvid} 的 subtitles 必须为数组`);
      const subtitles = (record.subtitles || []).map(line => {
        if (!finite(line.from) || !finite(line.to) || line.from < 0 || line.to <= line.from || typeof line.content !== 'string') fail(`${record.bvid} 字幕格式无效`);
        return { from: line.from, to: line.to, content: text(line.content) };
      }).sort((a, b) => a.from - b.from);
      const predictions = {};
      for (const source of ['model', 'topics', 'rules', 'legacy', 'conservative', 'pipeline']) {
        const raw = record.predictions?.[source] || {};
        const segments = Array.isArray(raw) ? raw : raw.segments || (raw.candidate ? [raw.candidate] : []);
        if (!Array.isArray(segments)) fail(`${record.bvid} 的 ${source} 预测格式无效`);
        predictions[source] = { threshold: finite(raw.threshold) ? raw.threshold : 0.5, automatic: raw.automatic === true,
          available: raw.available !== false,
          predictionMode: text(raw.predictionMode, 100), modelSha256: text(raw.modelSha256, 200),
          fold: Number.isInteger(raw.fold) ? raw.fold : null,
          segments: segments.map(segment => proposal(segment, record.duration)),
          lines: Array.isArray(raw.lines) ? raw.lines.filter(line => finite(line.from) && finite(line.to) && finite(line.score))
            .map(line => ({ from: line.from, to: line.to, score: line.score })) : [] };
      }
      if (record.assistantSegments != null && !Array.isArray(record.assistantSegments)) fail('assistantSegments 必须为数组');
      return { bvid: record.bvid, cid: record.cid, title: text(record.title, 1000), duration: record.duration,
        page: Number.isInteger(record.page) && record.page > 0 ? record.page : 1,
        creator: typeof record.creator === 'object' ? text(record.creator?.name, 200) : text(record.creator, 200),
        split: text(record.split || 'unknown', 80), subtitles, predictions,
        assistantSegments: (record.assistantSegments || []).map(segment => proposal(segment, record.duration)),
        priority: { score: finite(record.priority?.score) ? Math.max(0, Math.min(1000, record.priority.score)) : 0,
          reasons: Array.isArray(record.priority?.reasons) ? record.priority.reasons.map(reason => text(reason, 300)).slice(0, 10) : [] } };
    });
    return { schemaVersion: 1, kind: 'review-bundle', modelSha256: text(input.modelSha256, 200) || null,
      generatedAt: text(input.generatedAt, 100), records };
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const iou = (a, b) => overlap(a, b) / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
  function priority(record) {
    const skipOnly = segments => segments.filter(segment => axes(segment).skipDecision === 'skip');
    const model = skipOnly(record.predictions.model.segments), rules = skipOnly(record.predictions.rules.segments), legacy = skipOnly(record.predictions.legacy.segments);
    const conflict = model.some(a => !rules.some(b => iou(a, b) >= 0.5)) || rules.some(a => !model.some(b => iou(a, b) >= 0.5));
    const boundaries = model.some(a => [...rules, ...legacy].some(b => overlap(a, b) > 0
      && (Math.abs(a.start - b.start) >= 3 || Math.abs(a.end - b.end) >= 3)));
    const near = model.some(segment => finite(segment.score) && Math.abs(segment.score - record.predictions.model.threshold) <= 0.1)
      || record.predictions.model.lines.some(line => Math.abs(line.score - record.predictions.model.threshold) <= 0.05);
    const reasons = [...record.priority.reasons, ...(conflict ? ['模型与规则候选不一致'] : []),
      ...(boundaries ? ['起止边界有变化'] : []), ...(near ? ['存在接近阈值的分数'] : [])];
    return { score: record.priority.score + (conflict ? 50 : 0) + (boundaries ? 30 : 0) + (near ? 20 : 0),
      reasons: [...new Set(reasons)], conflict, boundaries, near };
  }
  function mergeRanges(values) {
    const result = [];
    for (const value of values.map(value => ({ start: value.start, end: value.end })).sort((a, b) => a.start - b.start)) {
      const last = result[result.length - 1];
      if (last && value.start <= last.end) last.end = Math.max(last.end, value.end);
      else result.push(value);
    }
    return result;
  }
  const reviewedRanges = segments => mergeRanges(segments.filter(segment => {
    const target = axes(segment);
    return ['skip', 'keep'].includes(target.skipDecision) && target.skipConfidence === 'high';
  }));
  function humanSegment(value, record) {
    const selected = range(value, record.duration);
    if (!hasAxes(value) && !['ad', 'normal', 'uncertain'].includes(value.label)) fail('人工标签必须是 ad、normal 或 uncertain，或提供双轴判断');
    if (value.origin !== 'human') fail('不能把模型或助手预标注直接导入成人工反馈');
    const result = { ...selected, ...axes(value),
      boundaryConfidence: value.boundaryConfidence === 'high' ? 'high' : 'uncertain',
      reason: text(value.reason), origin: 'human', reviewedAt: text(value.reviewedAt, 100),
      proposalSource: text(value.proposalSource, 100),
      evidence: record.subtitles.filter(line => line.to > selected.start && line.from < selected.end).slice(0, 12)
        .map(line => ({ from: line.from, to: line.to, text: line.content })) };
    for (const field of ['contentTypeSource', 'skipDecisionSource', 'semanticMigration']) {
      if (value[field] != null) result[field] = JSON.parse(JSON.stringify(value[field]));
    }
    return result;
  }
  function checkConflicts(segments) {
    for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i], b = segments[j];
      const left = axes(a), right = axes(b);
      if (left.skipConfidence === 'high' && right.skipConfidence === 'high'
        && left.skipDecision !== 'uncertain' && right.skipDecision !== 'uncertain'
        && left.skipDecision !== right.skipDecision && overlap(a, b) > 0) fail('跳过与保留决定发生重叠，请先编辑或删除冲突区间');
    }
  }
  function normalizeFeedback(input, bundle, { datasetSha256, allowVersionMismatch = false } = {}) {
    if (!input || input.schemaVersion !== 1 || input.kind !== 'human-review' || !Array.isArray(input.records)) fail('只能导入 human-review 人工反馈文件，不能导入助手标签');
    if (!allowVersionMismatch && (input.datasetSha256 !== datasetSha256 || (input.modelSha256 || null) !== bundle.modelSha256)) fail('数据或模型版本不同；确认 BV/CID/时长一致后，可启用跨版本导入');
    const lookup = new Map(bundle.records.map(record => [key(record), record])), seen = new Set();
    return input.records.map(value => {
      const record = lookup.get(key(value));
      if (!record || !finite(value.duration) || Math.abs(value.duration - record.duration) > 0.001) fail(`反馈视频或时长不匹配：${text(value.bvid, 50)}`);
      if (seen.has(key(value)) || !Array.isArray(value.segments)) fail('反馈记录重复或 segments 无效');
      seen.add(key(value));
      const segments = value.segments.map(segment => humanSegment(segment, record));
      checkConflicts(segments);
      return feedbackRecord(record, segments, text(value.updatedAt, 100), value);
    });
  }
  function feedbackRecord(record, segments, updatedAt = new Date().toISOString(), review = {}) {
    const ranges = reviewedRanges(segments);
    const reviewComplete = review.reviewComplete === true && segments.length > 0;
    return { bvid: record.bvid, cid: record.cid, duration: record.duration, split: record.split,
      status: ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === record.duration ? 'reviewed' : ranges.length ? 'partial' : 'unreviewed',
      reviewComplete, reviewCompletedAt: reviewComplete ? text(review.reviewCompletedAt, 100) : '',
      reviewedRanges: ranges, segments: [...segments].sort((a, b) => a.start - b.start), updatedAt };
  }
  function parseTime(value) {
    const parts = String(value).trim().split(':');
    if (!parts.length || parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) fail('时间格式应为秒数、分:秒或时:分:秒');
    const numbers = parts.map(Number);
    if (numbers.some(number => !Number.isFinite(number)) || (numbers.length > 1 && numbers[numbers.length - 1] >= 60)
      || (numbers.length === 3 && numbers[1] >= 60)) fail('时间格式无效');
    return numbers.reduce((total, number) => total * 60 + number, 0);
  }
  function formatTime(seconds) {
    const rounded = Math.round(seconds * 100);
    return `${Math.floor(rounded / 6000)}:${((rounded % 6000) / 100).toFixed(2).padStart(5, '0')}`;
  }
  function formatInputTime(seconds) {
    const rounded = Math.round(seconds * 1000);
    return `${Math.floor(rounded / 60000)}:${((rounded % 60000) / 1000).toFixed(3).padStart(6, '0').replace(/0$/, '')}`;
  }
  const api = { key, identity, range, normalizeBundle, priority, mergeRanges, reviewedRanges, humanSegment, axes, hasAxes,
    checkConflicts, normalizeFeedback, feedbackRecord, parseTime, formatTime, formatInputTime, iou };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.ReviewCore = api;
})(typeof globalThis === 'object' ? globalThis : this);
