/**
 * 手机端面板（单文件 HTML，内嵌 CSS/JS，零外部依赖）。
 *
 * 与桌面 DSH 对齐的设计：
 *  - 白底黑字（浅色主题）
 *  - 思考内容 = 半透明可展开块（<details>，同 DSH 的 thinking）
 *  - 工作区 / 会话与 DSH 同源（workspaceController.follow baseline + session/list）
 *  - 已归档会话不显示（archivedSessionIds 过滤）
 *  - 模型来自 DSH 的 modelCatalog()，可切换（含 reasoning effort）
 * 数据面：POST /mobile/api/<endpoint>（JSON）+ GET /mobile/stream?sid=…（SSE 事件流）
 *
 * 事件形状（取自真实会话日志）：
 *  user/message      { content:[{type:'text',text}], role:'user' }
 *  assistant/message { message:{ content:[{type:'reasoning',text}|{type:'text',text}|{type:'tool-call',id,name,arguments}] } }
 *  tool/call         { callId, name, arguments }
 *  tool/result       { toolCallId, message:{ content:[{type:'text',text}], isError } }
 *
 * 安全：模型输出一律用 textContent / createElement 渲染，绝不 innerHTML 注入。
 */

const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#ffffff">
<title>DSH 手机遥控</title>
<style>
:root{--bg:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--soft:#f3f4f6;--user:#e0e7ff;--accent:#2563eb;--ok:#10b981}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;overscroll-behavior:none}
header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;padding-top:calc(10px + env(safe-area-inset-top))}
header .title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;font-size:15px}
header .dot{width:8px;height:8px;border-radius:50%;background:var(--line);flex:none}
header .dot.on{background:var(--ok)}
button.icon{background:var(--soft);border:none;color:var(--fg);width:36px;height:36px;border-radius:10px;font-size:17px;flex:none;cursor:pointer}
button.model{background:var(--soft);border:1px solid var(--line);color:var(--fg);border-radius:999px;padding:5px 10px;font-size:12px;max-width:9.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;cursor:pointer}
#log{flex:1;overflow-y:auto;padding:12px 12px 4px;-webkit-overflow-scrolling:touch}
.row{margin:8px 0;max-width:94%}
.row.user{margin-left:auto}
.bub{border-radius:14px;padding:9px 12px;white-space:pre-wrap;word-break:break-word}
.user .bub{background:var(--user);border-bottom-right-radius:4px}
.bot .bub{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}
details.think{background:rgba(107,114,128,.08);border:1px solid rgba(107,114,128,.18);border-left:3px solid rgba(107,114,128,.4);border-radius:10px;padding:6px 10px;margin:6px 0;font-size:13px;color:#4b5563}
details.think>summary{cursor:pointer;list-style:none;font-weight:600;color:#6b7280;font-size:12px;user-select:none}
details.think>summary::-webkit-details-marker{display:none}
details.think>summary::before{content:"▸ "}
details.think[open]>summary::before{content:"▾ "}
details.think pre{margin:6px 0 2px;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,Consolas,monospace;opacity:.9}
details.tool{background:#f9fafb;border:1px solid var(--line);border-radius:10px;padding:7px 10px;margin:6px 0;font-size:12px}
details.tool>summary{cursor:pointer;list-style:none;font-family:ui-monospace,Consolas,monospace;color:#374151}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary::before{content:"🔧 "}
details.tool pre{margin:6px 0 2px;white-space:pre-wrap;word-break:break-word;font:11.5px/1.5 ui-monospace,Consolas,monospace;color:#4b5563;max-height:240px;overflow:auto}
details.tool .res{margin-top:6px;border-top:1px dashed var(--line);padding-top:6px}
.sysline{color:#9ca3af;font-size:12px;text-align:center;margin:8px 0}
#composer{display:flex;gap:8px;align-items:flex-end;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid var(--line)}
#txt{flex:1;resize:none;background:#fff;border:1px solid var(--line);color:var(--fg);border-radius:12px;padding:10px 12px;font:inherit;max-height:120px}
#send{background:var(--accent);border:none;color:#fff;border-radius:12px;padding:11px 16px;font-size:15px;font-weight:600;flex:none;cursor:pointer}
#cancel{display:none;background:#dc2626;border:none;color:#fff;border-radius:12px;padding:11px 12px;flex:none;cursor:pointer}
.sheet{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:30;display:none}
.sheet.open{display:block}
.sheet>.panel{position:absolute;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.18)}
#drawer>.panel{left:0;top:0;bottom:0;width:86%;max-width:360px;padding:calc(12px + env(safe-area-inset-top)) 10px 12px;overflow-y:auto}
#modelSheet>.panel{left:0;right:0;bottom:0;max-height:76%;border-radius:16px 16px 0 0;padding:12px 12px calc(12px + env(safe-area-inset-bottom));overflow-y:auto}
.sheet h3{margin:6px 6px 8px;font-size:13px;color:var(--muted);font-weight:600}
.ws{margin:10px 0 2px}
.ws>.name{font-size:12px;color:var(--muted);padding:4px 6px;display:flex;gap:6px;align-items:baseline}
.ws>.name b{color:var(--fg);font-size:13px;font-weight:600}
.ws>.name .path{opacity:.7;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess{display:flex;gap:8px;align-items:center;padding:9px 10px;border-radius:10px;cursor:pointer}
.sess.active{background:var(--soft)}
.sess .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}
.sess .st{font-size:10px;border-radius:6px;padding:2px 6px;flex:none;background:var(--soft);color:var(--muted)}
.sess .st.run{background:#d1fae5;color:#065f46}
.mrow{display:flex;gap:8px;align-items:center;padding:10px;border-radius:10px;cursor:pointer}
.mrow.cur{background:#eff6ff}
.mrow .mn{flex:1;min-width:0}
.mrow .mn b{font-weight:600}
.mrow .mn span{display:block;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrow .go{font-size:11px;color:var(--accent);flex:none}
.efforts{display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 8px 10px}
.efforts button{border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer}
.efforts button.cur{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}
.mprov{margin:10px 6px 2px;font-size:12px;color:var(--muted);font-weight:600}
</style></head>
<body>
<header>
  <button class="icon" id="menu">☰</button>
  <span class="dot" id="conn"></span>
  <div class="title" id="curTitle">DSH 手机遥控</div>
  <button class="model" id="modelBtn">模型</button>
  <button class="icon" id="jumpDown">↓</button>
</header>
<div id="log"></div>
<div id="composer">
  <textarea id="txt" rows="1" placeholder="发消息给 agent…"></textarea>
  <button id="cancel">■ 取消</button>
  <button id="send">发送</button>
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
var counter = 0

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
function autoGrow() { var t = $('txt'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px' }

async function api(endpoint, payload) {
  var res = await fetch('/mobile/api/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  if (res.status === 401) { location.replace('/mobile'); throw new Error('需要登录') }
  return res.json()
}

// ── 渲染（DOM，不用 innerHTML） ─────────────────────────────
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
function brief(args) {
  if (typeof args !== 'string' || !args) return ''
  var one = args.replace(/\\s+/g, ' ')
  return one.length > 60 ? one.slice(0, 60) + '…' : one
}
function pretty(args) {
  if (typeof args !== 'string') return ''
  try { return JSON.stringify(JSON.parse(args), null, 2) } catch (e) { return args }
}
function toolCard(name, args, callId) {
  var d = el('details', 'tool')
  d.appendChild(el('summary', null, (name || 'tool') + '  ' + brief(args)))
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
  var label = t
  if (t === 'session/title' && d.title) label = '标题：' + d.title
  var r5 = addRow(key, 'sysline')
  r5.appendChild(el('div', null, label))
}

// ── SSE ─────────────────────────────────────────────────────
function setRunning(on) {
  running = on
  $('conn').className = 'dot' + (on ? ' on' : '')
  $('cancel').style.display = on ? 'block' : 'none'
  $('send').style.display = on ? 'none' : 'block'
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
    curModel = ms.next || ms.lastUsed || null
    paintModelBtn()
    setRunning(!!vals.running)
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
    setRunning(false)
  }
}

// ── 工作区 / 会话 ───────────────────────────────────────────
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
  var total = 0

  function sessRow(s) {
    if (!s || archived[s.sessionId]) return null
    used[s.sessionId] = true
    total++
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
    sessions.forEach(function (s) {
      if (used[s.sessionId] || archived[s.sessionId]) return
      if (s.cwd && ws.path && s.cwd === ws.path) { var r = sessRow(s); if (r) { group.appendChild(r); any = true } }
    })
    if (!any) group.appendChild(el('div', 'sysline', '（无会话）'))
    box.appendChild(group)
  })

  var others = sessions.filter(function (s) { return !used[s.sessionId] && !archived[s.sessionId] })
  if (others.length) {
    var g2 = el('div', 'ws')
    g2.appendChild(el('div', 'name', '未归类'))
    others.forEach(function (s) { var r = sessRow(s); if (r) g2.appendChild(r) })
    box.appendChild(g2)
  }
  var hidden = sessions.filter(function (s) { return archived[s.sessionId] }).length
  if (hidden) box.appendChild(el('div', 'sysline', '已隐藏 ' + hidden + ' 条已归档会话（与 DSH 归档一致）'))
  if (total === 0) box.appendChild(el('div', 'sysline', '没有可见会话（已归档的不显示）'))
}

// ── 模型 ────────────────────────────────────────────────────
function paintModelBtn() {
  var btn = $('modelBtn')
  var name = ''
  if (curModel && modelCatalog) {
    (modelCatalog.groups || []).forEach(function (g) {
      if (g.id !== curModel.provider) return
      ;(g.models || []).forEach(function (m) { if (m.id === curModel.model) name = m.name || m.id })
    })
  }
  if (!name && curModel) name = curModel.model
  btn.textContent = name || '模型'
  btn.title = curModel ? (curModel.provider + ' / ' + curModel.model + (curModel.reasoningEffort ? ' / ' + curModel.reasoningEffort : '')) : '选择模型'
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
          var b = el('button' + (curEff ? '' : ''), curEff ? 'cur' : null, ef.name || ef.id)
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
  }).then(function () { setRunning(true) })
    .catch(function (e) {
      var rr = addRow('err-' + (++counter), 'sysline')
      rr.appendChild(el('div', null, '发送失败：' + (e && e.message ? e.message : e)))
    })
}
$('send').onclick = sendText
$('cancel').onclick = function () { if (cur) api('cancel', { sid: cur.sessionId }).catch(function () { }) }
$('txt').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() } })
$('txt').addEventListener('input', autoGrow)

// 初始：自动打开最近一个**未被归档**的可见会话（归档集合与 DSH 同源）
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
    var first = null
    for (var i = 0; i < items.length; i++) { if (!archived[items[i].sessionId]) { first = items[i]; break } }
    if (first) openSession(first)
    else {
      var r = addRow('boot', 'sysline')
      r.appendChild(el('div', null, '没有可见会话（已归档的不显示）：点 ☰ 选择工作区'))
    }
  } catch (e) { /* 未登录时 api() 已跳转 */ }
})()
</script></body></html>`

export function renderMobilePage(): string {
  return PAGE
}
