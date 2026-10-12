/**
 * 手机端面板（单文件 HTML，内嵌 CSS/JS，零外部依赖）。
 *
 * 与桌面 DSH 对齐：
 *  - 白底黑字浅色主题，圆角卡片、轻阴影
 *  - 会话列表只列「工作区内的会话」（DSH 侧栏同源）；子代理会话与已归档会话都不显示，
 *    其余（无工作区归属的杂项）收进默认折叠的「其他会话」
 *  - 思考内容 = 半透明可展开块（<details>，同 DSH 的 thinking）
 *  - 输入区做成 DSH 的样子：模型按钮在输入框内左侧，发送是圆形图标按钮（框内右下）
 *  - 任务执行时显示状态：执行中 / 排队 N 条（可展开看排队内容）
 * 数据面：POST /mobile/api/<endpoint> + GET /mobile/stream?sid=…（SSE）
 *
 * 事件形状（取自真实会话日志）：
 *  user/message      { content:[{type:'text',text}], role:'user' }
 *  assistant/message { message:{ content:[{type:'reasoning',text}|{type:'text',text}|{type:'tool-call',id,name,arguments}] } }
 *  tool/call         { callId, name, arguments }
 *  tool/result       { toolCallId, message:{ content:[{type:'text',text}], isError } }
 * 会话状态（/status）：{ running, blank, title, modelSelection, queue:{nextTurn[],nextStep[]} }
 *
 * 安全：模型输出一律 textContent / createElement，绝不 innerHTML 注入（只用于清空容器）。
 */

const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#ffffff">
<title>DSH 手机遥控</title>
<style>
:root{
  --bg:#f7f8fa;--card:#fff;--fg:#111827;--muted:#8b93a1;--line:#e8eaee;
  --soft:#f2f4f7;--user:#e8efff;--accent:#2f6fed;--ok:#12b76a;--warn:#f79009;
  --radius:16px;--shadow:0 1px 2px rgba(16,24,40,.04),0 4px 14px rgba(16,24,40,.05);
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:15px/1.62 -apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;overscroll-behavior:none}
header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(255,255,255,.92);backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;padding-top:calc(10px + env(safe-area-inset-top))}
header .title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:650;font-size:15.5px;letter-spacing:.1px}
header .sub{display:block;font-size:11.5px;color:var(--muted);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button.ghost{background:transparent;border:none;color:var(--fg);width:34px;height:34px;border-radius:10px;font-size:17px;flex:none;cursor:pointer;display:flex;align-items:center;justify-content:center}
button.ghost:active{background:var(--soft)}
#log{flex:1;overflow-y:auto;padding:14px 12px 6px;-webkit-overflow-scrolling:touch;scroll-behavior:smooth}
.row{margin:9px 0;max-width:93%}
.row.user{margin-left:auto}
.bub{border-radius:var(--radius);padding:10px 13px;white-space:pre-wrap;word-break:break-word}
.user .bub{background:var(--user);border-bottom-right-radius:5px}
.bot .bub{background:var(--card);border:1px solid var(--line);border-bottom-left-radius:5px;box-shadow:var(--shadow)}
details.think{background:rgba(107,114,128,.07);border:1px solid rgba(107,114,128,.16);border-left:3px solid rgba(107,114,128,.38);border-radius:12px;padding:7px 11px;margin:7px 0;font-size:13px;color:#525c6b}
details.think>summary{cursor:pointer;list-style:none;font-weight:600;color:#6b7280;font-size:12px;user-select:none;display:flex;align-items:center;gap:5px}
details.think>summary::-webkit-details-marker{display:none}
details.think>summary::before{content:"▸";font-size:10px;opacity:.75}
details.think[open]>summary::before{content:"▾"}
details.think pre{margin:7px 0 2px;white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.92}
details.tool{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 11px;margin:7px 0;font-size:12.5px;box-shadow:var(--shadow)}
details.tool>summary{cursor:pointer;list-style:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#3f4756;display:flex;gap:6px;align-items:baseline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary::before{content:"🔧";font-size:11px}
details.tool pre{margin:7px 0 2px;white-space:pre-wrap;word-break:break-word;font:11.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:#525c6b;max-height:260px;overflow:auto}
details.tool .res{margin-top:7px;border-top:1px dashed var(--line);padding-top:7px}
.sysline{color:#a3aab6;font-size:12px;text-align:center;margin:9px 0}
/* ── 输入区（DSH 样式：模型按钮在框内，圆形图标发送） ── */
#dock{padding:8px 12px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(180deg,rgba(247,248,250,0),var(--bg) 38%)}
#queue{display:none;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 11px;margin-bottom:8px;font-size:12.5px;box-shadow:var(--shadow)}
#queue .dot{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none}
#queue.run .dot{background:var(--ok);animation:pulse 1.4s infinite}
@keyframes pulse{50%{opacity:.35}}
#queue .txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#4b5563}
#queue button{border:none;background:transparent;color:var(--accent);font-size:12px;cursor:pointer;padding:2px 4px}
#queueList{display:none;margin:-2px 0 8px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 11px;font-size:12.5px;color:#4b5563}
#queueList .qi{padding:4px 0;border-bottom:1px dashed var(--line);white-space:pre-wrap;word-break:break-word}
#queueList .qi:last-child{border-bottom:none}
#box{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:6px 6px 6px 8px}
#txt{width:100%;resize:none;border:none;outline:none;background:transparent;color:var(--fg);font:inherit;padding:8px 6px 4px;max-height:132px}
#boxBottom{display:flex;align-items:center;gap:8px;padding:2px 2px 2px 4px}
#modelBtn{display:flex;align-items:center;gap:5px;background:var(--soft);border:none;color:#4b5563;border-radius:999px;padding:5px 10px;font-size:12px;max-width:58%;cursor:pointer}
#modelBtn .mn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#modelBtn .caret{opacity:.55;font-size:10px}
#boxBottom .spacer{flex:1}
button.round{width:34px;height:34px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;flex:none;cursor:pointer}
#send{background:var(--accent);color:#fff}
#send:disabled{background:#c9d3e4;color:#fff}
#stop{background:#fee4e2;color:#d92d20;display:none}
/* ── 抽屉 / 模型面板 ── */
.sheet{position:fixed;inset:0;background:rgba(16,24,40,.34);z-index:30;display:none}
.sheet.open{display:block}
.sheet>.panel{position:absolute;background:var(--card);box-shadow:0 10px 40px rgba(16,24,40,.2)}
#drawer>.panel{left:0;top:0;bottom:0;width:87%;max-width:370px;padding:calc(12px + env(safe-area-inset-top)) 10px 16px;overflow-y:auto;border-radius:0 18px 18px 0}
#modelSheet>.panel{left:0;right:0;bottom:0;max-height:78%;border-radius:20px 20px 0 0;padding:14px 12px calc(14px + env(safe-area-inset-bottom));overflow-y:auto}
.sheet h3{margin:4px 8px 10px;font-size:13px;color:var(--muted);font-weight:650;letter-spacing:.2px}
.ws{margin:12px 0 4px}
.ws>.name{font-size:12px;color:var(--muted);padding:2px 8px 6px;display:flex;gap:6px;align-items:baseline}
.ws>.name b{color:var(--fg);font-size:13.5px;font-weight:650}
.ws>.name .path{opacity:.72;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess{display:flex;gap:8px;align-items:center;padding:10px 11px;border-radius:12px;cursor:pointer}
.sess.active{background:#eef3ff}
.sess .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14.5px}
.sess .st{font-size:10.5px;border-radius:7px;padding:2px 7px;flex:none;background:var(--soft);color:var(--muted)}
.sess .st.run{background:#d9f7e8;color:#067647}
details.others{margin:14px 6px 0}
details.others>summary{cursor:pointer;list-style:none;font-size:12px;color:var(--muted);padding:6px 2px}
details.others>summary::-webkit-details-marker{display:none}
details.others>summary::before{content:"▸ ";}
details.others[open]>summary::before{content:"▾ ";}
.mrow{display:flex;gap:10px;align-items:center;padding:11px;border-radius:12px;cursor:pointer}
.mrow.cur{background:#eef3ff}
.mrow .mn{flex:1;min-width:0}
.mrow .mn b{font-weight:600;font-size:14.5px}
.mrow .mn span{display:block;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrow .go{font-size:11.5px;color:var(--accent);flex:none}
.mprov{margin:12px 8px 4px;font-size:12px;color:var(--muted);font-weight:650}
.efforts{display:flex;gap:7px;flex-wrap:wrap;padding:2px 11px 10px}
.efforts button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:5px 11px;font-size:12px;cursor:pointer;color:#4b5563}
.efforts button.cur{background:#eef3ff;border-color:#c7d9ff;color:#1d4ed8}
</style></head>
<body>
<header>
  <button class="ghost" id="menu" aria-label="会话">☰</button>
  <div class="title"><span id="curTitle">DSH 手机遥控</span><span class="sub" id="curSub">连接中…</span></div>
  <button class="ghost" id="jumpDown" aria-label="回到底部">↓</button>
</header>

<div id="log"></div>

<div id="dock">
  <div id="queue">
    <span class="dot"></span>
    <span class="txt" id="queueTxt"></span>
    <button id="queueToggle" type="button">查看</button>
  </div>
  <div id="queueList"></div>
  <div id="box">
    <textarea id="txt" rows="1" placeholder="给 agent 发消息…"></textarea>
    <div id="boxBottom">
      <button id="modelBtn" type="button" title="切换模型"><span class="mn">模型</span><span class="caret">▾</span></button>
      <span class="spacer"></span>
      <button class="round" id="stop" type="button" aria-label="停止">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
      </button>
      <button class="round" id="send" type="button" aria-label="发送">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
      </button>
    </div>
  </div>
</div>

<div class="sheet" id="drawer"><div class="panel">
  <h3>工作区 / 会话</h3>
  <div id="sessList">加载中…</div>
</div></div>

<div class="sheet" id="modelSheet"><div class="panel">
  <h3>选择模型（与 DSH 同步）</h3>
  <div id="modelList">加载中…</div>
</div></div>

<script>
'use strict'
var $ = function (id) { return document.getElementById(id) }
var logEl = $('log')
var cur = null
var es = null
var rows = new Map()
var cards = new Map()
var live = { text: '', think: '', tRow: null, kRow: null }
var sessions = []
var wsItems = []
var archived = {}
var modelCatalog = null
var curModel = null
var running = false
var queueItems = []
var counter = 0
var statusTimer = null

function el(tag, cls, text) {
  var d = document.createElement(tag)
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}
function scrollDown() { requestAnimationFrame(function () { logEl.scrollTop = logEl.scrollHeight }) }
function removeRow(key) { var r = rows.get(key); if (r) { r.remove(); rows.delete(key) } }
function addRow(key, cls) {
  removeRow(key)
  var r = el('div', 'row ' + cls)
  logEl.appendChild(r)
  rows.set(key, r)
  return r
}
function autoGrow() { var t = $('txt'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 132) + 'px' }
function oneLine(s, n) { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }

async function api(endpoint, payload) {
  var res = await fetch('/mobile/api/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  if (res.status === 401) { location.replace('/mobile'); throw new Error('需要登录') }
  return res.json()
}

// ── 渲染（DOM，不用 innerHTML 注入） ────────────────────────
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  var out = []
  for (var i = 0; i < content.length; i++) {
    var b = content[i]
    if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text)
    else if (b && b.type === 'image') out.push('[图片]')
    else if (b && b.type === 'file') out.push('[文件]')
  }
  return out.join('\\n')
}
function thinkBlock(text, open) {
  var d = el('details', 'think')
  if (open) d.open = true
  d.appendChild(el('summary', null, '思考过程 · ' + (text || '').length + ' 字'))
  d.appendChild(el('pre', null, text || ''))
  return d
}
function pretty(args) {
  if (typeof args !== 'string') return ''
  try { return JSON.stringify(JSON.parse(args), null, 2) } catch (e) { return args }
}
function toolCard(name, args, callId) {
  var d = el('details', 'tool')
  d.appendChild(el('summary', null, (name || 'tool') + '  ' + oneLine(args, 52)))
  d.appendChild(el('pre', null, pretty(args)))
  if (callId) cards.set(callId, d)
  return d
}

function renderEvent(ev, key) {
  var t = ev.type || '', d = ev.data || {}
  if (t === 'user/message') {
    var r = addRow(key, 'user')
    r.appendChild(el('div', 'bub', textOfContent(d.content)))
    return
  }
  if (t === 'assistant/message') {
    var content = ((d.message || {}).content) || []
    var r2 = addRow(key, 'bot')
    var bubble = el('div', 'bub')
    for (var i = 0; i < content.length; i++) {
      var b = content[i]
      if (!b) continue
      if (b.type === 'reasoning' && b.text) { r2.appendChild(thinkBlock(b.text, false)); continue }
      if (b.type === 'text' && b.text) { bubble.appendChild(el('div', null, b.text)); continue }
      if (b.type === 'tool-call') { r2.appendChild(toolCard(b.name, b.arguments, b.id)); continue }
    }
    if (bubble.childNodes.length) r2.appendChild(bubble)
    if (!r2.childNodes.length) r2.appendChild(el('div', 'sysline', '（空消息）'))
    return
  }
  if (t === 'tool/call') {
    var r3 = addRow(key, 'bot')
    r3.appendChild(toolCard(d.name, d.arguments, d.callId))
    return
  }
  if (t === 'tool/result') {
    var card = cards.get(d.toolCallId)
    var out = textOfContent((d.message || {}).content)
    var isErr = !!(d.message && d.message.isError)
    if (card) {
      var box = el('div', 'res')
      if (isErr) box.appendChild(el('div', null, '⚠️ 出错'))
      box.appendChild(el('pre', null, out || '（无输出）'))
      card.appendChild(box)
      if (isErr) card.open = true
    } else {
      var r4 = addRow(key, 'bot')
      var c2 = el('details', 'tool')
      c2.appendChild(el('summary', null, 'tool result'))
      c2.appendChild(el('pre', null, out))
      r4.appendChild(c2)
    }
    return
  }
  if (t === 'session/title' && d.title) { return }   // 标题只在 header 显示，不占消息流
  var r5 = addRow(key, 'sysline')
  r5.appendChild(el('div', null, t))
}

// ── SSE ─────────────────────────────────────────────────────
function setRunning(on) {
  running = on
  $('stop').style.display = on ? 'flex' : 'none'
  paintQueue()
}
function paintQueue() {
  var q = $('queue'), t = $('queueTxt'), list = $('queueList')
  var n = queueItems.length
  if (!running && n === 0) { q.style.display = 'none'; list.style.display = 'none'; return }
  q.style.display = 'flex'
  q.className = running ? 'run' : ''
  var parts = []
  if (running) parts.push('正在执行')
  if (n > 0) parts.push('排队 ' + n + ' 条')
  t.textContent = parts.join(' · ') || '空闲'
  $('curSub').textContent = parts.join(' · ') || (cur ? '空闲' : '连接中…')
  if (n > 0) {
    list.innerHTML = ''
    queueItems.forEach(function (s) {
      list.appendChild(el('div', 'qi', oneLine(s, 160)))
    })
  } else { list.style.display = 'none' }
}
$('queueToggle').onclick = function () {
  var list = $('queueList')
  var open = list.style.display === 'block'
  list.style.display = open ? 'none' : 'block'
  $('queueToggle').textContent = open ? '查看' : '收起'
}

function closeStream() { if (es) { es.close(); es = null } setRunning(false) }
function clearLog() { rows.forEach(function (r) { r.remove() }); rows = new Map(); cards = new Map(); live = { text: '', think: '', tRow: null, kRow: null } }

function follow(sid) {
  closeStream(); clearLog()
  $('curTitle').textContent = (cur && cur.title) ? cur.title : '加载中…'
  es = new EventSource('/mobile/stream?sid=' + encodeURIComponent(sid))
  es.addEventListener('frame', function (e) { try { onFrame(JSON.parse(e.data)) } catch (x) { } })
  es.addEventListener('fail', function () { setRunning(false) })
  es.addEventListener('end', function () { setRunning(false) })
  es.onerror = function () {
    setRunning(false)
    if (es) es.close()
    if (cur) setTimeout(function () { if (cur && cur.sessionId === sid) follow(sid) }, 2500)
  }
  startStatusPolling(sid)
}

function str(v) {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') { if (typeof v.text === 'string') return v.text; if (typeof v.title === 'string') return v.title }
  return ''
}

function onFrame(f) {
  if (f.type === 'snapshot') {
    var vals = (f.projections && f.projections.values) || {}
    var title = str(vals.title)
    if (title && cur) { cur.title = title; $('curTitle').textContent = title }
    var ms = vals.modelSelection || {}
    curModel = ms.next || ms.lastUsed || curModel
    paintModelBtn()
    var recs = f.records || []
    for (var i = 0; i < recs.length; i++) onRecord(recs[i])
    scrollDown()
    return
  }
  if (f.type === 'event') { onRecord(f); return }
  if (f.type === 'assistant-stream') { onLive(f.frame); return }
}

function onRecord(rec) {
  var ev = rec.event || rec
  var seq = ev.seq
  var key = (seq != null) ? ('s' + seq) : ('x' + (++counter))
  if (seq != null && rows.has(key)) return
  renderEvent(ev, key)
  scrollDown()
}

function onLive(fr) {
  if (!fr) return
  if (fr.type === 'start') {
    live.think = ''; live.text = ''
    if (live.kRow) { live.kRow.remove(); live.kRow = null }
    if (live.tRow) { live.tRow.remove(); live.tRow = null }
    setRunning(true)
    return
  }
  if (fr.type === 'chunk') {
    var c = fr.chunk || {}
    if (c.type === 'reasoning-delta' && typeof c.text === 'string') {
      live.think += c.text
      if (!live.kRow) { live.kRow = addRow('live-think', 'bot'); live.kRow.appendChild(thinkBlock('', true)) }
      var pre = live.kRow.querySelector('pre'), sum = live.kRow.querySelector('summary')
      if (pre) pre.textContent = live.think
      if (sum) sum.textContent = '思考中… · ' + live.think.length + ' 字'
      scrollDown(); return
    }
    if (c.type === 'tool-call-delta') return
    var txt = (typeof c.text === 'string') ? c.text : ''
    if (txt) {
      live.text += txt
      if (!live.tRow) { live.tRow = addRow('live-text', 'bot'); live.tRow.appendChild(el('div', 'bub')) }
      live.tRow.firstChild.textContent = live.text
      scrollDown()
    }
    return
  }
  if (fr.type === 'end') {
    if (live.kRow) { var d = live.kRow.querySelector('details'); if (d) d.open = false }
    live = { text: '', think: '', tRow: null, kRow: null }
  }
}

// ── 会话状态轮询（running / 队列 / 模型 与 DSH 同步） ───────
function startStatusPolling(sid) {
  if (statusTimer) clearInterval(statusTimer)
  var tick = async function () {
    if (!cur || cur.sessionId !== sid) return
    try {
      var r = await api('status', { sid: sid })
      var v = r.value || {}
      if (v.title && (!cur.title || cur.title !== v.title)) { cur.title = v.title; $('curTitle').textContent = v.title }
      if (v.modelSelection) { curModel = v.modelSelection; paintModelBtn() }
      queueItems = (v.queue && (v.queue.nextTurn || []).concat(v.queue.nextStep || [])) || []
      setRunning(!!v.running)
    } catch (e) { /* 忽略单次失败 */ }
  }
  tick()
  statusTimer = setInterval(tick, 3000)
}

// ── 工作区 / 会话（只列工作区内的会话，与 DSH 侧栏同源） ────
async function loadSidebar() {
  var box = $('sessList')
  box.textContent = '加载中…'
  try {
    var sres = await api('sessions', {})
    sessions = (sres.value && sres.value.items) || []
    var wres = await api('workspaces', {})
    var w = wres.value || {}
    wsItems = w.items || []
    archived = {}
    ;(w.archivedSessionIds || []).forEach(function (id) { archived[id] = true })
    paintSidebar(box)
  } catch (e) {
    box.textContent = '加载失败：' + e
  }
}

function paintSidebar(box) {
  box.innerHTML = ''
  var byId = {}
  sessions.forEach(function (s) { byId[s.sessionId] = s })
  var used = {}
  var shown = 0

  function sessRow(s) {
    // 已归档 / 子代理会话不显示（与 DSH 侧栏一致）
    if (!s || archived[s.sessionId] || s.origin === 'subagent') return null
    used[s.sessionId] = true
    shown++
    var d = el('div', 'sess' + (cur && cur.sessionId === s.sessionId ? ' active' : ''))
    d.appendChild(el('div', 't', s.title || s.sessionId.slice(0, 16)))
    if (s.running) d.appendChild(el('span', 'st run', '运行中'))
    else if (s.blank) d.appendChild(el('span', 'st', '空'))
    d.onclick = function () { openSession(s); closeSheets() }
    return d
  }

  wsItems.forEach(function (ws) {
    var group = el('div', 'ws')
    var head = el('div', 'name')
    head.appendChild(el('b', null, ws.title || ws.path))
    head.appendChild(el('span', 'path', ws.path || ''))
    group.appendChild(head)
    var any = false
    ;(ws.sessionIds || []).forEach(function (id) { var r = sessRow(byId[id]); if (r) { group.appendChild(r); any = true } })
    if (!any) group.appendChild(el('div', 'sysline', '（无会话）'))
    box.appendChild(group)
  })

  // 其余会话（无工作区归属的杂项）默认折叠，不干扰阅读
  var others = sessions.filter(function (s) {
    return !used[s.sessionId] && !archived[s.sessionId] && s.origin !== 'subagent'
  })
  if (others.length) {
    var det = el('details', 'others')
    det.appendChild(el('summary', null, '其他会话（' + others.length + '）'))
    others.forEach(function (s) { var r = sessRow(s); if (r) det.appendChild(r) })
    box.appendChild(det)
  }
  var hiddenArch = sessions.filter(function (s) { return archived[s.sessionId] }).length
  var hiddenSub = sessions.filter(function (s) { return s.origin === 'subagent' && !archived[s.sessionId] }).length
  box.appendChild(el('div', 'sysline',
    '共 ' + shown + ' 条可见 · 已隐藏 ' + hiddenArch + ' 条归档 / ' + hiddenSub + ' 条子代理'))
}

// ── 模型 ────────────────────────────────────────────────────
function paintModelBtn() {
  var name = ''
  var sel = curModel
  // 有些会话的列表投影不含 modelSelection：回退到 DSH 的默认模型（就是实际会用的那个）
  if (!sel && modelCatalog && modelCatalog.default && modelCatalog.default.provider) sel = modelCatalog.default
  if (sel && modelCatalog) {
    (modelCatalog.groups || []).forEach(function (g) {
      if (g.id !== sel.provider) return
      ;(g.models || []).forEach(function (m) { if (m.id === sel.model) name = m.name || m.id })
    })
  }
  if (!name && sel) name = sel.model
  var label = $('modelBtn').querySelector('.mn')
  if (label) label.textContent = name || '模型'
  $('modelBtn').title = sel ? (sel.provider + ' / ' + sel.model + (sel.reasoningEffort ? ' / ' + sel.reasoningEffort : '')) : '选择模型'
}

async function loadModels() {
  var box = $('modelList')
  box.textContent = '加载中…'
  try {
    var res = await api('models', {})
    modelCatalog = res.value || null
    paintModels(box)
    paintModelBtn()
  } catch (e) { box.textContent = '加载失败：' + e }
}

function paintModels(box) {
  box.innerHTML = ''
  if (!modelCatalog) { box.textContent = '无模型目录'; return }
  var def = modelCatalog.default || {}
  if (def.provider) box.appendChild(el('div', 'mprov', '默认：' + def.provider + ' / ' + def.model))
  ;(modelCatalog.groups || []).forEach(function (g) {
    box.appendChild(el('div', 'mprov', g.name || g.id))
    ;(g.models || []).forEach(function (m) {
      var isCur = !!(curModel && curModel.provider === g.id && curModel.model === m.id)
      var row = el('div', 'mrow' + (isCur ? ' cur' : ''))
      var mn = el('div', 'mn')
      mn.appendChild(el('b', null, m.name || m.id))
      mn.appendChild(el('span', null, m.id + (m.description ? ' · ' + m.description : '')))
      row.appendChild(mn)
      row.appendChild(el('span', 'go', isCur ? '当前' : '切换'))
      row.onclick = function () { pickModel(g.id, m) }
      box.appendChild(row)
      var efforts = (m.reasoning && m.reasoning.efforts) || []
      if (isCur && efforts.length) {
        var er = el('div', 'efforts')
        efforts.forEach(function (ef) {
          var curEff = !!(curModel && curModel.reasoningEffort === ef.id)
          var b = el('button', curEff ? 'cur' : null, ef.name || ef.id)
          b.onclick = function () { selectModel(g.id, m.id, ef.id) }
          er.appendChild(b)
        })
        box.appendChild(er)
      }
    })
  })
  ;(modelCatalog.failures || []).forEach(function (f) {
    box.appendChild(el('div', 'sysline', '不可用：' + (f.name || f.id) + ' · ' + (f.message || '')))
  })
}

function pickModel(provider, m) {
  var efforts = (m.reasoning && m.reasoning.efforts) || []
  selectModel(provider, m.id, efforts.length ? m.reasoning.defaultEffort : undefined)
}

async function selectModel(provider, model, reasoningEffort) {
  if (!cur) { alert('先选择一个会话'); return }
  try {
    await api('selectModel', { sid: cur.sessionId, provider: provider, model: model, reasoningEffort: reasoningEffort })
    curModel = { provider: provider, model: model }
    if (reasoningEffort) curModel.reasoningEffort = reasoningEffort
    paintModelBtn()
    loadModels()
  } catch (e) { alert('切换失败：' + e) }
}

// ── 交互 ────────────────────────────────────────────────────
function closeSheets() { $('drawer').classList.remove('open'); $('modelSheet').classList.remove('open') }
$('menu').onclick = function () { $('drawer').classList.add('open'); loadSidebar() }
$('modelBtn').onclick = function () { $('modelSheet').classList.add('open'); loadModels() }
$('drawer').onclick = function (e) { if (e.target.id === 'drawer') closeSheets() }
$('modelSheet').onclick = function (e) { if (e.target.id === 'modelSheet') closeSheets() }
$('jumpDown').onclick = scrollDown

function openSession(s) { cur = { sessionId: s.sessionId, title: s.title }; follow(s.sessionId) }

function sendText() {
  var t = $('txt').value.trim()
  if (!t) return
  $('txt').value = ''; autoGrow()
  if (!cur) { alert('先从 ☰ 选择一个会话'); return }
  var r = addRow('local-' + (++counter), 'user')
  r.appendChild(el('div', 'bub', t))
  scrollDown()
  api('prompt', {
    sid: cur.sessionId, text: t,
    mode: running ? 'queue' : 'steer',
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }).then(function () {
    setRunning(true)
    // 排队时立即在状态条上体现
    if (running) { queueItems.push(t); paintQueue() }
    setTimeout(function () { if (cur) startStatusPolling(cur.sessionId) }, 400)
  }).catch(function (e) {
    var rr = addRow('err-' + (++counter), 'sysline')
    rr.appendChild(el('div', null, '发送失败：' + (e && e.message ? e.message : e)))
  })
}
$('send').onclick = sendText
$('stop').onclick = function () { if (cur) api('cancel', { sid: cur.sessionId }).catch(function () { }) }
$('txt').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() } })
$('txt').addEventListener('input', autoGrow)

// 初始：自动打开最近一个未归档、非子代理的会话
;(async function boot() {
  try {
    var sres = await api('sessions', {})
    var items = (sres.value && sres.value.items) || []
    var wres = await api('workspaces', {})
    var w = wres.value || {}
    archived = {}
    ;(w.archivedSessionIds || []).forEach(function (id) { archived[id] = true })
    sessions = items
    wsItems = w.items || []
    var inWs = {}
    wsItems.forEach(function (ws) { (ws.sessionIds || []).forEach(function (id) { inWs[id] = true }) })
    var first = null
    for (var i = 0; i < items.length; i++) {
      var s = items[i]
      if (!archived[s.sessionId] && s.origin !== 'subagent' && inWs[s.sessionId]) { first = s; break }
    }
    if (!first) for (var j = 0; j < items.length; j++) {
      var s2 = items[j]
      if (!archived[s2.sessionId] && s2.origin !== 'subagent') { first = s2; break }
    }
    if (first) openSession(first)
    else { var r = addRow('boot', 'sysline'); r.appendChild(el('div', null, '没有可见会话：点 ☰ 选择工作区')) }
  } catch (e) { /* 未登录时 api() 已跳转 */ }
})()
</script></body></html>`

export function renderMobilePage(): string {
  return PAGE
}
