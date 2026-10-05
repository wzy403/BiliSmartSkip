// Public, credential-free PBP side-data collection for the frozen 438 identities.
// Does not read predictions, review records, subtitles, or danmaku. No retries.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');

const ROOT = path.resolve(__dirname, '../../..');
const MANIFEST = 'eval/benchmarks/content-438-v1/manifest.json';
const MANIFEST_SHA = '9293860c178d883a8a809e21829a24c366b013cd89a4a88b01ca1dd1a27b074a';
const PRIOR = path.resolve(__dirname, '../heatmap-verification-20261004');
const REPORT = path.join(__dirname, 'acquisition.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function readStoredBytes(record, fileKey, directory = __dirname) {
  const bytes = fs.readFileSync(path.join(directory, record[fileKey]));
  if (fileKey !== 'metadataFile') return bytes;
  if (record.metadataEncoding === 'gzip') return gunzipSync(bytes);
  if (record.metadataEncoding && record.metadataEncoding !== 'identity') {
    throw new Error(`Unsupported metadata encoding: ${record.metadataEncoding}`);
  }
  return bytes;
}

function request(url) {
  return new Promise((resolve, reject) => {
    // --disable must be first: do not inherit a user's curlrc, cookies or auth.
    execFile('curl', ['--disable', '--silent', '--show-error', '--connect-timeout', '5',
      '--max-time', '15', '--write-out', '\n%{http_code}', url],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`curl-${error.code}: ${String(stderr).trim().slice(0, 300)}`));
      const boundary = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(boundary + 1)), body: stdout.slice(0, boundary) });
    });
  });
}

function initialize() {
  const manifestBytes = fs.readFileSync(path.join(ROOT, MANIFEST));
  if (sha(manifestBytes) !== MANIFEST_SHA) throw new Error('Frozen manifest hash changed');
  const identities = JSON.parse(manifestBytes).records.map(({ bvid, cid, duration }) => ({ bvid, cid, duration }));
  if (identities.length !== 438 || new Set(identities.map(item => item.bvid)).size !== 438
    || identities.some(item => !/^BV[0-9A-Za-z]+$/.test(item.bvid)
      || !Number.isSafeInteger(item.cid) || item.cid <= 0 || !Number.isFinite(item.duration) || item.duration <= 0)) {
    throw new Error('Unexpected frozen identities');
  }
  fs.mkdirSync(path.join(__dirname, 'responses'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'metadata'), { recursive: true });
  if (fs.existsSync(REPORT)) {
    const saved = json(REPORT);
    if (saved.manifestSha256 !== MANIFEST_SHA || saved.records.length !== identities.length
      || saved.records.some((item, index) => ['bvid', 'cid', 'duration'].some(key => item[key] !== identities[index][key]))) {
      throw new Error('Resume identity mismatch');
    }
    for (const item of saved.records) {
      for (const [fileKey, hashKey] of [['responseFile', 'sha256'], ['metadataFile', 'metadataSha256']]) {
        if (item[fileKey] && sha(readStoredBytes(item, fileKey)) !== item[hashKey]) {
          throw new Error(`Resume response hash mismatch: ${item.bvid}/${fileKey}`);
        }
      }
    }
    return saved;
  }
  const previous = json(path.join(PRIOR, 'acquisition.json'));
  const previousById = new Map(previous.records.map(item => [item.bvid, item]));
  const report = {
    schemaVersion: 1,
    kind: 'frozen-content-438-public-pbp-side-data',
    capturedAt: new Date().toISOString(),
    manifestPath: MANIFEST,
    manifestSha256: MANIFEST_SHA,
    credentials: 'none; curl configuration disabled; no cookies or authorization headers',
    schema: 'modules[name=pbp].params.data',
    policy: { concurrency: 2, connectTimeoutSeconds: 5, requestTimeoutSeconds: 15,
      retryCount: 0, stopOnHttp: [412, 429], interVideoDelayMs: 300,
      inputsRead: 'Only frozen manifest bvid/cid/duration and prior public response provenance.',
      unavailablePolicy: 'Missing, malformed, blocked, or unavailable data are neutral, never zero heat.' },
    priorAcquisitionSha256: sha(fs.readFileSync(path.join(PRIOR, 'acquisition.json'))),
    records: identities.map(identity => {
      const previousItem = previousById.get(identity.bvid);
      if (!previousItem || previousItem.cid !== identity.cid || !previousItem.sha256 || previousItem.error) {
        return { ...identity, status: 'pending' };
      }
      const bytes = fs.readFileSync(path.join(PRIOR, 'responses', `${identity.bvid}.json`));
      if (sha(bytes) !== previousItem.sha256) throw new Error(`Prior response hash mismatch: ${identity.bvid}`);
      const responseFile = `responses/${identity.bvid}.json`;
      fs.writeFileSync(path.join(__dirname, responseFile), bytes);
      return { ...identity, ...previousItem, status: 'reused', responseFile,
        reusedFrom: 'eval/experiments/heatmap-verification-20261004/acquisition.json',
        priorMetadataBodyRetained: false };
    })
  };
  return report;
}

function checkpoint(report) {
  report.updatedAt = new Date().toISOString();
  report.counts = report.records.reduce((counts, record) => {
    counts[record.status] = (counts[record.status] || 0) + 1;
    return counts;
  }, { total: report.records.length });
  fs.writeFileSync(`${REPORT}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${REPORT}.tmp`, REPORT);
}

function markRiskStop(report, record, status, parsed) {
  if ([412, 429].includes(status) || [-412, -352, -509].includes(parsed?.code)) {
    report.stoppedEarly = true;
    report.stopReason = `risk-control: ${record.bvid}, HTTP ${status}, code ${parsed?.code ?? 'unknown'}`;
    throw new Error('risk-control-stop');
  }
}

async function collectOne(report, record) {
  if (report.stoppedEarly) return;
  record.status = 'collecting';
  record.capturedAt ??= new Date().toISOString();
  checkpoint(report);
  try {
    let metadata;
    if (record.metadataFile && record.metadataStatus === 200) {
      metadata = JSON.parse(readStoredBytes(record, 'metadataFile'));
    } else {
      record.metadataUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(record.bvid)}`;
      const response = await request(record.metadataUrl);
      record.metadataStatus = response.status;
      record.metadataCapturedAt = new Date().toISOString();
      record.metadataFile = `metadata/${record.bvid}.json.gz`;
      record.metadataEncoding = 'gzip';
      record.metadataSha256 = sha(response.body);
      // Hashes always describe the exact original HTTP body, before compression.
      fs.writeFileSync(path.join(__dirname, record.metadataFile), gzipSync(response.body));
      try { metadata = JSON.parse(response.body); } catch (_) {}
      checkpoint(report);
      markRiskStop(report, record, response.status, metadata);
      if (response.status !== 200) throw new Error('metadata-unavailable');
    }
    if (metadata?.code !== 0 || !Number.isSafeInteger(metadata?.data?.aid)
      || (metadata.data.bvid && metadata.data.bvid !== record.bvid)
      || !metadata.data.pages?.some(page => page.cid === record.cid)) {
      throw new Error('metadata-identity-unavailable');
    }
    record.aid = metadata.data.aid;
    record.currentPageDuration = metadata.data.pages.find(page => page.cid === record.cid).duration;
    if (report.stoppedEarly) {
      record.status = 'pending';
      checkpoint(report);
      return;
    }
    record.url = `https://bvc.bilivideo.com/pbp/data?aid=${record.aid}&cid=${record.cid}&bvid=${encodeURIComponent(record.bvid)}&r=loader`;
    const heat = await request(record.url);
    record.heatStatus = heat.status;
    record.heatCapturedAt = new Date().toISOString();
    record.responseFile = `responses/${record.bvid}.json`;
    record.sha256 = sha(heat.body);
    fs.writeFileSync(path.join(__dirname, record.responseFile), heat.body);
    let parsed;
    try { parsed = JSON.parse(heat.body); } catch (_) {}
    markRiskStop(report, record, heat.status, parsed);
    if (heat.status !== 200) throw new Error('heat-unavailable');
    if (!parsed || typeof parsed !== 'object') throw new Error('heat-invalid-json');
    record.status = 'complete';
  } catch (error) {
    record.status = 'error';
    record.error = error.message;
  }
  record.finishedAt = new Date().toISOString();
  checkpoint(report);
  console.log(JSON.stringify({ bvid: record.bvid, status: record.status, error: record.error, counts: report.counts }));
}

async function main() {
  const report = initialize();
  checkpoint(report);
  if (process.argv.includes('--initialize-only')) {
    console.log(JSON.stringify(report.counts));
    return;
  }
  if (report.stoppedEarly) throw new Error(`Previous risk stop is persistent; refusing further requests: ${report.stopReason}`);
  const pending = report.records.filter(item => ['pending', 'collecting'].includes(item.status));
  let next = 0;
  const worker = async () => {
    while (!report.stoppedEarly && next < pending.length) {
      const item = pending[next++];
      await collectOne(report, item);
      if (!report.stoppedEarly && next < pending.length) await delay(report.policy.interVideoDelayMs);
    }
  };
  await Promise.all([worker(), worker()]);
  report.completedAt = new Date().toISOString();
  checkpoint(report);
  console.log(JSON.stringify({ counts: report.counts, stoppedEarly: !!report.stoppedEarly }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { initialize, request, markRiskStop, readStoredBytes };
