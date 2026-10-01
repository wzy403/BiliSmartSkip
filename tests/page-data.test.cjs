const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../scr/page-data.js'), 'utf8');
const bvid = 'BV1iQeM6uEEH';

function readBridge(state, requestedBvid = bvid) {
  const script = { dataset: { bvid: requestedBvid } };
  vm.runInNewContext(source, {
    document: { currentScript: script },
    window: { __INITIAL_STATE__: state }
  });
  return script.dataset.videoInfo ? JSON.parse(script.dataset.videoInfo) : null;
}

test('exports only public metadata and per-part identifiers for the matching BV', () => {
  const result = readBridge({
    account: { token: 'private' },
    videoData: {
      bvid, cid: 101, title: 'Video', desc: '00:10 advertisement', duration: 500,
      owner: { mid: 123 },
      pages: [
        { page: 1, cid: 101, duration: 200, part: 'part 1', extra: 'excluded' },
        { page: 2, cid: 102, duration: 300, part: 'part 2' }
      ]
    }
  });
  assert.deepEqual(result, {
    bvid, cid: 101, title: 'Video', desc: '00:10 advertisement', duration: 500,
    pages: [{ page: 1, cid: 101, duration: 200 }, { page: 2, cid: 102, duration: 300 }]
  });
});

test('rejects stale SPA state or a missing requested BV', () => {
  assert.equal(readBridge({ videoData: { bvid: 'BV1different', cid: 101 } }), null);
  assert.equal(readBridge({ videoData: { bvid, cid: 101 } }, ''), null);
  assert.equal(readBridge({ videoData: { cid: 101 } }), null);
});

test('handles missing or temporarily unreadable page state', () => {
  assert.equal(readBridge(undefined), null);
  assert.equal(readBridge({}), null);
  assert.equal(readBridge({ get videoData() { throw new Error('state changing'); } }), null);
  assert.doesNotThrow(() => vm.runInNewContext(source, { document: { currentScript: null } }));
});

test('does not serialize unexpected nested objects in metadata fields', () => {
  const nested = { private: 'excluded' };
  nested.self = nested;
  assert.deepEqual(readBridge({ videoData: {
    bvid, cid: nested, title: nested, desc: nested, duration: Infinity,
    pages: [null, { page: '2', cid: '102', duration: '300', extra: nested }]
  } }), {
    bvid, cid: null, title: '', desc: '', duration: null,
    pages: [{ page: '2', cid: '102', duration: '300' }]
  });
});

test('does not read cookies, account data, or perform requests', () => {
  const script = { dataset: { bvid } };
  const videoData = { bvid, cid: 101, title: 'Video', desc: '', duration: 200, pages: [] };
  vm.runInNewContext(source, {
    document: {
      currentScript: script,
      get cookie() { throw new Error('cookies must not be read'); }
    },
    window: {
      __INITIAL_STATE__: {
        videoData,
        get loginInfo() { throw new Error('account data must not be read'); }
      }
    },
    fetch() { throw new Error('requests must not be made'); }
  });
  assert.equal(JSON.parse(script.dataset.videoInfo).cid, 101);
});
