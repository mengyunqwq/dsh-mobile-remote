/**
 * @dsh-external/dsh-mobile-remote — client 侧。
 *  1. conversation.view slot：对话视图里的入口卡片（面板地址说明）。
 *  2. plugins.bundle.config slot（keyed = 包名）：本插件在「插件设置」页的
 *     配置面板 —— 扫码配对二维码 + 各网卡候选地址 + 安全提示。
 * 手机扫到的地址打开 /mobile，由引导页自动完成登录配对（token → 签名 cookie）。
 * ⚠️ 必坑（实测）：inject = ['slots']；register 必须带 name；keyed slot 必须 key。
 */
import qrcode from 'qrcode-generator'

type SlotsLike = {
  inject(slot: string, factory: unknown, tag?: string): void
  register(def: unknown): unknown
}

type ClientContext = {
  slots: SlotsLike
  effect(fn: () => unknown, tag?: string): void
}

export const inject = ['slots']

const PLUGIN_ID = '@dsh-external/dsh-mobile-remote'

/** text → dataURL（ECC L，typeNumber 0 自动）；失败返回空串。 */
function qrDataUrl(text: string): string {
  try {
    const qr = (qrcode as unknown as (n: number, ecl: string) => {
      addData: (d: string) => void
      make(): void
      moduleCount: number
      isModule: (r: number, c: number) => boolean
    })(0, 'L')
    qr.addData(text)
    qr.make()
    const n = qr.moduleCount
    const cell = 4
    const margin = 3
    const size = (n + margin * 2) * cell
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const g = canvas.getContext('2d')
    if (!g) return ''
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, size, size)
    g.fillStyle = '#0b0f17'
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isModule(r, c)) g.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell)
      }
    }
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

type PairValue = { urls: { ip: string; url: string }[]; port: string; tunnel?: { status: string; url: string; pairCode?: string } }

async function fetchPair(): Promise<PairValue | null> {
  try {
    const res = await fetch('/mobile/api/pair', { method: 'GET' })
    const body = await res.json()
    if (body?.ok && Array.isArray(body.value?.urls)) return body.value
  } catch { /* 尚未认证等 */ }
  return null
}

const STYLE = `
.mr-set{font:13px/1.6 system-ui,sans-serif;max-width:560px}
.mr-set .row{display:flex;gap:14px;align-items:flex-start;margin:12px 0}
.mr-set img{border-radius:8px;background:#fff;padding:6px}
.mr-set code{background:rgba(127,143,170,.14);padding:2px 6px;border-radius:6px;font-size:12px;word-break:break-all}
.mr-set .dim{opacity:.7}
.mr-set .warn{color:#e6a23c}
.mr-set button{cursor:pointer;border-radius:8px;border:1px solid rgba(127,143,170,.4);background:transparent;color:inherit;padding:4px 10px}
.mr-set .item{margin:10px 0;padding:9px 11px;border:1px solid rgba(127,143,170,.25);border-radius:10px}
`

/** 设置页正文：向 host 取候选地址 → 每个候选一张二维码 + 复制按钮。 */
function buildPanel(): HTMLDivElement {
  const root = document.createElement('div')
  root.className = 'mr-set'
  root.innerHTML = `<style>${STYLE}</style>
    <h4 style="margin:0 0 2px">📱 手机遥控 · 扫码连接</h4>
    <div class="dim">手机用相机扫任意一个二维码即可打开面板；首次访问出现「手机端登录」引导页，在里面点一下即自动完成配对。</div>
    <div id="mr-list">正在获取本机地址…</div>
    <div class="warn" style="margin-top:8px">
      局域网二维码：手机须与电脑同一网络；若手机提示 403 或打不开，需把 webserver 监听改为
      <code>0.0.0.0</code> 并把本机 IP 加入 client-connection 的 <code>trustedHosts</code>（README 有完整说明）。
      <b>不装任何 App、跨网也能连：用下面的 ☁️ 云隧道二维码</b>（走公网 HTTPS，受本机登录认证保护）。
    </div>
    <div class="dim" style="margin-top:6px">云隧道地址随 DeepSeek Harness 进程生灭：Harness 关闭后隧道失效，重启后重新扫码即可。</div>`
  const list = root.querySelector('#mr-list') as HTMLDivElement
  void (async () => {
    const pair = await fetchPair()
    list.innerHTML = ''
    if (!pair) {
      list.innerHTML = '<div class="warn">获取本机地址失败（稍后重试，或查看 README 的局域网配置）。</div>'
      return
    }
    const candidates = pair.urls?.length ? pair.urls : []
    for (const c of candidates) {
      const item = document.createElement('div')
      item.className = 'item'
      const data = qrDataUrl(c.url)
      item.style.display = 'flex'
      item.style.gap = '14px'
      item.innerHTML = `
        <img src="${data}" width="132" height="132" alt="二维码" ${data ? '' : 'hidden'}>
        <div style="flex:1;min-width:0">
          <div><b>局域网 · ${c.ip}</b></div>
          <code>${c.url}</code>
          <div style="margin-top:6px"><button type="button">复制地址</button></div>
        </div>`
      const btn = item.querySelector('button') as HTMLButtonElement
      btn.onclick = () => {
        navigator.clipboard?.writeText(c.url).then(() => {
          btn.textContent = '已复制 ✓'
          setTimeout(() => { btn.textContent = '复制地址' }, 1500)
        })
      }
      list.appendChild(item)
    }
    if (!candidates.length) {
      const nodata = document.createElement('div')
      nodata.className = 'warn'
      nodata.textContent = '未发现局域网网卡地址（用下方 ☁️ 云隧道跨网连接）'
      list.appendChild(nodata)
    }
    // 云隧道（跨网）：手机无需同局域网、无需装任何 App
    const t = pair.tunnel
    const tItem = document.createElement('div')
    tItem.className = 'item'
    if (t && t.url) {
      tItem.style.display = 'flex'
      tItem.style.gap = '14px'
      const tdata = qrDataUrl(t.pairCode ? `${t.url}?pair=${t.pairCode}` : t.url)
      tItem.innerHTML = `
        <img src="${tdata}" width="132" height="132" alt="二维码" ${tdata ? '' : 'hidden'}>
        <div style="flex:1;min-width:0">
          <div><b>☁️ 云隧道 · 跨网可用</b></div>
          <div class="dim">HTTPS 加密直达，任何网络都能扫；走 Cloudflare 公网但受配对码保护。地址随 Harness 进程生灭。</div>
          <code>${t.url}</code>
          <div style="margin-top:6px">配对码（手机提示输入时手用）：<b style="font-size:18px;letter-spacing:3px">${t.pairCode ?? '—'}</b></div>
          <div style="margin-top:4px"><button type="button">复制地址</button></div>
        </div>`
      const tbtn = tItem.querySelector('button') as HTMLButtonElement
      tbtn.onclick = () => {
        navigator.clipboard?.writeText(t.url).then(() => {
          tbtn.textContent = '已复制 ✓'
          setTimeout(() => { tbtn.textContent = '复制地址' }, 1500)
        })
      }
    } else {
      tItem.innerHTML = `<div><b>☁️ 云隧道</b></div><div class="dim">状态：${t?.status ?? 'starting'}（隧道建立中，稍后刷新设置页；若持续未就绪可在插件配置里关掉 tunnel 再排障）</div>`
    }
    list.appendChild(tItem)
  })()
  return root
}

export function apply(ctx: ClientContext): void {
  // 1) 对话视图入口卡
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: `${PLUGIN_ID}-panel`,
      label: () => '手机遥控入口',
      component: () => ({
        render(props?: { view?: string }) {
          const el = document.createElement('div')
          if (props?.view === 'summary') {
            el.textContent = '手机遥控入口'
            return el
          }
          el.style.cssText = 'padding:14px;font:13px/1.7 system-ui,sans-serif'
          const here = new URL(location.href)
          el.innerHTML = `📱 手机远程操控：手机浏览器打开 <b>${here.origin}/mobile</b>。
            扫码配对二维码已放在 <b>插件设置 → 本插件页</b>（plugins.bundle.config）。`
          return el
        },
      }),
    }),
  ), `${PLUGIN_ID}: entry panel`)

  // 2) 插件设置页：二维码扫码配对（keyed by 包名）
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PLUGIN_ID,
      label: () => '手机遥控（扫码连接）',
      component: () => ({
        render(props?: { view?: string }) {
          const wrap = document.createElement('div')
          if (props?.view === 'summary') {
            wrap.textContent = '扫码连接手机端'
            return wrap
          }
          wrap.appendChild(buildPanel())
          return wrap
        },
      }),
    }),
  ), `${PLUGIN_ID}: settings qr`)
}
