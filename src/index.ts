/**
 * @dsh-external/dsh-mobile-remote — host 侧（hybrid）。
 * 手机端远程操控面板：
 *   GET  /mobile          — 单文件移动端 UI（首个请求未认证时下发登录引导页）
 *   GET  /mobile/stream?sid=… — SSE：sessionController.follow 开窗 + 实时事件
 *   POST /mobile/api      — JSON RPC：sessions / page / prompt / cancel / search
 * 认证全部走 ctx.connection.requestRejection（Host/Origin 栅栏 + 签名 cookie），
 * 登录引导页用 ctx.connection.authenticatedUrl 铸 token 链接（GET / 兑换 cookie）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type SessionControllerModule from '@deepseek-ai/dsh-api-session-controller'
import type WorkspaceControllerModule from '@deepseek-ai/dsh-api-workspace-controller'
import type { SessionPromptRequest, SessionAddress, SessionCancelRequest, SessionSelectModelRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import z from '@deepseek-ai/schemastery'
import { renderMobilePage } from './page.js'
import { CloudflareTunnel } from './tunnel.js'

export type TunnelConfig = {
  /** 随 harness 启动 cloudflared 免账号快隧道（跨网扫码连接，无需手机装任何 App）。 */
  tunnel?: boolean
  /** cloudflared 可执行文件路径（留空=自动从 GitHub 下载到数据目录）。 */
  cloudflaredPath?: string
  /** 云隧道二进制/日志缓存目录（留空=系统临时目录下 dsh-mobile-remote）。 */
  dataDir?: string
}

export const Config = z.object({
  tunnel: z.boolean().default(true),
  cloudflaredPath: z.string().default(''),
  dataDir: z.string().default(''),
})

type AppContext = Context & {
  webServer: WebServer
  connection: HostConnectionHandle
  sessionController: SessionControllerModule
  workspaceController: WorkspaceControllerModule
}

export const name = "@dsh-external/dsh-mobile-remote"
export const inject = ['webServer', 'connection', 'sessionController', 'workspaceController']

export function apply(ctx: AppContext, config: TunnelConfig): void {
  applyInner(ctx, config ?? {})
}

function applyInner(ctx: AppContext, config: TunnelConfig): void {
  const PAGE_PATH = '/mobile'
  const STREAM_PATH = '/mobile/stream'
  const API_PATH = '/mobile/api'

  // ── 跨网隧道（cloudflared quick tunnel）：默认随 harness 启动 ──
  // 数据目录放 DSH 数据区，避免 %TEMP% 被清理/抢占（实测踩坑）。
  const dataDir = config.dataDir ||
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mobile-remote')
  mkdirSync(dataDir, { recursive: true })
  const tunnel = new CloudflareTunnel(dataDir)
  const tunnelOn = config.tunnel !== false
  ctx.effect(() => {
    if (tunnelOn) {
      void (async () => {
        // 等一拍让 webserver 端口信息稳定，随后拉起隧道
        const port = ctx.webServer.port ?? 3080
        const res = await tunnel.ensure(`http://127.0.0.1:${port}`, config.cloudflaredPath || '')
        ctx.logger?.info?.(`[${name}] 云隧道: ${res.state} ${res.url || ''}`)
      })().catch((e) => ctx.logger?.info?.(`[${name}] 隧道启动失败: ${String(e)}`))
    }
    return () => tunnel.stop()
  }, `${name}: cloudflared tunnel lifecycle`)

  // ── 配对码：公网（云隧道）访客必须凭码完成登录（码只显示在电脑设置页）──
  const pairCode = String(Math.floor(100000 + Math.random() * 900000))

  // 隧道请求专用隔离 authority：cloudflared --http-host-header 改写 Host 到它；
  // 正式信任名单在 profile patch 的 connection.trustedHosts 里静态授予。
  // cookie authority 也固定为它 → 隧道换地址 cookie 不失效。
  const TUNNEL_HOST = 'dsh-tunnel:3080'
  const isTunnelReq = (req: import('node:http').IncomingMessage): boolean =>
    (req.headers.host ?? '').toLowerCase() === TUNNEL_HOST

  // 隧道请求的栅栏适配：去掉 Origin 头（fence 视为无 Origin 读放行；真正的跨站
  // 恶意页面仍会被 Sec-Fetch-Site=cross-site 拒绝）。cookie 认证不变。
  const trust = (req: import('node:http').IncomingMessage): ConnectionTrustRequest => {
    if (!isTunnelReq(req)) return { headers: req.headers }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    delete headers.origin
    return { headers }
  }

  // 路由注册必须挂在 ctx.effect 上：fiber 卸载时自动摘除，热重载才不会
  // 留下残路由导致下次 apply 抛 "duplicate exact route"（实测踩坑）。
  const reg = (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }): void => {
    ctx.effect(() => ctx.webServer.register(route), `dsh-mobile-remote: ${route.path}`)
  }

  const unauthorized = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): boolean => {
    const rejection = ctx.connection.requestRejection(trust(req))
    if (rejection === undefined) return false
    // 401（未持有有效 cookie）→ 下发登录引导页；公网隧道访客需要先输入配对码
    if (rejection === 401 && (req.url === PAGE_PATH || req.url?.startsWith(PAGE_PATH + '?'))) {
      const viaTunnel = isTunnelReq(req)
      const origin = new URL(`http://${req.headers.host ?? '127.0.0.1'}`).origin
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
      const codeGiven = url.searchParams.get('pair') ?? ''
      const codeOk = !!pairCode && codeGiven.trim() === pairCode
      if (viaTunnel && !codeOk) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;padding:2rem;max-width:30em;margin:auto">
<h2>🔐 手机端登录（公网模式）</h2>
<p style="color:#556">公网访问需要 6 位配对码。配对码显示在电脑端「插件设置 → 手机遥控」页。</p>
<form method="get" action="/mobile" style="display:flex;gap:8px">
  <input name="pair" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="配对码" style="flex:1;padding:12px;font-size:18px;border:1px solid #999;border-radius:10px;text-align:center;letter-spacing:6px">
  <button style="padding:12px 20px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-size:16px">连接</button>
</form>
${codeGiven ? '<p style="color:#b91c1c">配对码不正确。</p>' : ''}
</body>`)
        return true
      }
      // 公网拿到正确配对码 / 局域网访客：一步自动兑换登录
      // ⚠️ 关键坑（2026-10-12 实测）：不能用 req.headers.host 拼登录链接！
      //    云隧道下 cloudflared 会把 Host 改写成内部 authority（dsh-tunnel:3080），
      //    手机拿去解析这个域名必然 DNS 失败 → "扫码连不上"。
      //    正确做法：只下发 token，让页面用 **自己的 location.origin** 拼（LAN/隧道/反代都成立）。
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      const tokenized = ctx.connection.authenticatedUrl('http://placeholder.invalid/')
      const token = new URL(tokenized).searchParams.get('token') ?? ''
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;padding:2rem;max-width:30em;margin:auto">
<h2>🔐 正在连接…</h2><p id="st" style="color:#889">正在完成配对（通常 1 秒内）</p>
<p style="font-size:13px;color:#aaa">若 10 秒仍未进入，<a id="manual" href="#" style="color:#4c8dff">点此手动登录</a>后回到本页。</p>
<script>
var TOKEN = ${JSON.stringify(token)};
var LOGIN_URL = location.origin + '/?token=' + encodeURIComponent(TOKEN);
document.getElementById('manual').href = LOGIN_URL;
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms) }) }
async function authed(){
  try { var r = await fetch('/mobile/api/ping', { method:'POST', credentials:'same-origin' }); return r.ok } catch(e){ return false }
}
(async function(){
  var st = document.getElementById('st');
  // ① 先用 fetch 触发一次 token 兑换（浏览器会落 Set-Cookie），不加载笨重的桌面 GUI
  try { await fetch(LOGIN_URL, { credentials:'same-origin', redirect:'manual' }) } catch(e){}
  for (var i=0;i<12;i++){ if (await authed()) { location.replace('/mobile'); return } await sleep(350) }
  // ② 兜底：用隐藏 iframe 走一次完整跳转（个别浏览器对 manual redirect 的 Set-Cookie 处理不同）
  st.textContent = '正在用备用方式登录…';
  var f = document.createElement('iframe');
  f.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0';
  f.src = LOGIN_URL;
  document.body.appendChild(f);
  for (var j=0;j<40;j++){ if (await authed()) { location.replace('/mobile'); return } await sleep(500) }
  st.textContent = '自动登录未完成：请点上方链接手动登录，然后回到本页刷新。';
})();
</script></body>`)
      return true
    }
    res.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
    if (rejection === 403 && isTunnelReq(req)) {
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;padding:2rem;max-width:30em;margin:auto">
<h2>⏳ 云隧道尚未就绪</h2><p>监听配置已更新但还没重启 DeepSeek Harness。</p>
<p style="color:#556">在电脑端重启 DSH 后，本地址即可用；配对码在「插件设置 → 手机遥控」页。</p>
<p><button onclick="location.reload()">刷新重试</button></p></body>`)
      return true
    }
    res.end(rejection === 403 ? 'forbidden (host fence)' : 'unauthorized: open /mobile first')
    return true
  }

  // ── 手机面板页面 ──────────────────────────────────────────────
  reg({
    kind: 'exact',
    path: PAGE_PATH,
    handler(req, res) {
      if (unauthorized(req, res)) return
      const html = renderMobilePage()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    },
  })

  // ── 受控调试口：loopback + flag 文件双条件，缺一不走 ─────────
  // 用途：agent/脚本端到端自测（拿 loginUrl → 兑换 cookie → 调 API）。
  // 生产无需理会；不建 debug.flag 文件时任何请求都 404。
  const debugFlag = join(dirname(fileURLToPath(import.meta.url)), 'debug.flag')
  reg({
    kind: 'exact',
    path: PAGE_PATH + '/__debug',
    handler(req, res) {
      const remote = req.socket.remoteAddress ?? ''
      const loopbackOk = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!loopbackOk || !existsSync(debugFlag)) { res.writeHead(404).end(); return }
      const origin = new URL(`http://${req.headers.host ?? '127.0.0.1'}`).origin
      const html = JSON.stringify({ loginUrl: ctx.connection.authenticatedUrl(origin) })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(html)
    },
  })

  // 登录引导页里的登录态探测
  reg({
    kind: 'prefix',
    path: PAGE_PATH + '/api',
    handler(req, res) {
      void handleApi(req, res)
    },
  })

  // ── SSE：跟随一条会话的事件流 ────────────────────────────────
  reg({
    kind: 'exact',
    path: STREAM_PATH,
    handler(req, res) {
      if (unauthorized(req, res)) return
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const sid = url.searchParams.get('sid')
      if (!sid) { res.writeHead(400); res.end('missing sid'); return }
      req.socket.setKeepAlive?.(true, 15000)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const send = (event: string, data: unknown): void => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* 客户端已断开 */ }
      }
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      const pingTimer = setInterval(() => {
        try { res.write(': ping\n\n') } catch { /* ignore */ }
      }, 15000)
      const address = { kind: 'session', sessionId: sid } as unknown as SessionAddress
      void (async () => {
        try {
          const stream = ctx.sessionController.follow({
            address,
            assistantStream: true,
            maxMessages: 400,
            turnWindow: { minMessages: 200, minTurns: 20 },
          }, controller.signal)
          for await (const frame of stream) {
            if (controller.signal.aborted) return
            send('frame', frame)
          }
          send('end', { ok: true })
        } catch (e) {
          if (!controller.signal.aborted) send('fail', { message: String(e instanceof Error ? e.message : e) })
        } finally {
          clearInterval(pingTimer)
          try { res.end() } catch { /* ignore */ }
        }
      })()
    },
  })

  // ── JSON RPC：一次性命令（列表 / 历史页 / 发送 / 取消 / 搜索）──
  const readBody = (req: import('node:http').IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (c: Buffer) => {
        total += c.length
        if (total > 1_000_000) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  async function handleApi(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    if (unauthorized(req, res)) return
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const endpoint = url.pathname.replace(/^\/mobile\/api\/?/, '')
    if (req.method === 'GET') {
      //GET /mobile/api/pair — 给桌面 GUI 设置页的扫码配对：返回本机局域网候选 + 手机面板地址
      if (endpoint === 'pair') {
        const os = await import('node:os')
        const ips: string[] = []
        for (const list of Object.values(os.networkInterfaces())) {
          for (const net of list ?? []) {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
          }
        }
        const port = String(ctx.webServer.port ?? new URL(`http://${req.headers.host ?? '127.0.0.1'}`).port)
        // 云隧道：若尚未就绪且开启中，尝试等待（首次会下载二进制，可能较慢）
        let tunnelUrl = tunnel.publicUrl
        if (!tunnelUrl && tunnelOn && tunnel.status === 'disabled') {
          const r = await tunnel.ensure(`http://127.0.0.1:${port}`, config.cloudflaredPath || '')
          tunnelUrl = r.url
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          ok: true,
          value: {
            port,
            ips,
            urls: ips.map(ip => ({ ip, url: `http://${ip}:${port}/mobile` })),
            tunnel: {
              status: tunnel.status,
              url: tunnelUrl,
              // 已发现但还没被云端确认注册的地址（面板显示"注册中"，此时扫码会 530）
              pendingUrl: tunnel.pendingUrl,
              registered: tunnel.isRegistered,
              lastError: tunnel.lastError || '',
              logTail: tunnel.tail(),
              // 公网配对码（设置页展示；二维码里的直连地址在多数相机场景预填，输入码兜底）
              pairCode,
            },
            fallback: `http://127.0.0.1:${port}/mobile`,
          },
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, endpoints: ['sessions', 'page', 'prompt', 'cancel', 'search', 'pair', 'workspaces', 'models', 'selectModel', 'status'] }))
      return
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body: any
    try {
      // 常见坑：PowerShell Set-Content UTF8 带 BOM，JSON.parse 会失败 → 剥 BOM 再解析
      const raw = (await readBody(req)).toString('utf8').replace(/^\uFEFF/, '')
      body = JSON.parse(raw || '{}')
    } catch { body = {} }
    try {
      let value: unknown
      switch (endpoint) {
        case 'ping':
          value = { ok: true }
          break
        case 'workspaces': {
          // 工作区 + 归档集合 + 置顶集合：取 follow() 的首帧 baseline（与桌面 GUI 同源）
          const ac = new AbortController()
          let baseline: unknown = null
          try {
            const it = ctx.workspaceController.follow(ac.signal)
            for await (const frame of it) {
              if (frame.type === 'baseline') { baseline = frame.value; break }
            }
          } finally {
            ac.abort()
          }
          value = baseline ?? { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
          break
        }
        case 'models': {
          value = await ctx.sessionController.modelCatalog()
          break
        }
        case 'status': {
          // 轻量会话状态：运行中？排队几条？当前模型？标题？
          // （running/inbox 只在会话摘要里，follow 快照不含 running —— 实测踩坑）
          const sid = String(body.sid)
          const list = await ctx.sessionController.list({}, new AbortController().signal)
          const row = list.items.find(i => String(i.sessionId) === sid)
          const vals = (row?.projections?.values ?? {}) as Record<string, unknown>
          const inbox = (vals.inbox ?? {}) as Record<string, unknown>
          const texts = (arr: unknown): string[] => {
            if (!Array.isArray(arr)) return []
            return arr.map((m: any) => {
              const c = m?.content
              if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join(' ').trim()
              return ''
            }).filter(Boolean)
          }
          value = {
            exists: !!row,
            running: !!row?.running,
            blank: !!row?.blank,
            title: row ? readProjectionTitle(row) : '',
            modelSelection: vals.modelSelection ?? null,
            queue: {
              nextTurn: texts(inbox['next-turn']),
              nextStep: texts(inbox['next-step']),
            },
          }
          break
        }
        case 'selectModel': {
          value = await ctx.sessionController.selectModel({
            sessionId: String(body.sid),
            provider: String(body.provider),
            model: String(body.model),
            ...(body.reasoningEffort ? { reasoningEffort: String(body.reasoningEffort) } : {}),
          } as SessionSelectModelRequest)
          break
        }
        case 'sessions': {
          const list = await ctx.sessionController.list({}, new AbortController().signal)
          value = {
            items: list.items.map(s => ({
              ...s,
              title: readProjectionTitle(s),
            })),
          }
          break
        }
        case 'page': {
          const address = { kind: 'session', sessionId: String(body.sid) } as unknown as SessionAddress
          const page = await ctx.sessionController.page({
            address,
            throughSeq: Number(body.throughSeq) || 0,
            beforeSeq: body.beforeSeq === undefined ? undefined : Number(body.beforeSeq),
            maxMessages: Math.min(Number(body.maxMessages) || 50, 200),
          }, new AbortController().signal)
          value = page
          break
        }
        case 'prompt': {
          const text = String(body.text ?? '')
          if (!text.trim()) { value = { accepted: false, error: 'empty prompt' }; break }
          const request: SessionPromptRequest = {
            requestId: crypto.randomUUID(),
            sessionId: String(body.sid),
            mode: body.mode === 'queue' ? 'queue' : 'steer',
            content: [{ type: 'text', text }],
            clientTimeZone: body.clientTimeZone,
          } as unknown as SessionPromptRequest
          value = await ctx.sessionController.prompt(request, new AbortController().signal)
          break
        }
        case 'create': {
          value = await ctx.sessionController.create({})
          break
        }
        case 'cancel': {
          value = await ctx.sessionController.cancel({ sessionId: String(body.sid) } as SessionCancelRequest)
          break
        }
        case 'search': {
          value = await ctx.sessionController.search({ query: String(body.query ?? '') }, new AbortController().signal)
          break
        }
        default:
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'unknown endpoint' }))
          return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, value }))
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: String(e instanceof Error ? e.message : e) }))
    }
  }

  ctx.logger?.info?.(`[${name}] 手机面板已挂载: ${PAGE_PATH}`)
}

/** 从 projections 提示里读会话标题（键位未必存在，取不到回退 sessionId）。 */
function readProjectionTitle(s: { sessionId: string; projections?: { values?: Record<string, unknown> } }): string {
  const values = s.projections?.values ?? {}
  for (const key of ['title', 'session-title', 'summary.title', 'name']) {
    const v = values[key]
    if (typeof v === 'string' && v.trim()) return v
    if (v && typeof v === 'object') {
      const text = (v as any).text ?? (v as any).title
      if (typeof text === 'string' && text.trim()) return text
    }
  }
  return s.sessionId.slice(0, 18)
}
