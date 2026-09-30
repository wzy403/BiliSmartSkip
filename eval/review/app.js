(function () {
  'use strict';
  const C = window.ReviewCore, $ = id => document.getElementById(id);
  const names = { model: '实验模型 · 仅供复核', topics: '完整段落实验', rules: '当前字幕规则', legacy: '旧版 88652 字幕', conservative: '第一版保守字幕', pipeline: '当前多来源最终结果', assistant: '助手预标注', human: '人工已保存' };
  const splitNames = { train: '训练集', holdout: '保留集', development: '开发集', 'legacy-development': '早期开发集', 'seen-creator': '已见作者', regression: '回归样本', 'creator-overflow': '作者额外样本', unknown: '未指定分组' };
  const sources = { 'danmaku-time': '弹幕时轴', subtitles: '字幕', chapters: '章节', description: '视频简介', 'danmaku-keywords': '弹幕关键词', 'local-model-experimental': '实验模型' };
  const contentNames = { ad: '广告', non_ad: '非广告', uncertain: '不确定' };
  const skipNames = { skip: '跳过', keep: '保留', uncertain: '待定' };
  const describe = segment => { const value = C.axes(segment); return `内容：${contentNames[value.contentType]}${value.contentConfidence === 'high' ? '' : '（待核实）'} · 决定：${skipNames[value.skipDecision]}${value.skipConfidence === 'high' ? '' : '（待核实）'}`; };
  const batchEligible = segment => { const value = C.axes(segment); return value.skipDecision === 'skip' && value.skipConfidence === 'high' && segment.boundaryConfidence === 'high'; };
  let bundle = null, datasetHash = '', storageKey = '', selectedKey = '', draftSource = '', editingIndex = null, draftSegment = null;
  let saved = new Map(), undoStack = [], batchSelection = new Set(), ordered = [], visible = [];
  let storageFailed = false;
  const el = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content != null) node.textContent = content; return node; };
  const button = (title, action, className = 'secondary') => { const node = el('button', className, title); node.type = 'button'; node.addEventListener('click', action); return node; };
  const record = () => bundle?.records.find(value => C.key(value) === selectedKey);
  const segments = () => saved.get(selectedKey)?.segments || [];
  const span = segment => `${C.formatTime(segment.start)} – ${C.formatTime(segment.end)}`;
  const sameRange = (a, b) => Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6;
  const matchingHuman = proposal => segments().filter(done => C.iou(proposal, done) >= 0.8)
    .sort((a, b) => C.iou(proposal, b) - C.iou(proposal, a))[0];
  function message(value, error = false) { $('message').textContent = value; $('message').className = `message${error ? ' error' : ''}`; }
  function guarded(action) { try { action(); } catch (error) { message(error.message, true); } }
  function linkTo(time) {
    const current = record();
    return `https://www.bilibili.com/video/${current.bvid}/?p=${current.page}&t=${Math.max(0, Math.floor(time))}`;
  }
  async function sha256(value) {
    // localhost and modern file:// contexts support WebCrypto. Do not silently use a weaker namespace.
    if (!globalThis.crypto?.subtle) throw new Error('浏览器未提供 SHA-256。请使用 localhost 服务打开本页。');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const feedback = () => ({ schemaVersion: 1, kind: 'human-review', datasetSha256: datasetHash,
    modelSha256: bundle.modelSha256, exportedAt: new Date().toISOString(), records: [...saved.values()].filter(value => value.segments.length) });
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ feedback: feedback(), selectedKey })); storageFailed = false; }
    catch { storageFailed = true; message('浏览器未能保存本地进度。请导出人工反馈以免丢失；当前页面仍可继续审核。', true); }
  }
  async function loadBundle(input) {
    const normalized = C.normalizeBundle(input);
    // generatedAt changes do not invalidate otherwise identical review data.
    const digest = await sha256(JSON.stringify({ ...normalized, generatedAt: '' }));
    bundle = normalized; datasetHash = digest;
    storageKey = `bilismartskip-review:v1:${digest}:${bundle.modelSha256 || 'unversioned'}`;
    saved = new Map(); undoStack = []; selectedKey = ''; storageFailed = false;
    let recovered = 0, recoveryError = '';
    try {
      const previous = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (previous?.feedback) {
        const entries = C.normalizeFeedback(previous.feedback, bundle, { datasetSha256: datasetHash });
        saved = new Map(entries.map(value => [C.key(value), value])); recovered = entries.length;
        if (bundle.records.some(value => C.key(value) === previous.selectedKey)) selectedKey = previous.selectedKey;
      }
    } catch (error) { recoveryError = `本地历史未载入：${error.message}。`; }
    ordered = [...bundle.records].sort((a, b) => C.priority(b).score - C.priority(a).score || a.bvid.localeCompare(b.bvid));
    selectedKey ||= C.key(ordered[0]);
    $('main').hidden = false; $('empty-state').hidden = true; $('export-feedback').disabled = false;
    $('dataset-info').textContent = `${bundle.records.length} 个视频 · 数据 ${digest.slice(0, 10)} · 模型 ${bundle.modelSha256?.slice(0, 10) || '未指定'}`;
    $('search').value = ''; $('filter').value = 'all';
    $('split-filter').replaceChildren();
    for (const split of ['all', ...new Set(bundle.records.map(value => value.split))]) {
      const option = el('option', '', split === 'all' ? '全部' : `${splitNames[split] || split} · ${split}`); option.value = split; $('split-filter').append(option);
    }
    $('split-filter').value = 'all';
    renderQueue(); select(selectedKey);
    message(`${recoveryError}已加载 ${bundle.records.length} 个视频${recovered ? `，恢复 ${recovered} 个视频的人工记录` : ''}。预标注尚未计入人工反馈。`, Boolean(recoveryError));
  }
  function renderQueue() {
    if (!bundle) return;
    const query = $('search').value.trim().toLowerCase(), filter = $('filter').value, split = $('split-filter').value;
    visible = ordered.filter(value => {
      const state = saved.get(C.key(value)), hasReviewed = (state?.reviewedRanges.length || 0) > 0, priority = C.priority(value);
      return (!query || `${value.title} ${value.bvid} ${value.creator}`.toLowerCase().includes(query))
        && (split === 'all' || value.split === split)
        && (filter === 'all' || (filter === 'reviewed' && hasReviewed) || (filter === 'unreviewed' && !hasReviewed)
          || (filter === 'pending' && !state?.reviewComplete) || (filter === 'completed' && state?.reviewComplete)
          || (filter === 'assistant-any' && value.assistantSegments.length > 0)
          || (filter === 'assistant-uncertain' && !state?.reviewComplete && value.assistantSegments.some(segment => segment.confidence !== 'high' || segment.boundaryConfidence !== 'high'))
          || priority[filter] === true);
    });
    const queue = $('queue'); queue.replaceChildren();
    for (const value of visible) {
      const id = C.key(value), priority = C.priority(value), state = saved.get(id);
      const item = button('', () => select(id), `queue-item${id === selectedKey ? ' selected' : ''}`);
      item.setAttribute('aria-current', id === selectedKey ? 'true' : 'false');
      item.append(el('strong', '', value.title || value.bvid), el('span', 'small muted', `${value.bvid} · ${value.split}`));
      item.append(el('span', 'small', `${state?.reviewComplete ? '✓ 本条核对完成' : state?.segments.length ? `● 已保存 ${state.segments.length} 段 · 可标记完成` : '○ 待核对'} · 优先级 ${priority.score}`));
      queue.append(item);
    }
    if (!visible.length) queue.append(el('p', 'muted', '没有符合筛选条件的视频。'));
    const confirmed = [...saved.values()].filter(value => value.reviewedRanges.length).length;
    const completed = [...saved.values()].filter(value => value.reviewComplete).length;
    $('queue-summary').textContent = `${visible.length} 条符合筛选 · ${completed} 条核对完成 · ${confirmed} 个视频有确定范围`;
  }
  function select(id) {
    selectedKey = id; editingIndex = null; batchSelection = new Set();
    const current = record(); if (!current) return;
    current.assistantSegments.forEach((segment, index) => {
      if (batchEligible(segment)
        && !matchingHuman(segment)) batchSelection.add(index);
    });
    $('video-title').textContent = current.title || current.bvid;
    $('video-meta').textContent = `${current.bvid} · CID ${current.cid} · ${current.creator || 'UP 未知'} · ${C.formatTime(current.duration)} · ${current.split}`;
    $('priority-reasons').replaceChildren(...C.priority(current).reasons.map(reason => el('span', 'badge', reason)));
    const proposal = current.assistantSegments.find(value => C.axes(value).skipDecision === 'skip') || current.predictions.model.segments[0]
      || current.predictions.pipeline.segments[0] || current.predictions.rules.segments[0] || current.predictions.legacy.segments[0];
    const done = proposal && matchingHuman(proposal);
    loadDraft(done || proposal || { start: 0, end: Math.min(10, current.duration) }, done ? '已保存的人工范围' : proposal ? '预标注草稿' : '自选待核对范围', done ? segments().indexOf(done) : null);
    renderCurrent(); renderQueue(); persist();
  }
  function renderCurrent() { renderTimeline(); renderProposals(); renderAssistant(); renderHuman(); }
  function metadata(segment) {
    return [segment.source && (sources[segment.source] || segment.source), segment.reason,
      Number.isFinite(segment.score) && `分数 ${segment.score.toFixed(3)}（未经校准）`,
      segment.matchedKeywords?.length && `命中：${segment.matchedKeywords.join('、')}`,
      Number.isFinite(segment.explicitCount) && `明确跳转 ${segment.explicitCount} / 时间引用 ${segment.referenceCount ?? '?'}`].filter(Boolean).join(' · ');
  }
  function renderTimeline() {
    const current = record(), container = $('timeline'); container.replaceChildren();
    const rows = [...Object.entries(current.predictions).map(([name, value]) => [name, value.segments]), ['assistant', current.assistantSegments], ['human', segments()]];
    for (const [source, intervals] of rows) {
      const row = el('div', 'timeline-row'), label = el('span', 'timeline-label small', names[source]), track = el('div', 'timeline-track');
      if (!intervals.length) track.append(el('span', 'timeline-empty small', '无候选 / 无确认范围'));
      for (const segment of intervals) {
        const bar = button('', () => loadDraft(segment, names[source]), `interval-bar ${source} ${segment.label}`);
        bar.style.left = `${segment.start / current.duration * 100}%`; bar.style.width = `${(segment.end - segment.start) / current.duration * 100}%`;
        bar.title = `${names[source]} ${span(segment)} ${describe(segment)}`; bar.setAttribute('aria-label', bar.title); track.append(bar);
      }
      row.append(label, track); container.append(row);
    }
    container.append(el('div', 'timeline-scale small muted', `0:00　　　　　　　　　　　　　　　　　全片 ${C.formatTime(current.duration)}`));
  }
  function renderProposals() {
    const container = $('proposals'); container.replaceChildren();
    for (const [source, prediction] of Object.entries(record().predictions)) {
      const card = el('div', `proposal ${source}`); card.append(el('h4', '', names[source]));
      if (source === 'pipeline') card.append(el('p', 'small', prediction.available ? `${prediction.automatic ? '会自动跳过' : '需要确认 / 未跳过'} · 生产多来源选择` : '当前记录缺少重放输入'));
      if (source === 'model' || source === 'topics') card.append(el('p', 'small muted', source === 'model' ? `阈值 ${prediction.threshold} · 始终仅供复核` : '完整段落候选实验 · 尚未经人工验证'),
        el('p', 'small', prediction.predictionMode === 'creator-held-out-development-fold'
          ? `作者留出预测 · 第 ${prediction.fold + 1} 折` : '初始模型预测'),
        el('p', 'small muted', prediction.modelSha256 ? `模型 ${prediction.modelSha256.slice(0, 10)}` : ''));
      if (!prediction.segments.length) card.append(el('p', 'muted small', '没有候选。未检出不代表已确认正常。'));
      for (const segment of prediction.segments) {
        card.append(button(span(segment), () => loadDraft(segment, names[source]), 'range-link'), el('p', 'small semantic-summary', describe(segment)), el('p', 'small evidence', metadata(segment)));
      }
      container.append(card);
    }
  }
  function renderAssistant() {
    const container = $('assistant-drafts'); container.replaceChildren();
    record().assistantSegments.forEach((segment, index) => {
      const row = el('div', 'assistant-row'), done = matchingHuman(segment);
      const eligible = !done && batchEligible(segment);
      if (eligible) {
        const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = batchSelection.has(index);
        checkbox.setAttribute('aria-label', `加入批量确认 ${span(segment)}`);
        checkbox.addEventListener('change', () => { checkbox.checked ? batchSelection.add(index) : batchSelection.delete(index); $('confirm-batch').disabled = !batchSelection.size; });
        row.append(checkbox);
      } else batchSelection.delete(index);
      const detail = el('div'); detail.append(button(span(segment), () => loadDraft(segment, '助手预标注'), 'range-link'),
        el('span', 'badge', `范围边界 ${segment.boundaryConfidence === 'high' ? '明确' : '待审'}`), el('p', 'small semantic-summary', describe(segment)), el('p', 'small', segment.reason || '无附加说明'));
      if (done) detail.append(el('p', 'small saved-state', `${sameRange(segment, done) ? '✓ 已保存人工标注' : '已有相近人工标注（边界不同）'}：${describe(done)} ${span(done)}`),
        button('查看已保存范围', () => loadDraft(done, '已保存的人工范围', segments().indexOf(done)), 'text-button'));
      else detail.append(el('p', 'small muted', eligible ? '勾选仅用于批量确认；也可点击区间逐段核对。' : '点击区间，在下方核对后确认；无需勾选。'));
      row.append(detail); container.append(row);
    });
    if (!record().assistantSegments.length) container.append(el('p', 'muted small', '暂无助手预标注，可从模型 / 规则候选载入，或在字幕中自选范围。'));
    $('confirm-batch').disabled = !batchSelection.size;
  }
  function loadDraft(segment, source, index = null) {
    if (index == null) {
      const found = segments().findIndex(done => sameRange(done, segment) && (!segment.label && !C.hasAxes(segment) || C.axes(done).skipDecision === C.axes(segment).skipDecision));
      if (found >= 0) { index = found; segment = segments()[found]; }
    }
    editingIndex = index; draftSource = source; draftSegment = segment;
    const semantic = C.axes(segment);
    $('content-type').value = semantic.contentType; $('content-confidence').value = semantic.contentConfidence;
    $('content-confidence').disabled = semantic.contentType === 'uncertain';
    $('draft-skip-state').textContent = `当前${index == null ? '建议' : '已保存决定'}：${skipNames[semantic.skipDecision]}${semantic.skipConfidence === 'high' ? '（确定）' : '（待核实）'}`;
    $('start-time').value = C.formatInputTime(segment.start); $('end-time').value = C.formatInputTime(segment.end);
    $('reason').value = segment.reason || ''; $('full-range-ack').checked = false;
    refreshDraft();
  }
  function renderDraftState() {
    let unchanged = false;
    try { const done = segments()[editingIndex], semantic = done && C.axes(done); unchanged = Boolean(done && sameRange(done, draftRange()) && done.reason === $('reason').value
      && semantic.contentType === $('content-type').value && semantic.contentConfidence === $('content-confidence').value); } catch {}
    $('draft-source').textContent = unchanged ? '✓ 当前人工范围已保存；可编辑后再次确认' : `${draftSource} · ${editingIndex != null ? '修改尚未保存；确认后替换此人工范围' : '尚未保存'}`;
  }
  function draftRange() { return C.range({ start: C.parseTime($('start-time').value), end: C.parseTime($('end-time').value) }, record().duration); }
  function refreshDraft() {
    renderDraftState();
    try {
      const value = draftRange(); $('open-start').href = linkTo(Math.max(0, value.start - 3)); $('open-end').href = linkTo(Math.max(0, value.end - 5));
      $('full-range-note').hidden = value.end - value.start < record().duration * 0.9;
    } catch { $('open-start').removeAttribute('href'); $('open-end').removeAttribute('href'); $('full-range-note').hidden = true; }
    renderSubtitles();
  }
  function renderSubtitles() {
    if (!record()) return;
    let value; try { value = draftRange(); } catch { value = { start: 0, end: 10 }; }
    const all = $('all-subtitles').checked, current = record(), container = $('subtitle-list'); container.replaceChildren();
    const visibleLines = current.subtitles.filter(line => all || (line.to >= value.start - 15 && line.from <= value.end + 15));
    for (const line of visibleLines) {
      const row = el('div', `subtitle-row${line.to > value.start && line.from < value.end ? ' in-range' : ''}`);
      const scores = current.predictions.model.lines.filter(scored => scored.from === line.from || (scored.from < line.to && scored.to > line.from));
      const score = scores.length ? Math.max(...scores.map(scored => scored.score)) : null;
      const choose = (which) => { $(which === 'start' ? 'start-time' : 'end-time').value = C.formatInputTime(Math.min(current.duration, which === 'start' ? line.from : line.to)); $('full-range-ack').checked = false; refreshDraft(); };
      const content = button('', event => choose(event.shiftKey ? 'end' : 'start'), 'subtitle-content');
      content.append(el('span', 'small muted', `${C.formatTime(line.from)} – ${C.formatTime(line.to)}${score == null ? '' : ` · ${score.toFixed(3)}`}`), el('span', '', line.content));
      const controls = el('div', 'subtitle-controls'); controls.append(button('起', () => choose('start'), 'text-button'), button('止', () => choose('end'), 'text-button'));
      row.append(content, controls); container.append(row);
    }
    if (!visibleLines.length) container.append(el('p', 'muted', current.subtitles.length ? '当前范围附近没有字幕；可切换为全部字幕。' : '未取得字幕，请通过视频核对。'));
  }
  function changeSegments(next, announcement) {
    C.checkConflicts(next);
    undoStack.push({ key: selectedKey, value: saved.has(selectedKey) ? JSON.parse(JSON.stringify(saved.get(selectedKey))) : null });
    saved.set(selectedKey, C.feedbackRecord(record(), next)); editingIndex = null;
    persist(); renderCurrent(); renderQueue();
    if (!storageFailed) message(announcement);
  }
  function confirm(skipDecision) {
    const selected = draftRange();
    if (skipDecision === 'keep' && selected.end - selected.start >= record().duration * 0.9 && !$('full-range-ack').checked) throw new Error('不能一键把整片视为应保留；请先确认已完整检查所选范围，或缩小范围。');
    const semantic = { contentType: $('content-type').value, contentConfidence: $('content-confidence').value,
      skipDecision, skipConfidence: skipDecision === 'uncertain' ? 'uncertain' : 'high' };
    const provenance = {}, prior = C.axes(draftSegment || {});
    for (const field of ['contentTypeSource', 'skipDecisionSource', 'semanticMigration']) if (draftSegment?.[field] != null) provenance[field] = draftSegment[field];
    const contentChanged = semantic.contentType !== prior.contentType || semantic.contentConfidence !== prior.contentConfidence;
    const decisionChanged = semantic.skipDecision !== prior.skipDecision || semantic.skipConfidence !== prior.skipConfidence;
    if (contentChanged) delete provenance.contentTypeSource;
    if (decisionChanged) delete provenance.skipDecisionSource;
    if (contentChanged || decisionChanged || !sameRange(draftSegment, selected)) delete provenance.semanticMigration;
    const next = [...segments()], segment = C.humanSegment({ ...selected, ...semantic, ...provenance, boundaryConfidence: skipDecision === 'uncertain' ? 'uncertain' : 'high',
      origin: 'human', reviewedAt: new Date().toISOString(), proposalSource: draftSource, reason: $('reason').value }, record());
    if (editingIndex != null) next[editingIndex] = segment;
    else if (!next.some(done => sameRange(done, segment) && C.axes(done).skipDecision === skipDecision)) next.push(segment);
    changeSegments(next, `已保存 ${describe(segment)}，范围 ${span(segment)}；范围外仍然未知。`);
    loadDraft(segment, '已保存的人工范围', segments().findIndex(done => sameRange(done, segment) && C.axes(done).skipDecision === skipDecision));
  }
  function toggleReviewComplete() {
    const state = saved.get(selectedKey);
    if (!state?.segments.length) throw new Error('请先保存至少一个跳过、保留或待定范围，再标记本条核对完成。');
    undoStack.push({ key: selectedKey, value: JSON.parse(JSON.stringify(state)) });
    const reviewComplete = !state.reviewComplete;
    saved.set(selectedKey, C.feedbackRecord(record(), state.segments, new Date().toISOString(),
      { reviewComplete, reviewCompletedAt: reviewComplete ? new Date().toISOString() : '' }));
    persist(); renderCurrent(); renderQueue();
    if (!storageFailed) message(reviewComplete ? '本条核对完成。只使用你保存的范围，未查看的部分仍然未知；可继续下一条。' : '已重新打开本条核对，保存的范围保持不变。');
  }
  function confirmBatch() {
    const next = [...segments()]; let count = 0;
    for (const index of batchSelection) {
      const proposal = record().assistantSegments[index];
      if (!proposal || !batchEligible(proposal)) throw new Error('批量确认只支持跳过决定高置信、范围边界明确的建议');
      if (!next.some(done => sameRange(done, proposal) && C.axes(done).skipDecision === 'skip')) {
        next.push(C.humanSegment({ ...proposal, ...C.axes(proposal), origin: 'human', reviewedAt: new Date().toISOString(), proposalSource: 'assistant-batch-confirmed' }, record())); count++;
      }
    }
    C.checkConflicts(next); batchSelection.clear(); changeSegments(next, `你已确认 ${count} 个范围应跳过，内容性质按建议分别保留。其他建议仍未成为人工标签。`);
    select(selectedKey);
  }
  function renderHuman() {
    const container = $('human-segments'); container.replaceChildren();
    segments().forEach((segment, index) => {
      const row = el('div', 'human-row'); row.append(el('strong', C.axes(segment).label, `${describe(segment)} ${span(segment)}`), el('p', 'small', segment.reason));
      const actions = el('div', 'actions'); actions.append(button('编辑', () => loadDraft(segment, '人工范围编辑', index), 'text-button'),
        button('删除', () => guarded(() => changeSegments(segments().filter((_, i) => i !== index), '已删除该人工范围，可撤销。')), 'text-button danger'));
      row.append(actions); container.append(row);
    });
    const coverage = C.reviewedRanges(segments()), seconds = coverage.reduce((total, value) => total + value.end - value.start, 0);
    $('coverage').textContent = `已确认跳过 / 保留 ${C.formatTime(seconds)} / 全片 ${C.formatTime(record().duration)}（${(seconds / record().duration * 100).toFixed(1)}%）。内容性质不确定不影响明确的保留决定；跳过决定待定及未覆盖范围不计入覆盖。`;
    const complete = saved.get(selectedKey)?.reviewComplete;
    $('review-status').textContent = complete ? '✓ 本条核对完成。未查看部分仍然未知。' : segments().length ? `已保存 ${segments().length} 段。需要核对的片段处理好后，点击「本条核对完成」即可。` : '先保存需要核对的范围，再标记本条完成。';
    $('complete-review').textContent = complete ? '重新打开本条核对' : '本条核对完成';
    $('complete-review').disabled = !segments().length;
    if (!segments().length) container.append(el('p', 'small muted', '尚无人工记录。'));
    $('undo').disabled = !undoStack.length;
  }
  function advance(direction, unreviewed = false) {
    if (!visible.length) return;
    const index = visible.findIndex(value => C.key(value) === selectedKey);
    const base = index < 0 ? (direction > 0 ? -1 : 0) : index;
    for (let step = 1; step <= visible.length; step++) {
      const next = visible[(base + direction * step + visible.length) % visible.length];
      if (!unreviewed || !saved.get(C.key(next))?.reviewComplete) return select(C.key(next));
    }
    message('当前筛选结果都已完成本条核对；未标注时间仍然未知。');
  }
  function exportFeedback() {
    const snapshot = feedback(), json = JSON.stringify(snapshot, null, 2) + '\n';
    $('feedback-json').value = json; $('feedback-preview').hidden = false; $('feedback-preview').open = true;
    const blob = new Blob([json], { type: 'application/json' }), url = URL.createObjectURL(blob);
    const a = el('a'); a.href = url; a.download = `bilismartskip-human-review-${datasetHash.slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    message(`已生成 ${snapshot.records.length} 个视频的人工反馈并请求下载；如未下载，可展开查看 / 复制 JSON。未确认预标注不在其中。`);
  }
  async function readFile(input) { const file = input.files?.[0]; if (!file) return null; if (file.size > 100 * 1024 * 1024) throw new Error('文件过大（上限 100 MB）'); return JSON.parse(await file.text()); }
  $('bundle-file').addEventListener('change', async event => { try { const value = await readFile(event.target); if (value) await loadBundle(value); } catch (error) { message(error.message, true); } finally { event.target.value = ''; } });
  $('feedback-file').addEventListener('change', async event => {
    try {
      if (!bundle) throw new Error('请先加载审核数据');
      const value = await readFile(event.target); if (!value) return;
      const entries = C.normalizeFeedback(value, bundle, { datasetSha256: datasetHash, allowVersionMismatch: $('allow-cross-version').checked });
      const merged = new Map(saved);
      // Merge exact duplicate windows, but reject contradictory labels atomically.
      for (const entry of entries) {
        const rawEntry = value.records.find(item => C.key(item) === C.key(entry));
        const previous = merged.get(C.key(entry)), existing = previous?.segments || [], combined = [...existing];
        entry.segments.forEach(segment => {
          const target = C.axes(segment);
          let found = combined.findIndex(done => sameRange(done, segment)
            && C.axes(done).skipDecision === target.skipDecision && C.axes(done).skipConfidence === target.skipConfidence);
          // A definite imported human decision resolves the same pending range.
          // It does not create a second interval or reopen completed migration.
          if (found < 0 && target.skipConfidence === 'high' && target.skipDecision !== 'uncertain') {
            found = combined.findIndex(done => sameRange(done, segment)
              && (C.axes(done).skipDecision === 'uncertain' || C.axes(done).skipConfidence === 'uncertain'));
            if (found >= 0) { combined[found] = segment; return; }
          }
          if (found < 0) combined.push(segment);
          // Explicit axes can update an existing decision's content description.
          // Legacy feedback must not erase a newer independent content judgment.
          else if (rawEntry.segments.some(raw => sameRange(raw, segment) && C.hasAxes(raw)
            && C.axes(raw).skipDecision === target.skipDecision && C.axes(raw).skipConfidence === target.skipConfidence)) combined[found] = segment;
        });
        const explicitCompletion = Object.prototype.hasOwnProperty.call(rawEntry, 'reviewComplete');
        let completion = JSON.stringify(combined) === JSON.stringify(existing) ? previous : {};
        if (explicitCompletion && (!entry.reviewComplete || combined.length === entry.segments.length)) completion = entry;
        C.checkConflicts(combined); merged.set(C.key(entry), C.feedbackRecord(bundle.records.find(item => C.key(item) === C.key(entry)), combined, new Date().toISOString(), completion));
      }
      // Imported ranges may sort before the edited range; select rebinds its index.
      saved = merged; undoStack = []; select(selectedKey); message(`已导入并合并 ${entries.length} 个视频的人工记录。`);
    } catch (error) { message(error.message, true); } finally { event.target.value = ''; }
  });
  for (const id of ['search', 'filter', 'split-filter']) $(id).addEventListener('input', renderQueue);
  for (const id of ['start-time', 'end-time']) $(id).addEventListener('input', () => { $('full-range-ack').checked = false; refreshDraft(); });
  $('reason').addEventListener('input', renderDraftState);
  $('content-type').addEventListener('change', () => {
    const uncertain = $('content-type').value === 'uncertain';
    $('content-confidence').value = uncertain ? 'uncertain' : 'high';
    $('content-confidence').disabled = uncertain; renderDraftState();
  });
  $('content-confidence').addEventListener('change', renderDraftState);
  $('all-subtitles').addEventListener('change', renderSubtitles);
  for (const [id, decision] of [['confirm-ad', 'skip'], ['confirm-normal', 'keep'], ['confirm-uncertain', 'uncertain']]) $(id).addEventListener('click', () => guarded(() => confirm(decision)));
  $('confirm-batch').addEventListener('click', () => guarded(confirmBatch));
  $('complete-review').addEventListener('click', () => guarded(toggleReviewComplete));
  $('export-feedback').addEventListener('click', () => guarded(exportFeedback));
  $('copy-feedback').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('feedback-json').value); message('已复制本次生成的人工反馈 JSON。'); }
    catch { $('feedback-json').focus(); $('feedback-json').select(); message('浏览器未允许直接复制。已选中 JSON，请按 Ctrl+C / Command+C 复制。'); }
  });
  $('previous').addEventListener('click', () => advance(-1)); $('next').addEventListener('click', () => advance(1)); $('next-unreviewed').addEventListener('click', () => advance(1, true));
  $('undo').addEventListener('click', () => guarded(() => {
    const previous = undoStack.pop(); if (!previous) return;
    previous.value ? saved.set(previous.key, previous.value) : saved.delete(previous.key);
    select(previous.key); message('已撤销上一步审核修改。');
  }));
  document.addEventListener('keydown', event => {
    if (!bundle) return;
    if (event.altKey && event.key === 'Enter') { event.preventDefault(); return guarded(() => confirm('skip')); }
    if (event.ctrlKey || event.altKey || event.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.key.toLowerCase() === 'j') advance(1); else if (event.key.toLowerCase() === 'k') advance(-1); else if (event.key.toLowerCase() === 'n') advance(1, true); else return;
    event.preventDefault();
  });
  try { const embedded = JSON.parse($('embedded-bundle').textContent); if (embedded) loadBundle(embedded).catch(error => message(error.message, true)); }
  catch (error) { message(`内嵌审核数据无效：${error.message}`, true); }
})();
