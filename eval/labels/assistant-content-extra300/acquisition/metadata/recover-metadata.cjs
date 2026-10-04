// Content-only metadata recovery using the existing public-page parser.
// Does not collect danmaku, predictions, community labels, or annotations.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { initialState } = require('../../../../collect-public.cjs');
const out = __dirname;
const input = path.resolve(__dirname, '../../../../data/danmaku-audit-20261001/new-public.jsonl');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const raw = await fs.readFile(input);
  const sourceLines = raw.toString('utf8').trim().split('\n');
  const rows = sourceLines.map(JSON.parse);
  const failed = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => ['failed', 'error'].includes(row.acquisition?.metadata));
  const summary = { schemaVersion: 1, source: path.relative(process.cwd(), input), inputSha256: sha256(raw),
    method: 'anonymous-public-page-metadata-only-existing-initialState-parser', startedAt: new Date().toISOString(),
    total: failed.length, attempted: 0, recovered: 0, unresolved: 0, unattempted: 0, paused: false, records: [] };
  const recovered = [];
  for (const { row, index } of failed) {
    const result = { bvid: row.bvid, cid: row.cid, inputLine: index + 1, inputRecordSha256: sha256(sourceLines[index]),
      url: `https://www.bilibili.com/video/${row.bvid}/`, observedAt: new Date().toISOString(), status: 'pending' };
    if (summary.paused) {
      result.status = 'not-attempted'; result.reason = 'paused-after-access-restriction'; summary.unattempted++;
    } else {
      if (summary.attempted) await new Promise(resolve => setTimeout(resolve, 1500));
      summary.attempted++;
      try {
        const response = await fetch(result.url, { signal: AbortSignal.timeout(20000),
          headers: { 'User-Agent': 'BiliSmartSkip-public-evaluation/1.0', Referer: 'https://www.bilibili.com/' } });
        result.httpStatus = response.status;
        if (!response.ok) {
          if ([401, 403, 412, 429].includes(response.status)) summary.paused = true;
          throw new Error(`http-${response.status}`);
        }
        const html = await response.text();
        result.responseSha256 = sha256(html);
        const state = initialState(html);
        const video = state.videoData;
        result.returnedBvid = video?.bvid || null;
        if (!video || video.bvid !== row.bvid) throw new Error('unexpected-or-missing-video-identity');
        const pages = (video.pages || []).map(p => ({ cid: p.cid, page: p.page, duration: p.duration, part: p.part }));
        result.availablePages = pages;
        const page = pages.find(p => String(p.cid) === String(row.cid));
        if (!page) throw new Error('requested-cid-not-present-in-video');
        const restored = { bvid: row.bvid, cid: row.cid, page: page.page, title: video.title || '',
          duration: page.duration || video.duration || row.duration,
          creator: { mid: video.owner?.mid || null, name: video.owner?.name || '' },
          category: video.tname_v2 || video.tname || 'unknown', desc: video.desc || '', subtitles: [], chapters: [],
          acquisition: { metadata: 'available', metadataMethod: summary.method, metadataRecoveredAt: result.observedAt,
            subtitles: 'unavailable', subtitleReason: 'not-yet-collected', metadataSource: result.url },
          provenance: { input: summary.source, inputSha256: summary.inputSha256, inputRecordSha256: result.inputRecordSha256,
            inputLine: result.inputLine, responseSha256: result.responseSha256 } };
        result.status = 'recovered'; result.title = restored.title; result.duration = restored.duration;
        await fs.writeFile(path.join(out, `${row.bvid}-${row.cid}.json`), JSON.stringify(restored, null, 2) + '\n');
        recovered.push(restored); summary.recovered++;
      } catch (error) {
        result.status = 'unresolved'; result.reason = error.message;
        if (error.cause?.code) result.networkCode = error.cause.code;
        summary.unresolved++;
      }
    }
    summary.records.push(result);
    await fs.writeFile(path.join(out, 'metadata-recovery-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ bvid: result.bvid, cid: result.cid, status: result.status, reason: result.reason }));
  }
  const recoveredText = recovered.map(r => JSON.stringify(r)).join('\n') + (recovered.length ? '\n' : '');
  await fs.writeFile(path.join(out, 'recovered-for-subtitles.jsonl'), recoveredText);
  summary.completedAt = new Date().toISOString();
  summary.recoveredInputSha256 = sha256(recoveredText);
  await fs.writeFile(path.join(out, 'metadata-recovery-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ total: summary.total, attempted: summary.attempted, recovered: summary.recovered,
    unresolved: summary.unresolved, unattempted: summary.unattempted, paused: summary.paused }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
