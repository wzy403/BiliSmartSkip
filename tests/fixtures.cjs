// Synthetic cases only: none of these strings/transcripts came from the reported video.
function transcript(first, second, start = 79, gap = 20) {
  return [
    { from: 10, to: 13, content: '今天继续介绍我们的主题' },
    { from: 30, to: 33, content: '先看这个例子' },
    { from: start, to: start + 4, content: first },
    { from: start + gap, to: start + gap + 4, content: second },
    { from: start + gap + 10, to: start + gap + 13, content: '接下来回到刚才的问题' }
  ];
}

const weakSubtitles = transcript('这个工具是免费的', '然后搜索你想了解的内容');
const strongSubtitles = transcript('本期视频由某品牌赞助', '点击下方蓝链领取优惠券');
const timestamp = (text = '跳过广告 2:00', time = 74) => ({ time, textContent: text });

module.exports = { transcript, weakSubtitles, strongSubtitles, timestamp };
