// == BiliSmartSkip: Constants & Configuration ==

const DEBUG = false;
const COUNTDOWN = 5;

// === Ad Keyword Dictionaries ===
const AD_START_KEYWORDS = ["广告开始", "开始恰饭", "恰饭开始", "广告来了", "开始推广", "金主来了", "广告时间"];
const AD_END_KEYWORDS = ["广告结束", "欢迎回来", "恰饭结束", "回来了", "广告完了", "正片开始", "回归正片"];
const AD_GENERAL_KEYWORDS = ["已买", "购买", "购入", "接广", "广告", "广子", "感谢金主", "买了", "恭喜接广", "下单", "期待发货", "付款", "商单", "买买买", "恰饭", "恰上饭", "谢甲催", "有转无赞"];
const AD_CONTENT_KEYWORDS = [
  // Sponsorship signals
  "赞助", "冠名", "推广", "合作", "商单",
  // CTA (call-to-action)
  "评论区", "蓝链", "点击", "链接", "二维码", "口令",
  "领取", "领券", "优惠券", "优惠码", "兑换码", "折扣码",
  "下单", "购买", "入手", "抢购",
  // Promotional language
  "优惠", "折扣", "限时", "福利", "免费", "首充",
  "专属", "新用户", "官方旗舰", "性价比",
  // Product pitch
  "推荐给大家", "安利", "种草", "体验装",
  // Platform/download
  "下载", "注册", "搜索", "应用商店"
];
