/**
 * 手机端面板（单文件 HTML，内嵌 CSS/JS，零外部依赖）。
 *
 * 与桌面 DSH 对齐：
 *  - 白底黑字浅色主题，圆角卡片、轻阴影
 *  - 会话列表只列「工作区内的会话」；子代理会话与已归档会话不显示，其余收进折叠区
 *  - **思考内容默认折叠**（半透明可展开块）
 *  - **一个 turn 的思考/工具调用在执行结束后折进「已完成 · 完成时间」**（同 DSH 的 turn 折叠）
 *  - 输入区同 DSH：权限 chip + 模型 chip 在框内左侧，**上下文圆环**（百分比）在右侧，
 *    发送是圆形图标按钮；运行中额外出现停止按钮
 *  - 权限可切换（写回会话，桌面 GUI 同步）；模型可切换并立即回显
 *  - 任务执行时显示「正在执行 · 排队 N 条」（可展开看排队内容）
 * 数据面：POST /mobile/api/<endpoint> + GET /mobile/stream?sid=…（SSE）
 *
 * 事件形状（取自真实会话日志）：
 *  user/message      { content:[{type:'text',text}] }
 *  assistant/message { turn, step, message:{ content:[{type:'reasoning',text}|{type:'text',text}|{type:'tool-call',id,name,arguments}] } }
 *  tool/call         { turn, step, callId, name, arguments }
 *  tool/result       { turn, step, toolCallId, message:{ content:[{type:'text',text}], isError } }
 *  turn/start | turn/end | step/start | step/end
 * /status：{ running, title, modelSelection, permissions, tokenUsage, contextPressure, contextBreakdown, queue:{nextTurn[],nextStep[]} }
 * /permissions：{ catalog:{options[],defaultPreset}, current }
 *
 * 安全：模型输出一律 textContent / createElement（innerHTML 只用于清空容器）。
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
  --sys:#7c9cf5;--tools:#f0b45f;--msgs:#7dd3a8;
  --radius:16px;--shadow:0 1px 2px rgba(16,24,40,.04),0 4px 14px rgba(16,24,40,.05);
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:15px/1.62 -apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;overscroll-behavior:none}
header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(255,255,255,.92);backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;padding-top:calc(10px + env(safe-area-inset-top))}
header .title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:650;font-size:15.5px}
header .sub{display:block;font-size:11.5px;color:var(--muted);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button.ghost{background:transparent;border:none;color:var(--fg);width:34px;height:34px;border-radius:10px;font-size:17px;flex:none;cursor:pointer;display:flex;align-items:center;justify-content:center}
button.ghost:active{background:var(--soft)}
#log{flex:1;overflow-y:auto;padding:14px 12px 6px;-webkit-overflow-scrolling:touch}
.row{margin:9px 0;max-width:93%}
.row.user{margin-left:auto}
.row.bot{max-width:100%}
.bub{border-radius:var(--radius);padding:10px 13px;white-space:pre-wrap;word-break:break-word}
.user .bub{background:var(--user);border-bottom-right-radius:5px}
.bot .bub{background:var(--card);border:1px solid var(--line);border-bottom-left-radius:5px;box-shadow:var(--shadow)}
/* turn 过程折叠（已完成） */
details.proc{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:7px 11px;margin:8px 0;font-size:12.5px}
details.proc>summary{cursor:pointer;list-style:none;color:#6b7280;font-weight:600;display:flex;align-items:center;gap:6px}
details.proc>summary::-webkit-details-marker{display:none}
details.proc>summary::before{content:"▸";font-size:10px;opacity:.7}
details.proc[open]>summary::before{content:"▾"}
details.proc .body{padding-top:6px}
details.think{background:rgba(107,114,128,.07);border:1px solid rgba(107,114,128,.16);border-left:3px solid rgba(107,114,128,.38);border-radius:12px;padding:7px 11px;margin:7px 0;font-size:13px;color:#525c6b}
details.think>summary{cursor:pointer;list-style:none;font-weight:600;color:#6b7280;font-size:12px;display:flex;align-items:center;gap:5px}
details.think>summary::-webkit-details-marker{display:none}
details.think>summary::before{content:"▸";font-size:10px;opacity:.75}
details.think[open]>summary::before{content:"▾"}
details.think pre{margin:7px 0 2px;white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.92}
details.tool{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 11px;margin:7px 0;font-size:12.5px}
details.tool>summary{cursor:pointer;list-style:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#3f4756;display:flex;gap:6px;align-items:baseline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary::before{content:"🔧";font-size:11px}
details.tool pre{margin:7px 0 2px;white-space:pre-wrap;word-break:break-word;font:11.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:#525c6b;max-height:260px;overflow:auto}
details.tool .res{margin-top:7px;border-top:1px dashed var(--line);padding-top:7px}
.sysline{color:#a3aab6;font-size:12px;text-align:center;margin:9px 0}
/* 核查面板：改动文件 / diff / 待办 */
.pchip{display:none;align-items:center;gap:4px;background:#eef3ff;border:none;color:#1d4ed8;border-radius:999px;padding:4px 9px;font-size:11.5px;cursor:pointer;flex:none}
.changes{margin:6px 0 2px;border-top:1px dashed var(--line);padding-top:6px}
.changes .hd{font-size:12px;color:#4b5563;margin-bottom:4px}
.chgRow{display:flex;gap:6px;align-items:baseline;padding:4px 6px;border-radius:8px;cursor:pointer;font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.chgRow:active{background:var(--soft)}
.chgRow .p{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#374151}
.chgRow .a{color:#067647}
.chgRow .d{color:#b42318}
.dwrap{font:11.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;overflow-x:auto;background:#fbfcfd;border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:8px 0}
.dline{display:block;white-space:pre}
.dline.add{background:#e7f6ec;color:#116329}
.dline.del{background:#fdecea;color:#a40e26}
.dline.hunk{color:#7a8699}
.todoRow{display:flex;gap:8px;align-items:flex-start;padding:6px 8px;font-size:13px}
.todoRow .ic{flex:none;width:16px;text-align:center}
.todoRow.completed{color:#98a2b3;text-decoration:line-through}
.todoRow.in_progress{color:#1d4ed8;font-weight:600}
.statRow{display:flex;gap:8px;padding:5px 8px;font-size:12.5px}
.statRow .k{flex:1;color:#4b5563}
.statRow .v{font-variant-numeric:tabular-nums;color:#374151}
/* 输入区 */
#dock{padding:8px 12px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(180deg,rgba(247,248,250,0),var(--bg) 38%)}
#queue{display:none;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 11px;margin-bottom:8px;font-size:12.5px;box-shadow:var(--shadow)}
#queue .dot{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none}
#queue.run .dot{background:var(--ok);animation:pulse 1.4s infinite}
@keyframes pulse{50%{opacity:.35}}
#queue .txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#4b5563}
#queue button{border:none;background:transparent;color:var(--accent);font-size:12px;cursor:pointer}
#queueList{display:none;margin:-2px 0 8px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 11px;font-size:12.5px;color:#4b5563}
#queueList .qi{padding:4px 0;border-bottom:1px dashed var(--line);white-space:pre-wrap;word-break:break-word}
#queueList .qi:last-child{border-bottom:none}
#box{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:6px 6px 6px 8px}
#txt{width:100%;resize:none;border:none;outline:none;background:transparent;color:var(--fg);font:inherit;padding:8px 6px 4px;max-height:132px}
#boxBottom{display:flex;align-items:center;gap:6px;padding:2px}
.chip{display:flex;align-items:center;gap:4px;background:var(--soft);border:none;color:#4b5563;border-radius:999px;padding:5px 9px;font-size:12px;cursor:pointer;max-width:34%}
.chip .lb{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip .caret{opacity:.55;font-size:10px}
.chip.perm{color:#7a5b13;background:#fdf3e2}
#boxBottom .spacer{flex:1}
.ring{display:flex;align-items:center;gap:4px;background:transparent;border:none;padding:2px 4px;cursor:pointer;color:var(--muted);font-size:11px}
button.round{width:34px;height:34px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;flex:none;cursor:pointer}
#send{background:var(--accent);color:#fff}
#stop{background:#fee4e2;color:#d92d20;display:none}
/* 面板 */
.sheet{position:fixed;inset:0;background:rgba(16,24,40,.34);z-index:30;display:none}
.sheet.open{display:block}
.sheet>.panel{position:absolute;background:var(--card);box-shadow:0 10px 40px rgba(16,24,40,.2)}
#drawer>.panel{left:0;top:0;bottom:0;width:87%;max-width:370px;padding:calc(12px + env(safe-area-inset-top)) 10px 16px;overflow-y:auto;border-radius:0 18px 18px 0}
#sheetModel>.panel,#sheetCtx>.panel,#sheetPerm>.panel{left:0;right:0;bottom:0;max-height:78%;border-radius:20px 20px 0 0;padding:14px 12px calc(14px + env(safe-area-inset-bottom));overflow-y:auto}
.sheet h3{margin:4px 8px 10px;font-size:13px;color:var(--muted);font-weight:650}
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
details.others>summary::before{content:"▸ "}
details.others[open]>summary::before{content:"▾ "}
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
/* 上下文面板 */
.ctxHead{font-size:15px;font-weight:650;margin:2px 8px 10px}
.ctxBar{display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--soft);margin:0 8px 12px}
.ctxBar i{display:block;height:100%}
.ctxRow{display:flex;align-items:center;gap:8px;padding:7px 8px;font-size:13px}
.ctxRow .sw{width:9px;height:9px;border-radius:3px;flex:none}
.ctxRow .k{flex:1;min-width:0;color:#4b5563}
.ctxRow .v{font-variant-numeric:tabular-nums;color:#374151}
.ctxSep{height:1px;background:var(--line);margin:8px}
</style></head>
<body>
<header>
  <button class="ghost" id="menu" aria-label="会话">☰</button>
  <div class="title"><span id="curTitle">DSH 手机遥控</span><span class="sub" id="curSub">连接中…</span></div>
  <button class="pchip" id="progBtn" type="button" title="进度/工作量/改动">进度</button>
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
      <button class="chip perm" id="permBtn" type="button" title="权限（与桌面同步）"><span class="lb">权限</span><span class="caret">▾</span></button>
      <button class="chip" id="modelBtn" type="button" title="切换模型"><span class="lb">模型</span><span class="caret">▾</span></button>
      <span class="spacer"></span>
      <button class="ring" id="ctxBtn" type="button" title="上下文占用"></button>
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

<div class="sheet" id="sheetModel"><div class="panel">
  <h3>选择模型（与 DSH 同步）</h3>
  <div id="modelList">加载中…</div>
</div></div>

<div class="sheet" id="sheetCtx"><div class="panel">
  <h3>上下文与 token 用量</h3>
  <div id="ctxBody">暂无数据</div>
</div></div>

<div class="sheet" id="sheetPerm"><div class="panel">
  <h3>权限（与桌面 DSH 同步）</h3>
  <div id="permList">加载中…</div>
</div></div>

<div class="sheet" id="sheetProg"><div class="panel">
  <h3>进度 / 工作量 / 改动</h3>
  <div id="progBody">加载中…</div>
</div></div>

<div class="sheet" id="sheetDiff"><div class="panel">
  <h3 id="diffTitle">文件改动</h3>
  <div id="diffBody">加载中…</div>
</div></div>

<script>
'use strict'
var $ = function (id) { return document.getElementById(id) }
var logEl = $('log')
var cur = null
var es = null
var rows = new Map()
var cards = new Map()
var turns = new Map()
var live = { text: '', think: '', tRow: null, kRow: null }
var sessions = []
var wsItems = []
var archived = {}
var modelCatalog = null
var curModel = null
var modelOverride = null
var permCatalog = null
var curPerm = ''
var usage = { tokenUsage: null, contextPressure: null, contextBreakdown: null }
var todos = null
var goal = null
var plan = null
var stats = null
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
function oneLine(s, n) { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
function autoGrow() { var t = $('txt'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 132) + 'px' }
function hhmmss(ms) {
  try { return new Date(ms || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }) } catch (e) { return '' }
}
function fmtTokens(v) {
  var n = Number(v || 0)
  if (!isFinite(n)) return '0'
  if (n < 1000) return String(n)
  var scaled = function (x) { return x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10) }
  if (n < 1e6) return scaled(n / 1e3) + 'K'
  return scaled(n / 1e6) + 'M'
}

async function api(endpoint, payload) {
  var res = await fetch('/mobile/api/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  if (res.status === 401) { location.replace('/mobile'); throw new Error('需要登录') }
  return res.json()
}

// ── 渲染 ────────────────────────────────────────────────────
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
/** 思考块：默认折叠（用户明确要求不要默认展开）。 */
function thinkBlock(text) {
  var d = el('details', 'think')
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

/** 一个 turn 的过程容器：执行中展开，结束后折成「已完成 · 时间」。
 *  分组键优先用事件里的 turn 号；没有 turn 号时用"当前活跃 turn"序号兜底，
 *  避免多个 turn 的内容落进同一个已收起的框。 */
var activeTurn = '1'
var turnCounter = 1
function keyOfTurn(turnNo) {
  return (turnNo == null) ? activeTurn : String(turnNo)
}
function turnBox(turnNo) {
  var key = keyOfTurn(turnNo)
  var t = turns.get(key)
  if (t && t.done) {                       // 已收起的框不再续写：开新框
    turnCounter += 1
    key = 'r' + turnCounter
    t = null
  }
  if (t) return t
  var box = el('details', 'proc')
  box.open = true
  var sum = el('summary', null, '执行中…')
  var body = el('div', 'body')
  box.appendChild(sum); box.appendChild(body)
  logEl.appendChild(box)
  t = { box: box, body: body, sum: sum, done: false, steps: 0, tools: 0, errors: 0, start: 0, end: 0, chg: '' }
  turns.set(key, t)
  return t
}
function appendToTurn(turnNo, node) { turnBox(turnNo).body.appendChild(node) }
/** 完成摘要：把"做了什么"摆到折叠标题上（步数/工具次数/耗时/改动/错误）。 */
function turnSummary(t) {
  var parts = ['已完成']
  if (t.end) parts.push(hhmmss(t.end))
  var bits = []
  if (t.steps) bits.push(t.steps + ' 步')
  if (t.tools) bits.push(t.tools + ' 次工具')
  if (t.start && t.end && t.end >= t.start) bits.push(((t.end - t.start) / 1000).toFixed(1) + 's')
  if (bits.length) parts.push(bits.join(' · '))
  if (t.chg) parts.push(t.chg)
  if (t.errors) parts.push('⚠️ ' + t.errors + ' 处出错')
  return parts.join(' · ')
}
function refreshTurnSummary(t) { if (t.done) t.sum.textContent = turnSummary(t) }
function finishTurn(turnNo, timeMs) {
  var t = turns.get(keyOfTurn(turnNo))
  if (!t || t.done) return
  t.done = true
  t.end = timeMs || Date.now()
  t.sum.textContent = turnSummary(t)
  t.box.open = false
  scrollDown()
}

// ── 「实际做了什么」：改动文件 + 单文件 diff（D SH 的 workspaceChanges 数据）──
var lastChanges = null   // { seq, summary }
async function loadChanges(turnKey, seq) {
  if (!cur || seq == null) return
  try {
    var res = await api('changes', { sid: cur.sessionId, seq: seq })
    var s = res.value
    if (!s || !s.total) return
    lastChanges = { seq: seq, summary: s }
    var t = turns.get(turnKey)
    var box = el('div', 'changes')
    var hd = el('div', 'hd', '改动 ' + s.total + ' 个文件 · +' + s.added + ' −' + s.deleted)
    box.appendChild(hd)
    ;(s.files || []).forEach(function (f, i) {
      var row = el('div', 'chgRow')
      row.appendChild(el('span', 'p', f.display || f.path))
      row.appendChild(el('span', 'a', '+' + (f.added || 0)))
      row.appendChild(el('span', 'd', '−' + (f.deleted || 0)))
      row.onclick = function () { openDiff(seq, i, f.display || f.path) }
      box.appendChild(row)
    })
    var note = el('div', 'hd', '点文件看改动前后对比')
    box.appendChild(note)
    if (t) {
      t.body.appendChild(box)
      t.chg = '📄 ' + s.total + ' 文件 +' + s.added + '−' + s.deleted
      refreshTurnSummary(t)
    } else {
      var rowWrap = el('div', 'row')
      rowWrap.appendChild(box)
      logEl.appendChild(rowWrap)
    }
    scrollDown()
  } catch (e) { /* 改动汇总取不到就算了，不打扰阅读 */ }
}

async function openDiff(seq, index, display) {
  openSheet('sheetDiff')
  $('diffTitle').textContent = display || '文件改动'
  var body = $('diffBody')
  body.textContent = '加载中…'
  try {
    var res = await api('fileDiff', { sid: cur.sessionId, seq: seq, index: index })
    var d = res.value
    body.innerHTML = ''
    if (!d) { body.appendChild(el('div', 'sysline', '该改动已不可用（会话已释放或未记录）')); return }
    if (d.kind === 'binary') { body.appendChild(el('div', 'sysline', '二进制文件，无文本对比')); return }
    if (d.kind === 'oversized') { body.appendChild(el('div', 'sysline', '文件过大，未做对比')); return }
    var meta = el('div', 'statRow')
    meta.appendChild(el('span', 'k', (d.before ? '改前有' : '改前无') + ' → ' + (d.after ? '改后有' : '改后无') + (d.coarse ? '（粗略对比）' : '')))
    body.appendChild(meta)
    var wrap = el('div', 'dwrap')
    ;(d.hunks || []).forEach(function (h) {
      wrap.appendChild(el('span', 'dline hunk', '@@ -' + h.oldStart + ',' + h.oldLines + ' +' + h.newStart + ',' + h.newLines + ' @@'))
      ;(h.lines || []).forEach(function (ln) {
        var cls = 'dline'
        if (ln.charAt(0) === '+') cls += ' add'
        else if (ln.charAt(0) === '-') cls += ' del'
        wrap.appendChild(el('span', cls, ln))
      })
    })
    if (!(d.hunks || []).length) wrap.appendChild(el('span', 'dline', '（内容无变化）'))
    body.appendChild(wrap)
  } catch (e) { body.textContent = '读取失败：' + e }
}

// ── 进度 / 工作量（DSH 的 todos / goal / plan / sessionStats 投影）──
function paintProgress() {
  var btn = $('progBtn')
  var list = todos || []
  var done = list.filter(function (t) { return t.status === 'completed' }).length
  var has = list.length > 0 || goal
  if (!has) { btn.style.display = 'none'; return }
  btn.style.display = 'flex'
  btn.textContent = list.length ? ('待办 ' + done + '/' + list.length) : '进度'
  btn.title = '进度 / 工作量 / 改动'
}
function paintProgSheet() {
  var box = $('progBody')
  box.innerHTML = ''
  var list = todos || []
  if (goal) {
    box.appendChild(el('div', 'mprov', '目标'))
    box.appendChild(el('div', 'statRow')).appendChild(el('span', 'k', String(goal.objective || '')))
    box.appendChild(el('div', 'statRow')).appendChild(el('span', 'k', '阶段：' + String(goal.phase || '—') + (goal.roundsStarted != null ? ' · 轮次 ' + goal.roundsStarted : '')))
  }
  if (list.length) {
    var done = list.filter(function (t) { return t.status === 'completed' }).length
    box.appendChild(el('div', 'mprov', '待办 ' + done + '/' + list.length))
    list.forEach(function (t) {
      var row = el('div', 'todoRow ' + (t.status || 'pending'))
      var ic = t.status === 'completed' ? '✓' : (t.status === 'in_progress' ? '▶' : '○')
      row.appendChild(el('span', 'ic', ic))
      row.appendChild(el('span', 'k', t.content || ''))
      box.appendChild(row)
    })
  }
  var st = stats || {}
  if (st.turns != null || st.steps != null) {
    box.appendChild(el('div', 'mprov', '工作量'))
    ;[['turns', '轮次'], ['steps', '步数'], ['llmMs', '模型耗时'], ['toolMs', '工具耗时'], ['ttftMs', '首字延迟'], ['decodeTokens', '输出 token']].forEach(function (p) {
      var v = st[p[0]]
      if (v == null) return
      var val = (p[0].indexOf('Ms') > 0) ? (Math.round(Number(v) / 100) / 10) + 's' : String(v)
      var r = el('div', 'statRow')
      r.appendChild(el('span', 'k', p[1]))
      r.appendChild(el('span', 'v', val))
      box.appendChild(r)
    })
  }
  if (lastChanges && lastChanges.summary) {
    var s = lastChanges.summary
    box.appendChild(el('div', 'mprov', '最近一次改动（' + s.total + ' 文件 +' + s.added + ' −' + s.deleted + '）'))
    ;(s.files || []).forEach(function (f, i) {
      var row = el('div', 'chgRow')
      row.appendChild(el('span', 'p', f.display || f.path))
      row.appendChild(el('span', 'a', '+' + (f.added || 0)))
      row.appendChild(el('span', 'd', '−' + (f.deleted || 0)))
      row.onclick = function () { openDiff(lastChanges.seq, i, f.display || f.path) }
      box.appendChild(row)
    })
  }
  if (!box.childNodes.length) box.appendChild(el('div', 'sysline', '该会话还没有待办/改动记录（agent 用 todo_write 或改了文件后会出现）'))
}

function renderEvent(ev, key) {
  var t = ev.type || '', d = ev.data || {}
  if (t === 'user/message') {
    var r = el('div', 'row user')
    r.appendChild(el('div', 'bub', textOfContent(d.content)))
    logEl.appendChild(r); rows.set(key, r)
    return
  }
  if (t === 'turn/start') {
    if (d.turn == null) { turnCounter += 1; activeTurn = String(turnCounter) } else { activeTurn = String(d.turn) }
    var tb0 = turnBox(d.turn)
    tb0.start = ev.time || Date.now()
    return
  }
  if (t === 'turn/end') { finishTurn(d.turn, ev.time); return }
  if (t === 'step/start') { turnBox(d.turn).steps += 1; return }
  if (t === 'workspace/changes') { loadChanges(keyOfTurn(d.turn), ev.seq); return }
  if (t === 'assistant/message') {
    var content = ((d.message || {}).content) || []
    var textBubble = null
    for (var i = 0; i < content.length; i++) {
      var b = content[i]
      if (!b) continue
      if (b.type === 'reasoning' && b.text) { appendToTurn(d.turn, thinkBlock(b.text)); continue }
      if (b.type === 'tool-call') { appendToTurn(d.turn, toolCard(b.name, b.arguments, b.id)); continue }
      if (b.type === 'text' && b.text) {
        if (!textBubble) {
          var row = el('div', 'row bot')
          textBubble = el('div', 'bub')
          row.appendChild(textBubble)
          // 回复气泡插在过程块之后
          logEl.appendChild(row)
        }
        textBubble.appendChild(el('div', null, b.text))
      }
    }
    return
  }
  if (t === 'tool/call') {
    var tc = turnBox(d.turn); tc.tools += 1
    appendToTurn(d.turn, toolCard(d.name, d.arguments, d.callId))
    return
  }
  if (t === 'tool/result') {
    var card = cards.get(d.toolCallId)
    var out = textOfContent((d.message || {}).content)
    var isErr = !!(d.message && d.message.isError)
    var tr = turnBox(d.turn)
    if (isErr) { tr.errors += 1; refreshTurnSummary(tr) }
    var res = el('div', 'res')
    if (isErr) res.appendChild(el('div', null, '⚠️ 出错'))
    res.appendChild(el('pre', null, out || '（无输出）'))
    if (card) {
      card.appendChild(res)
      if (isErr) card.open = true
    } else {
      var t2 = el('details', 'tool')
      t2.appendChild(el('summary', null, 'tool result'))
      t2.appendChild(el('pre', null, out))
      appendToTurn(d.turn, t2)
    }
    return
  }
  if (t === 'session/title') return
  if (/^(step\\/|request\\/|agent\\/inbox)/.test(t)) return   // 过程噪音不占屏
  var r5 = el('div', 'row')
  r5.appendChild(el('div', 'sysline', t))
  logEl.appendChild(r5)
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
    queueItems.forEach(function (s) { list.appendChild(el('div', 'qi', oneLine(s, 160))) })
  } else { list.style.display = 'none' }
}
$('queueToggle').onclick = function () {
  var list = $('queueList')
  var open = list.style.display === 'block'
  list.style.display = open ? 'none' : 'block'
  $('queueToggle').textContent = open ? '查看' : '收起'
}

function closeStream() { if (es) { es.close(); es = null } setRunning(false) }
function clearLog() {
  rows.forEach(function (r) { r.remove() })
  rows = new Map(); cards = new Map(); turns = new Map()
  live = { text: '', think: '', tRow: null, kRow: null }
  var kids = Array.prototype.slice.call(logEl.children)
  kids.forEach(function (k) { k.remove() })
}

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
    var sel = ms.next || ms.lastUsed
    if (sel && !modelOverride) { curModel = sel }
    if (vals.permissions) curPerm = String(vals.permissions.currentValue || curPerm)
    usage.tokenUsage = vals.tokenUsage || usage.tokenUsage
    usage.contextPressure = vals.contextPressure || usage.contextPressure
    usage.contextBreakdown = vals.contextBreakdown || usage.contextBreakdown
    paintModelBtn(); paintPermBtn(); paintCtx()
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
      if (!live.kRow) {
        live.kRow = el('div', 'row bot')
        var tb = thinkBlock('')          // 默认折叠
        live.kRow.appendChild(tb)
        logEl.appendChild(live.kRow)
        appendToTurn('cur', live.kRow)   // 归入当前 turn 的过程块
      }
      var pre = live.kRow.querySelector('pre'), sum = live.kRow.querySelector('summary')
      if (pre) pre.textContent = live.think
      if (sum) sum.textContent = '思考中… · ' + live.think.length + ' 字'
      scrollDown(); return
    }
    if (c.type === 'tool-call-delta') return
    var txt = (typeof c.text === 'string') ? c.text : ''
    if (txt) {
      live.text += txt
      if (!live.tRow) {
        live.tRow = el('div', 'row bot')
        live.tRow.appendChild(el('div', 'bub'))
        logEl.appendChild(live.tRow)
      }
      live.tRow.firstChild.textContent = live.text
      scrollDown()
    }
    return
  }
  if (fr.type === 'end') { live = { text: '', think: '', tRow: null, kRow: null } }
}

// ── 状态轮询（运行/队列/模型/权限/用量，与 DSH 同步） ────────
function startStatusPolling(sid) {
  if (statusTimer) clearInterval(statusTimer)
  var tick = async function () {
    if (!cur || cur.sessionId !== sid) return
    try {
      var r = await api('status', { sid: sid })
      var v = r.value || {}
      if (v.title && (!cur.title || cur.title !== v.title)) { cur.title = v.title; $('curTitle').textContent = v.title }
      // 模型：用户刚切过的选择优先（服务器投影可能滞后一拍）
      var sel = v.modelSelection
      if (modelOverride) {
        if (sel && sel.provider === modelOverride.provider && sel.model === modelOverride.model) modelOverride = null
      } else if (sel && (sel.provider || sel.model)) {
        curModel = sel
      }
      if (v.permissions) curPerm = String(v.permissions.currentValue || curPerm)
      if (v.tokenUsage) usage.tokenUsage = v.tokenUsage
      if (v.contextPressure) usage.contextPressure = v.contextPressure
      if (v.contextBreakdown) usage.contextBreakdown = v.contextBreakdown
      todos = v.todos || null
      goal = v.goal || null
      plan = v.plan || null
      stats = v.sessionStats || stats
      queueItems = (v.queue && (v.queue.nextTurn || []).concat(v.queue.nextStep || [])) || []
      setRunning(!!v.running)
      paintModelBtn(); paintPermBtn(); paintCtx(); paintProgress()
    } catch (e) { /* 忽略单次失败 */ }
  }
  tick()
  statusTimer = setInterval(tick, 3000)
}

// ── 上下文 / token 用量（与 DSH 同算法：projectedTokens ?? pressureTokens / contextWindow） ──
function occupancy() {
  var p = usage.contextPressure || {}
  var used = (p.projectedTokens != null) ? p.projectedTokens : p.pressureTokens
  if (used == null || p.contextWindow == null || !p.contextWindow) return null
  return { percent: Math.min(100, Math.round(used / p.contextWindow * 100)), used: used, window: p.contextWindow }
}
function paintCtx() {
  var btn = $('ctxBtn')
  btn.innerHTML = ''
  var occ = occupancy()
  if (!occ) { btn.style.display = 'none'; return }
  btn.style.display = 'flex'
  var R = 5.5, C = 2 * Math.PI * R
  var ns = 'http://www.w3.org/2000/svg'
  var svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 14 14'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14')
  var track = document.createElementNS(ns, 'circle')
  track.setAttribute('cx', '7'); track.setAttribute('cy', '7'); track.setAttribute('r', String(R))
  track.setAttribute('fill', 'none'); track.setAttribute('stroke', '#e8eaee'); track.setAttribute('stroke-width', '2')
  var fill = document.createElementNS(ns, 'circle')
  fill.setAttribute('cx', '7'); fill.setAttribute('cy', '7'); fill.setAttribute('r', String(R))
  fill.setAttribute('fill', 'none'); fill.setAttribute('stroke', occ.percent >= 85 ? '#d92d20' : (occ.percent >= 60 ? '#f79009' : '#2f6fed'))
  fill.setAttribute('stroke-width', '2'); fill.setAttribute('stroke-linecap', 'round')
  fill.setAttribute('stroke-dasharray', (C * occ.percent / 100).toFixed(2) + ' ' + C.toFixed(2))
  fill.setAttribute('transform', 'rotate(-90 7 7)')
  svg.appendChild(track); svg.appendChild(fill)
  btn.appendChild(svg)
  btn.appendChild(el('span', null, occ.percent + '%'))
  btn.title = '上下文已用 ' + occ.percent + '%（' + fmtTokens(occ.used) + ' / ' + fmtTokens(occ.window) + '）'
}
function paintCtxSheet() {
  var box = $('ctxBody')
  box.innerHTML = ''
  var occ = occupancy()
  if (!occ) { box.appendChild(el('div', 'sysline', '该会话暂无上下文数据（模型尚未上报用量）')); return }
  box.appendChild(el('div', 'ctxHead', '上下文已用 ' + occ.percent + '%（' + fmtTokens(occ.used) + ' / ' + fmtTokens(occ.window) + '）'))
  var bd = usage.contextBreakdown || null
  var total = bd ? (bd.systemTokens || 0) + (bd.toolsTokens || 0) + (bd.messageTokens || 0) : 0
  var bar = el('div', 'ctxBar')
  if (bd && total > 0) {
    ;[['systemTokens', 'var(--sys)'], ['toolsTokens', 'var(--tools)'], ['messageTokens', 'var(--msgs)']].forEach(function (pair) {
      var w = occ.percent * (bd[pair[0]] || 0) / total
      if (w <= 0) return
      var seg = el('i'); seg.style.width = w + '%'; seg.style.background = pair[1]
      bar.appendChild(seg)
    })
  } else {
    var seg = el('i'); seg.style.width = occ.percent + '%'; seg.style.background = 'var(--accent)'
    bar.appendChild(seg)
  }
  box.appendChild(bar)
  if (bd) {
    ;[['systemTokens', '系统提示', 'var(--sys)'], ['toolsTokens', '工具定义', 'var(--tools)'], ['messageTokens', '对话内容', 'var(--msgs)']].forEach(function (row) {
      var r = el('div', 'ctxRow')
      var sw = el('span', 'sw'); sw.style.background = row[2]
      r.appendChild(sw)
      r.appendChild(el('span', 'k', row[1]))
      r.appendChild(el('span', 'v', fmtTokens(bd[row[0]] || 0)))
      box.appendChild(r)
    })
    box.appendChild(el('div', 'ctxSep'))
  }
  var tu = usage.tokenUsage || {}
  ;[['uncachedInputTokens', '输入（未缓存）'], ['cacheReadTokens', '输入（缓存读）'], ['cacheWriteTokens', '缓存写'], ['outputTokens', '输出']].forEach(function (row) {
    var v = tu[row[0]]
    if (v == null) return
    var r = el('div', 'ctxRow')
    r.appendChild(el('span', 'k', row[1]))
    r.appendChild(el('span', 'v', fmtTokens(v)))
    box.appendChild(r)
  })
}

// ── 模型 ────────────────────────────────────────────────────
function modelDisplayName(sel) {
  if (!sel) return ''
  var name = ''
  if (modelCatalog) {
    (modelCatalog.groups || []).forEach(function (g) {
      if (g.id !== sel.provider) return
      ;(g.models || []).forEach(function (m) { if (m.id === sel.model) name = m.name || m.id })
    })
  }
  return name || sel.model || ''
}
function paintModelBtn() {
  var sel = curModel || (modelCatalog && modelCatalog.default && modelCatalog.default.provider ? modelCatalog.default : null)
  var label = $('modelBtn').querySelector('.lb')
  if (label) label.textContent = modelDisplayName(sel) || '模型'
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
    var res = await api('selectModel', { sid: cur.sessionId, provider: provider, model: model, reasoningEffort: reasoningEffort })
    var sel = (res.value && res.value.selected) || { provider: provider, model: model }
    if (reasoningEffort) sel.reasoningEffort = reasoningEffort
    curModel = sel
    modelOverride = { provider: sel.provider, model: sel.model }   // 防状态轮询用旧值覆盖
    paintModelBtn()
    loadModels()
  } catch (e) { alert('切换失败：' + e) }
}

// ── 权限 ────────────────────────────────────────────────────
// ── 权限（中文文案取自 DSH 本地化表：preset.readOnly / workspaceWrite / fullAccess / auto.*）──
var PERM_ZH = {
  'read-only': { name: '仅可查看', short: '只读', desc: '只能读取，不能修改文件' },
  'workspace-write': { name: '工作区内修改', short: '工作区可写', desc: '只在工作目录内可写（默认）' },
  'danger-full-access': { name: '完全权限', short: '完全权限', desc: '无沙箱限制，可直接执行敏感操作、改文件或跑外部命令' },
  'auto': { name: 'Auto review（实验）', short: '自动审查', desc: '无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查' }
}
function catalogOption(v) {
  var hit = null
  ;((permCatalog && permCatalog.options) || []).forEach(function (o) { if (o.value === v) hit = o })
  return hit
}
/** 展示名：优先 DSH 中文；若部署方自定义了 label（与机器值不同）则用它；最后回退机器值。 */
function permName(v) {
  var o = catalogOption(v)
  if (o && o.name && o.name !== o.value) return o.name
  if (PERM_ZH[v]) return PERM_ZH[v].name
  return (o && o.name) || v || '权限'
}
function permShort(v) {
  if (PERM_ZH[v]) return PERM_ZH[v].short
  return permName(v)
}
function permDesc(v) {
  var o = catalogOption(v)
  if (o && o.description) return o.description
  return (PERM_ZH[v] && PERM_ZH[v].desc) || ''
}
/** 高危权限的确认文案与 DSH 一致（完全权限 / Auto review 都有风险门）。 */
function permConfirm(v) {
  if (v === 'danger-full-access') {
    return '确认启用完全权限？\\n\\n启用完全权限后，新会话将减少确认步骤，并且可以直接执行更多操作，\\n包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。'
  }
  if (v === 'auto') {
    return '确认启用 Auto review（实验）？\\n\\nAuto review 不使用沙箱。每次原生工具调用和 PTC 内层调用前，都会由与当前 agent 相同的模型进行审查；审查拒绝的调用由你批准或拒绝。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。'
  }
  return ''
}
function paintPermBtn() {
  var lb = $('permBtn').querySelector('.lb')
  if (lb) lb.textContent = permShort(curPerm)
  $('permBtn').title = curPerm ? ('当前权限：' + permName(curPerm) + '（' + curPerm + '）切换后桌面 DSH 同步') : '权限'
}
async function loadPermissions() {
  var box = $('permList')
  box.textContent = '加载中…'
  try {
    var res = await api('permissions', { sid: cur ? cur.sessionId : '' })
    permCatalog = (res.value && res.value.catalog) || null
    if (res.value && res.value.current) curPerm = res.value.current
    paintPermList(box)
    paintPermBtn()
  } catch (e) { box.textContent = '加载失败：' + e }
}
function paintPermList(box) {
  box.innerHTML = ''
  if (!permCatalog) { box.textContent = '无权限目录'; return }
  ;(permCatalog.options || []).forEach(function (o) {
    var isCur = curPerm === o.value
    var row = el('div', 'mrow' + (isCur ? ' cur' : ''))
    var mn = el('div', 'mn')
    mn.appendChild(el('b', null, permName(o.value)))
    var d = permDesc(o.value)
    mn.appendChild(el('span', null, o.value + (d ? ' · ' + d : '')))
    row.appendChild(mn)
    row.appendChild(el('span', 'go', isCur ? '当前' : '切换'))
    row.onclick = function () { selectPerm(o.value) }
    box.appendChild(row)
  })
  box.appendChild(el('div', 'sysline', '切换会写入该会话（permission/preset + sandbox/mode + approval/policy），桌面端立即可见'))
}
async function selectPerm(preset) {
  if (!cur) { alert('先选择一个会话'); return }
  var warn = permConfirm(preset)
  if (warn && !window.confirm(warn)) return
  try {
    await api('selectPermission', { sid: cur.sessionId, preset: preset })
    curPerm = preset
    paintPermBtn()
    loadPermissions()
    setRunning(running)
  } catch (e) { alert('切换权限失败：' + e) }
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
  var shown = 0
  function sessRow(s) {
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
  box.appendChild(el('div', 'sysline', '共 ' + shown + ' 条可见 · 已隐藏 ' + hiddenArch + ' 条归档 / ' + hiddenSub + ' 条子代理'))
}

// ── 交互 ────────────────────────────────────────────────────
function closeSheets() {
  ;['drawer', 'sheetModel', 'sheetCtx', 'sheetPerm', 'sheetProg', 'sheetDiff'].forEach(function (id) { $(id).classList.remove('open') })
}
function openSheet(id) { closeSheets(); $(id).classList.add('open') }
$('menu').onclick = function () { openSheet('drawer'); loadSidebar() }
$('modelBtn').onclick = function () { openSheet('sheetModel'); loadModels() }
$('permBtn').onclick = function () { openSheet('sheetPerm'); loadPermissions() }
$('ctxBtn').onclick = function () { openSheet('sheetCtx'); paintCtxSheet() }
$('progBtn').onclick = function () { openSheet('sheetProg'); paintProgSheet() }
;$(['drawer', 'sheetModel', 'sheetCtx', 'sheetPerm', 'sheetProg', 'sheetDiff']).forEach(function (id) {
  $(id).onclick = function (e) { if (e.target.id === id) closeSheets() }
})
$('jumpDown').onclick = scrollDown

function openSession(s) {
  cur = { sessionId: s.sessionId, title: s.title }
  modelOverride = null
  lastChanges = null
  todos = null; goal = null; plan = null; stats = null
  follow(s.sessionId)
}

function sendText() {
  var t = $('txt').value.trim()
  if (!t) return
  $('txt').value = ''; autoGrow()
  if (!cur) { alert('先从 ☰ 选择一个会话'); return }
  var r = el('div', 'row user')
  r.appendChild(el('div', 'bub', t))
  logEl.appendChild(r)
  scrollDown()
  api('prompt', {
    sid: cur.sessionId, text: t,
    mode: running ? 'queue' : 'steer',
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }).then(function () {
    if (running) { queueItems.push(t); paintQueue() }
    setRunning(true)
    setTimeout(function () { if (cur) startStatusPolling(cur.sessionId) }, 400)
  }).catch(function (e) {
    var rr = el('div', 'row')
    rr.appendChild(el('div', 'sysline', '发送失败：' + (e && e.message ? e.message : e)))
    logEl.appendChild(rr)
  })
}
$('send').onclick = sendText
$('stop').onclick = function () { if (cur) api('cancel', { sid: cur.sessionId }).catch(function () { }) }
$('txt').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() } })
$('txt').addEventListener('input', autoGrow)

// 初始：自动打开最近一个未归档、非子代理、属于工作区的会话
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
    else { var r = el('div', 'row'); r.appendChild(el('div', 'sysline', '没有可见会话：点 ☰ 选择工作区')); logEl.appendChild(r) }
  } catch (e) { /* 未登录时 api() 已跳转 */ }
})()
</script></body></html>`

export function renderMobilePage(): string {
  return PAGE
}
