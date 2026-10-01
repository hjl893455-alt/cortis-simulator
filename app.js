const members=[
 {id:'james',name:'赵雨凡',en:'James',role:'领舞 · 领唱',tone:'礼貌温和，细致而克制'},
 {id:'juhoon',name:'金主训',en:'Juhoon',role:'主舞 · Rapper',tone:'冷感直接，情绪写在眼里'},
 {id:'martin',name:'马丁',en:'Martin',role:'队长 · 制作人',tone:'沉稳控场，敏锐又真诚'},
 {id:'seong',name:'严成玹',en:'Seonghyeon',role:'主唱',tone:'嘴硬心细，镜头感十足'},
 {id:'keonho',name:'安乾镐',en:'Keonho',role:'副唱 · 忙内',tone:'安静真诚，笑眼很亮'}
];
const $=s=>document.querySelector(s); const state={turn:0,time:468,chosen:[],items:[],affDim:{},stats:{mood:70,popularity:32,money:18000,secrecy:100,alertness:18,pressure:52,impulse:28},affection:{},player:{},cg:0,lastChoiceKeyword:''};
const statName={mood:'心情值',popularity:'人气值',money:'金钱',secrecy:'保密度',alertness:'公司警觉度',pressure:'事业压力',impulse:'越线冲动'};
function bag(){if(!Array.isArray(state.items))state.items=[];return state.items}
function syncBag(){const b=$('#bag');if(b)b.textContent=bag().join('、')||'空'}
function save(){localStorage.setItem('cortis-save',JSON.stringify(state))}
/* 好感多维度：state.affection[id] 保持数字（兼容 multiplayer 广播/微信读取），
   state.affDim[id]={heart:心动,tacit:默契,trust:信任} 为附加明细，老存档防御性初始化。 */
function dim(id){if(!state.affDim||typeof state.affDim!=='object')state.affDim={};const d=state.affDim[id]||(state.affDim[id]={heart:0,tacit:0,trust:0});return d}
function addDims(id,delta){let s=0;const d=dim(id);for(const k in delta||{}){d[k]=(d[k]||0)+delta[k];s+=delta[k]}state.affection[id]=(state.affection[id]||0)+s;return s}
function affTier(id){const a=state.affection[id]||0;return a>=45?'warm':a>=28?'mild':'cool'}
function float(txt){const d=document.createElement('div');d.className='affection-float';d.textContent=txt;document.body.appendChild(d);setTimeout(()=>d.remove(),1500)}
/* 打字机：renderTurn 先同步写入完整 HTML（multiplayer 同步读取），再 setTimeout(0) 启动逐字打出；
   tag-aware（标签整体拷贝不逐字）；约 28ms/字、总时长封顶 4s；点击 #narrative 立即补全；新回合取消旧 timer。 */
let twTimer=null;
function startTypewriter(el){if(twTimer){clearTimeout(twTimer);twTimer=null}const full=el.innerHTML;const len=full.replace(/<[^>]*>/g,'').length;if(!len)return;const total=Math.min(4000,Math.max(400,len*28));const batch=Math.max(1,Math.ceil(len/(total/28)));let i=0;el.innerHTML='';const finish=()=>{if(twTimer){clearTimeout(twTimer);twTimer=null}el.innerHTML=full};el.onclick=finish;const step=()=>{let n=0;while(i<full.length&&n<batch){if(full[i]==='<'){const j=full.indexOf('>',i);i=j<0?full.length:j+1}else{i++;n++}}el.innerHTML=full.slice(0,i);twTimer=i<full.length?setTimeout(step,28):null};step()}
/* 常规选项定义（含维度影响与数值影响） */
const CHOICES=[
 {key:'A',title:'回应他',detail:'把话题留在工作范围内，礼貌而清楚地回应。',hint:'♥ 可能拉近距离',dims:{heart:1,tacit:1},stats:{mood:1}},
 {key:'B',title:'继续做自己的事',detail:'整理物料，把空间还给正在休息的成员。',hint:'🛡 稳妥不出错',dims:{trust:1},stats:{mood:1}},
 {key:'C',title:'轻轻试探',detail:'用一句不越界的玩笑，看看他的反应。',hint:'⚡ 有点冒险',dims:{heart:2},stats:{mood:1,alertness:1,impulse:2}},
 {key:'D',title:'先离开',detail:'以时间表为由告别，避免停留太久。',hint:'🌫 可能渐行渐远',dims:{trust:1},stats:{mood:1}}];
const OPT_E={key:'E',title:'主动靠近一点',detail:'趁没人注意，往他身边挪了半步。',hint:'♥ 心动专属',dims:{heart:2,tacit:1},stats:{mood:1}};
const E_UNLOCK=30;
/* 突发小事件：2 选 1 快速抉择。按钮 data-action 为纯人类可读文本「⚡标题：描述」；applyChoice 靠本回合的 pendingEvent + 标题匹配识别事件选项（multiplayer 抓取 data-action 广播给客人，机器标记会泄漏，故不用）。*/
const events=[
 {text:l=>`⚡ 突发小事件：排练间隙，<b>${l.name}</b>把一瓶没开封的矿泉水递到你面前。`,options:[
  {label:'接过水道谢',detail:'笑着接过来，说了声谢谢。',hint:'♥ 可能拉近距离',dims:{heart:2},stats:{mood:1},item:'他递的矿泉水'},
  {label:'摆手婉拒',detail:'说自己带了水，轻轻推了回去。',hint:'🛡 稳妥不出错',dims:{trust:1},stats:{pressure:1}}]},
 {text:l=>`⚡ 突发小事件：经纪人从走廊那头走来，视线正扫过你和<b>${l.name}</b>。`,options:[
  {label:'自然打招呼',detail:'大大方方问好，不遮不掩。',hint:'🛡 稳妥不出错',dims:{trust:1},stats:{alertness:1}},
  {label:'侧身避开',detail:'假装看手机，等他走过去。',hint:'⚡ 有点冒险',dims:{heart:1,tacit:1},stats:{secrecy:1,impulse:1}}]},
 {text:l=>`⚡ 突发小事件：休息室里，<b>${l.name}</b>晃了晃手里的台本：“要不要一起对一遍？”`,options:[
  {label:'坐下一起对',detail:'搬把椅子坐到他对面。',hint:'♥ 可能拉近距离',dims:{heart:2},stats:{mood:2},item:'对词用的台本页'},
  {label:'说下次吧',detail:'以还有事为由先走开。',hint:'🌫 可能渐行渐远',dims:{tacit:1},stats:{pressure:-1}}]},
 {text:l=>`⚡ 突发小事件：外景地突然下起雨，<b>${l.name}</b>撑开伞看向你。`,options:[
  {label:'并肩躲进伞下',detail:'肩膀挨得很近，一起跑回棚里。',hint:'♥ 可能拉近距离',dims:{heart:2},stats:{impulse:2},item:'共撑过的那把伞'},
  {label:'自己冒雨跑回去',detail:'摆摆手，顶着雨冲回棚里。',hint:'🛡 稳妥不出错',dims:{trust:1},stats:{mood:-1}}]},
 {text:l=>`⚡ 突发小事件：休息室有点冷，<b>${l.name}</b>把多余的暖宝宝塞进你手里。`,options:[
  {label:'收下暖宝宝',detail:'把暖宝宝揣进口袋。',hint:'♥ 可能拉近距离',dims:{heart:1,tacit:1},stats:{mood:1},item:'他塞的暖宝宝'},
  {label:'笑着说不用',detail:'摆摆手，说自己不怕冷。',hint:'🛡 稳妥不出错',dims:{trust:1},stats:{secrecy:1}}]}
];
let pendingEvent=null;
const picker=$('#member-picker');
picker.innerHTML=members.map((m,i)=>`<label class="member-card" data-index="0${i+1}"><input type="checkbox" value="${m.id}"><span><strong>${m.name}</strong><small>${m.en} · ${m.role}</small></span></label>`).join('');
$('#player-job').addEventListener('change',e=>$('#custom-job-wrap').hidden=e.target.value!=='custom');
$('#setup-form').addEventListener('submit',e=>{e.preventDefault();const chosen=[...document.querySelectorAll('.member-card input:checked')].map(x=>x.value);if(!chosen.length){alert('请至少选择一位故事主角。');return}state.chosen=chosen;state.player={name:$('#player-name').value.trim(),age:$('#player-age').value,country:$('#player-country').value.trim(),traits:$('#player-traits').value.trim(),job:$('#player-job').value==='custom'?$('#custom-job').value.trim():$('#player-job').value,style:$('#player-style').value.trim()};chosen.forEach(id=>{state.affection[id]=18;dim(id)});save();$('#onboarding').hidden=true;$('#story').hidden=false;renderTurn('start')});
function selected(){return state.chosen.map(id=>members.find(m=>m.id===id))}function clock(){return `${String(Math.floor(state.time/60)).padStart(2,'0')}:${String(state.time%60).padStart(2,'0')}`}function place(){return state.turn<2?'HYBE 练习室 B':state.turn<4?'制作楼层的自动贩卖机前':'汉江边的外景拍摄地'}
function renderTurn(mode,action){state.turn++;state.time+=mode==='start'?0:25;const leads=selected(),lead=leads[(state.turn-1)%leads.length],other=members.find(m=>!state.chosen.includes(m.id));pendingEvent=(state.turn>1&&state.turn%3===0&&Math.random()<0.85)?Math.floor(Math.random()*events.length):null;let text,phone='';
 if(state.turn===1){text=`<p>练习室的门在身后合上，低频的鼓点还从隔壁漏进来。你抱着刚领到的彩排物料，鞋底在木地板上停了一下。</p><p>镜墙前，<span class="speaker">${lead.name}（${lead.en}）</span>抬手关掉音响。他额前的碎发被汗水压出弯曲的弧度，视线越过其余成员，落在你怀里那叠印着时间表的纸上。</p><p class="quote">“这里下午一点之后排给 CORTIS。”他把毛巾搭到肩上，声音压得很轻，“你是来彩排的？”</p><p>角落里的经纪人正低头回工作群；门外有人推着器材箱经过。这个空间并不适合长谈，却也还没有人催你离开。</p>`;}
 else {const cue=action||'你没有急着靠近，只把自己的事做完';const tier=affTier(lead.id);
  const body={cool:`<p><span class="speaker">${lead.name}（${lead.en}）</span>没有立刻接话。他先看了一眼不远处的工作人员，把手里拧开的矿泉水放到窗台上，礼貌地和你保持着半步距离。</p>`,
   mild:`<p><span class="speaker">${lead.name}（${lead.en}）</span>没有立刻接话。他先看了一眼不远处的工作人员，又把手里拧开的矿泉水放到窗台上，才向你靠近半步。</p>`,
   warm:`<p><span class="speaker">${lead.name}（${lead.en}）</span>一看到你就停下了手里的动作。他把拧开的矿泉水直接递到你面前，眼神亮亮的：“渴了吧，先喝口水再说。”</p>`}[tier];
  const quote={cool:`<p class="quote">“嗯，我知道了。”他把水瓶放回窗台，视线已经飘向别处，“这边还在彩排，你先忙你的。”</p>`,
   mild:`<p class="quote">“你刚才说的，我记住了。”他指尖在瓶身上停住，抬眼时神情很稳，“只是这里人多，别让人误会你是特意为谁来的。”</p>`,
   warm:`<p class="quote">“你刚才说的，我都记着呢。”他指尖擦过你的手背，也没立刻收回去，“下次彩排前提前跟我说，我等你。”</p>`}[tier];
  const curious=state.turn%3===0; text=`<p>${cue}。走廊另一头的感应灯依次亮起，冷白的光落在你们脚边，像把短暂的停留切成几段。</p>${body}${quote}${curious?`<p>手机在他掌心亮了一下。屏幕上是一条来自工作群的提醒：外景拍摄的集合时间提前。${other.name}从转角探出头，朝这边晃了晃通行证，像是无意地打断了这段安静。</p>`:''}`;if(state.turn===2)phone=`<div class="phone-head">KKT · 新消息</div><div class="bubble"><small>▢ ${lead.name}　${clock()}</small>到家之后说一声。不是催你，只是今天外面风很大。</div>`}
 $('#day-label').textContent='周二';$('#time-label').textContent=clock();$('#place-label').textContent=place();syncBag();$('#narrative').innerHTML=text;setTimeout(()=>startTypewriter($('#narrative')),0);$('#phone-card').hidden=!phone;$('#phone-card').innerHTML=phone; renderChoices(lead); renderStats([]);window.scrollTo({top:0,behavior:'smooth'});}
function heartsHook(e){if(window.burstHearts){try{burstHearts(e.clientX,e.clientY)}catch(_){}}}
function renderChoices(lead){const prompt=document.querySelector('.choices p');let html='';
 if(pendingEvent!=null){const ev=events[pendingEvent];if(prompt)prompt.textContent='⚡ 突发小事件，快做决定！';
  html=`<div class="event-box"><p>${ev.text(lead)}</p></div>`+ev.options.map((o,i)=>`<button class="choice event-choice" data-action="⚡${o.label}：${o.detail}"><b>${i+1}</b>⚡${o.label}<br><span class="choice-detail">${o.detail}</span><span class="choice-hint">${o.hint}</span></button>`).join('');}
 else{if(prompt)prompt.textContent='接下来你打算怎么做？';
  html=CHOICES.map(c=>`<button class="choice" data-action="${c.title}：${c.detail}"><b>${c.key}</b>${c.title}<br><span class="choice-detail">${c.detail}</span><span class="choice-hint">${c.hint}</span></button>`).join('');
  const heart=dim(lead.id).heart;
  html+=heart>=E_UNLOCK
   ?`<button class="choice" data-action="${OPT_E.title}：${OPT_E.detail}"><b>${OPT_E.key}</b>${OPT_E.title}<br><span class="choice-detail">${OPT_E.detail}</span><span class="choice-hint">${OPT_E.hint}</span></button>`
   :`<button class="choice-locked" disabled><b>${OPT_E.key}</b>${OPT_E.title}<span class="choice-detail">${OPT_E.detail}</span><span class="choice-hint">🔒 心动 ${heart}/${E_UNLOCK} 解锁</span></button>`;}
 $('#choice-list').innerHTML=html;document.querySelectorAll('.choice').forEach(b=>b.onclick=e=>{heartsHook(e);applyChoice(b.dataset.action,lead)});}
function applyChoice(action,lead){const seg=action.split('：');const desc=seg.slice(1).join('：');
 if(pendingEvent!=null){const _e=events[pendingEvent];const _i=_e?_e.options.findIndex(function(o){return("⚡"+o.label)===seg[0]}):-1;const ev=_i>=0?_e:null;const opt=ev?ev.options[_i]:null;
  if(opt){const d=addDims(lead.id,opt.dims);const deltas=[`${lead.name}（${lead.en}）好感 <b>${d>0?'+':''}${d}</b>`];
   Object.keys(opt.stats||{}).forEach(k=>{state.stats[k]+=opt.stats[k];deltas.push(`${statName[k]} <b>${opt.stats[k]>0?'+':''}${opt.stats[k]}</b>`)});
   if(opt.item&&!bag().includes(opt.item)){bag().push(opt.item);deltas.push(`获得道具：<b>${opt.item}</b>`);syncBag()}
   const label=seg[0].replace(/^⚡/,'');state.lastChoiceKeyword=label.slice(0,4);save();
   if(d!==0)float(`${d>0?'+':''}${d} ♥`);if(opt.item)float(`🎁 ${opt.item}`);
   pendingEvent=null;renderTurn('choice',label+'：'+opt.detail);renderStats(deltas);return;}}
 const title=seg[0];const def=CHOICES.concat([OPT_E]).find(c=>c.title===title);
 let dims,stats;
 if(def){dims=def.dims;stats=def.stats}
 else{const plus=action.startsWith('回应')||action.startsWith('轻轻');const dd=plus?2:1;dims={heart:dd};stats={mood:1};if(action.startsWith('轻轻')){stats.alertness=1;stats.impulse=2}}
 const d=addDims(lead.id,dims);const deltas=[`${lead.name}（${lead.en}）好感 <b>${d>0?'+':''}${d}</b>`];
 Object.keys(stats).forEach(k=>{state.stats[k]+=stats[k];deltas.push(`${statName[k]} <b>${stats[k]>0?'+':''}${stats[k]}</b>`)});
 state.lastChoiceKeyword=title.slice(0,4);save();float(`+${d} ♥`);renderTurn('choice',action);renderStats(deltas);}
$('#custom-toggle').onclick=()=>$('#custom-action').hidden=!$('#custom-action').hidden;$('#custom-send').onclick=()=>{const v=$('#custom-input').value.trim();if(v)applyChoice(v,selected()[0]);};
function renderStats(deltas){$('#delta-list').innerHTML=deltas.length?deltas.map(d=>`<div class="delta">${d}</div>`).join(''):'<div class="delta">无</div>';}
$('#back-btn').onclick=()=>{if(confirm('返回会结束本次未保存的页面状态。'))location.reload()};$('#save-btn').onclick=()=>{save();alert('进度已保存在本机。')};
const dialog=$('#panel-dialog');$('#close-dialog').onclick=()=>dialog.close();document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.bottom-nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');if(b.dataset.panel==='story')return;const profile=b.dataset.panel==='profile';$('#dialog-content').innerHTML=profile?`<h2 class="dialog-title">你的档案</h2>${[['姓名',state.player.name],['年龄',state.player.age],['职业',state.player.job],['性格',state.player.traits],['主角',selected().map(x=>x.name).join('、')]].map(x=>`<div class="profile-row"><span>${x[0]}</span>${x[1]}</div>`).join('')}`:`<h2 class="dialog-title">故事数值</h2><div class="stat-grid">${[['人气值',state.stats.popularity],['心情值',state.stats.mood],['金钱','₩'+state.stats.money.toLocaleString()],['保密度',state.stats.secrecy],['事业压力',state.stats.pressure],['越线冲动',state.stats.impulse],['解锁 CG',state.cg]].map(x=>`<div class="stat-box">${x[0]}<b>${x[1]}</b></div>`).join('')}</div><h3 style="font-size:13px;margin-top:20px">好感度</h3>${selected().map(x=>`<div class="profile-row"><span>${x.name}</span>${state.affection[x.id]} · 有印象</div>`).join('')}`;dialog.showModal()});
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js');

/* 爱心粒子爆发（手感 worker 配的 CSS .heart-particle；故事/微信里防御性调用） */
window.burstHearts = function(x, y){
  try{
    var n = 10;
    for(var i = 0; i < n; i++){
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
      (function(el){
        setTimeout(function(){ el.remove(); }, 1100);
      })(s);
    }
  }catch(e){ /* 静默忽略 */ }
};
