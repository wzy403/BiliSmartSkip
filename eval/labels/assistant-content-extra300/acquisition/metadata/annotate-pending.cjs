#!/usr/bin/env node
// Attach existing identity-recovery diagnostics; never changes identity or review decisions.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const base = path.resolve(__dirname, '../..');
const root = path.resolve(base, '../../..');
if (cp.execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() !== 'test-branch') throw new Error('Requires test-branch');
const summaryFile = path.join(__dirname, 'metadata-recovery-summary.json');
const bytes = fs.readFileSync(summaryFile);
const summary = JSON.parse(bytes);
const summarySha256 = crypto.createHash('sha256').update(bytes).digest('hex');
let updated = 0;
const skipped = [];
for (const attempt of summary.records) {
  const file = path.join(base, 'records', `${attempt.bvid}.json`);
  const item = JSON.parse(fs.readFileSync(file));
  if (item.record.reviewStatus !== 'needs-source' || item.record.fullTranscriptRead) { skipped.push(attempt.bvid); continue; }
  if (item.record.bvid !== attempt.bvid || item.record.cid !== attempt.cid || item.source.inputSha256 !== summary.inputSha256 || item.source.inputLine !== attempt.inputLine || item.source.inputLineSha256 !== attempt.inputRecordSha256) throw new Error(`Identity/hash mismatch: ${attempt.bvid}`);
  let reason;
  if (attempt.reason === 'requested-cid-not-present-in-video') {
    reason = `公开页补采返回了原 BV，但原 CID ${attempt.cid} 不在当前分 P 列表；当前列出的 CID 为 ${(attempt.availablePages || []).map(p => p.cid).join('、') || '无'}。未以新 CID 替换原身份，仍缺原视频可核实资料。`;
  } else if (attempt.reason === 'unexpected-or-missing-video-identity') {
    reason = `公开页补采 HTTP ${attempt.httpStatus}，但未取得与原 BV/CID 一致的视频身份（返回 BV：${attempt.returnedBvid || '缺失'}）；HTTP 成功不代表视频资料可用，也不能据此推定删除或无广告。`;
  } else if (attempt.reason === 'Video metadata not present in public page') {
    reason = `公开页补采 HTTP ${attempt.httpStatus}，既有 initialState 解析器未找到视频元数据，原 BV/CID 身份仍未核实；未将页面请求成功计为恢复成功。`;
  } else {
    reason = `公开页补采未恢复原 BV/CID 身份，具体采集原因：${attempt.reason}。`;
  }
  const marker = '元数据补采诊断：';
  item.record.pendingReasons = [...item.record.pendingReasons.filter(x => !x.startsWith(marker)), marker + reason];
  item.metadataRecovery = {
    kind: 'identity-recovery-diagnostic-not-content-review',
    file: path.relative(root, summaryFile), sha256: summarySha256,
    inputLine: attempt.inputLine, bvid: attempt.bvid, cid: attempt.cid,
    attemptedAt: attempt.observedAt, method: summary.method,
    url: attempt.url, status: attempt.status, httpStatus: attempt.httpStatus,
    responseSha256: attempt.responseSha256, reason: attempt.reason,
    returnedBvid: attempt.returnedBvid ?? null,
    availableCids: (attempt.availablePages || []).map(p => ({ cid: p.cid, page: p.page, duration: p.duration })),
    limitation: '仅元数据与身份补采诊断，未读取社区广告标签或作为内容审核；原 BV/CID 保持不变。'
  };
  fs.writeFileSync(file, JSON.stringify(item, null, 2) + '\n');
  updated++;
}
console.log(JSON.stringify({ updated, skipped, note: 'prepare-sources overwrites unreviewed placeholders; rerun this helper after the final source refresh.' }));
