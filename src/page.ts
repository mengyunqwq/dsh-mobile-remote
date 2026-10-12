/**
 * 手机端面板：单文件 HTML（内嵌 CSS/JS，无外部依赖）。
 * 数据面：POST /mobile/api/<endpoint>（JSON）+ GET /mobile/stream?sid=…（SSE 事件流）。
 * 事件渲染用统一规则：user 文本→右侧气泡；assistant 文本→左侧气泡；tool 调用→卡片；
 * 未知事件→灰色一行（类型名截断）。
 */

const MAX_ARG = 160

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function truncate(s: string, n: number): string {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

const PAGE_INNER = `
<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#0b0f17">
<title>DSH 手机遥控</title>
<style>
:root{--bg:#0b0f17;--panel:#131a26;--card:#1a2333;--text:#e6ebf4;--dim:#8b96ab;--accent:#4c8dff;--user:#2563eb;--ok:#34d399;--radius:14px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;overscroll-behavior:none}
header{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--panel);border-bottom:1px solid #223;position:sticky;top:0;z-index:10;padding-top:calc(10px + env(safe-area-inset-top))}
header .title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
header .dot{width:8px;height:8px;border-radius:50%;background:var(--dim);flex:none}
header .dot.on{background:var(--ok)}
.iconbtn{background:var(--card);border:none;color:var(--text);width:36px;height:36px;border-radius:10px;font-size:17px;flex:none;cursor:pointer}
#log{flex:1;overflow-y:auto;padding:12px 12px 8px;-webkit-overflow-scrolling:touch}
.row{margin:6px 0;max-width:92%}
.row.user{margin-left:auto}
.bub{border-radius:var(--radius);padding:10px 13px;white-space:pre-wrap;word-break:break-word;font-size:15px}
.user .bub{background:var(--user);color:#fff;border-bottom-right-radius:4px}
.bot .bub{background:var(--card);border-bottom-left-radius:4px}
.tool{background:#101826;border:1px solid #2a3a55;border-radius:10px;padding:7px 10px;font:12px/1.45 ui-monospace,Consolas,monospace;color:#9db4d8}
.tool b{color:#7fd1ff;font-weight:600}
.typing::after{content:"▍";color:var(--accent);animation:bl 1s steps(2) infinite}
@keyframes bl{50%{opacity:0}}
.sysline{color:#5b6b85;font-size:12px;text-align:center;margin:8px 0;max-width:100%}
#chips{display:flex;gap:6px;overflow-x:auto;padding:4px 12px;flex:none}
.chip{background:var(--card);border:1px solid #2a3a55;color:var(--accent);border-radius:20px;padding:5px 12px;font-size:13px;white-space:nowrap;flex:none;cursor:pointer}
#composer{display:flex;gap:8px;align-items:flex-end;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:var(--panel);border-top:1px solid #223}
#txt{flex:1;resize:none;background:var(--card);border:1px solid #2a3a55;color:var(--text);border-radius:12px;padding:10px 12px;font:inherit;max-height:120px}
#send{background:var(--accent);border:none;color:#fff;border-radius:12px;padding:11px 16px;font-size:15px;font-weight:600;flex:none;cursor:pointer}
#cancel{display:none;background:#7f1d1d;border:none;color:#fff;border-radius:12px;padding:11px 12px;flex:none;cursor:pointer}
#drawer{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:30;display:none}
#drawer.open{display:block}
#drawer .panel{position:absolute;left:0;top:0;bottom:0;width:82%;max-width:340px;background:var(--panel);padding:calc(12px + env(safe-area-inset-top)) 12px 12px;overflow-y:auto;box-shadow:4px 0 24px rgba(0,0,0,.5)}
.sess{background:var(--card);border-radius:10px;padding:10px 12px;margin:7px 0;display:flex;gap:8px;align-items:center;cursor:pointer}
.sess .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess .sub{display:block;font-size:11px;color:var(--dim)}
.sess .st{font-size:10px;border-radius:6px;padding:2px 6px;flex:none}
.st.run{background:#065f46;color:#a7f3d0}.st.stop{background:#334155;color:#cbd5e1}
#drawer h3{margin:10px 4px 4px;font-size:13px;color:var(--dim)}
</style></head>
<body>
<header>
  <button class="iconbtn" id="menu">☰</button>
  <span class="dot" id="conn"></span>
  <div class="title" id="curTitle">DSH 手机遥控</div>
  <button class="iconbtn" id="jumpDown">↓</button>
</header>
<div id="chips">
  <button class="chip" data-cmd="继续">▶ 继续</button>
  <button class="chip" data-cmd="查看当前插件装配状态">插件状态</button>
  <button class="chip" data-cmd="列出后台任务和状态">后台任务</button>
  <button class="chip" data-cmd="把刚才的结论总结成一段话">总结结论</button>
</div>
<div id="log"></div>
<div id="composer">
  <textarea id="txt" rows="1" placeholder="发消息给 agent…"></textarea>
  <button id="cancel">■ 取消</button>
  <button id="send">发送</button>
</div>
<div id="drawer"><div class="panel">
  <h3>会话</h3><div id="sessList">加载中…</div>
  <button class="chip" id="newSess" style="display:block;width:100%;text-align:center;margin-top:10px;padding:9px">＋ 新会话</button>
</div></div>
<script>
'use strict'
var $=function(id){return document.getElementById(id)}
var logEl=$('log')
var cur=null, es=null, entries=new Map(), evCounter=0, liveAcc={}

function esc(s){return escapeHtmlLocal(s)}
function escapeHtmlLocal(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function truncateLocal(s,n){s=String(s==null?'':s);return s.length>n?s.slice(0,n)+'…':s}
function scrollDown(){requestAnimationFrame(function(){logEl.scrollTop=logEl.scrollHeight})}

function removeRow(key){var r=entries.get(key);if(!r)return;r.remove();entries.delete(key)}
function addRow(key,cls,html){var row=document.createElement('div');row.className='row '+cls;row.innerHTML=html;logEl.appendChild(row);entries.set(key,row);return row}
function bub(text,dims){return '<div class="bub'+(dims?' typing':'')+'">'+escapeHtmlLocal(text)+'</div>'}

/* 统一事件渲染 */
function unified(ev){
  var t=String(ev.type||''),d=ev.data||{}
  if(/user/i.test(t)&&typeof d.text==='string')return{cls:'user',html:bub(d.text)}
  if(/assistant/i.test(t)&&typeof d.text==='string')return{cls:'bot',html:bub(d.text)}
  if(t==='assistant-stream')return null
  if(/tool/i.test(t)){
    var name=typeof d.name==='string'?d.name:(typeof d.toolName==='string'?d.toolName:truncateLocal(t,26))
    var arg=d.input!==undefined?d.input:(d.arguments!==undefined?d.arguments:(d.args!==undefined?d.args:''))
    var brief='';try{brief=typeof arg==='string'?arg:JSON.stringify(arg)}catch(e){brief=''}
    if(brief&&/\\"/.test(brief)&&brief.length>2&&brief[0]==='{')try{brief=JSON.parse(brief)&&JSON.stringify(JSON.parse(brief))}catch(e){}
    return{cls:'bot',html:'<div class="tool"><b>🔧 '+escapeHtmlLocal(name)+'</b>'+(brief?'<br>'+escapeHtmlLocal(truncateLocal(brief,MAX_ARG)):'')+'</div>'}
  }
  if(d&&typeof d.text==='string'&&d.text)return{cls:'bot',html:bub(d.text)}
  if(d&&typeof d.content==='string'&&d.content)return{cls:'bot',html:bub(d.content)}
  return null
}

function handleRecord(rec){
  var ev=rec.event||rec,seq=ev.seq
  if(seq!=null&&(typeof seq!=='number'||seq<0))seq=null
  if(seq!=null&&entries.has(seq))return
  var key=(seq!=null)?seq:('x'+(++evCounter))
  var u=unified(ev)
  if(u)addRow(key,u.cls,u.html)
  else addRow(key,'sysline','<span>'+escapeHtmlLocal(truncateLocal(ev.type,48))+'</span>')
  scrollDown()
}

/* ── SSE ── */
function closeStream(){if(es){es.close();es=null}setRun(false)}
function clearLog(){var it=entries.keys();for(;;){var n=it.next();if(n.done)break;removeRow(n.value)}entries=new Map();liveAcc={}}
function setRun(running){
  $('conn').className='dot'+(running?' on':'')
  $('cancel').style.display=running?'block':'none'
  $('send').style.display=running?'none':'block'
}
function follow(sid){
  closeStream();clearLog()
  $('curTitle').textContent=cur&&cur.title?cur.title:'…'
  es=new EventSource('/mobile/stream?sid='+encodeURIComponent(sid))
  es.addEventListener('frame',function(e){try{handleFrame(JSON.parse(e.data))}catch(x){}})
  es.addEventListener('end',function(){setRun(false)})
  es.addEventListener('fail',function(e){setRun(false)})
  es.onerror=function(){setRun(false);if(cur&&cur.sid===(cur.sessionId)){setTimeout(function(){if(cur)follow(cur.sessionId)},2500)}if(es)es.close()}
  refreshRunningFlag(sid)
}
function strOf(v){if(typeof v==='string')return v;if(v&&typeof v==='object'){if(typeof v.text==='string')return v.text;if(typeof v.title==='string')return v.title}return v===undefined||v===null?'':String(v)}
function handleFrame(f){
  if(f.type==='snapshot'){
    handleSnapshot(f);return
  }
  if(f.type==='event'){handleRecord(f);return}
  if(f.type==='assistant-stream'){handleLive(f.frame);return}
}
function handleSnapshot(f){
  for(var i=0;i<(f.records||[]).length;i++)handleRecord(f.records[i])
  var vals=(f.projections&&f.projections.values)||{}
  var title=strOf(vals.title)||strOf(vals['session/title'])
  if(title&&cur){cur.title=title;$('curTitle').textContent=title}
  refreshRunningFlag(f.header&&f.header.id?f.header.id:null)
  scrollDown()
}
function handleLive(fr){
  if(!fr)return
  if(fr.type==='start'){liveAcc[fr.attemptId]='';return}
  if(fr.type==='chunk'){
    var c=fr.chunk,txt=''
    if(c&&typeof c.text==='string')txt=c.text
    liveAcc[fr.attemptId]=(liveAcc[fr.attemptId]||'')+txt
    var key='live-'+fr.attemptId
    removeRow(key)
    addRow(key,'bot',bub(liveAcc[fr.attemptId]||'…',true))
    scrollDown();return
  }
  if(fr.type==='end'){removeRow('live-'+fr.attemptId);delete liveAcc[fr.attemptId]}
}
async function refreshRunningFlag(sid){
  setRun(false)
  try{var r=await api('sessions',{}),items=(r.value&&r.value.items)||[]
    for(var i=0;i<items.length;i++){
      if(sid&&items[i].sessionId===sid){setRun(!!items[i].running);if(items[i].title){$('curTitle').textContent=items[i].title}}
    }}catch(e){}
}

/* ── API ── */
async function api(endpoint,payload){
  var res=await fetch('/mobile/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload||{})})
  if(res.status===401){location.replace('/mobile');throw new Error('需要登录')}
  return res.json()
}

/* ── 抽屉 ── */
async function refreshSessions(){
  try{
    var r=await api('sessions',{}),items=(r.value&&r.value.items)||[]
    $('sessList').innerHTML=''
    for(var i=0;i<items.length;i++){
      (function(s){
        var el=document.createElement('div');el.className='sess'
        var st=s.running?'<span class="st run">运行中</span>':'<span class="st stop">'+(s.blank?'空':'空闲')+'</span>'
        el.innerHTML='<div class="t">'+escapeHtmlLocal(truncateLocal(s.title||s.sessionId,30))+'<span class="sub">'+escapeHtmlLocal(truncateLocal(s.cwd||'',36))+'</span></div>'+st
        el.onclick=function(){openSession(s);$('drawer').classList.remove('open')}
        $('sessList').appendChild(el)
      })(items[i])
    }
  }catch(e){$('sessList').textContent='加载失败：'+e}
}
function openSession(s){cur=s;follow(s.sessionId)}
$('menu').onclick=function(){$('drawer').classList.toggle('open');refreshSessions()}
$('drawer').onclick=function(e){if(e.target.id==='drawer')$('drawer').classList.remove('open')}
$('newSess').onclick=async function(){
  try{var r=await api('create',{});if(r.ok&&r.value&&r.value.sessionId){openSession({sessionId:r.value.sessionId,title:'新会话'});$('drawer').classList.remove('open')}else alert('创建失败:'+JSON.stringify(r))}catch(e){alert('创建失败:'+e)}
}

/* ── 发送/取消 ── */
function sendText(){
  var t=$('txt').value.trim();if(!t)return
  $('txt').value='';autoGrow()
  if(!cur){addRow('log-'+(++evCounter),'sysline','先从 ☰ 选择会话');scrollDown();return}
  addRow('log-'+(++evCounter),'user',bub(t));scrollDown()
  api('prompt',{sid:cur.sessionId,text:t,clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})
    .catch(function(e){addRow('log-'+(++evCounter),'sysline','发送失败：'+escapeHtmlLocal(String(e&&e.message||e)))})
  setTimeout(refreshRunningFlag.bind(null,cur.sessionId),500)
  scrollDown()
}
$('send').onclick=sendText
$('txt').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendText()}})
$('cancel').onclick=function(){if(cur)api('cancel',{sid:cur.sessionId}).catch(function(){})}
function autoGrow(){var t=$('txt');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,120)+'px'}
$('txt').addEventListener('input',autoGrow)
document.querySelectorAll('.chip[data-cmd]').forEach(function(chip){chip.onclick=function(){$('txt').value=chip.dataset.cmd;sendText()}})
$('jumpDown').onclick=scrollDown
</script></body></html>
`.replace('$$NONE$', '')

export function renderMobilePage(): string {
  return PAGE_INNER
}
