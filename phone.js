/* CORTIS 恋爱模拟器 · 手机系统
 * 把游戏做成一台虚拟手机：锁屏 → 主屏幕 → 微信 / 电话 / 故事 / 相册 四个 App。
 * - 微信：和 5 位角色真实互动聊天（关键词 + 状态感知的回复引擎），剧情事件会推送消息
 * - 电话：通讯录 / 拨号盘 / 通话记录，可打出打入，带选项式通话对话
 * - 故事：原有剧情（app.js 零改动）
 * - 相册：随剧情推进解锁"照片"
 * 多人模式：房主=手机主人；客人看到同步的微信/通话记录/相册（只读）。
 * 依赖 app.js 的全局 state / members / selected / clock / place；multiplayer.js 可选。
 */
(function () {
'use strict';
if (!document.getElementById('setup-form')) return;

var $ = function (s) { return document.querySelector(s); };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function toast(msg) {
  var t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.classList.add('show'); }, 30);
  setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 400); }, 2200);
}
function memberById(id) {
  var ms = window.members || [];
  for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i];
  return null;
}
function gameClock() {
  var el = $('#time-label');
  var t = el ? el.textContent.trim() : '';
  if (/^\d{1,2}:\d{2}$/.test(t)) return t;
  var d = new Date();
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
function placeNow() {
  try { return (typeof place === 'function') ? place() : '练习室'; } catch (e) { return '练习室'; }
}

/* ================= 状态 ================= */
var threads = {};        // threadId -> [{me, text, ts}]
var threadMeta = {};     // threadId -> {name, sub}
var unread = {};         // threadId -> n
var callLog = [];        // [{name, dir:'in'|'out'|'missed', time, dur}]
var photosUnlocked = []; // [photoId]
var guestMode = false;
var currentThread = null;
var callState = null;    // {contact, t0, timer, script}
var inCall = false;

/* ================= 屏幕管理 ================= */
var SCREENS = ['lockscreen', 'onboarding', 'home', 'story', 'app-wechat', 'app-phone', 'app-photos'];
function show(id) {
  SCREENS.forEach(function (s) {
    var el = document.getElementById(s);
    if (el) {
      var on = (s === id);
      el.hidden = !on;
      el.style.display = on ? '' : 'none'; // 内联样式兜底：旧缓存 CSS 也能正确隐藏
    }
  });
  window.scrollTo(0, 0);
}
function goHome() {
  show('home');
  ensureFirstDay();
  ensureWxScore();
  renderHomeBadges();
  updateBondDays();
}
/* ---- 羁绊天数计数器：state.firstDay 为存档时间戳，老存档防御性补设 ---- */
function ensureFirstDay() {
  try {
    if (typeof state === 'undefined' || !state) return;
    if (!state.firstDay) {
      state.firstDay = Date.now();
      try { localStorage.setItem('cortis-save', JSON.stringify(state)); } catch (e2) {}
    }
  } catch (e) {}
}
/* 旧存档兼容：微信私聊哄哄模式新增字段（开场记录 / 里程碑记录），不存在则补空对象 */
function ensureWxScore() {
  try {
    if (typeof state === 'undefined' || !state) return;
    if (!state.wxIntro) state.wxIntro = {};
    if (!state.wxMile) state.wxMile = {};
  } catch (e) {}
}
/* 在 #home 的 .home-clock 后面创建 <div class="bond-days">，文本如"羁绊第 X 天"（前面带爱心符号） */
function updateBondDays() {
  var days = 1;
  try {
    if (typeof state === 'undefined' || !state || !state.firstDay) return;
    days = Math.floor((Date.now() - state.firstDay) / 86400000) + 1;
    if (days < 1) days = 1;
  } catch (e) { return; }
  var el = document.querySelector('.bond-days');
  if (!el) {
    var clock = document.querySelector('#home .home-clock');
    if (!clock || !clock.parentNode) return;
    el = document.createElement('div');
    el.className = 'bond-days';
    clock.parentNode.insertBefore(el, clock.nextSibling);
  }
  el.textContent = '💞 羁绊第 ' + days + ' 天';
}
function openApp(name) {
  if (name === 'story') { show('story'); return; }
  show('app-' + name);
  if (name === 'wechat') renderThreadList();
  if (name === 'phone') renderPhoneTab();
  if (name === 'photos') renderPhotos();
}

/* ================= 状态栏 / 锁屏时钟 ================= */
function tickClock() {
  var d = new Date();
  var hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  var sb = $('#sb-time'); if (sb) sb.textContent = hm;
  var lt = $('#lock-time'); if (lt) lt.textContent = hm;
  var wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  var ds = (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + wd;
  var ld = $('#lock-date'); if (ld) ld.textContent = ds;
  var hd = $('#home-date'); if (hd) hd.textContent = ds;
  var ht = $('#home-time'); if (ht) ht.textContent = hm;
}

/* ================= 微信 ================= */
function threadIdFor(mid) { return 'dm:' + mid; }
function ensureThreads() {
  threadMeta['group'] = { name: 'CORTIS · 练习生小群', sub: '5 位成员' };
  if (!threads['group']) threads['group'] = [];
  var chosen = [];
  try { chosen = (window.state && state.chosen) || []; } catch (e) {}
  (window.members || []).forEach(function (m) {
    if (chosen.indexOf(m.id) < 0) return;
    var tid = threadIdFor(m.id);
    threadMeta[tid] = { name: m.name, sub: m.tone };
    if (!threads[tid]) threads[tid] = [];
  });
}
function lastMsg(tid) {
  var arr = threads[tid] || [];
  return arr.length ? arr[arr.length - 1] : null;
}
function threadOrder() {
  return Object.keys(threadMeta).sort(function (a, b) {
    if (a === 'group') return -1;
    if (b === 'group') return 1;
    var la = lastMsg(a), lb = lastMsg(b);
    return (lb ? 1 : 0) - (la ? 1 : 0);
  });
}
function renderHomeBadges() {
  var w = Object.keys(unread).reduce(function (s, k) { return s + (unread[k] || 0); }, 0);
  var bw = $('#badge-wechat');
  if (bw) { bw.hidden = !w; bw.textContent = w > 99 ? '99+' : w; }
  var bp = $('#badge-photos');
  if (bp) { bp.hidden = !Phone._photoBadge; if (Phone._photoBadge) bp.textContent = Phone._photoBadge; }
}
function renderThreadList() {
  $('#wx-thread').hidden = true;
  $('#wx-thread').classList.remove('dm');
  var dh = $('#wx-dm-head'), qq = $('#wx-quick');
  if (dh) dh.hidden = true;
  if (qq) qq.hidden = true;
  $('#wx-thread-list').hidden = false;
  var list = $('#wx-thread-list');
  list.innerHTML = '';
  threadOrder().forEach(function (tid) {
    var meta = threadMeta[tid];
    var lm = lastMsg(tid);
    var b = document.createElement('button');
    b.className = 'wx-thread-item';
    b.innerHTML = '<span class="wx-avatar">' + esc(meta.name.charAt(0)) + '</span>' +
      '<span class="wx-thread-info"><b>' + esc(meta.name) + '</b>' +
      '<small>' + esc(lm ? (lm.me ? '我：' : '') + lm.text : meta.sub) + '</small></span>' +
      (unread[tid] ? '<i class="wx-unread">' + (unread[tid] > 99 ? '99+' : unread[tid]) + '</i>' : '');
    b.onclick = function () { openThread(tid); };
    list.appendChild(b);
  });
  maybeProactive(null);
}
function openThread(tid) {
  currentThread = tid;
  $('#wx-thread-list').hidden = true;
  var th = $('#wx-thread');
  th.hidden = false;
  $('#wx-thread-name').textContent = threadMeta[tid].name;
  unread[tid] = 0;
  renderMsgs();
  /* 私聊 / 群聊分流：私聊挂哄哄模式（对象头 + 快捷回复 + 每日开场 + 里程碑检查） */
  var isDm = tid.indexOf('dm:') === 0;
  th.classList.toggle('dm', isDm);
  var dmHead = $('#wx-dm-head'), quickBar = $('#wx-quick');
  if (dmHead) dmHead.hidden = !isDm;
  if (quickBar) quickBar.hidden = !isDm;
  if (isDm) {
    ensureWxScore();
    var dmid = tid.replace(/^dm:/, '');
    renderDmHead(dmid);
    dmDailyIntro(tid, dmid);
    maybeMilestone(dmid);
  }
  renderHomeBadges();
  maybeProactive(tid);
}
function renderMsgs() {
  var box = $('#wx-msgs');
  box.innerHTML = '';
  (threads[currentThread] || []).forEach(function (m) {
    var d = document.createElement('div');
    d.className = 'wx-msg ' + (m.me ? 'me' : 'them');
    if (!m.me) {
      var av = document.createElement('span');
      av.className = 'wx-avatar sm';
      av.textContent = threadMeta[currentThread].name.charAt(0);
      d.appendChild(av);
    }
    var b = document.createElement('div');
    b.className = 'wx-bubble';
    b.textContent = m.text;
    var ts = document.createElement('small');
    ts.className = 'wx-ts';
    ts.textContent = m.ts;
    b.appendChild(ts);
    d.appendChild(b);
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
}
/* 剧情/系统向某 thread 推送一条"对方"消息；房主自动广播给客人 */
function pushIM(tid, fromId, text) {
  if (!threads[tid]) { threads[tid] = []; }
  if (!threadMeta[tid]) {
    var m = fromId ? memberById(fromId) : null;
    threadMeta[tid] = { name: m ? m.name : '未知', sub: '' };
  }
  threads[tid].push({ me: false, text: text, ts: gameClock(), from: fromId || null });
  if (currentThread === tid && !$('#wx-thread').hidden) {
    renderMsgs();
  } else {
    unread[tid] = (unread[tid] || 0) + 1;
  }
  renderHomeBadges();
  if (window.Netplay && Netplay.mode === 'host' && Netplay.broadcast) {
    Netplay.broadcast({ t: 'im', thread: tid, from: fromId, text: text }, null);
  }
}
function sendWx() {
  var input = $('#wx-text');
  var text = input.value.trim().slice(0, 200);
  if (!text || !currentThread) return;
  if (guestMode) { toast('客人模式下不能发微信哦'); return; }
  input.value = '';
  var tid = currentThread;
  threads[tid].push({ me: true, text: text, ts: gameClock() });
  renderMsgs();
  if (tid === 'group') { groupReply(text); return; }
  var mid = tid.replace(/^dm:/, '');
  /* 私聊哄哄模式：先判分写入好感，再出反应句 + 回复气泡 */
  var sc = scoreWxMsg(text);
  try {
    if (!state.affection) state.affection = {};
    state.affection[mid] = Math.max(0, Math.min(100, dmAff(mid) + sc.delta));
    save();
  } catch (e) {}
  showScorePill(sc.delta, sc.tag);
  renderDmHead(mid);
  maybeMilestone(mid);
  var reaction = pickDmReact(sc.delta, mid);
  var reply = botReply(mid, text);
  var bubbles = Array.isArray(reply) ? [reaction].concat(reply) : [reaction, reply];
  var box = $('#wx-msgs');
  var typing = document.createElement('div');
  typing.className = 'wx-msg them';
  typing.innerHTML = '<span class="wx-avatar sm">' + esc(threadMeta[tid].name.charAt(0)) +
    '</span><div class="wx-bubble typing"><i></i><i></i><i></i></div>';
  setTimeout(function () {
    if (currentThread === tid && box) { box.appendChild(typing); box.scrollTop = box.scrollHeight; }
  }, 600);
  /* 输入中指示器按回复长度随机化，保留到第一条气泡发出；私聊再延迟 400~800ms */
  setTimeout(function () {
    if (typing.parentNode) typing.parentNode.removeChild(typing);
    setTimeout(function () { deliverReply(tid, mid, bubbles); }, 400 + Math.random() * 400);
  }, typingDelay(bubbles.join('')));
}
/* 输入中指示器时长：短句约 0.8 秒，长句可到 2.5 秒+随机 */
function typingDelay(text) {
  var len = String(text || '').length;
  if (len <= 8) return 800 + Math.random() * 600;
  if (len <= 20) return 1400 + Math.random() * 900;
  return 2200 + Math.random() * 1400;
}

/* ---- 微信回复引擎：关键词 + 好感/地点/时间上下文 ---- */
var FALLBACK = {
  james: ['嗯，我在听，你说', '这样啊…你觉得呢？', '慢慢来，不着急'],
  juhoon: ['哦', '…嗯', '知道了'],
  martin: ['交给我吧', '放心，有我在', '嗯，我明白'],
  seong: ['哼，算你有眼光', '才、才不是关心你', '知道了啦'],
  keonho: ['嘿嘿', '真的吗？', '好开心呀'],
};
/* ---- 第二轮：NPC 五档态度 + 三段式回复 ---- */
function affectionTier(aff) {
  var a = Number(aff) || 0;
  if (a >= 60) return 'active';   /* 积极 */
  if (a >= 40) return 'friendly'; /* 友好 */
  if (a >= 20) return 'hesitant'; /* 迟疑 */
  if (a >= 5) return 'cold';      /* 冷淡 */
  return 'leave';                 /* 离开 */
}
function affectionTierOf(mid) {
  var aff = 0;
  try { aff = (state.affection && state.affection[mid]) || 0; } catch (e) {}
  return affectionTier(aff);
}
/* 积极/友好档第 2 条：分享自己的一点事（回应—分享—问一句） */
var TIER_SHARE = {
  james: ['刚刚练舞出了一身汗，洗完澡才看到手机', '中午吃了超好吃的三明治，下次带你一起去'],
  juhoon: ['刚才写了一段旋律，感觉还不错', '耳机里单曲循环了一整个下午'],
  martin: ['今天加练了半小时，现在浑身酸', '刚给成员们买了饮料，大家都挺开心的'],
  seong: ['哼，刚才被经纪人说了两句', '今天自拍居然还挺好看的，罕见'],
  keonho: ['刚才偷吃了经纪人的零食，嘿嘿', '今天练舞被老师夸了，超开心'],
};
/* 积极/友好档第 3 条：反问一句 */
var TIER_ASK = {
  james: ['你呢，今天过得怎么样？', '你吃晚饭了吗？', '最近忙不忙呀？'],
  juhoon: ['你呢，在干嘛？', '你平时喜欢听什么歌？'],
  martin: ['你最近还好吗？', '累了就跟我说，别硬撑'],
  seong: ['喂，你呢？', '你今天都干嘛了？'],
  keonho: ['你呢你呢？', '想听我唱歌吗？'],
};
/* 离开档：终结话题式短句，不再追问 */
var TIER_LEAVE = {
  james: '我先忙了',
  juhoon: '…先这样',
  martin: '我先去忙了',
  seong: '走了',
  keonho: '先撤啦',
};
/* 冷淡档：言简意赅、不提问的单条短气泡 */
function coldShort(text) {
  var s = String(text || '').split(/[？?!！…]/)[0];
  s = s.replace(/[，。、；：,.]+$/g, '').slice(0, 10);
  return s || '嗯';
}
/* 玩家性别称呼：男→小哥哥 / 女→小姐姐，自定义或空保持中性 */
function playerTitle() {
  var g = '';
  try { var st = window.state || {}; g = String(st.player && st.player.gender || '').trim(); } catch (e) {}
  if (g === '男') return '小哥哥';
  if (g === '女') return '小姐姐';
  return '';
}
/* 档位组装：返回气泡数组，走现有 deliverReply 通道发出 */
function tierWrap(mid, core, tier) {
  core = String(core || '');
  if (tier === 'leave') return [TIER_LEAVE[mid] || '我先忙了'];
  if (tier === 'cold') return [coldShort(core)];
  if (tier === 'hesitant') return [stylize(mid, core)];
  /* 积极/友好：回应—分享—问一句 */
  var out = [stylize(mid, core)];
  var shares = TIER_SHARE[mid], asks = TIER_ASK[mid];
  if (tier === 'active') {
    if (shares) out.push(shares[Math.floor(Math.random() * shares.length)]);
    if (asks) out.push(asks[Math.floor(Math.random() * asks.length)]);
  } else {
    if (shares && Math.random() < 0.4) out.push(shares[Math.floor(Math.random() * shares.length)]);
    if (asks) out.push(asks[Math.floor(Math.random() * asks.length)]);
  }
  /* 性别称呼：友好/积极档小概率在首条加一次称呼，不改写原台词 */
  var pt = playerTitle();
  if (pt && out.length && out[0].indexOf(pt) < 0 && Math.random() < 0.3) out[0] = pt + '，' + out[0];
  return out;
}
function botReply(mid, text) {
  var m = memberById(mid);
  var t = String(text || '');
  var tier = affectionTierOf(mid);
  var aff = 0;
  try { aff = (state.affection && state.affection[mid]) || 0; } catch (e) {}
  var warm = aff >= 50;
  var rules = [
    [/你好|您好|嗨|哈喽|hi|hello/i, ['嗨！在呢', '嘿，你来啦', '在！找我什么事？']],
    [/谢谢|感谢|辛苦/, ['不客气～', '跟我还客气什么', '应该的，你开心就好']],
    [/晚安|睡了|休息|睡觉/, ['晚安，明天见', '嗯，早点休息', '晚安，好梦']],
    [/早安|早上好/, ['早！', '早上好呀，今天也要加油']],
    [/在干嘛|在做什么|干什么呢|忙吗|忙不忙/, function () {
      return ['在' + placeNow() + '呢，你呢？', '刚忙完，看到你的消息就回了'];
    }],
    [/喜欢|爱你|爱/, warm ? ['我也…挺喜欢和你待在一起的', '嘿嘿，被发现了'] : ['谢、谢谢…', '你突然说什么呢']],
    [/对不起|抱歉|原谅/, ['没事啦', '嗯，原谅你了', '下次注意哦']],
    [/彩排|练习|舞台|表演|拍摄|片场/, ['今天彩排你也看到了吧', '舞台上的事交给我', '下次带你去看彩排']],
    [/吃饭|饿|夜宵|好吃|火锅/, ['我知道一家超好吃的店', '走，请你吃夜宵', '练完一起去吃？']],
    [/漂亮|帅|好看|可爱/, ['嘿嘿，谢谢', '你也很好看啊']],
    [/加油| fighting/i, ['一起加油！', '嗯！不会让你失望的']],
    [/再见|拜拜|回见|晚点聊/, ['拜拜', '嗯，回见']],
  ];
  var core = null;
  for (var i = 0; i < rules.length; i++) {
    if (rules[i][0].test(t)) {
      var r = rules[i][1];
      r = (typeof r === 'function') ? r() : r;
      core = r[Math.floor(Math.random() * r.length)];
      break;
    }
  }
  if (core == null) {
    var fb = FALLBACK[mid] || ['嗯嗯', '哈哈', '这样啊'];
    core = fb[Math.floor(Math.random() * fb.length)];
    if (Math.random() < 0.25) core += '对了，' + placeNow() + '这边刚才还挺热闹的。';
  }
  /* 关键词规则原样保留，档位只影响语气 / 长度 / 结构 */
  return tierWrap(mid, core, tier);
}
/* ---- 微信拟真度：个性点缀 / 多气泡 / 记忆引用 / 主动消息 ---- */
var WX_EMOJI = {
  james: ['😊', '🌙'],
  juhoon: ['❄️'],
  martin: ['💪', '☕'],
  seong: ['🙄', '💢'],
  keonho: ['🥺', '✨'],
};
var WX_FILLER = {
  james: ['嗯——', '那个…'],
  juhoon: ['…', '啧，'],
  martin: ['听我说，', '放心，'],
  seong: ['哼，', '喂，'],
  keonho: ['嘿嘿，', '呜哇——'],
};
/* 个性点缀：偶尔加口头禅开头、常用 emoji 结尾，不会每条都加 */
function stylize(mid, text) {
  var s = String(text || '');
  if (Math.random() < 0.28) {
    var fs = WX_FILLER[mid];
    if (fs) s = fs[Math.floor(Math.random() * fs.length)] + s;
  }
  if (Math.random() < 0.32) {
    var es = WX_EMOJI[mid] || [];
    var has = es.some(function (e) { return s.indexOf(e) >= 0; });
    if (es.length && !has) s += es[Math.floor(Math.random() * es.length)];
  }
  return s;
}
/* 记忆引用：低概率带玩家名字或提一句上次选项关键词（防御式读取 state） */
function memoryLine() {
  var name = '', kw = '';
  try {
    if (window.state && state.player && state.player.name) name = String(state.player.name);
    if (typeof state.lastChoiceKeyword !== 'undefined' && state.lastChoiceKeyword) kw = String(state.lastChoiceKeyword);
  } catch (e) {}
  var r = Math.random();
  if (kw && r < 0.10) return '说起来，你上次说「' + kw + '」的时候，我记到现在呢';
  if (name && r < 0.18) {
    var tpl = ['话说回来，' + name + '，你今天辛苦啦', '有你在，' + name + '，真好', '对了' + name + '，最近还好吗'];
    return tpl[Math.floor(Math.random() * tpl.length)];
  }
  return '';
}
/* 长回复按标点/长度拆成 2~3 条短气泡 */
function splitBubbles(text) {
  var t = String(text || '');
  if (t.length <= 14) return [t];
  var parts = t.match(/[^，。！？；…]+[，。！？；…]?/g) || [t];
  var out = [], cur = '';
  parts.forEach(function (p) {
    if (cur && cur.length + p.length > 22) { out.push(cur); cur = p; }
    else cur += p;
  });
  if (cur) out.push(cur);
  if (out.length > 3) out = [out[0], out.slice(1, out.length - 1).join(''), out[out.length - 1]];
  return out;
}
/* 多气泡发送：第一条立即 pushIM，其余链式间隔 0.8~2 秒；
 * rawText 可为字符串或已组装好的气泡数组（第二轮三段式回复） */
function deliverReply(tid, mid, rawText, prefix) {
  var tier = affectionTierOf(mid);
  var bubbles = Array.isArray(rawText)
    ? rawText.slice()
    : splitBubbles(stylize(mid, rawText));
  bubbles = bubbles.filter(function (b) { return String(b || '').length > 0; });
  if (!bubbles.length) bubbles = ['嗯'];
  var mem = memoryLine();
  /* 离开档不追加记忆气泡，保持终结话题 */
  if (mem && tier !== 'leave') {
    if (bubbles.length < 3) bubbles.push(mem);
    else bubbles[bubbles.length - 1] += mem;
  }
  /* 爱心粒子钩子：积极/友好档的暖心回复，或回复含爱心符号；burstHearts 由协调人稍后注入 */
  if (tier === 'active' || tier === 'friendly' ||
      bubbles.some(function (b) { return String(b).indexOf('♥') >= 0; })) {
    if (window.burstHearts) { try { burstHearts(window.innerWidth / 2, window.innerHeight * 0.35); } catch (_) {} }
  }
  prefix = prefix || '';
  pushIM(tid, mid, prefix + bubbles[0]);
  var i = 1;
  (function next() {
    if (i >= bubbles.length) return;
    setTimeout(function () {
      pushIM(tid, mid, bubbles[i]);
      i++;
      next();
    }, 800 + Math.random() * 1200);
  })();
}
/* 角色主动消息：每隔 3 回合、小概率推一条日常，guestMode 不触发 */
var PROACTIVE_LINES = {
  james: ['在干嘛呢？突然有点想你了', '今天排练看到一只超可爱的猫，可惜你没在', '晚上有空吗？想跟你说说话'],
  juhoon: ['…你在忙吗', '刚写了段旋律，要听吗', '没睡的话，回我一下'],
  martin: ['今天训练还顺利吗？别太累了', '给你留了好吃的，记得来拿', '有我在，别担心'],
  seong: ['哼，某人今天怎么没找我', '喂！看到消息就回一下啊', '今天舞台超帅的，可惜你没看到'],
  keonho: ['嘿嘿！猜我在哪儿？', '给你带了小蛋糕，要不要吃！', '今天超想你的说🥺'],
};
var _lastProactiveTurn = -99;
function maybeProactive(tid) {
  if (guestMode) return;
  var turn = 0;
  try { turn = (window.state && typeof state.turn === 'number') ? state.turn : 0; } catch (e) {}
  if (turn < 2) return;
  if (turn - _lastProactiveTurn < 3) return;
  if (Math.random() > 0.25) return;
  _lastProactiveTurn = turn;
  var targets;
  if (tid && tid.indexOf('dm:') === 0) targets = [tid];
  else targets = Object.keys(threadMeta).filter(function (t) { return t.indexOf('dm:') === 0; });
  if (!targets.length) return;
  var t2 = targets[Math.floor(Math.random() * targets.length)];
  var mid = t2.replace(/^dm:/, '');
  var lines = PROACTIVE_LINES[mid];
  if (!lines) return;
  var line = lines[Math.floor(Math.random() * lines.length)];
  setTimeout(function () { pushIM(t2, mid, line); }, 1200 + Math.random() * 1500);
}
var GROUP_POOL = [
  '今天彩排累瘫了', '谁看到我的水杯了？', '明天几点集合来着', '刚那遍副歌绝了',
  '想吃夜宵，有人一起吗', '经纪人说明天有拍摄', '新编舞也太难了', '大家早点休息啊',
];
function groupAmbient() {
  var ids = Object.keys(threadMeta).filter(function (t) { return t.indexOf('dm:') === 0; });
  if (!ids.length) return;
  var tid = ids[Math.floor(Math.random() * ids.length)];
  var mid = tid.replace(/^dm:/, '');
  var m = memberById(mid);
  var line = GROUP_POOL[Math.floor(Math.random() * GROUP_POOL.length)];
  pushIM('group', mid, (m ? m.name : '成员') + '：' + line);
}
function groupReply(text) {
  var ids = Object.keys(threadMeta).filter(function (t) { return t.indexOf('dm:') === 0; });
  if (!ids.length) return;
  var tid = ids[Math.floor(Math.random() * ids.length)];
  var mid = tid.replace(/^dm:/, '');
  setTimeout(function () {
    var m = memberById(mid);
    deliverReply('group', mid, botReply(mid, text), (m ? m.name : '成员') + '：');
  }, 1500 + Math.random() * 1500);
}

/* ================= 微信私聊重做（哄哄模式） =================
 * 只作用于 dm: 开头的私聊会话：四档态度、关键词判分、分数胶囊、
 * 对象信息头、快捷回复、每日开场三连、100 好感里程碑。
 * 群聊 / 电话 / 故事 / 相册 / 锁屏 / 联机消息结构一律不动。 */

/* 四档：0-34->0，35-69->1，70-99->2，100->3 */
function dmTier(aff) {
  var a = Number(aff) || 0;
  if (a >= 100) return 3;
  if (a >= 70) return 2;
  if (a >= 35) return 1;
  return 0;
}
var DM_FACE = ['😤', '😐', '🙂', '🥰'];
var DM_MOOD = [
  '还在气头上，小心轻放',
  '有点松动了，再哄哄',
  '心情不错，多聊两句',
  '彻底心动了 ♥',
];
function dmAff(mid) {
  try { return Number((state.affection && state.affection[mid]) || 0); } catch (e) { return 0; }
}
function wxToday() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/* ---- 关键词判分：返回 {delta, tag}，单轮钳制到 [-25, +34] ---- */
var WX_POS_RULES = [
  { re: /对不起|我错了|是我不好|抱歉|原谅我|我的错/, delta: 26, tag: '认错' },
  { re: /补偿|以后|我改|请你|陪你|带你去|给你买/, delta: 16, tag: '行动' },
  { re: /理解|懂你|委屈|心疼|辛苦了|不容易/, delta: 15, tag: '共情' },
  { re: /宝贝|抱抱|爱你|在乎|喜欢你|想你/, delta: 14, tag: '甜言蜜语' },
];
var WX_NEG_RE = /但是|可是|至于|你也|无理取闹|随便|烦死了|别闹|你想多了/;
var WX_BLUF_RE = /^(?:嗯|哦|知道了|好的|行吧|呵呵|嗯嗯|是|对|好|恩)+[。.!！?？…~～]*$/;
var WX_SHOUT_RE = /(！|!){2,}/;
function scoreWxMsg(text) {
  var t = String(text || '');
  var stripped = t.replace(/\s+/g, '');
  var delta = 0, tag = '';
  var perfunctory = WX_BLUF_RE.test(stripped) || stripped.length <= 2;
  if (perfunctory) {
    delta = -14; tag = '敷衍';
  } else if (WX_NEG_RE.test(t)) {
    delta = -22; tag = '甩锅';
  } else {
    WX_POS_RULES.forEach(function (r) {
      if (r.re.test(t)) { delta += r.delta; if (!tag) tag = r.tag; }
    });
    if (t.length >= 18) delta += 6;
    if (!tag) tag = '走心长文';
  }
  if (WX_SHOUT_RE.test(t)) delta -= 6;
  delta = Math.max(-25, Math.min(34, delta));
  return { delta: delta, tag: tag };
}
/* 分数胶囊：纯本地 UI，不写入 threads，不广播 */
function showScorePill(delta, tag) {
  var box = $('#wx-msgs');
  if (!box) return;
  var d = document.createElement('div');
  d.className = 'wx-score-pill' + (delta > 0 ? ' up' : (delta < 0 ? ' down' : ''));
  d.textContent = delta > 0 ? ('+' + delta + ' ♥ · ' + tag)
    : (delta < 0 ? (delta + ' ♥') : '±0 ♥ · 打平');
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  setTimeout(function () { d.classList.add('fade'); }, 2000);
  setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2400);
}

/* ---- 对象信息头 ---- */
function renderDmHead(mid) {
  var aff = dmAff(mid);
  var tier = dmTier(aff);
  var m = memberById(mid);
  var name = m ? m.name : '成员';
  var av = $('#wx-dm-avatar'), nm = $('#wx-dm-name'), mo = $('#wx-dm-mood'),
      nu = $('#wx-dm-num'), fill = $('#wx-dm-fill');
  if (av) av.textContent = DM_FACE[tier];
  if (nm) nm.textContent = name;
  if (mo) mo.textContent = DM_MOOD[tier];
  if (nu) nu.textContent = '好感 ' + aff + ' / 100';
  if (fill) fill.style.width = aff + '%';
  renderQuickReplies(mid);
}

/* ---- 快捷回复：cold 档位 0-1，warm 档位 2-3，{name} 渲染时替换 ---- */
var WX_QUICK = {
  james: {
    cold: ['{name}，对不起嘛，我真的知道错了', '别不理我好不好，我会改的', '罚我请你喝奶茶，原谅我嘛', '今晚等我一起下班好不好'],
    warm: ['今天排练辛苦啦{name}，我陪你去吃夜宵', '{name}，今晚有空吗？想跟你说说话', '看到好吃的就想起你，改天一起去', '{name}今天也超帅的，加油！'],
  },
  juhoon: {
    cold: ['是我不好，{name}', '别气了，行吗', '下次不会了', '{name}，理我一下'],
    warm: ['{name}，刚写了段旋律，想第一个给你听', '今天想你了', '有空一起去听歌吗，{name}', '辛苦了，早点休息'],
  },
  martin: {
    cold: ['{name}，这次是我没做好，对不起', '给我个机会补偿你，好吗', '别生气了，气坏身体我心疼', '{name}，我改，保证'],
    warm: ['训练累了就靠我，{name}', '{name}，今天也辛苦了，一起去吃饭', '有我在，别担心', '想你了，{name}'],
  },
  seong: {
    cold: ['喂，{name}，我错了还不行吗', '别不理我啊，我会改的', '哼……对不起啦', '{name}，原谅我这一次'],
    warm: ['{name}，今天舞台超帅的，可惜你没看到', '喂，看到消息就回一下啊', '想你了，不许笑', '{name}，下次彩排带你去'],
  },
  keonho: {
    cold: ['{name}，对不起嘛，我真的错了', '别生气了好不好，抱抱', '我给你买好吃的，原谅我嘛', '{name}，理理我嘛'],
    warm: ['{name}！今天被老师夸了，超开心', '给你带了小蛋糕，要不要吃', '嘿嘿，想你了{name}', '{name}，想听我唱歌吗'],
  },
};
var WX_QUICK_FALLBACK = {
  cold: ['对不起，我错了', '别生气了好不好', '我会改的', '原谅我这一次'],
  warm: ['今天辛苦啦', '想你了', '有空一起吃饭吗', '最近还好吗'],
};
function renderQuickReplies(mid) {
  var box = $('#wx-quick');
  if (!box) return;
  var m = memberById(mid);
  var name = m ? m.name : '他';
  var q = WX_QUICK[mid] || WX_QUICK_FALLBACK;
  var pool = dmTier(dmAff(mid)) <= 1 ? q.cold : q.warm;
  box.innerHTML = '';
  pool.forEach(function (line) {
    var rendered = String(line).replace(/\{name\}/g, name);
    var b = document.createElement('button');
    b.className = 'wx-quick-item';
    b.textContent = rendered;
    b.onclick = function () {
      var inp = $('#wx-text');
      if (inp && !guestMode) { inp.value = rendered; sendWx(); }
    };
    box.appendChild(b);
  });
}

/* ---- 四档反应台词池：按本轮 delta 选档，{name} 占位符 ---- */
var DM_REACT = {
  big: [
    '{name}，你这样说，我整颗心都要化了……',
    '！！你认真的吗？等等，我先去冷静三秒钟',
    '嘿嘿，被你哄好了——那就原谅你了',
    '其实早就想说了，谢谢你一直在我身边',
  ],
  small: [
    '嗯……这还差不多',
    '哼，算你会说话',
    '好吧好吧，不生气了',
    '行，这次就放过你',
  ],
  flat: [
    '嗯',
    '知道了',
    '哦……行吧',
    '还行',
  ],
  minus: [
    '你先自己好好想想吧',
    '……我现在不想说话',
    '随便你',
    '别烦我，让我静静',
  ],
};
function pickDmReact(delta, mid) {
  var pool = delta >= 22 ? DM_REACT.big
    : (delta >= 8 ? DM_REACT.small : (delta > 0 ? DM_REACT.flat : DM_REACT.minus));
  var m = memberById(mid);
  var name = m ? m.name : '';
  var line = pool[Math.floor(Math.random() * pool.length)] || '';
  return String(line).replace(/\{name\}/g, name);
}

/* ---- 每日开场三连：场景句 + 对方开场白气泡 + 玩法提示 ---- */
var DM_SCENE = {
  james: '深夜的练习室，灯还亮着，他刚结束加练',
  juhoon: '走廊尽头的录音室，门缝里漏出一段旋律',
  martin: '队长办公室的灯还亮着，他在看明天的行程表',
  seong: '天台上风有点大，他一个人看了一会儿夜景',
  keonho: '宿舍的灯关了一半，他抱着抱枕缩在沙发上',
};
var DM_OPEN = {
  james: '还没睡？我刚练完，看到你在线，就想跟你说说话。',
  juhoon: '…睡不着。刚才写了段东西，你要听吗？',
  martin: '这么晚还没休息？别熬太晚，身体要紧。',
  seong: '喂，还没睡啊？正好，我有话跟你说。',
  keonho: '嘿嘿，你还没睡！我刚偷吃了经纪人的饼干，要分你一半吗？',
};
var DM_HINT = '回得走心一点——他会记住你的每一句话';
function dmDailyIntro(tid, mid) {
  var box = $('#wx-msgs');
  if (!box) return;
  var today = wxToday();
  try { ensureWxScore(); } catch (e) {}
  try { if (state.wxIntro && state.wxIntro[mid] === today) return; } catch (e) { return; }
  var m = memberById(mid);
  var name = m ? m.name : '他';
  /* 场景句 */
  var scene = document.createElement('div');
  scene.className = 'wx-scene-pill';
  scene.textContent = DM_SCENE[mid] || '夜深了，他还在等你说话';
  box.appendChild(scene);
  /* 对方开场白气泡（结构仿 renderMsgs 的 them 行）；只留存 threads，不走 pushIM */
  var line = DM_OPEN[mid] || '嗨，在吗？';
  var d = document.createElement('div');
  d.className = 'wx-msg them';
  var av = document.createElement('span');
  av.className = 'wx-avatar sm';
  av.textContent = name.charAt(0);
  d.appendChild(av);
  var b = document.createElement('div');
  b.className = 'wx-bubble';
  b.textContent = line;
  var ts = document.createElement('small');
  ts.className = 'wx-ts';
  ts.textContent = gameClock();
  b.appendChild(ts);
  d.appendChild(b);
  box.appendChild(d);
  try {
    if (!threads[tid]) threads[tid] = [];
    threads[tid].push({ me: false, text: line, ts: gameClock(), from: mid });
  } catch (e) {}
  /* 玩法提示 */
  var hint = document.createElement('div');
  hint.className = 'wx-hint-pill';
  hint.textContent = '💡 ' + DM_HINT;
  box.appendChild(hint);
  box.scrollTop = box.scrollHeight;
  try {
    state.wxIntro[mid] = today;
    save();
  } catch (e) {}
}

/* ---- 里程碑：好感到 100 且未触发过时，全屏心动 overlay ---- */
var DM_MILE = {
  james: '练习室的灯还亮着，他擦着汗朝你笑，第一次没有躲开你的视线。',
  juhoon: '他把耳机分了一只给你，耳机线那头，是他写给你的旋律。',
  martin: '他把明天的行程表递给你，说：以后，都一起。',
  seong: '他别过脸，耳尖发红：哼……是我的了，不许反悔。',
  keonho: '他抱着抱枕扑过来：嘿嘿，从今天起，你是我的人啦！',
};
function maybeMilestone(mid) {
  var ov = $('#wx-milestone');
  var txt = ov ? ov.querySelector('.wx-milestone-text') : null;
  try { ensureWxScore(); } catch (e) {}
  var aff = dmAff(mid);
  var done = false;
  try { done = !!(state.wxMile && state.wxMile[mid]); } catch (e) {}
  if (aff < 100 || done || !ov) return;
  try { state.wxMile[mid] = true; save(); } catch (e) {}
  if (txt) txt.textContent = DM_MILE[mid] || '他第一次没有躲开你的视线。';
  ov.hidden = false;
  /* 连撒几次爱心 */
  var n = 0;
  var iv = setInterval(function () {
    try {
      if (window.burstHearts) burstHearts(Math.random() * window.innerWidth, window.innerHeight * (0.2 + Math.random() * 0.5));
    } catch (_) {}
    n++;
    if (n >= 6) clearInterval(iv);
  }, 350);
}

/* ================= 电话 ================= */
var AGENT = { id: 'agent', name: '经纪人 韩哥', note: '公司经纪人' };
function contactById(id) {
  if (id === 'agent') return AGENT;
  var m = memberById(id);
  return m ? { id: m.id, name: m.name, note: m.tone } : null;
}
var phoneTab = 'log';
function renderPhoneTab() {
  Array.prototype.forEach.call(document.querySelectorAll('.ph-tab'), function (b) {
    b.classList.toggle('active', b.getAttribute('data-ptab') === phoneTab);
  });
  $('#ph-log').hidden = phoneTab !== 'log';
  $('#ph-contacts').hidden = phoneTab !== 'contacts';
  $('#ph-dial').hidden = phoneTab !== 'dial';
  if (phoneTab === 'log') renderCallLog();
  if (phoneTab === 'contacts') renderContacts();
}
function renderCallLog() {
  var box = $('#ph-log');
  box.innerHTML = callLog.length ? '' : '<p class="ph-empty">暂无通话记录</p>';
  callLog.slice().reverse().forEach(function (c) {
    var d = document.createElement('div');
    d.className = 'ph-log-item';
    var icon = c.dir === 'missed' ? '🔴' : (c.dir === 'in' ? '↙' : '↗');
    d.innerHTML = '<span class="ph-log-icon">' + icon + '</span><span class="ph-log-info"><b>' +
      esc(c.name) + '</b><small>' + esc(c.time) + ' · ' +
      (c.dir === 'missed' ? '未接来电' : (c.dur || '0:00')) + '</small></span>';
    box.appendChild(d);
  });
}
function renderContacts() {
  var box = $('#ph-contacts');
  box.innerHTML = '';
  var list = [AGENT].concat((window.members || []).filter(function (m) {
    try { return state.chosen.indexOf(m.id) >= 0; } catch (e) { return true; }
  }).map(function (m) { return { id: m.id, name: m.name, note: m.tone }; }));
  list.forEach(function (c) {
    var b = document.createElement('button');
    b.className = 'ph-contact';
    b.innerHTML = '<span class="wx-avatar">' + esc(c.name.charAt(0)) + '</span>' +
      '<span class="ph-log-info"><b>' + esc(c.name) + '</b><small>' + esc(c.note || '') + '</small></span>' +
      '<span class="ph-call-btn">📞</span>';
    b.onclick = function () { dialContact(c.id); };
    box.appendChild(b);
  });
}
function dialContact(id) {
  if (guestMode) { toast('客人模式下不能打电话哦'); return; }
  var c = contactById(id);
  if (!c) return;
  startCall(c, false, outgoingScript(c));
}
function outgoingScript(c) {
  var greet = c.id === 'agent' ? '喂，是我。什么事？' :
    ({ james: '喂？是我。怎么了？', juhoon: '…喂', martin: '喂，我在听',
       seong: '喂？干嘛？', keonho: '喂！嘿嘿，怎么啦？' }[c.id] || '喂？');
  return [
    { say: greet },
    { choices: [
      { t: '就是想听听你的声音', r: c.id === 'agent' ? '……没事我挂了，忙着呢。' : '嘿嘿，我也是。', aff: 2 },
      { t: '明天的行程确认一下', r: '嗯，明天见，别迟到。', aff: 1 },
    ]},
    { say: c.id === 'agent' ? '行，那就这样。' : '那先这样，看到你的消息我会回的。', end: true },
  ];
}
var CALL_SCRIPTS = {
  agent_notice: [
    { say: '是我，韩哥。通知一下：明天的外景拍摄提前到早上 6 点集合，别迟到。' },
    { choices: [
      { t: '收到，我会准时到', r: '好，靠谱。早点休息。', aff: 2 },
      { t: '6 点？也太早了吧', r: '导演定的，我也没办法。定好闹钟。', aff: 0 },
    ]},
    { say: '就这样，挂了。', end: true },
  ],
  lead_call: null, // 动态生成
};
function leadCallScript(lead) {
  return [
    { say: '喂？是我，' + lead.name + '。刚才那场戏…你觉得我演得怎么样？' },
    { choices: [
      { t: '特别好，你就是天生的主角', r: '嘿嘿，被你这么一说，突然有信心了。', aff: 3 },
      { t: '有一场情绪差了点，但整体不错', r: '…哪一场？你说说，我再琢磨琢磨。', aff: 1 },
    ]},
    { say: '不打扰你了，早点休息。明天见。', end: true },
  ];
}
function startCall(contact, answered, script) {
  if (inCall) { toast('正在通话中'); return; }
  inCall = true;
  $('#ph-call').hidden = false;
  $('#call-avatar').textContent = contact.name.charAt(0);
  $('#call-name').textContent = contact.name;
  $('#call-script').innerHTML = '';
  var st = $('#call-status');
  callState = { contact: contact, script: script, idx: 0, t0: Date.now(), timer: null, secs: 0 };
  if (!answered) {
    st.textContent = '正在呼叫…';
    setTimeout(function () {
      if (!callState) return;
      st.textContent = '通话中 0:00';
      startCallTimer();
      runCallStep();
    }, 2000);
  } else {
    st.textContent = '通话中 0:00';
    startCallTimer();
    runCallStep();
  }
}
function startCallTimer() {
  callState.timer = setInterval(function () {
    callState.secs++;
    var s = callState.secs;
    $('#call-status').textContent = '通话中 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}
function runCallStep() {
  var cs = callState;
  if (!cs) return;
  var box = $('#call-script');
  box.innerHTML = '';
  var step = cs.script[cs.idx];
  if (!step) { endCall(false); return; }
  if (step.say) {
    var d = document.createElement('div');
    d.className = 'call-line them';
    d.textContent = step.say;
    box.appendChild(d);
  }
  if (step.choices) {
    step.choices.forEach(function (ch) {
      var b = document.createElement('button');
      b.className = 'call-choice';
      b.textContent = ch.t;
      b.onclick = function () {
        var d = document.createElement('div');
        d.className = 'call-line me';
        d.textContent = ch.t;
        box.appendChild(d);
        var r = document.createElement('div');
        r.className = 'call-line them';
        r.textContent = ch.r;
        box.appendChild(r);
        if (ch.aff && cs.contact.id !== 'agent') {
          try {
            state.affection[cs.contact.id] = Math.max(0, Math.min(100, (state.affection[cs.contact.id] || 0) + ch.aff));
            if (typeof renderStats === 'function') renderStats({});
          } catch (e) {}
        }
        box.querySelectorAll('.call-choice').forEach(function (x) { x.disabled = true; });
        setTimeout(function () { cs.idx++; runCallStep(); }, 1200);
      };
      box.appendChild(b);
    });
  } else {
    setTimeout(function () { cs.idx++; runCallStep(); }, step.end ? 1400 : 1600);
  }
}
function endCall(missed) {
  var cs = callState;
  if (cs && cs.timer) clearInterval(cs.timer);
  if (cs) {
    var s = cs.secs || 0;
    addCallLog({ name: cs.contact.name, dir: missed ? 'missed' : 'out', time: gameClock(), dur: Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') });
  }
  callState = null;
  inCall = false;
  $('#ph-call').hidden = true;
  $('#ph-incoming').hidden = true;
}
function addCallLog(entry) {
  callLog.push(entry);
  if (window.Netplay && Netplay.mode === 'host' && Netplay.broadcast) {
    Netplay.broadcast({ t: 'calllog', log: callLog.slice(-30) }, null);
  }
}
function incomingCall(contactId, scriptKey) {
  var c = contactById(contactId);
  if (!c || inCall || guestMode) return;
  var script = scriptKey === 'lead_call' ? leadCallScript(c) : (CALL_SCRIPTS[scriptKey] || []);
  $('#ph-incoming').hidden = false;
  $('#inc-avatar').textContent = c.name.charAt(0);
  $('#inc-name').textContent = c.name;
  $('#inc-accept').onclick = function () {
    $('#ph-incoming').hidden = true;
    startCall(c, true, script);
  };
  $('#inc-decline').onclick = function () {
    $('#ph-incoming').hidden = true;
    addCallLog({ name: c.name, dir: 'missed', time: gameClock(), dur: '' });
    toast('已挂断 ' + c.name + ' 的来电');
  };
}

/* ================= 相册 ================= */
function svgArt(bg1, bg2, glyph, label) {
  return '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="g' + label + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + bg1 + '"/><stop offset="1" stop-color="' + bg2 + '"/></linearGradient></defs>' +
    '<rect width="200" height="200" fill="url(#g' + label + ')"/>' +
    '<text x="100" y="118" font-size="64" text-anchor="middle">' + glyph + '</text>' +
    '<text x="100" y="172" font-size="13" text-anchor="middle" fill="#ffffff" opacity="0.85">' + label + '</text></svg>';
}
var PHOTOS = [
  { id: 'p1', title: '练习室 · 凌晨3点', cap: '第一次一起加练到半夜', art: function () { return svgArt('#2b2a4a', '#0f0e1c', '🎧', 'PRACTICE 03:00'); } },
  { id: 'p2', title: '贩卖机前的合影', cap: '深夜贩卖机小分队', art: function () { return svgArt('#3a2b4a', '#141020', '🥤', 'VENDING MACHINE'); } },
  { id: 'p3', title: '天台晚风', cap: '杀青那晚的天台', art: function () { return svgArt('#1c3a4a', '#0e1a24', '🌙', 'ROOFTOP'); } },
  { id: 'p4', title: '彩排后台', cap: '上台前五分钟', art: function () { return svgArt('#4a2b3a', '#1c0f16', '🎤', 'BACKSTAGE'); } },
  { id: 'p5', title: '雨中的伞', cap: '那把没还的伞', art: function () { return svgArt('#2b4a3a', '#0f1c14', '☂️', 'RAINY DAY'); } },
  { id: 'p6', title: '出道舞台', cap: '灯亮起来的瞬间', art: function () { return svgArt('#4a3a1c', '#1c1408', '✨', 'DEBUT STAGE'); } },
];
function unlockPhoto(id) {
  if (photosUnlocked.indexOf(id) >= 0) return;
  photosUnlocked.push(id);
  var p = PHOTOS.filter(function (x) { return x.id === id; })[0];
  Phone._photoBadge = (Phone._photoBadge || 0) + 1;
  renderHomeBadges();
  if (p) toast('📸 解锁新照片：《' + p.title + '》');
  if (window.Netplay && Netplay.mode === 'host' && Netplay.broadcast) {
    Netplay.broadcast({ t: 'photo', id: id }, null);
  }
}
function renderPhotos() {
  Phone._photoBadge = 0;
  renderHomeBadges();
  var grid = $('#photo-grid');
  grid.innerHTML = '';
  PHOTOS.forEach(function (p) {
    var un = photosUnlocked.indexOf(p.id) >= 0;
    var d = document.createElement('div');
    d.className = 'photo-item' + (un ? '' : ' locked');
    d.innerHTML = un
      ? p.art() + '<b>' + esc(p.title) + '</b><small>' + esc(p.cap) + '</small>'
      : '<div class="photo-lock">🔒</div><b>未解锁</b><small>推进故事解锁</small>';
    grid.appendChild(d);
  });
}

/* ================= 剧情事件钩子 ================= */
function leadNow() {
  try {
    var leads = selected();
    return leads[(state.turn - 1) % leads.length] || leads[0];
  } catch (e) { return null; }
}
function phoneOnTurn() {
  var soloish = !window.Netplay || Netplay.mode === 'off' || Netplay.mode === 'host';
  if (!soloish) return;
  // 1) 把旧的 phone-card 短信迁移进微信
  try {
    var pc = $('#phone-card');
    if (pc && !pc.hidden && pc.textContent.trim()) {
      var lead = leadNow();
      if (lead) pushIM(threadIdFor(lead.id), lead.id, pc.textContent.trim().replace(/\s+/g, ' ').slice(0, 200));
      pc.hidden = true;
      pc.innerHTML = '';
    }
  } catch (e) {}
  if (!window.state) return;
  var turn = state.turn;
  // 2) 照片解锁：第 2/4/6/8/10/12 回合
  if (turn >= 2 && turn % 2 === 0) {
    var pi = turn / 2 - 1;
    if (pi < PHOTOS.length) unlockPhoto(PHOTOS[pi].id);
  }
  // 3) 群聊气氛：每 4 回合
  if (turn > 1 && turn % 4 === 0) {
    setTimeout(groupAmbient, 3000);
  }
  // 4) 剧本来电
  if (turn === 3) {
    setTimeout(function () { incomingCall('agent', 'agent_notice'); }, 4000);
  }
  if (turn === 6) {
    var ld = leadNow();
    if (ld) setTimeout(function () { incomingCall(ld.id, 'lead_call'); }, 4000);
  }
}
/* app.js 已退役：只有旧故事引擎仍在（typeof 检查通过）时才包装 renderTurn，
 * 否则跳过——直接引用未定义的 renderTurn 会抛 ReferenceError 杀死整个 IIFE。 */
if (typeof renderTurn === 'function') {
  var _renderTurn = renderTurn;
  renderTurn = function (mode, action) {
    _renderTurn(mode, action);
    try { phoneOnTurn(); } catch (e) { console.warn('[phone] onTurn', e); }
  };
}

/* ================= 对外 API ================= */
var Phone = {
  show: show,
  goHome: goHome,
  openApp: openApp,
  im: pushIM,
  unlockPhoto: unlockPhoto,
  incomingCall: incomingCall,
  _photoBadge: 0,
  setGuest: function (g) {
    guestMode = !!g;
    var wx = $('#wx-text');
    if (wx) {
      wx.disabled = guestMode;
      wx.placeholder = guestMode ? '客人模式：只读房主的故事' : '发消息…';
    }
    var send = $('#wx-send');
    if (send) send.disabled = guestMode;
  },
  exportIM: function () { return { threads: threads, meta: threadMeta }; },
  exportPhotos: function () { return photosUnlocked.slice(); },
  exportCallLog: function () { return callLog.slice(-30); },
  guestIM: function (tid, from, text) {
    if (!threads[tid]) threads[tid] = [];
    if (!threadMeta[tid]) {
      var m = from ? memberById(from) : null;
      threadMeta[tid] = { name: m ? m.name : (tid === 'group' ? 'CORTIS · 练习生小群' : '未知'), sub: '' };
    }
    threads[tid].push({ me: false, text: text, ts: gameClock(), from: from || null });
    if (currentThread === tid && !$('#wx-thread').hidden) renderMsgs();
    else unread[tid] = (unread[tid] || 0) + 1;
    renderHomeBadges();
  },
  guestPhoto: function (id) {
    if (photosUnlocked.indexOf(id) < 0) {
      photosUnlocked.push(id);
      Phone._photoBadge = (Phone._photoBadge || 0) + 1;
      renderHomeBadges();
    }
  },
  guestCallLog: function (log) {
    callLog = log || [];
    if (phoneTab === 'log' && !$('#app-phone').hidden) renderCallLog();
  },
  /* 进入手机主流程：solo | host | guest */
  enterMain: function (mode, snapshot) {
    guestMode = (mode === 'guest');
    ensureThreads();
    if (snapshot) {
      if (snapshot.im) { threads = snapshot.im.threads || {}; threadMeta = snapshot.im.meta || {}; }
      if (snapshot.photos) photosUnlocked = snapshot.photos.slice();
      if (snapshot.calllog) callLog = snapshot.calllog.slice();
    }
    Phone.setGuest(guestMode);
    document.body.classList.add('phone-on');
    goHome();
    if (mode === 'solo') {
      setTimeout(function () {
        var lead = leadNow();
        if (lead) pushIM(threadIdFor(lead.id), lead.id,
          '嗨！我是' + lead.name + '，刚才见过啦。存下我的微信吧，有事随时找我。');
      }, 1500);
    }
  },
};
window.Phone = Phone;

/* game.js 复用桥：哄哄模式纯逻辑 + 数据（只读调用）。
 * 注意：phone.js 本体是 IIFE，这些函数/数据不暴露就跨文件用不了；
 * 写旧 #wx-* DOM 的渲染函数（renderDmHead / renderQuickReplies / dmDailyIntro 等）不在此列，game.js 自己写新渲染。 */
window.WxCore = {
  scoreWxMsg: scoreWxMsg, dmTier: dmTier, affectionTier: affectionTier,
  tierWrap: tierWrap, splitBubbles: splitBubbles, pickDmReact: pickDmReact,
  WX_QUICK: WX_QUICK, WX_QUICK_FALLBACK: WX_QUICK_FALLBACK,
  DM_SCENE: DM_SCENE, DM_OPEN: DM_OPEN, DM_HINT: DM_HINT, DM_MILE: DM_MILE,
  DM_FACE: DM_FACE, DM_MOOD: DM_MOOD,
  dmAff: dmAff, memberById: memberById, gameClock: gameClock, wxToday: wxToday,
  ensureFirstDay: ensureFirstDay, ensureWxScore: ensureWxScore, esc: esc, toast: toast,
  playerTitle: playerTitle
};

/* ================= 开机流程 & 接线 ================= */
function parseSetup() {
  var chosen = Array.prototype.map.call(
    document.querySelectorAll('.member-card input:checked'), function (x) { return x.value; });
  if (!chosen.length) { alert('请至少选择一位故事主角。'); return null; }
  /* 年龄/国籍/性格/职业是 select（custom 选项走手填框），只有姓名是必填文本输入 */
  var nameEl = $('#player-name');
  if (!nameEl || !nameEl.value.trim()) { alert('请填写姓名。'); if (nameEl) nameEl.focus(); return null; }
  return chosen;
}
function startSolo() {
  var chosen = parseSetup();
  if (!chosen) return;
  state.chosen = chosen;
  state.player = {
    name: $('#player-name').value.trim(),
    age: setupField('age'),
    country: setupField('country'),
    traits: setupField('traits'),
    job: setupField('job'),
    gender: setupField('gender'),
  };
  if (!state.affection) state.affection = {};
  chosen.forEach(function (id) { state.affection[id] = 18; });
  ensureFirstDay();
  ensureWxScore();
  save();
  $('#onboarding').hidden = true;
  $('#game').hidden = false;
  if (typeof Game !== 'undefined' && Game.init) Game.init();
  toast('欢迎回来，' + state.player.name);
}

/* onboarding 成员卡：用 game.js 注入的 window.members 填充，默认勾选第一位 */
function fillMemberPicker() {
  var box = $('#member-picker');
  if (!box) return;
  var ms = window.members || [];
  if (!box.children.length && ms.length) {
    box.innerHTML = ms.map(function (m, i) {
      return '<label class="member-card" data-index="0' + (i + 1) + '"><input type="checkbox" value="' +
        m.id + '"><span><strong>' + m.name + '</strong><small>' + m.en + ' · ' + m.role + '</small></span></label>';
    }).join('');
  }
  var first = box.querySelector('.member-card input');
  if (first && !box.querySelector('.member-card input:checked')) first.checked = true;
}
/* 设定页 select + 自定义手填框：选 custom 时读手填框（空则回落"随便"），逻辑层不区分预设/手填 */
function setupField(name) {
  var sel = $('#player-' + name);
  var custom = $('#player-' + name + '-custom');
  if (!sel) return '';
  if (sel.value === 'custom' && custom) {
    return custom.value.trim() || '随便';
  }
  return sel.value;
}
function wireCustomInputs() {
  ['age', 'country', 'traits', 'job', 'gender'].forEach(function (name) {
    var sel = $('#player-' + name);
    var custom = $('#player-' + name + '-custom');
    if (!sel || !custom) return;
    var sync = function () { custom.hidden = (sel.value !== 'custom'); };
    sel.addEventListener('change', sync);
    sync();
  });
}
/* 随机昵称池：点一下填一个进 #player-name */
var NAME_POOL = ['阿哲', '小北', '陈屿', '林晚', '苏打', '阿野', '江小满', '迟遇', '沈聿', '陆燃', '顾清', '温辞'];
function wireRandName() {
  var b = $('#rand-name');
  if (!b) return;
  b.onclick = function () {
    var inp = $('#player-name');
    if (inp) inp.value = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
  };
}

function wire() {
  // document 捕获阶段拦截单人提交（multiplayer 只处理 create；app.js 在目标阶段）
  document.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'setup-form') return;
    if (window.Netplay && Netplay.pending === 'create') return; // 交给 multiplayer
    e.preventDefault();
    e.stopPropagation();
    startSolo();
  }, true);

  // 锁屏
  var hasRoom = /[?&]room=/.test(location.search);
  document.body.classList.add('phone-on');
  if (hasRoom) {
    show('onboarding');
  } else {
    show('lockscreen');
    var lk = $('#lockscreen');
    if (lk) {
      var unlock = function () { show('onboarding'); };
      lk.addEventListener('click', unlock);
      /* 上滑解锁：touchstart 记起点，touchend 上滑超 30px 即解锁；轻点走 click */
      var tsY = 0;
      lk.addEventListener('touchstart', function (e) {
        try { tsY = e.changedTouches[0].clientY; } catch (_) { tsY = 0; }
      }, { passive: true });
      lk.addEventListener('touchend', function (e) {
        var dy = 0;
        try { dy = tsY - e.changedTouches[0].clientY; } catch (_) {}
        if (dy > 30) { e.preventDefault(); unlock(); }
      });
    }
  }
  tickClock();
  setInterval(tickClock, 20000);

  // 主屏幕图标
  Array.prototype.forEach.call(document.querySelectorAll('.app-icon'), function (b) {
    b.onclick = function () { openApp(b.getAttribute('data-app')); };
  });
  // 各 App 的 ⌂ 主页键
  Array.prototype.forEach.call(document.querySelectorAll('.home-btn'), function (b) {
    b.onclick = goHome;
  });
  // 故事页的 ⌂（index.html 里单独加的）
  var shb = $('#story-home-btn');
  if (shb) shb.onclick = goHome;

  // 微信接线（旧 #app-wechat 已下线：逐个判空，缺 DOM 即跳过，避免抛错杀死脚本）
  var wxBack = $('#wx-back');
  if (wxBack) wxBack.onclick = renderThreadList;
  var wxSend = $('#wx-send');
  if (wxSend) wxSend.onclick = sendWx;
  var wxText = $('#wx-text');
  if (wxText) wxText.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendWx(); }
  });
  // 私聊里程碑 overlay：继续聊天按钮关闭
  var mileBtn = $('#wx-milestone-btn');
  if (mileBtn) {
    mileBtn.onclick = function () {
      var ov = $('#wx-milestone');
      if (ov) ov.hidden = true;
    };
  }

  // 电话接线
  Array.prototype.forEach.call(document.querySelectorAll('.ph-tab'), function (b) {
    b.onclick = function () { phoneTab = b.getAttribute('data-ptab'); renderPhoneTab(); };
  });
  var dialNum = '';
  Array.prototype.forEach.call(document.querySelectorAll('.dial-key'), function (k) {
    k.onclick = function () {
      if (dialNum.length >= 15) return;
      dialNum += k.getAttribute('data-k');
      $('#dial-display').textContent = dialNum;
    };
  });
  var dialClear = $('#dial-clear');
  if (dialClear) dialClear.onclick = function () { dialNum = ''; var dd = $('#dial-display'); if (dd) dd.textContent = '　'; };
  var dialCall = $('#dial-call');
  if (dialCall) dialCall.onclick = function () {
    if (guestMode) { toast('客人模式下不能打电话哦'); return; }
    if (!dialNum) return;
    toast('你拨打的号码是空号…');
  };
  var callEnd = $('#call-end');
  if (callEnd) callEnd.onclick = function () { endCall(false); };

  fillMemberPicker();
  wireRandName();
  wireCustomInputs();
  updateBondDays();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}
})();
