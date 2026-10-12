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
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type SessionControllerModule from '@deepseek-ai/dsh-api-session-controller'
import type { SessionPromptRequest, SessionAddress, SessionCancelRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { renderMobilePage } from './page.js'

type AppContext = Context & {
  webServer: WebServer
  connection: HostConnectionHandle
  sessionController: SessionControllerModule
}

export const name = "@dsh-external/dsh-mobile-remote"
export const inject = ['webServer', 'connection', 'sessionController']

export function apply(ctx: AppContext): void {
  applyInner(ctx)
}

function applyInner(ctx: AppContext): void {
  const PAGE_PATH = '/mobile'
  const STREAM_PATH = '/mobile/stream'
  const API_PATH = '/mobile/api'

  const trust = (req: import('node:http').IncomingMessage): ConnectionTrustRequest =>
    ({ headers: req.headers })

  // 路由注册必须挂在 ctx.effect 上：fiber 卸载时自动摘除，热重载才不会
  // 留下残路由导致下次 apply 抛 "duplicate exact route"（实测踩坑）。
  const reg = (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }): void => {
    ctx.effect(() => ctx.webServer.register(route), `dsh-mobile-remote: ${route.path}`)
  }

  const unauthorized = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): boolean => {
    const rejection = ctx.connection.requestRejection(trust(req))
    if (rejection === undefined) return false
    // 401（未持有有效 cookie）→ 下发登录引导页（不直接 302，避免清除用户正在做的操作）
    if (rejection === 401 && (req.url === PAGE_PATH || req.url?.startsWith(PAGE_PATH + '?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      const loginUrl = ctx.connection.authenticatedUrl(new URL(`http://${req.headers.host ?? '127.0.0.1'}`).origin)
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;padding:2rem;max-width:30em;margin:auto">
<h2>🔐 手机端登录</h2><p id="st" style="color:#889">正在自动登录…</p>
<p>若长时间未跳转，<a href="${loginUrl}" style="color:#4c8dff">点此手动登录</a>，然后刷新本页。</p>
<iframe src="${loginUrl}" style="width:0;height:0;border:0" title="login"></iframe>
<script>
var t = setInterval(function(){
  fetch(location.pathname.replace(/\\/$/,'') + '/api/ping', {method:'POST'}).then(function(r){
    if (r.ok) { clearInterval(t); location.replace('/mobile?t=' + Date.now()) }
  }).catch(function(){})
}, 1200);
setTimeout(function(){ var s=document.getElementById('st'); if(s) s.textContent='若自动登录未完成，请点上方链接手动登录后刷新。' }, 8000);
</script></body>`)
      return true
    }
    res.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
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
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, endpoints: ['sessions', 'page', 'prompt', 'cancel', 'search'] }))
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
