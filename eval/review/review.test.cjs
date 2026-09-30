'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const C = require('./core.js');
const { build } = require('./build.cjs');
const { createServer } = require('./serve.cjs');

function fixture() {
  return { schemaVersion: 1, kind: 'review-bundle', modelSha256: 'model-a', records: [{
    bvid: 'BV1a5N4zxEQe', cid: 123, title: '测试 <script>危险字符</script>', duration: 100,
    creator: { name: '测试作者' }, split: 'train',
    subtitles: [{ from: 10, to: 20, content: '</script><img src=x onerror=alert(1)>' }, { from: 20, to: 30, content: '回到正片' }],
    predictions: { model: { threshold: .68, predictionMode: 'creator-held-out-development-fold', fold: 1, modelSha256: 'fold-b',
      segments: [{ start: 10, end: 30, score: .69 }] }, rules: { segments: [{ start: 18, end: 28 }] },
      conservative: { segments: [] }, pipeline: { automatic: true, segments: [{ start: 10, end: 25, source: 'danmaku-time', requiresConfirmation: false, matchedKeywords: ['跳过广告'], explicitCount: 2, referenceCount: 3 }] } },
    assistantSegments: [{ start: 10, end: 20, label: 'ad', confidence: 'high', boundaryConfidence: 'high', reason: '请核对广告' },
      { start: 40, end: 50, label: 'ad', confidence: 'high', boundaryConfidence: 'uncertain' },
      { start: 60, end: 70, label: 'normal', confidence: 'high', boundaryConfidence: 'high' }]
  }] };
}
function human(start, end, label = 'ad') {
  return { start, end, label, confidence: label === 'uncertain' ? 'uncertain' : 'high', boundaryConfidence: 'high', origin: 'human', reviewedAt: '2026-01-01T00:00:00Z' };
}
test('legacy proposal normalization preserves the pre-dual-axis namespace byte for byte', () => {
  const bundle = C.normalizeBundle(fixture());
  assert.equal(createHash('sha256').update(JSON.stringify({ ...bundle, generatedAt: '' })).digest('hex'),
    'ce67fe7dc2ce42698f8986e284430743b7d9c6757fbd5c64a78189891257cfcd');
  assert.ok(!Object.hasOwn(bundle.records[0].assistantSegments[0], 'contentType'));
  assert.deepEqual(C.normalizeBundle(bundle), bundle);
});

test('explicit dual-axis proposals and human feedback keep advertisement separate from keep decisions', () => {
  const input = fixture();
  input.records[0].assistantSegments[0] = { ...input.records[0].assistantSegments[0],
    contentType: 'ad', contentConfidence: 'high', skipDecision: 'keep', skipConfidence: 'high' };
  const bundle = C.normalizeBundle(input), proposal = bundle.records[0].assistantSegments[0];
  assert.equal(proposal.label, 'normal');
  assert.equal(proposal.contentType, 'ad');
  assert.deepEqual(C.normalizeBundle(bundle), bundle);
  const segment = C.humanSegment({ ...proposal, origin: 'human',
    contentTypeSource: 'user-note', skipDecisionSource: 'user-review',
    semanticMigration: { previousLabel: 'uncertain', note: 'keep decision, not full visual ad boundaries' } }, bundle.records[0]);
  const feedback = { schemaVersion: 1, kind: 'human-review', datasetSha256: 'dual-data', modelSha256: bundle.modelSha256,
    records: [C.feedbackRecord(bundle.records[0], [segment], '2026-01-01T00:00:00Z',
      { reviewComplete: true, reviewCompletedAt: '2026-01-01T00:00:00Z' })] };
  const restored = C.normalizeFeedback(JSON.parse(JSON.stringify(feedback)), bundle, { datasetSha256: 'dual-data' })[0];
  assert.deepEqual(restored.segments[0], segment);
  assert.equal(restored.reviewComplete, true);
  assert.deepEqual(restored.reviewedRanges, [{ start: 10, end: 20 }]);
});

test('conflicts and reviewed coverage follow high-confidence skip decisions, not content nature', () => {
  const record = C.normalizeBundle(fixture()).records[0];
  const keep = C.humanSegment({ ...human(10, 20), contentType: 'uncertain', contentConfidence: 'uncertain',
    skipDecision: 'keep', skipConfidence: 'high' }, record);
  assert.equal(keep.label, 'normal'); assert.equal(keep.confidence, 'high');
  assert.deepEqual(C.reviewedRanges([keep]), [{ start: 10, end: 20 }]);
  const adKeep = { ...keep, contentType: 'ad', contentConfidence: 'high' };
  const nonAdKeep = { ...keep, contentType: 'non_ad', contentConfidence: 'high' };
  assert.doesNotThrow(() => C.checkConflicts([adKeep, nonAdKeep]));
  assert.throws(() => C.checkConflicts([adKeep, { ...adKeep, skipDecision: 'skip' }]), /跳过与保留/);
  assert.deepEqual(C.reviewedRanges([{ ...adKeep, skipDecision: 'uncertain', skipConfidence: 'uncertain' }]), []);
  assert.throws(() => C.humanSegment({ ...human(10, 20), contentType: 'typo' }, record), /contentType/);
});
test('bundle validates identity/ranges and preserves five-source evidence and held-out model identity', () => {
  const bundle = C.normalizeBundle(fixture()), record = bundle.records[0];
  assert.deepEqual(Object.keys(record.predictions), ['model', 'topics', 'rules', 'legacy', 'conservative', 'pipeline']);
  assert.equal(record.predictions.pipeline.segments[0].source, 'danmaku-time');
  assert.deepEqual(record.predictions.pipeline.segments[0].matchedKeywords, ['跳过广告']);
  assert.equal(record.predictions.model.fold, 1); assert.equal(record.predictions.model.modelSha256, 'fold-b');
  assert.deepEqual(C.normalizeBundle(bundle), bundle, 'normalization is idempotent for stable data namespaces');
  const broken = fixture(); broken.records[0].bvid = '<script>';
  assert.throws(() => C.normalizeBundle(broken), /BV/);
  broken.records[0].bvid = 'BV1a5N4zxEQe'; broken.records[0].assistantSegments[0].end = 101;
  assert.throws(() => C.normalizeBundle(broken), /区间/);
});
test('only explicit high-confidence ranges count as reviewed; gaps remain unknown', () => {
  const record = C.normalizeBundle(fixture()).records[0];
  const result = C.feedbackRecord(record, [human(10, 20), human(20, 25), human(40, 50, 'normal'), human(60, 70, 'uncertain')]);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.reviewedRanges, [{ start: 10, end: 25 }, { start: 40, end: 50 }]);
  assert.equal(C.feedbackRecord(record, [human(0, 100, 'normal')]).status, 'reviewed');
  assert.throws(() => C.checkConflicts([human(10, 20), human(15, 22, 'normal')]), /重叠/);
});
test('feedback rejects assistant provenance, version/identity/duration mismatch and conflicting labels', () => {
  const bundle = C.normalizeBundle(fixture());
  const feedback = { schemaVersion: 1, kind: 'human-review', datasetSha256: 'data-a', modelSha256: 'model-a', records: [{ ...bundle.records[0], segments: [human(10, 20)] }] };
  const normalize = value => C.normalizeFeedback(value, bundle, { datasetSha256: 'data-a' });
  assert.equal(normalize(feedback)[0].segments[0].evidence[0].text, fixture().records[0].subtitles[0].content);
  assert.throws(() => normalize({ ...feedback, kind: 'assistant-provisional' }), /human-review/);
  assert.throws(() => normalize({ ...feedback, modelSha256: 'different' }), /版本不同/);
  const other = structuredClone(feedback); other.records[0].duration = 99;
  assert.throws(() => normalize(other), /时长不匹配/);
  other.records[0].duration = 100; other.records[0].segments[0].origin = 'assistant';
  assert.throws(() => normalize(other), /不能把模型或助手/);
  assert.equal(C.normalizeFeedback({ ...feedback, modelSha256: 'different' }, bundle, { datasetSha256: 'data-a', allowVersionMismatch: true }).length, 1);
});
test('legacy feedback without review completion remains compatible and does not imply whole-video coverage', () => {
  const bundle = C.normalizeBundle(fixture());
  const feedback = { schemaVersion: 1, kind: 'human-review', datasetSha256: 'data-a', modelSha256: 'model-a',
    records: [{ bvid: bundle.records[0].bvid, cid: 123, duration: 100, segments: [human(10, 20)] }] };
  const restored = C.normalizeFeedback(feedback, bundle, { datasetSha256: 'data-a' })[0];
  assert.equal(restored.reviewComplete, false);
  assert.ok(!restored.reviewCompletedAt);
  assert.equal(restored.status, 'partial');
  assert.deepEqual(restored.reviewedRanges, [{ start: 10, end: 20 }]);
  assert.equal(restored.segments.length, 1);
});
test('priority detects model/rule disagreements, changed boundaries and actual configured threshold', () => {
  const record = C.normalizeBundle(fixture()).records[0], priority = C.priority(record);
  assert.equal(priority.boundaries, true); assert.equal(priority.near, true);
  record.predictions.rules.segments = [];
  assert.equal(C.priority(record).conflict, true);
  assert.equal(C.parseTime('3:10'), 190); assert.equal(C.formatTime(59.999), '1:00.00');
  assert.equal(C.formatInputTime(182.7), '3:02.70');
  assert.equal(C.formatInputTime(334.36), '5:34.36');
  for (const time of [0, 59.999, 60, 182.7, 203.899, 334.36, 3600]) {
    assert.ok(Math.abs(C.parseTime(C.formatInputTime(time)) - time) < 1e-9, 'editing preserves millisecond boundaries');
  }
  assert.throws(() => C.parseTime('3:99'), /格式无效/);
});
test('standalone build safely embeds hostile text without closing its JSON script', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-review-'));
  try {
    const input = path.join(tmp, 'bundle.json'), out = path.join(tmp, 'review.html');
    fs.writeFileSync(input, JSON.stringify(fixture()));
    assert.equal(build(input, out).videos, 1);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(!html.includes('<script src=')); assert.ok(!html.includes('href="style.css"'));
    assert.ok(!html.includes('<img src=x onerror='));
    const data = html.match(/<script id="embedded-bundle" type="application\/json">([\s\S]*?)<\/script>/)[1];
    assert.equal(JSON.parse(data).records[0].subtitles[0].content, fixture().records[0].subtitles[0].content);
    assert.equal((html.match(/<\/script>/g) || []).length, 4);
    assert.ok(html.indexOf('root.LabelSemantics') < html.indexOf('global.ReviewCore'), 'shared semantics loads before the review core');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Small DOM double: exercises actual app event handlers, persistence and exports;
// browser layout is verified separately with the generated real review bundle.
class Node {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.attributes = {}; this.style = {}; this.textContent = ''; this.value = ''; this.checked = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this[key]; delete this.attributes[key]; }
  addEventListener(name, action) { (this.events[name] ||= []).push(action); }
  async dispatch(name, options = {}) { for (const action of this.events[name] || []) await action({ target: this, preventDefault() {}, ...options }); }
  click() { return this.dispatch('click'); }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function renderedText(node) { return descendants(node).map(value => value.textContent).join(' '); }
async function appHarness(storage = new Map(), input = fixture()) {
  const template = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), nodes = new Map();
  for (const match of template.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)) nodes.set(match[2], new Node(match[1]));
  nodes.get('embedded-bundle').textContent = JSON.stringify(input);
  const document = new Node('document'); document.getElementById = id => nodes.get(id); document.createElement = tag => new Node(tag);
  let blob = null;
  const context = { document, console, TextEncoder, Blob, crypto: webcrypto, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    URL: { createObjectURL(value) { blob = value; return 'blob:test'; }, revokeObjectURL() {} } };
  context.window = context; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../labels/semantics.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);
  const expected = `${input.records.length} 个视频`;
  for (let i = 0; i < 100 && !nodes.get('dataset-info').textContent.includes(expected); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(nodes.get('dataset-info').textContent.includes(expected), nodes.get('message').textContent);
  return { nodes, document, storage, getBlob: () => blob,
    saved: () => JSON.parse([...storage.values()][0]).feedback,
    click: id => nodes.get(id).click() };
}
test('real app keeps proposals out of feedback, batch confirms only explicit eligible ads, exports and restores human ranges', async () => {
  const app = await appHarness();
  assert.deepEqual(app.saved().records, []);
  assert.equal(app.nodes.get('start-time').value, '0:10.00');
  assert.equal(app.nodes.get('end-time').value, '0:20.00');
  await app.click('confirm-batch');
  const saved = app.saved(); assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].segments.length, 1); assert.equal(saved.records[0].segments[0].label, 'ad');
  assert.equal(saved.records[0].segments[0].origin, 'human');
  assert.deepEqual(saved.records[0].reviewedRanges, [{ start: 10, end: 20 }]);
  await app.click('export-feedback');
  assert.equal(JSON.parse(await app.getBlob().text()).kind, 'human-review');
  assert.equal(JSON.parse(app.nodes.get('feedback-json').value).records[0].segments[0].origin, 'human');
  assert.equal(app.nodes.get('feedback-preview').hidden, false);
  const restored = await appHarness(app.storage);
  assert.equal(restored.saved().records[0].segments.length, 1);
});
test('real app advertisement plus keep roundtrips through editing, export, import, reload and undo', async () => {
  const app = await appHarness();
  app.nodes.get('content-type').value = 'ad'; await app.nodes.get('content-type').dispatch('change');
  await app.click('confirm-normal'); await app.click('complete-review');
  const saved = structuredClone(app.saved().records[0]);
  assert.equal(saved.segments[0].contentType, 'ad'); assert.equal(saved.segments[0].contentConfidence, 'high');
  assert.equal(saved.segments[0].skipDecision, 'keep'); assert.equal(saved.segments[0].skipConfidence, 'high');
  assert.equal(saved.segments[0].label, 'normal'); assert.equal(saved.reviewComplete, true);
  assert.match(renderedText(app.nodes.get('human-segments')), /内容：广告.*决定：保留/);
  await app.click('export-feedback');
  const exported = JSON.parse(await app.getBlob().text());
  const restored = await appHarness(app.storage);
  assert.deepEqual(restored.saved().records[0], saved);
  const imported = await appHarness();
  imported.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(exported) }];
  await imported.nodes.get('feedback-file').dispatch('change');
  assert.equal(imported.saved().records[0].segments[0].contentType, 'ad');
  assert.equal(imported.saved().records[0].reviewComplete, true);
  const prior = structuredClone(app.saved().records[0]);
  app.nodes.get('content-type').value = 'non_ad'; await app.nodes.get('content-type').dispatch('change');
  await app.click('confirm-normal');
  assert.equal(app.saved().records[0].segments[0].contentType, 'non_ad');
  await app.click('undo');
  assert.deepEqual(app.saved().records[0], prior);
});

test('real app content uncertainty does not weaken a confirmed keep or completion', async () => {
  const app = await appHarness();
  app.nodes.get('content-type').value = 'uncertain'; await app.nodes.get('content-type').dispatch('change');
  await app.click('confirm-normal'); await app.click('complete-review');
  const saved = app.saved().records[0], segment = saved.segments[0];
  assert.equal(segment.contentType, 'uncertain'); assert.equal(segment.contentConfidence, 'uncertain');
  assert.equal(segment.skipDecision, 'keep'); assert.equal(segment.skipConfidence, 'high');
  assert.equal(segment.confidence, 'high'); assert.equal(saved.reviewComplete, true);
  assert.deepEqual(saved.reviewedRanges, [{ start: 10, end: 20 }]);
  assert.match(renderedText(app.nodes.get('human-segments')), /内容：不确定.*决定：保留/);
});

test('legacy local progress recovers under the identical namespace without inventing non-ad content', async () => {
  const digest = 'ce67fe7dc2ce42698f8986e284430743b7d9c6757fbd5c64a78189891257cfcd';
  const storageKey = `bilismartskip-review:v1:${digest}:model-a`;
  const storage = new Map([[storageKey, JSON.stringify({ selectedKey: 'BV1a5N4zxEQe:123', feedback: {
    schemaVersion: 1, kind: 'human-review', datasetSha256: digest, modelSha256: 'model-a', records: [{
      bvid: 'BV1a5N4zxEQe', cid: 123, duration: 100, segments: [human(10, 20, 'normal')],
      reviewComplete: true, reviewCompletedAt: '2026-01-01T00:00:00Z'
    }] } })]]);
  const app = await appHarness(storage), segment = app.saved().records[0].segments[0];
  assert.deepEqual([...storage.keys()], [storageKey]);
  assert.equal(segment.contentType, 'uncertain'); assert.equal(segment.skipDecision, 'keep');
  assert.equal(segment.skipConfidence, 'high'); assert.equal(app.saved().records[0].reviewComplete, true);
  assert.equal(app.nodes.get('content-type').value, 'uncertain');
  assert.match(app.nodes.get('draft-skip-state').textContent, /保留/);
});

test('batch confirmation preserves content uncertainty and never selects an explicit keep proposal', async () => {
  const input = fixture();
  input.records[0].assistantSegments[0] = { ...input.records[0].assistantSegments[0],
    contentType: 'uncertain', contentConfidence: 'uncertain', skipDecision: 'skip', skipConfidence: 'high' };
  input.records[0].assistantSegments[2] = { ...input.records[0].assistantSegments[2],
    contentType: 'ad', contentConfidence: 'high', skipDecision: 'keep', skipConfidence: 'high' };
  const app = await appHarness(new Map(), input);
  await app.click('confirm-batch');
  assert.equal(app.saved().records[0].segments.length, 1);
  const segment = app.saved().records[0].segments[0];
  assert.equal(segment.contentType, 'uncertain'); assert.equal(segment.contentConfidence, 'uncertain');
  assert.equal(segment.skipDecision, 'skip'); assert.equal(segment.skipConfidence, 'high');
});

test('explicit-axis imports update content on the same keep range while legacy imports do not erase it', async () => {
  const app = await appHarness();
  app.nodes.get('content-type').value = 'uncertain'; await app.nodes.get('content-type').dispatch('change');
  await app.click('confirm-normal'); await app.click('complete-review');
  const incoming = structuredClone(app.saved());
  const segment = incoming.records[0].segments[0];
  Object.assign(segment, { contentType: 'ad', contentConfidence: 'high', contentTypeSource: 'human-note',
    skipDecisionSource: 'human-confirmation', semanticMigration: { previousLabel: 'normal' } });
  const upload = async value => {
    app.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(value) }];
    await app.nodes.get('feedback-file').dispatch('change');
  };
  await upload(incoming);
  assert.equal(app.saved().records[0].segments.length, 1);
  assert.equal(app.saved().records[0].segments[0].contentType, 'ad');
  assert.equal(app.saved().records[0].reviewComplete, true);
  assert.deepEqual(app.saved().records[0].segments[0].semanticMigration, { previousLabel: 'normal' });
  const legacy = structuredClone(incoming);
  for (const field of ['contentType', 'contentConfidence', 'skipDecision', 'skipConfidence', 'contentTypeSource', 'skipDecisionSource', 'semanticMigration']) delete legacy.records[0].segments[0][field];
  await upload(legacy);
  assert.equal(app.saved().records[0].segments[0].contentType, 'ad');
  assert.equal(app.saved().records[0].reviewComplete, true);
  await app.click('confirm-normal');
  assert.deepEqual(app.saved().records[0].segments[0].semanticMigration, { previousLabel: 'normal' }, 'unchanged semantic decisions retain migration provenance');
  app.nodes.get('content-type').value = 'non_ad'; await app.nodes.get('content-type').dispatch('change');
  await app.click('confirm-normal');
  assert.ok(!Object.hasOwn(app.saved().records[0].segments[0], 'contentTypeSource'));
  assert.ok(!Object.hasOwn(app.saved().records[0].segments[0], 'semanticMigration'));
  assert.equal(app.saved().records[0].segments[0].skipDecisionSource, 'human-confirmation');
});

test('a definite imported skip decision replaces only an identical pending range; conflicting definite decisions remain atomic', async () => {
  const app = await appHarness();
  await app.click('confirm-uncertain'); await app.click('complete-review');
  const incoming = structuredClone(app.saved());
  Object.assign(incoming.records[0].segments[0], { contentType: 'ad', contentConfidence: 'high',
    skipDecision: 'keep', skipConfidence: 'high', boundaryConfidence: 'high' });
  const upload = async value => {
    app.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(value) }];
    await app.nodes.get('feedback-file').dispatch('change');
  };
  await upload(incoming);
  assert.equal(app.saved().records[0].segments.length, 1);
  assert.equal(app.saved().records[0].segments[0].skipDecision, 'keep');
  assert.equal(app.saved().records[0].reviewComplete, true);
  const beforeConflict = structuredClone(app.saved());
  const conflict = structuredClone(incoming); conflict.records[0].segments[0].skipDecision = 'skip';
  await upload(conflict);
  assert.match(app.nodes.get('message').textContent, /跳过与保留决定发生重叠/);
  assert.deepEqual(app.saved(), beforeConflict);
});

test('mixed unsorted legacy and dual-axis imports use matching ranges rather than raw array indices', async () => {
  const app = await appHarness();
  await app.click('confirm-normal');
  const incoming = structuredClone(app.saved());
  incoming.records[0].segments = [
    { ...human(80, 90, 'normal'), contentType: 'ad', contentConfidence: 'high', skipDecision: 'keep', skipConfidence: 'high' },
    human(10, 20, 'normal')
  ];
  app.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(incoming) }];
  await app.nodes.get('feedback-file').dispatch('change');
  const segments = app.saved().records[0].segments;
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start, 10); assert.equal(segments[0].contentType, 'ad', 'legacy normal must not erase the existing independent advertisement judgment');
  assert.equal(segments[1].start, 80); assert.equal(segments[1].contentType, 'ad');
});

test('real v1 to dual-axis v2 migration imports 25 segments and retains all 14 completed reviews', async () => {
  const v1 = JSON.parse(fs.readFileSync(path.join(__dirname, '../labels/human/review-2026-09-30-v1.json'), 'utf8'));
  const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../labels/human/review-2026-09-30-v2.json'), 'utf8'));
  // Small derived bundle, retaining the actual human identities, intervals and
  // migration metadata; no browser or real localStorage is touched.
  const input = { schemaVersion: 1, kind: 'review-bundle', modelSha256: v1.modelSha256,
    records: v1.records.map(row => ({ bvid: row.bvid, cid: row.cid, duration: row.duration,
      split: row.split, subtitles: [], assistantSegments: [] })) };
  const normalized = C.normalizeBundle(input);
  const digest = createHash('sha256').update(JSON.stringify({ ...normalized, generatedAt: '' })).digest('hex');
  const stored = { ...v1, datasetSha256: digest };
  const storageKey = `bilismartskip-review:v1:${digest}:${v1.modelSha256}`;
  const storage = new Map([[storageKey, JSON.stringify({ feedback: stored, selectedKey: C.key(v1.records[0]) })]]);
  const app = await appHarness(storage, input);
  const incoming = { ...v2, datasetSha256: digest, modelSha256: v1.modelSha256 };
  app.nodes.get('feedback-file').files = [{ size: 10000, text: async () => JSON.stringify(incoming) }];
  await app.nodes.get('feedback-file').dispatch('change');
  assert.match(app.nodes.get('message').textContent, /已导入并合并 14/);
  const actual = app.saved();
  assert.equal(actual.records.length, 14);
  assert.equal(actual.records.flatMap(row => row.segments).length, 25);
  assert.equal(actual.records.filter(row => row.reviewComplete).length, 14);
  for (const record of incoming.records) {
    const restored = actual.records.find(row => C.key(row) === C.key(record));
    assert.equal(restored.reviewCompletedAt, record.reviewCompletedAt);
    for (const segment of record.segments) {
      const result = restored.segments.find(row => row.start === segment.start && row.end === segment.end);
      assert.deepEqual(C.axes(result), C.axes(segment));
      assert.deepEqual(result.semanticMigration, segment.semanticMigration);
    }
  }
  const sponsor = actual.records.find(row => row.bvid === 'BV1TnVb6bEwG').segments.find(row => row.start === 0.08);
  assert.equal(sponsor.contentType, 'ad'); assert.equal(sponsor.skipDecision, 'keep');
  assert.equal(sponsor.boundaryConfidence, 'high');
  assert.deepEqual([...storage.keys()], [storageKey]);
});
test('real app blocks one-click full-video normal, supports uncertain and undo without claiming coverage', async () => {
  const app = await appHarness();
  app.nodes.get('start-time').value = '0'; app.nodes.get('end-time').value = '100';
  await app.click('confirm-normal');
  assert.deepEqual(app.saved().records, []); assert.match(app.nodes.get('message').textContent, /不能一键/);
  await app.click('confirm-uncertain');
  assert.deepEqual(app.saved().records[0].reviewedRanges, []);
  await app.click('undo'); assert.deepEqual(app.saved().records, []);
  app.nodes.get('start-time').value = '50'; app.nodes.get('end-time').value = '60';
  await app.click('confirm-normal');
  assert.deepEqual(app.saved().records[0].reviewedRanges, [{ start: 50, end: 60 }]);
});
test('real app completion survives export, import and reload while unreviewed time stays unknown', async () => {
  const app = await appHarness();
  assert.equal(descendants(app.nodes.get('assistant-drafts')).filter(node => node.tagName === 'INPUT').length, 1);
  assert.equal(app.nodes.get('complete-review').disabled, true, 'a video with no human decision cannot be completed');
  await app.click('confirm-ad');
  assert.equal(descendants(app.nodes.get('assistant-drafts')).filter(node => node.tagName === 'INPUT').length, 0,
    'a saved proposal shows human status rather than a useless disabled batch checkbox');
  assert.match(renderedText(app.nodes.get('assistant-drafts')), /已保存人工标注/);
  assert.equal(app.nodes.get('complete-review').disabled, false);
  assert.equal(app.saved().records[0].reviewComplete, false);
  await app.click('complete-review');
  const completed = app.saved().records[0];
  assert.equal(completed.reviewComplete, true);
  assert.match(renderedText(app.nodes.get('queue')), /本条核对完成/);
  assert.ok(Number.isFinite(Date.parse(completed.reviewCompletedAt)));
  assert.equal(completed.status, 'partial', 'workflow completion is not complete temporal coverage');
  assert.deepEqual(completed.reviewedRanges, [{ start: 10, end: 20 }]);
  assert.equal(completed.segments.length, 1, 'completion must not manufacture normal labels');
  await app.click('export-feedback');
  const exported = JSON.parse(await app.getBlob().text());
  assert.equal(exported.records[0].reviewComplete, true);
  assert.deepEqual(exported.records[0].reviewedRanges, [{ start: 10, end: 20 }]);
  const restored = await appHarness(app.storage);
  assert.equal(restored.saved().records[0].reviewComplete, true);
  assert.equal(restored.saved().records[0].reviewCompletedAt, completed.reviewCompletedAt);
  const imported = await appHarness();
  imported.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(exported) }];
  await imported.nodes.get('feedback-file').dispatch('change');
  assert.equal(imported.saved().records[0].reviewComplete, true, 'explicit completion survives human feedback import');
  assert.deepEqual(imported.saved().records[0].reviewedRanges, [{ start: 10, end: 20 }]);
});
test('real app range changes clear completion and undo restores the prior completed review', async () => {
  const app = await appHarness();
  await app.click('confirm-ad'); await app.click('complete-review');
  const completed = structuredClone(app.saved().records[0]);
  app.nodes.get('start-time').value = '0:50.00'; app.nodes.get('end-time').value = '1:00.00';
  await app.click('confirm-normal');
  const edited = app.saved().records[0];
  assert.equal(edited.reviewComplete, false);
  assert.ok(!edited.reviewCompletedAt);
  assert.deepEqual(edited.reviewedRanges, [{ start: 50, end: 60 }], 'editing the saved draft replaces its previous range');
  await app.click('undo');
  assert.deepEqual(app.saved().records[0], completed, 'undo restores both label data and completion metadata');
  await app.click('complete-review');
  assert.equal(app.saved().records[0].reviewComplete, false, 'clicking a completed review reopens it');
  assert.deepEqual(app.saved().records[0].reviewedRanges, completed.reviewedRanges);
});
test('real app uncertain-only review may complete without turning uncertainty into reviewed coverage', async () => {
  const app = await appHarness();
  await app.click('confirm-uncertain'); await app.click('complete-review');
  const completed = app.saved().records[0];
  assert.equal(completed.reviewComplete, true);
  assert.equal(completed.status, 'unreviewed');
  assert.deepEqual(completed.reviewedRanges, []);
  assert.equal(completed.segments[0].label, 'uncertain');
  assert.equal(completed.segments[0].confidence, 'uncertain');
  await app.click('export-feedback');
  assert.deepEqual(JSON.parse(app.nodes.get('feedback-json').value).records[0].reviewedRanges, []);
});
test('real app import rebinds the edited range after an earlier imported interval changes sort order', async () => {
  const app = await appHarness();
  await app.click('confirm-ad');
  const incoming = structuredClone(app.saved());
  incoming.records[0].segments = [human(0, 5, 'normal')];
  app.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(incoming) }];
  await app.nodes.get('feedback-file').dispatch('change');
  assert.deepEqual(app.saved().records[0].segments.map(({ start, end, label }) => ({ start, end, label })),
    [{ start: 0, end: 5, label: 'normal' }, { start: 10, end: 20, label: 'ad' }]);
  assert.equal(app.nodes.get('start-time').value, '0:10.00');
  assert.equal(app.nodes.get('end-time').value, '0:20.00');
  app.nodes.get('start-time').value = '0:12.00';
  await app.click('confirm-ad');
  assert.deepEqual(app.saved().records[0].segments.map(({ start, end, label }) => ({ start, end, label })),
    [{ start: 0, end: 5, label: 'normal' }, { start: 12, end: 20, label: 'ad' }],
    'editing the selected ad must preserve the newly imported normal range and replace the original ad');
});
test('real app preserves completion when identical legacy feedback omits the field, but respects explicit false', async () => {
  const app = await appHarness();
  await app.click('confirm-ad'); await app.click('complete-review');
  const completed = structuredClone(app.saved().records[0]);
  const legacy = structuredClone(app.saved());
  delete legacy.records[0].reviewComplete;
  delete legacy.records[0].reviewCompletedAt;
  app.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(legacy) }];
  await app.nodes.get('feedback-file').dispatch('change');
  assert.equal(app.saved().records[0].reviewComplete, true, 'missing legacy metadata is not an explicit request to reopen review');
  assert.equal(app.saved().records[0].reviewCompletedAt, completed.reviewCompletedAt);
  assert.deepEqual(app.saved().records[0].reviewedRanges, completed.reviewedRanges);
  const reopened = structuredClone(legacy);
  reopened.records[0].reviewComplete = false;
  app.nodes.get('feedback-file').files = [{ size: 1000, text: async () => JSON.stringify(reopened) }];
  await app.nodes.get('feedback-file').dispatch('change');
  assert.equal(app.saved().records[0].reviewComplete, false, 'an explicitly imported incomplete state reopens the review');
  assert.ok(!app.saved().records[0].reviewCompletedAt);
  assert.deepEqual(app.saved().records[0].reviewedRanges, completed.reviewedRanges);
  assert.deepEqual(app.saved().records[0].segments, completed.segments);
});
test('read-only server handler exposes only generated HTML and rejects writes and paths', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-review-http-')), file = path.join(tmp, 'review.html');
  fs.writeFileSync(file, '<!doctype html><title>review</title>');
  const server = createServer(file);
  try {
    // Exercise the real request handler without requiring socket permission in CI.
    const request = (route, method = 'GET') => new Promise(resolve => {
      const headers = {}; let status = 200;
      server.emit('request', { url: route, method }, {
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        writeHead(code, extra) { status = code; Object.assign(headers, extra); },
        end(body) { resolve({ status, body: body == null ? '' : String(body), headers }); }
      });
    });
    assert.equal((await request('/')).status, 200); assert.equal((await request('/review.html')).status, 200);
    assert.equal((await request('/core.js')).status, 404); assert.equal((await request('/../package.json')).status, 404);
    assert.equal((await request('/', 'POST')).status, 405); assert.equal((await request('/', 'HEAD')).body, '');
    assert.match((await request('/')).headers['content-security-policy'], /connect-src 'none'/);
  } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
