const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, parseDanmaku } = require('./collect-public.cjs');

test('metadata extraction handles braces/escaped quotes in titles without evaluating scripts', () => {
  const value = { videoData: { title: 'a } " b', cid: 123 }, unrelated: { nested: true } };
  const html = '<script>window.__INITIAL_STATE__=' + JSON.stringify(value) + ';throw new Error("must not execute")</script>';
  assert.deepEqual(initialState(html), value);
  assert.throws(() => initialState('<html>unavailable</html>'), /not present/);
});

test('danmaku XML keeps content and timing while decoding entities and CDATA', () => {
  const xml = '<i><d p="79.5,1">跳过广告 2&#x3a;00 &amp; 谢谢</d>'
    + '<d p="60,1"><![CDATA[原样 & 文本]]></d><d p="NaN,1">invalid</d></i>';
  assert.deepEqual(parseDanmaku(xml), [
    { time: 60, textContent: '原样 & 文本' },
    { time: 79.5, textContent: '跳过广告 2:00 & 谢谢' }
  ]);
  assert.throws(() => parseDanmaku('<html>Access denied</html>'), /not danmaku XML/);
});
