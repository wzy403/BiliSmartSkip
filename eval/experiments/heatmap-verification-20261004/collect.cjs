// Read only 24 preselected development curves and one separate user case.
// No cookies, credentials, video downloads, retries, or benchmark rewrites.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const directory = __dirname;
const sampleBytes = fs.readFileSync(path.join(directory, 'sample.json'));
const sample = JSON.parse(sampleBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const responseDirectory = path.join(directory, 'responses');
fs.mkdirSync(responseDirectory, { recursive: true });
const report = { capturedAt: new Date().toISOString(), sampleSha256: sha(sampleBytes),
  schema: 'modules[name=pbp].params.data', credentials: 'none', records: [] };

function get(url) {
  const result = execFileSync('curl', ['--silent', '--show-error', '--connect-timeout', '5',
    '--max-time', '15', '--write-out', '\n%{http_code}', url], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const lastLine = result.lastIndexOf('\n');
  return { status: Number(result.slice(lastLine + 1)), body: result.slice(0, lastLine) };
}

for (const video of [...sample.videos, ...sample.auxiliaryCases]) {
  const record = { bvid: video.bvid, cid: video.cid, capturedAt: new Date().toISOString() };
  report.records.push(record);
  try {
    const metaUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(video.bvid)}`;
    const meta = get(metaUrl);
    record.metadataStatus = meta.status;
    if (meta.status === 412 || meta.status === 429) throw new Error('risk-control-stop');
    if (meta.status !== 200) throw new Error('metadata-unavailable');
    const parsed = JSON.parse(meta.body);
    if (parsed.code !== 0 || !Number.isSafeInteger(parsed.data?.aid)
      || !parsed.data.pages?.some(page => page.cid === video.cid)) throw new Error('metadata-identity-unavailable');
    record.aid = parsed.data.aid;
    record.url = `https://bvc.bilivideo.com/pbp/data?aid=${record.aid}&cid=${video.cid}&bvid=${encodeURIComponent(video.bvid)}&r=loader`;
    const heat = get(record.url);
    record.heatStatus = heat.status;
    if (heat.status === 412 || heat.status === 429) throw new Error('risk-control-stop');
    if (heat.status !== 200) throw new Error('heat-unavailable');
    JSON.parse(heat.body);
    fs.writeFileSync(path.join(responseDirectory, `${video.bvid}.json`), heat.body);
    record.sha256 = sha(heat.body);
  } catch (error) {
    record.error = error.message;
    if (error.message === 'risk-control-stop') {
      report.stoppedEarly = true;
      break;
    }
  }
  console.log(`${video.bvid}: ${record.error || 'saved'}`);
}
fs.writeFileSync(path.join(directory, 'acquisition.json'), JSON.stringify(report, null, 2) + '\n');
