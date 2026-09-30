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
    if (el) el.hidden = (s !== id);
  });
  window.scrollTo(0, 0);
}
function goHome() {
  show('home');
  renderHomeBadges();
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
}
function openThread(tid) {
  currentThread = tid;
  $('#wx-thread-list').hidden = true;
  var th = $('#wx-thread');
  th.hidden = false;
  $('#wx-thread-name').textContent = threadMeta[tid].name;
  unread[tid] = 0;
  renderMsgs();
  renderHomeBadges();
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
  threads[currentThread].push({ me: true, text: text, ts: gameClock() });
  renderMsgs();
  if (currentThread === 'group') { groupReply(text); return; }
  var mid = currentThread.replace(/^dm:/, '');
  var box = $('#wx-msgs');
  var typing = document.createElement('div');
  typing.className = 'wx-msg them';
  typing.innerHTML = '<span class="wx-avatar sm">' + esc(threadMeta[currentThread].name.charAt(0)) +
    '</span><div class="wx-bubble typing"><i></i><i></i><i></i></div>';
  setTimeout(function () {
    if (currentThread) { box.appendChild(typing); box.scrollTop = box.scrollHeight; }
  }, 600);
  setTimeout(function () {
    if (typing.parentNode) typing.parentNode.removeChild(typing);
    pushIM(currentThread, mid, botReply(mid, text));
  }, 1400 + Math.random() * 1400);
}

/* ---- 微信回复引擎：关键词 + 好感/地点/时间上下文 ---- */
var FALLBACK = {
  james: ['嗯，我在听，你说', '这样啊…你觉得呢？', '慢慢来，不着急'],
  juhoon: ['哦', '…嗯', '知道了'],
  martin: ['交给我吧', '放心，有我在', '嗯，我明白'],
  seong: ['哼，算你有眼光', '才、才不是关心你', '知道了啦'],
  keonho: ['嘿嘿', '真的吗？', '好开心呀'],
};
function botReply(mid, text) {
  var m = memberById(mid);
  var t = String(text || '');
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
  for (var i = 0; i < rules.length; i++) {
    if (rules[i][0].test(t)) {
      var r = rules[i][1];
      r = (typeof r === 'function') ? r() : r;
      return r[Math.floor(Math.random() * r.length)];
    }
  }
  var fb = FALLBACK[mid] || ['嗯嗯', '哈哈', '这样啊'];
  var s = fb[Math.floor(Math.random() * fb.length)];
  if (Math.random() < 0.25) s += '对了，' + placeNow() + '这边刚才还挺热闹的。';
  return s;
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
    pushIM('group', mid, (m ? m.name : '成员') + '：' + botReply(mid, text));
  }, 1500 + Math.random() * 1500);
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
var _renderTurn = renderTurn;
renderTurn = function (mode, action) {
  _renderTurn(mode, action);
  try { phoneOnTurn(); } catch (e) { console.warn('[phone] onTurn', e); }
};

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

/* ================= 开机流程 & 接线 ================= */
function parseSetup() {
  var chosen = Array.prototype.map.call(
    document.querySelectorAll('.member-card input:checked'), function (x) { return x.value; });
  if (!chosen.length) { alert('请至少选择一位故事主角。'); return null; }
  var req = [['#player-name', '姓名'], ['#player-age', '年龄'], ['#player-country', '国籍'], ['#player-traits', '性格']];
  for (var i = 0; i < req.length; i++) {
    if (!$(req[i][0]).value.trim()) { alert('请填写' + req[i][1] + '。'); $(req[i][0]).focus(); return null; }
  }
  return chosen;
}
function startSolo() {
  var chosen = parseSetup();
  if (!chosen) return;
  state.chosen = chosen;
  state.player = {
    name: $('#player-name').value.trim(),
    age: $('#player-age').value,
    country: $('#player-country').value.trim(),
    traits: $('#player-traits').value.trim(),
    job: $('#player-job').value === 'custom' ? $('#custom-job').value.trim() : $('#player-job').value,
    style: $('#player-style').value.trim(),
  };
  chosen.forEach(function (id) { state.affection[id] = 18; });
  try { localStorage.setItem('cortis-save', JSON.stringify(state)); } catch (err) {}
  $('#onboarding').hidden = true;
  renderTurn('start');
  Phone.enterMain('solo');
  toast('欢迎回来，' + state.player.name);
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
    $('#lockscreen').addEventListener('click', function () { show('onboarding'); });
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

  // 微信接线
  $('#wx-back').onclick = renderThreadList;
  $('#wx-send').onclick = sendWx;
  $('#wx-text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendWx(); }
  });

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
  $('#dial-clear').onclick = function () { dialNum = ''; $('#dial-display').textContent = '　'; };
  $('#dial-call').onclick = function () {
    if (guestMode) { toast('客人模式下不能打电话哦'); return; }
    if (!dialNum) return;
    toast('你拨打的号码是空号…');
  };
  $('#call-end').onclick = function () { endCall(false); };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}
})();
