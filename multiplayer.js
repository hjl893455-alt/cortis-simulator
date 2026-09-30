/* CORTIS 恋爱模拟器 · 多人模式
 * P2P 联机：房主创建房间（拿到 4 位房间码）→ 朋友输入房间码加入
 * 每回合大家投票决定剧情走向，另带房间实时聊天。
 * 房主是故事的唯一数据源（source of truth），客人只接收同步 + 投票。
 * 依赖：PeerJS（CDN）。单人模式不受任何影响。
 */
(function () {
'use strict';
if (!document.getElementById('setup-form')) return; // 非游戏页不运行

var $ = function (s) { return document.querySelector(s); };

var PEER_PREFIX = 'cortis-sim-v1-';
var VOTE_SECS = 25;
var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

var Netplay = {
  pending: 'solo',          // onboarding 选择：solo | create
  mode: 'off',              // off | host | guest
  peer: null,
  code: null,
  name: '',
  conns: {},                // host: peerId -> { conn, name }
  members: [],              // [{ id, name, host }]
  voterChoice: {},           // voterId -> choiceKey
  timer: null,
  timeLeft: 0,
  lastTurn: null,
  chatUnread: 0,
  joinTimer: null,
};
window.Netplay = Netplay;
Netplay.broadcast = broadcast; // 供 phone.js 同步微信/相册/通话记录（broadcast 为函数声明，提升可用）

/* ---------- 小工具 ---------- */
function genCode() {
  var c = '';
  for (var i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
function toast(msg) {
  var t = document.createElement('div');
  t.className = 'np-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.classList.add('show'); }, 30);
  setTimeout(function () { t.classList.remove('show'); setTimeout(function(){ t.remove(); }, 400); }, 2600);
}
function inviteURL() {
  return location.origin + location.pathname + '?room=' + Netplay.code;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ---------- 房主 ---------- */
function startHost() {
  if (typeof Peer === 'undefined') {
    alert('多人模式需要加载 PeerJS 组件（CDN），请检查网络后重试。');
    return;
  }
  Netplay.mode = 'host';
  Netplay.name = state.player.name || '房主';
  Netplay.code = genCode();
  Netplay.members = [{ id: 'host', name: Netplay.name, host: true }];
  Netplay.voterChoice = {};
  document.body.classList.add('np-host');
  $('#onboarding').hidden = true;
  $('#join-panel').hidden = true;
  if (window.Phone) Phone.enterMain('host'); else $('#story').hidden = false;
  // 房主保留自定义行动：直接结算
  $('#custom-send').onclick = function () {
    var v = $('#custom-input').value.trim();
    if (!v) return;
    $('#custom-input').value = '';
    $('#custom-input').placeholder = '写下你的行动…';
    hostCustom(v);
  };
  createHostPeer(0);
  openRoomPanel();
  renderTurn('start');
}

function createHostPeer(retry) {
  if (retry > 3) { toast('创建房间失败，请重试'); Netplay.mode = 'off'; return; }
  if (Netplay.code == null) Netplay.code = genCode();
  var peer = new Peer(PEER_PREFIX + Netplay.code.toLowerCase());
  Netplay.peer = peer;
  peer.on('open', function () {
    $('#room-code').textContent = Netplay.code;
    renderMembers();
    toast('房间已创建，房间码 ' + Netplay.code);
  });
  peer.on('connection', function (conn) { handleGuestConn(conn); });
  peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) {} });
  peer.on('error', function (err) {
    if (err && err.type === 'unavailable-id') {
      Netplay.code = genCode(); // 房间码被占用，换一个
      createHostPeer(retry + 1);
    } else {
      console.warn('[netplay] peer error', err);
    }
  });
}

function handleGuestConn(conn) {
  conn.on('open', function () {
    Netplay.conns[conn.peer] = { conn: conn, name: '…' };
  });
  conn.on('data', function (d) { onHostData(conn, d); });
  conn.on('close', function () { removeGuest(conn.peer); });
  conn.on('error', function () { removeGuest(conn.peer); });
}

function onHostData(conn, d) {
  if (!d || !d.t) return;
  var rec = Netplay.conns[conn.peer];
  if (d.t === 'hello') {
    var name = String(d.name || '朋友').slice(0, 18) || '朋友';
    if (rec) rec.name = name;
    Netplay.members = Netplay.members.filter(function (m) { return m.id !== conn.peer; });
    Netplay.members.push({ id: conn.peer, name: name, host: false });
    conn.send({ t: 'welcome', hostName: Netplay.name, members: Netplay.members, turn: Netplay.lastTurn,
      im: window.Phone ? Phone.exportIM() : null,
      photos: window.Phone ? Phone.exportPhotos() : [],
      calllog: window.Phone ? Phone.exportCallLog() : [] });
    broadcast({ t: 'members', members: Netplay.members }, conn.peer);
    broadcast({ t: 'chat', name: '系统', text: name + ' 加入了房间', sys: true }, null);
    addChat('系统', name + ' 加入了房间', true);
    renderMembers();
    recount(false);
  } else if (d.t === 'vote') {
    if (!Netplay.lastTurn) return;
    var valid = Netplay.lastTurn.choices.some(function (c) { return c.key === d.key; });
    if (!valid) return;
    Netplay.voterChoice[conn.peer] = d.key;
    recount(true);
  } else if (d.t === 'chat') {
    var text = String(d.text || '').slice(0, 200);
    if (!text.trim()) return;
    var who = rec ? rec.name : '朋友';
    addChat(who, text, false);
    broadcast({ t: 'chat', name: who, text: text }, conn.peer);
  }
}

function removeGuest(peerId) {
  var rec = Netplay.conns[peerId];
  if (!rec) return;
  try { rec.conn.close(); } catch (e) {}
  delete Netplay.conns[peerId];
  var left = Netplay.members.filter(function (m) { return m.id === peerId; })[0];
  Netplay.members = Netplay.members.filter(function (m) { return m.id !== peerId; });
  delete Netplay.voterChoice[peerId];
  if (left) {
    addChat('系统', left.name + ' 离开了房间', true);
    broadcast({ t: 'chat', name: '系统', text: left.name + ' 离开了房间', sys: true }, null);
  }
  broadcast({ t: 'members', members: Netplay.members }, null);
  renderMembers();
  recount(true);
}

function broadcast(msg, exceptPeerId) {
  Object.keys(Netplay.conns).forEach(function (id) {
    if (id === exceptPeerId) return;
    try { Netplay.conns[id].conn.send(msg); } catch (e) {}
  });
}

/* 房主：每回合渲染后广播 + 开启投票 */
function onTurnRendered() {
  var choices = [];
  Array.prototype.forEach.call(document.querySelectorAll('#choice-list .choice'), function (b) {
    var action = b.getAttribute('data-action') || '';
    var parts = action.split('：');
    choices.push({
      key: (b.querySelector('b') || {}).textContent || '',
      title: parts[0] || '',
      detail: parts.slice(1).join('：') || '',
      action: action,
    });
  });
  var packet = {
    t: 'turn',
    n: state.turn,
    html: $('#narrative').innerHTML,
    phone: $('#phone-card').innerHTML,
    phoneHidden: !!$('#phone-card').hidden,
    day: $('#day-label').textContent,
    time: $('#time-label').textContent,
    place: $('#place-label').textContent,
    choices: choices,
    player: {
      name: state.player.name, age: state.player.age, job: state.player.job,
      traits: state.player.traits, leads: selected().map(function (x) { return x.name; }),
    },
    stats: Object.assign({}, state.stats),
    affection: Object.assign({}, state.affection),
  };
  Netplay.lastTurn = packet;
  Netplay.voterChoice = {};
  broadcast(packet, null);
  setupHostVoting(choices);
  startVoteTimer();
  recount(false);
}

function setupHostVoting(choices) {
  Array.prototype.forEach.call(document.querySelectorAll('#choice-list .choice'), function (b) {
    var key = (b.querySelector('b') || {}).textContent || '';
    var meta = document.createElement('span');
    meta.className = 'vote-meta';
    meta.innerHTML = '<span class="vote-fill"></span>';
    var num = document.createElement('span');
    num.className = 'vote-num';
    num.textContent = '0 票';
    b.appendChild(meta);
    b.appendChild(num);
    b.onclick = function () { castVote(key); };
  });
  var vs = $('#vote-status');
  vs.hidden = false;
  vs.innerHTML = '🗳️ 投票中 <b id="vote-countdown">' + VOTE_SECS + '</b>s · 已投 <b id="vote-cast">0</b>/<span id="vote-total">' +
    Netplay.members.length + '</span> <button id="settle-now" class="settle-btn">立即结算</button>';
  $('#settle-now').onclick = function () { settle(); };
}

function castVote(key) {
  Netplay.voterChoice['host'] = key;
  Array.prototype.forEach.call(document.querySelectorAll('#choice-list .choice'), function (b) {
    var k = (b.querySelector('b') || {}).textContent || '';
    b.classList.toggle('voted', k === key);
  });
  recount(true);
}

function tally() {
  var counts = {};
  Object.keys(Netplay.voterChoice).forEach(function (v) {
    var k = Netplay.voterChoice[v];
    counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}

function recount(announce) {
  var counts = tally();
  var total = Netplay.members.length || 1;
  Array.prototype.forEach.call(document.querySelectorAll('#choice-list .choice'), function (b) {
    var k = (b.querySelector('b') || {}).textContent || '';
    var c = counts[k] || 0;
    var fill = b.querySelector('.vote-fill');
    var num = b.querySelector('.vote-num');
    if (fill) fill.style.width = Math.round((c / total) * 100) + '%';
    if (num) num.textContent = c + ' 票';
  });
  var castEl = $('#vote-cast');
  if (castEl) castEl.textContent = Object.keys(Netplay.voterChoice).length;
  var totalEl = $('#vote-total');
  if (totalEl) totalEl.textContent = Netplay.members.length;
  if (announce && Netplay.mode === 'host') broadcast({ t: 'votes', counts: counts }, null);
  if (Netplay.mode === 'host' && Netplay.lastTurn &&
      Object.keys(Netplay.voterChoice).length >= Netplay.members.length &&
      Netplay.members.length > 0) {
    settle();
  }
}

function startVoteTimer() {
  stopVoteTimer();
  Netplay.timeLeft = VOTE_SECS;
  Netplay.timer = setInterval(function () {
    Netplay.timeLeft--;
    var cd = $('#vote-countdown');
    if (cd) cd.textContent = Math.max(Netplay.timeLeft, 0);
    if (Netplay.timeLeft <= 0) settle();
  }, 1000);
}
function stopVoteTimer() {
  if (Netplay.timer) { clearInterval(Netplay.timer); Netplay.timer = null; }
}

function settle() {
  if (Netplay.mode !== 'host' || !Netplay.lastTurn) return;
  stopVoteTimer();
  var counts = tally();
  var order = Netplay.lastTurn.choices.map(function (c) { return c.key; });
  var best = order[0], bestN = -1;
  order.forEach(function (k) {
    var c = counts[k] || 0;
    if (c > bestN) { bestN = c; best = k; }
  });
  // 平票时房主的投票优先
  var hostPick = Netplay.voterChoice['host'];
  if (hostPick && (counts[hostPick] || 0) === bestN) best = hostPick;
  var choice = Netplay.lastTurn.choices.filter(function (c) { return c.key === best; })[0] ||
               Netplay.lastTurn.choices[0];
  $('#vote-status').hidden = true;
  Netplay.lastTurn = null;
  var leads = selected();
  var lead = leads[(state.turn - 1) % leads.length];
  _applyChoice(choice.action, lead);
}

function hostCustom(v) {
  stopVoteTimer();
  $('#vote-status').hidden = true;
  Netplay.lastTurn = null;
  _applyChoice(v, selected()[0]);
}

function onStatsBroadcast() {
  if (Netplay.mode === 'host') broadcast({ t: 'deltas', html: $('#delta-list').innerHTML }, null);
}

/* ---------- 客人 ---------- */
function joinRoom(code, nick) {
  if (typeof Peer === 'undefined') {
    alert('多人模式需要加载 PeerJS 组件（CDN），请检查网络后重试。');
    return;
  }
  code = String(code || '').trim().toUpperCase();
  nick = String(nick || '').trim().slice(0, 18) || '朋友';
  if (!/^[A-Z0-9]{4}$/.test(code)) { toast('房间码是 4 位字母/数字'); return; }
  Netplay.mode = 'guest';
  Netplay.code = code;
  Netplay.name = nick;
  var peer = new Peer();
  Netplay.peer = peer;
  var joined = false;
  $('#join-go').disabled = true;
  $('#join-go').textContent = '连接中…';
  Netplay.joinTimer = setTimeout(function () {
    if (!joined) {
      toast('连接超时：房间不存在或房主不在线');
      try { peer.destroy(); } catch (e) {}
      $('#join-go').disabled = false;
      $('#join-go').textContent = '加入房间 →';
      Netplay.mode = 'off';
    }
  }, 12000);
  peer.on('open', function () {
    var conn = peer.connect(PEER_PREFIX + code.toLowerCase(), { reliable: true });
    conn.on('open', function () {
      joined = true;
      clearTimeout(Netplay.joinTimer);
      conn.send({ t: 'hello', name: nick });
    });
    conn.on('data', function (d) { onGuestData(conn, d); });
    conn.on('close', function () { guestDisconnected(); });
    conn.on('error', function () { guestDisconnected(); });
    Netplay.guestConn = conn;
  });
  peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) {} });
  peer.on('error', function (err) {
    console.warn('[netplay] guest peer error', err);
    if (!joined && err && (err.type === 'peer-unreachable' || err.type === 'network' || err.type === 'server-error')) {
      clearTimeout(Netplay.joinTimer);
      toast('连接失败：房间不存在或房主不在线');
      $('#join-go').disabled = false;
      $('#join-go').textContent = '加入房间 →';
      Netplay.mode = 'off';
    }
  });
}

function onGuestData(conn, d) {
  if (!d || !d.t) return;
  if (d.t === 'welcome') {
    enterGuestMode(d);
    if (d.turn) applyTurn(d.turn);
  } else if (d.t === 'turn') {
    applyTurn(d);
  } else if (d.t === 'votes') {
    updateGuestVotes(d.counts || {});
  } else if (d.t === 'members') {
    Netplay.members = d.members || [];
    renderMembers();
  } else if (d.t === 'deltas') {
    $('#delta-list').innerHTML = d.html || '<div class="delta">无</div>';
  } else if (d.t === 'chat') {
    addChat(d.name || '朋友', d.text || '', !!d.sys);
  } else if (d.t === 'im') {
    if (window.Phone) Phone.guestIM(d.thread, d.from, d.text || '');
  } else if (d.t === 'photo') {
    if (window.Phone) Phone.guestPhoto(d.id);
  } else if (d.t === 'calllog') {
    if (window.Phone) Phone.guestCallLog(d.log);
  }
}

function enterGuestMode(packet) {
  var hostName = packet.hostName, members = packet.members;
  Netplay.members = members || [];
  document.body.classList.add('np-guest');
  $('#onboarding').hidden = true;
  $('#join-panel').hidden = true;
  if (window.Phone) Phone.enterMain('guest', packet); else $('#story').hidden = false;
  $('#room-fab').hidden = false;
  // 客人隐藏房主专属控件
  var cust = $('#custom-action'); if (cust) cust.hidden = true;
  var ct = $('#custom-toggle'); if (ct) ct.style.display = 'none';
  patchGuestDialogs();
  renderMembers();
  toast('已加入 ' + hostName + ' 的房间');
}

function applyTurn(p) {
  Netplay.lastTurn = p;
  $('#day-label').textContent = p.day || '周二';
  $('#time-label').textContent = p.time || '';
  $('#place-label').textContent = p.place || '';
  var topStrong = document.querySelector('.topbar strong');
  if (topStrong) topStrong.textContent = 'Chapter ' + String(p.n).padStart(2, '0');
  $('#narrative').innerHTML = p.html || '';
  var pc = $('#phone-card');
  pc.innerHTML = p.phone || '';
  pc.hidden = !!p.phoneHidden;
  var list = $('#choice-list');
  list.innerHTML = '';
  p.choices.forEach(function (c) {
    var b = document.createElement('button');
    b.className = 'choice';
    b.setAttribute('data-key', c.key);
    b.innerHTML = '<b>' + esc(c.key) + '</b>' + esc(c.title) +
      '<br><span class="choice-detail">' + esc(c.detail) + '</span>' +
      '<span class="vote-meta"><span class="vote-fill"></span></span><span class="vote-num"></span>';
    b.onclick = function () { guestVote(c.key); };
    list.appendChild(b);
  });
  var prompt = document.querySelector('.choices > p');
  if (prompt) prompt.textContent = '和大家一起投票，决定接下来怎么做';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function guestVote(key) {
  if (!Netplay.guestConn) return;
  Netplay.myVote = key;
  try { Netplay.guestConn.send({ t: 'vote', key: key }); } catch (e) {}
  Array.prototype.forEach.call(document.querySelectorAll('#choice-list .choice'), function (b) {
    b.classList.toggle('voted', b.getAttribute('data-key') === key);
  });
  toast('已投票给 ' + key);
}

function updateGuestVotes(counts) {
  var total = Netplay.members.length || 1;
  Array.prototype.forEach.call(document.querySelectorAll('#choice-list .choice'), function (b) {
    var k = b.getAttribute('data-key');
    var c = counts[k] || 0;
    var fill = b.querySelector('.vote-fill');
    var num = b.querySelector('.vote-num');
    if (fill) fill.style.width = Math.round((c / total) * 100) + '%';
    if (num) num.textContent = c ? c + ' 票' : '';
  });
}

function guestDisconnected() {
  if (Netplay.mode !== 'guest') return;
  Netplay.mode = 'off';
  toast('与房主断开连接');
  if (confirm('与房主的连接已断开，重新加载页面可再次加入。')) location.reload();
}

/* 客人版档案/数值弹窗：用房主同步的快照渲染 */
function patchGuestDialogs() {
  var dialog = $('#panel-dialog');
  Array.prototype.forEach.call(document.querySelectorAll('.bottom-nav button'), function (b) {
    if (b.dataset.panel === 'story') return;
    b.onclick = function () {
      document.querySelectorAll('.bottom-nav button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      var p = Netplay.lastTurn;
      if (!p) { $('#dialog-content').innerHTML = '<h2 class="dialog-title">等待同步</h2><p style="font-size:13px;color:#9b97a2">房主的故事数据还没同步过来。</p>'; }
      else if (b.dataset.panel === 'profile') {
        $('#dialog-content').innerHTML = '<h2 class="dialog-title">房主的档案</h2>' +
          [['姓名', p.player.name], ['年龄', p.player.age], ['职业', p.player.job], ['性格', p.player.traits],
           ['主角', (p.player.leads || []).join('、')]].map(function (x) {
            return '<div class="profile-row"><span>' + x[0] + '</span>' + esc(x[1]) + '</div>';
          }).join('');
      } else {
        var s = p.stats || {};
        $('#dialog-content').innerHTML = '<h2 class="dialog-title">故事数值（实时）</h2><div class="stat-grid">' +
          [['人气值', s.popularity], ['心情值', s.mood], ['金钱', '₩' + Number(s.money || 0).toLocaleString()],
           ['保密度', s.secrecy], ['公司警觉', s.alertness], ['事业压力', s.pressure],
           ['越线冲动', s.impulse], ['解锁 CG', 0]].map(function (x) {
            return '<div class="stat-box">' + x[0] + '<b>' + x[1] + '</b></div>';
          }).join('') + '</div><h3 style="font-size:13px;margin-top:20px">好感度</h3>' +
          Object.keys(p.affection || {}).map(function (id) {
            var m = (window.members || []).filter(function (mm) { return mm.id === id; })[0];
            return '<div class="profile-row"><span>' + esc(m ? m.name : id) + '</span>' + p.affection[id] + '</div>';
          }).join('');
      }
      dialog.showModal();
    };
  });
}

/* ---------- 弹幕 ---------- */
var danmakuLanes = [];
var DANMAKU_LANES = 9, DANMAKU_H = 32, DANMAKU_TOP = 76;
function danmakuEnabled() {
  var sw = $('#danmaku-switch');
  return sw ? sw.checked : true;
}
function nameColor(name) {
  var h = 0;
  for (var i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360;
  return 'hsl(' + h + ',72%,74%)';
}
function spawnDanmaku(name, text, sys) {
  if (!danmakuEnabled()) return;
  if (Netplay.mode !== 'host' && Netplay.mode !== 'guest') return;
  if ($('#story').hidden) return;
  var layer = $('#danmaku-layer');
  if (!layer) return;
  var now = Date.now(), lane = 0, oldest = -1;
  for (var i = 0; i < DANMAKU_LANES; i++) {
    var idle = now - (danmakuLanes[i] || 0);
    if (idle > oldest) { oldest = idle; lane = i; }
  }
  danmakuLanes[lane] = now;
  var el = document.createElement('div');
  el.className = 'danmaku' + (sys ? ' sys' : '');
  el.innerHTML = sys ? esc(text) : '<b style="color:' + nameColor(name) + '">' + esc(name) + '</b>' + esc(text);
  el.style.top = (DANMAKU_TOP + lane * DANMAKU_H) + 'px';
  layer.appendChild(el);
  var layerW = layer.clientWidth || window.innerWidth;
  var elW = el.offsetWidth || 220;
  var dist = layerW + elW + 40;
  var dur = Math.min(14000, Math.max(6000, (dist / 110) * 1000)); // 约 110px/s
  el.style.transition = 'transform ' + dur + 'ms linear';
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { el.style.transform = 'translateX(-' + dist + 'px)'; });
  });
  setTimeout(function () { el.remove(); }, dur + 600);
}

/* ---------- 房间面板 / 聊天（房主客人共用） ---------- */
function openRoomPanel() {
  $('#room-panel').hidden = false;
  $('#room-fab').hidden = false;
}
function renderMembers() {
  var ul = $('#member-list');
  if (!ul) return;
  ul.innerHTML = Netplay.members.map(function (m) {
    return '<li>' + (m.host ? '👑 ' : '👤 ') + esc(m.name) + (m.host ? ' <small>房主</small>' : '') + '</li>';
  }).join('') || '<li>暂无成员</li>';
}
function addChat(name, text, sys) {
  var log = $('#chat-log');
  if (!log) return;
  var div = document.createElement('div');
  div.className = 'chat-msg' + (sys ? ' sys' : '');
  div.innerHTML = sys ? esc(text) : '<b>' + esc(name) + '</b>' + esc(text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  spawnDanmaku(name, text, sys);
  var panel = $('#room-panel');
  var chatTab = !$('#chat-box').hidden;
  if ((panel.hidden || !chatTab) && !sys) {
    Netplay.chatUnread++;
    var badge = $('#chat-badge');
    badge.hidden = false;
    badge.textContent = Netplay.chatUnread > 99 ? '99+' : Netplay.chatUnread;
  }
}
function sendChat() {
  var input = $('#chat-text');
  var text = input.value.trim().slice(0, 200);
  if (!text) return;
  input.value = '';
  if (Netplay.mode === 'host') {
    addChat(Netplay.name, text, false);
    broadcast({ t: 'chat', name: Netplay.name, text: text }, null);
  } else if (Netplay.mode === 'guest' && Netplay.guestConn) {
    addChat(Netplay.name, text, false);
    try { Netplay.guestConn.send({ t: 'chat', text: text }); } catch (e) {}
  }
}

/* ---------- 拦截原有逻辑 ---------- */
var _renderTurn = renderTurn;
renderTurn = function (mode, action) {
  _renderTurn(mode, action);
  if (Netplay.mode === 'host') onTurnRendered();
};
var _applyChoice = applyChoice;
var _renderStats = renderStats;
renderStats = function (deltas) {
  _renderStats(deltas);
  onStatsBroadcast();
};

/* ---------- onboarding 接线 ---------- */
function parseSetupOrAlert() {
  var chosen = Array.prototype.map.call(
    document.querySelectorAll('.member-card input:checked'), function (x) { return x.value; });
  if (!chosen.length) { alert('请至少选择一位故事主角。'); return null; }
  var req = [['#player-name', '姓名'], ['#player-age', '年龄'], ['#player-country', '国籍'], ['#player-traits', '性格']];
  for (var i = 0; i < req.length; i++) {
    if (!$(req[i][0]).value.trim()) { alert('请填写' + req[i][1] + '。'); $(req[i][0]).focus(); return null; }
  }
  return chosen;
}

function wireOnboarding() {
  var form = $('#setup-form');
  // 捕获阶段拦截提交（app.js 的监听在目标阶段，先执行这里）
  form.parentElement.addEventListener('submit', function (e) {
    if (Netplay.pending !== 'create') return;
    e.preventDefault();
    e.stopPropagation();
    var chosen = parseSetupOrAlert();
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
    startHost();
  }, true);

  // 模式切换
  Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (btn) {
    btn.onclick = function () {
      document.querySelectorAll('.mode-btn').forEach(function (x) { x.classList.remove('active'); });
      btn.classList.add('active');
      Netplay.pending = btn.getAttribute('data-mode');
      var multi = Netplay.pending === 'create';
      $('#start-btn').innerHTML = multi ? '创建房间，开始故事 <b>→</b>' : '确认设定，进入故事 <b>→</b>';
      $('#mode-hint').textContent = multi
        ? '你将作为房主创建房间，朋友输入房间码加入，一起投票决定剧情走向。'
        : '独自体验完整剧情。';
      $('#join-link').hidden = !multi;
    };
  });

  // 加入房间
  $('#join-link').onclick = function () {
    $('#setup-form').hidden = true;
    $('#join-panel').hidden = false;
    window.scrollTo({ top: 0 });
  };
  $('#join-back').onclick = function () {
    $('#join-panel').hidden = true;
    $('#setup-form').hidden = false;
  };
  $('#join-go').onclick = function () {
    joinRoom($('#join-code').value, $('#join-nick').value);
  };
  $('#join-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); joinRoom($('#join-code').value, $('#join-nick').value); }
  });

  // 邀请链接直达 ?room=CODE
  try {
    var m = /[?&]room=([A-Za-z0-9]{4})/.exec(location.search);
    if (m) {
      document.querySelector('.mode-btn[data-mode="create"]').click();
      $('#join-link').click();
      $('#join-code').value = m[1].toUpperCase();
      toast('已填入房间码，输入昵称后加入');
    }
  } catch (e) {}

  // 房间面板
  $('#room-fab').onclick = function () {
    var p = $('#room-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) { Netplay.chatUnread = 0; $('#chat-badge').hidden = true; }
  };
  $('#room-close').onclick = function () { $('#room-panel').hidden = true; };
  Array.prototype.forEach.call(document.querySelectorAll('.room-tab'), function (tab) {
    tab.onclick = function () {
      document.querySelectorAll('.room-tab').forEach(function (x) { x.classList.remove('active'); });
      tab.classList.add('active');
      var chat = tab.getAttribute('data-tab') === 'chat';
      $('#member-list').hidden = chat;
      $('#chat-box').hidden = !chat;
      if (chat) { Netplay.chatUnread = 0; $('#chat-badge').hidden = true; }
    };
  });
  $('#copy-invite').onclick = function () {
    var url = inviteURL();
    function done() { toast('邀请链接已复制'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { prompt('复制邀请链接发给朋友：', url); });
    } else { prompt('复制邀请链接发给朋友：', url); }
  };
  $('#chat-send').onclick = sendChat;
  var dsw = $('#danmaku-switch');
  if (dsw) dsw.onchange = function () { toast(dsw.checked ? '弹幕已开启' : '弹幕已关闭'); };
  $('#chat-text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  window.addEventListener('beforeunload', function () {
    try { if (Netplay.peer) Netplay.peer.destroy(); } catch (e) {}
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireOnboarding);
} else {
  wireOnboarding();
}
})();
