/* CORTIS 恋爱模拟器 · 哄哄式单屏聊天主逻辑
 * 加载顺序 game.js 在前、phone.js 在后（HTML 保证）。
 * app.js 已退役：本文件顶部先定义 $ / state / save / members（替代 app.js 的同名全局），
 * phone.js 的 IIFE 内部通过作用域链读到它们；哄哄判分与台词通过 phone.js 暴露的 window.WxCore 只读复用。
 */
'use strict';
var $ = function (s) { return document.querySelector(s); };

/* 成员表：与 app.js 第 1-8 行一致（含 en/role/tone 字段） */
var members=[
 {id:'james',name:'赵雨凡',en:'James',role:'领舞 · 领唱',tone:'礼貌温和，细致而克制'},
 {id:'juhoon',name:'金主训',en:'Juhoon',role:'主舞 · Rapper',tone:'冷感直接，情绪写在眼里'},
 {id:'martin',name:'马丁',en:'Martin',role:'队长 · 制作人',tone:'沉稳控场，敏锐又真诚'},
 {id:'seong',name:'严成玹',en:'Seonghyeon',role:'主唱',tone:'嘴硬心细，镜头感十足'},
 {id:'keonho',name:'安乾镐',en:'Keonho',role:'副唱 · 忙内',tone:'安静真诚，笑眼很亮'}
];
window.members = members;

/* 存档：读 localStorage 'cortis-save'；读不到或缺字段时补默认对象（只增字段，老存档兼容） */
var state = (function () {
  var def = {
    turn: 0, time: 468, chosen: [], items: [], affDim: {},
    stats: { mood: 70, popularity: 32, money: 18000, secrecy: 100, alertness: 18, pressure: 52, impulse: 28 },
    affection: {}, player: {}, firstDay: 0, chat: {}
  };
  var s = null;
  try {
    var raw = localStorage.getItem('cortis-save');
    if (raw) s = JSON.parse(raw);
  } catch (e) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  Object.keys(def).forEach(function (k) {
    if (typeof s[k] === 'undefined') s[k] = def[k];
  });
  if (!s.stats || typeof s.stats !== 'object') s.stats = def.stats;
  if (!s.affection || typeof s.affection !== 'object') s.affection = {};
  if (!s.chat || typeof s.chat !== 'object') s.chat = {};
  return s;
})();
function save() {
  try { localStorage.setItem('cortis-save', JSON.stringify(state)); } catch (e) {}
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 撒花：复用 style.css 的 .heart-particle（app.js 的 burstHearts 已随 app.js 退役，本地补一份等效实现） */
function popHearts(x, y) {
  try {
    for (var i = 0; i < 10; i++) {
      var s = document.createElement('span');
      s.className = 'heart-particle';
      s.textContent = '♥';
      s.style.left = x + 'px';
      s.style.top = y + 'px';
      var ang = Math.random() * Math.PI * 2;
      var dist = 60 + Math.random() * 90;
      s.style.setProperty('--dx', Math.round(Math.cos(ang) * dist) + 'px');
      s.style.setProperty('--dy', Math.round(Math.sin(ang) * dist) + 'px');
      document.body.appendChild(s);
      (function (el) { setTimeout(function () { el.remove(); }, 1100); })(s);
    }
  } catch (e) {}
}

/* 心情副标题（四档） */
var G_MOOD = ['还在气头上', '有点松动了', '快好了，再加把劲', '彻底心动'];
/* dmTier 0-3 映射到 tierWrap 的档名 */
var TIER_NAME = ['cold', 'hesitant', 'friendly', 'active'];

/* 心动场景 2/3（新写；scene1 走 DM_SCENE/DM_OPEN）。
 * 主题取自旧剧情：练习室初遇、雨天共伞、深夜便利店、天台夜景、录音室；每人 3 个不重样，CORTIS 人设口吻。 */
var SCENES_NEW = {
  james: [
    { pill: '雨天的练习室门口，他把伞往你这边倾了倾', open: '雨下得好大……你没带伞吧？一起走，我送你到门口。', hint: '他把伞让给了你——回点暖心的话试试' },
    { pill: '深夜便利店，他买了两瓶热牛奶，递给你一瓶', open: '这个点了还不睡？热牛奶分你一瓶，暖暖手。', hint: '深夜便利店的热牛奶——别辜负这份体贴' }
  ],
  juhoon: [
    { pill: '走廊尽头的录音室，他摘下耳机，示意你进来坐', open: '……你怎么来了。刚写了段旋律，要听吗？只给你听一遍。', hint: '冷脸底下藏着分享欲——认真听他说' },
    { pill: '天台夜景，他一个人站了很久，风把外套吹得鼓起来', open: '风大，站过来点。……刚才在想新歌的事，有点卡住了。', hint: '他愿意跟你说卡住的事——别敷衍' }
  ],
  martin: [
    { pill: '练习室初遇，他关掉音响，朝你点了点头', open: '你就是今天来对接的工作人员？辛苦了，先喝口水，慢慢说。', hint: '队长的沉稳开场——礼貌回应，别拘谨' },
    { pill: '深夜的队长办公室，他把明天的行程表推到你面前', open: '这么晚还没走？正好，帮我看看明天的安排有没有漏的。', hint: '被队长需要了——认真一点，他会记住' }
  ],
  seong: [
    { pill: '天台上风有点大，他嘴上说着麻烦，却把外套分了你一半', open: '喂，你冷不冷？……别误会，我就是外套穿不下了。', hint: '嘴硬又心软——戳穿他要温柔一点' },
    { pill: '深夜便利店，他买了关东煮，嘴上嫌弃还是分了你一串', open: '哼，看你可怜才分你的。……好吃吧？我就知道。', hint: '傲娇的关东煮——夸他两句试试' }
  ],
  keonho: [
    { pill: '练习室初遇，他练舞练到一半，笑着朝你挥手', open: '嘿嘿，你来啦！刚才那段帅不帅？我练了好久呢。', hint: '忙内的元气开场——夸他，他会超开心' },
    { pill: '雨天共伞，他举着伞，自己半边肩膀全湿了', open: '嘿嘿，伞小了点，你往中间站嘛。我没事，我不怕淋。', hint: '他肩膀都湿了——心疼他一下' }
  ]
};
/* 取第 idx 个场景三连：idx=0 复用 DM_SCENE/DM_OPEN，其余走 SCENES_NEW */
function sceneTrio(mid, idx) {
  var W = window.WxCore || {};
  if (idx === 0) {
    return {
      pill: (W.DM_SCENE && W.DM_SCENE[mid]) || '夜深了，他还在等你说话',
      open: (W.DM_OPEN && W.DM_OPEN[mid]) || '嗨，在吗？',
      hint: W.DM_HINT || '回得走心一点——他会记住你的每一句话'
    };
  }
  var arr = SCENES_NEW[mid] || [];
  return arr[(idx - 1) % arr.length] || { pill: '', open: '嗨，在吗？', hint: '' };
}

var Game = {
  mid: null,
  _docked: false,

  /* ---------- 基础 ---------- */
  memberOf: function (id) {
    for (var i = 0; i < members.length; i++) if (members[i].id === id) return members[i];
    return null;
  },
  chatOf: function (mid) {
    return (state.chat && state.chat[mid]) || null;
  },
  clampAff: function (a) {
    a = Number(a) || 0;
    return Math.max(0, Math.min(100, a));
  },
  clock: function () {
    try {
      var W = window.WxCore || {};
      if (W.gameClock) return W.gameClock();
    } catch (e) {}
    var d = new Date();
    return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  },
  tierOf: function (mid) {
    var W = window.WxCore || {};
    var c = this.chatOf(mid);
    var aff = c ? c.aff : 0;
    return W.dmTier ? W.dmTier(aff) : 0;
  },
  faceOf: function (mid) {
    var W = window.WxCore || {};
    var tier = this.tierOf(mid);
    return (W.DM_FACE && W.DM_FACE[tier]) || '😐';
  },

  /* state.chat 初始化：aff 取旧存档 state.affection[mid] 钳制 0-100，否则 20；msgs 上限 100 */
  ensureChat: function () {
    var self = this;
    if (!state.chat || typeof state.chat !== 'object') state.chat = {};
    members.forEach(function (m) {
      var c = state.chat[m.id];
      if (!c || typeof c !== 'object') c = state.chat[m.id] = { msgs: [], aff: 0, scene: 0, win: false, introDay: '' };
      if (!Array.isArray(c.msgs)) c.msgs = [];
      if (!c._inited) {
        var old = Number(state.affection && state.affection[m.id]);
        c.aff = isNaN(old) ? 20 : self.clampAff(old);
        if (state.affection && typeof state.affection[m.id] === 'undefined') state.affection[m.id] = c.aff;
        c._inited = true;
      }
      c.aff = self.clampAff(c.aff);
      if (c.msgs.length > 100) c.msgs = c.msgs.slice(-100);
    });
    save();
  },

  /* ---------- 入口 ---------- */
  init: function () {
    var W = window.WxCore || {};
    try { if (W.ensureFirstDay) W.ensureFirstDay(); } catch (e) {}
    try { if (W.ensureWxScore) W.ensureWxScore(); } catch (e) {}
    this.ensureChat();
    this.wireDock();
    var mid = (state.chosen && state.chosen[0]) || 'james';
    if (!this.chatOf(mid)) mid = 'james';
    this.selectMember(mid);
  },

  selectMember: function (mid) {
    if (!this.chatOf(mid)) return;
    this.mid = mid;
    this.renderBar();
    this.renderHead();
    this.renderFlow();
    this.renderQuick();
    this.maybeIntro();
  },

  /* ---------- 渲染 ---------- */
  renderBar: function () {
    var bar = $('#member-bar');
    if (!bar) return;
    var self = this;
    var ids = (state.chosen && state.chosen.length) ? state.chosen : members.map(function (m) { return m.id; });
    bar.innerHTML = '';
    ids.forEach(function (id) {
      var m = self.memberOf(id);
      if (!m) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mtab' + (id === self.mid ? ' active' : '');
      b.setAttribute('data-mid', id);
      var face = document.createElement('span');
      face.className = 'mtab-face';
      face.textContent = self.faceOf(id);
      var nm = document.createElement('span');
      nm.className = 'mtab-name';
      nm.textContent = m.name;
      b.appendChild(face);
      b.appendChild(nm);
      b.onclick = function () { self.selectMember(id); };
      bar.appendChild(b);
    });
  },

  renderHead: function () {
    var m = this.memberOf(this.mid);
    var c = this.chatOf(this.mid);
    if (!m || !c) return;
    var tier = this.tierOf(this.mid);
    var set = function (sel, txt) { var el = $(sel); if (el) el.textContent = txt; };
    set('#g-avatar', this.faceOf(this.mid));
    set('#g-name', m.name + ' · ' + m.en);
    set('#g-mood', G_MOOD[tier] || '');
    set('#g-affnum', c.aff + ' / 100');
    var fill = $('#g-fill');
    if (fill) fill.style.width = c.aff + '%';
    var days = 1;
    try {
      if (state.firstDay) {
        days = Math.floor((Date.now() - state.firstDay) / 86400000) + 1;
        if (days < 1) days = 1;
      }
    } catch (e) {}
    set('#g-days', '羁绊第 ' + days + ' 天');
  },

  /* 单条消息 DOM：me 右气泡 / them 左气泡（头像用当前档位表情） */
  msgEl: function (msg) {
    var d = document.createElement('div');
    var bub = document.createElement('div');
    bub.className = 'g-bubble';
    bub.textContent = msg.text;
    var ts = document.createElement('small');
    ts.className = 'g-ts';
    ts.textContent = msg.ts || '';
    bub.appendChild(ts);
    if (msg.me) {
      d.className = 'g-msg me';
      d.appendChild(bub);
    } else {
      d.className = 'g-msg them';
      var av = document.createElement('span');
      av.className = 'g-avatar';
      av.textContent = this.faceOf(this.mid);
      d.appendChild(av);
      d.appendChild(bub);
    }
    return d;
  },

  renderFlow: function () {
    var flow = $('#g-flow');
    if (!flow) return;
    var self = this;
    flow.innerHTML = '';
    var c = this.chatOf(this.mid);
    (c ? c.msgs : []).forEach(function (msg) { flow.appendChild(self.msgEl(msg)); });
    flow.scrollTop = flow.scrollHeight;
  },

  /* 快捷回复：WX_QUICK 冷暖两档按档位取（0-1 档 cold，2-3 档 warm），{name} 替换 */
  renderQuick: function () {
    var box = $('#g-quick');
    if (!box) return;
    var W = window.WxCore || {};
    var m = this.memberOf(this.mid);
    var name = m ? m.name : '他';
    var q = (W.WX_QUICK && W.WX_QUICK[this.mid]) || W.WX_QUICK_FALLBACK || { cold: [], warm: [] };
    var tier = this.tierOf(this.mid);
    var pool = tier <= 1 ? q.cold : q.warm;
    box.innerHTML = '';
    var self = this;
    pool.slice(0, 5).forEach(function (line) {
      var rendered = String(line).replace(/\{name\}/g, name);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qr-btn';
      b.textContent = rendered;
      b.onclick = function () { self.send(rendered); };
      box.appendChild(b);
    });
  },

  /* ---------- 消息流 ---------- */
  pushMsg: function (mid, msg, skipRender) {
    var c = this.chatOf(mid);
    if (!c) return;
    c.msgs.push(msg);
    if (c.msgs.length > 100) c.msgs = c.msgs.slice(-100);
    if (!skipRender && mid === this.mid) {
      var flow = $('#g-flow');
      if (flow) {
        flow.appendChild(this.msgEl(msg));
        flow.scrollTop = flow.scrollHeight;
      }
    }
    save();
  },

  /* 分数胶囊：中央显示，+N 绿 / -N 红，几秒后淡出 */
  showScorePill: function (delta, tag) {
    var flow = $('#g-flow');
    if (!flow) return;
    var d = document.createElement('div');
    d.className = 'score-pill ' + (delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat'));
    d.textContent = delta > 0 ? ('+' + delta + ' ♥ · ' + tag)
      : (delta < 0 ? (delta + ' ♥') : '±0 ♥');
    flow.appendChild(d);
    flow.scrollTop = flow.scrollHeight;
    setTimeout(function () { d.classList.add('fade'); }, 2200);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2600);
  },

  showTyping: function (mid) {
    if (mid !== this.mid) return;
    var flow = $('#g-flow');
    if (!flow) return;
    this.hideTyping();
    var d = document.createElement('div');
    d.className = 'g-msg them';
    d.id = 'g-typing';
    var av = document.createElement('span');
    av.className = 'g-avatar';
    av.textContent = this.faceOf(mid);
    var bub = document.createElement('div');
    bub.className = 'g-bubble typing';
    bub.textContent = '正在输入…';
    d.appendChild(av);
    d.appendChild(bub);
    flow.appendChild(d);
    flow.scrollTop = flow.scrollHeight;
  },
  hideTyping: function () {
    var t = document.getElementById('g-typing');
    if (t && t.parentNode) t.parentNode.removeChild(t);
  },

  /* 开场三连：场景 pill → 对方开场白气泡 → 玩法 hint；开场白记入历史 */
  playScene: function (mid, idx) {
    var trio = sceneTrio(mid, idx);
    var c = this.chatOf(mid);
    if (!c) return;
    c.scene = idx;
    if (mid === this.mid) {
      var flow = $('#g-flow');
      if (flow) {
        var pill = document.createElement('div');
        pill.className = 'scene-pill';
        pill.textContent = trio.pill;
        flow.appendChild(pill);
        flow.appendChild(this.msgEl({ me: false, text: trio.open, ts: this.clock() }));
        var hint = document.createElement('div');
        hint.className = 'hint-pill';
        hint.textContent = '💡 ' + trio.hint;
        flow.appendChild(hint);
        flow.scrollTop = flow.scrollHeight;
      }
    }
    this.pushMsg(mid, { me: false, text: trio.open, ts: this.clock() }, true);
    save();
  },

  /* 每日首次进入该成员时播开场三连 */
  maybeIntro: function () {
    var W = window.WxCore || {};
    var c = this.chatOf(this.mid);
    if (!c) return;
    var today = W.wxToday ? W.wxToday() : '';
    if (c.introDay === today) return;
    this.playScene(this.mid, c.scene || 0);
    c.introDay = today;
    save();
  },

  /* 发送：判分 → 胶囊 → 好感 → 延迟 → 正在输入 → 档位反应逐条发出 */
  send: function (raw) {
    var text = String(raw || '').trim().slice(0, 200);
    if (!text || !this.mid) return;
    var W = window.WxCore || {};
    var mid = this.mid;
    var self = this;
    this.hideTyping();
    this.pushMsg(mid, { me: true, text: text, ts: this.clock() });
    var sc = W.scoreWxMsg ? W.scoreWxMsg(text) : { delta: 0, tag: '' };
    var c = this.chatOf(mid);
    c.aff = this.clampAff(c.aff + sc.delta);
    if (!state.affection) state.affection = {};
    state.affection[mid] = c.aff;
    this.showScorePill(sc.delta, sc.tag);
    this.renderHead();
    this.renderBar();
    this.renderQuick();
    save();
    this.maybeMilestone(mid);
    setTimeout(function () {
      if (mid !== self.mid) { self.deliverReply(mid, sc.delta); return; }
      self.showTyping(mid);
      setTimeout(function () { self.deliverReply(mid, sc.delta); }, 500 + Math.random() * 500);
    }, 400 + Math.random() * 400);
  },

  /* 按得分档抽反应（pickDmReact）→ 按好感四档组装（tierWrap）→ 拆条 → 逐条发出 */
  deliverReply: function (mid, delta) {
    var W = window.WxCore || {};
    var self = this;
    this.hideTyping();
    var c = this.chatOf(mid);
    if (!c) return;
    var tierIdx = W.dmTier ? W.dmTier(c.aff) : 0;
    var tierName = TIER_NAME[tierIdx] || 'cold';
    var react = W.pickDmReact ? W.pickDmReact(delta, mid) : '嗯';
    var bubbles = W.tierWrap ? W.tierWrap(mid, react, tierName) : [react];
    var flat = [];
    bubbles.forEach(function (b) {
      var parts = W.splitBubbles ? W.splitBubbles(b) : [b];
      parts.forEach(function (p) { if (String(p).trim()) flat.push(p); });
    });
    if (!flat.length) flat = ['嗯'];
    var i = 0;
    (function next() {
      if (i >= flat.length) { save(); return; }
      self.pushMsg(mid, { me: false, text: flat[i], ts: self.clock() });
      i++;
      if (i < flat.length) setTimeout(next, 800 + Math.random() * 1200);
      else save();
    })();
  },

  /* 里程碑：好感首次到 100，弹全屏心动 overlay 并撒花 */
  maybeMilestone: function (mid) {
    var W = window.WxCore || {};
    var c = this.chatOf(mid);
    if (!c || c.win) return;
    if (c.aff < 100) return;
    c.win = true;
    save();
    var ov = $('#g-win');
    if (!ov) return;
    var txt = ov.querySelector('.g-win-text');
    if (txt) txt.textContent = (W.DM_MILE && W.DM_MILE[mid]) || '他第一次没有躲开你的视线。';
    ov.hidden = false;
    var n = 0;
    var iv = setInterval(function () {
      try { popHearts(Math.random() * window.innerWidth, window.innerHeight * (0.2 + Math.random() * 0.5)); } catch (_) {}
      n++;
      if (n >= 6) clearInterval(iv);
    }, 350);
  },

  /* 输入区接线：回车发送、Shift+回车换行、maxlength 200、场景切换、里程碑关闭 */
  wireDock: function () {
    if (this._docked) return;
    this._docked = true;
    var self = this;
    var input = $('#g-input');
    var sendBtn = $('#g-send');
    var doSend = function () {
      if (!input) return;
      var v = input.value;
      input.value = '';
      self.send(v);
    };
    if (sendBtn) sendBtn.onclick = doSend;
    if (input) {
      input.setAttribute('maxlength', '200');
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
      });
    }
    var sb = $('#g-scene-btn');
    if (sb) sb.onclick = function () {
      if (!self.mid) return;
      var c = self.chatOf(self.mid);
      var next = (((c && typeof c.scene === 'number') ? c.scene : 0) + 1) % 3;
      self.playScene(self.mid, next);
    };
    var ok = $('#g-win-ok');
    if (ok) ok.onclick = function () { var ov = $('#g-win'); if (ov) ov.hidden = true; };
  }
};
window.Game = Game;
