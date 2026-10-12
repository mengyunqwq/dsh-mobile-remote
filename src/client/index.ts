/**
 * @dsh-external/dsh-mobile-remote — client 侧（DSH GUI 内的三个界面）。
 *
 *  1. 「手机遥控」独立主面板：sidebar.panellist 图标 + main 面板（keyed='mobile-remote'）
 *     —— 二维码扫码配对、隧道状态、本机地址、以及内嵌 /mobile 的实时预览（手机界面映射）。
 *  2. plugins.bundle.config：插件设置页里的扫码配对卡（keyed=包名）。
 *  3. conversation.view：对话视图入口卡。
 *
 * ⚠️ 关键坑（2026-10-12 实测）：DSH 渲染器把 entry.component **直接当 React 组件**用
 *    （`jsx(Comp, {...props})`）。脚手架生成的 `component: () => ({ render() {} })`
 *    不是 React 组件 → 渲染时抛错，被 slot 错误边界静默吞掉（界面一片空白）。
 *    所以这里全部写成真正的 React 函数组件。
 * ⚠️ 另一个坑：register 必须带 name（slot 名）；keyed slot 必须带 key；
 *    侧边栏图标 id 必须与主面板 key 一致。
 */
import React from 'react'
import qrcode from 'qrcode-generator'

const h = React.createElement

const PLUGIN_ID = '@dsh-external/dsh-mobile-remote'
/** 侧边栏图标与主面板共用的 id（sidebar.panellist.id === main.key）。 */
const PANEL_ID = 'mobile-remote'

export const inject = ['slots', 'layout']

/** apply 时注入的面板导航能力（供设置页「打开面板」按钮使用）。 */
let layoutRef: { selectPanel?: (id: string) => void } | null = null

// ── 工具 ─────────────────────────────────────────────────────────────

/** text → 二维码 SVG 字符串（ECC L，自动版本）；失败返回空串。
 *  ⚠️ 必须用 qrcode-generator **v2** 的 API：getModuleCount() / isDark() / createSvgTag()。
 *     v1 的 `qr.moduleCount` / `qr.isModule()` 在 v2 里是 undefined → 会画出**空白**二维码
 *     （2026-10-12 实测踩坑：面板上只有一个白方块、无任何报错）。自检里已加 API 漂移负向对照。 */
export function qrSvg(text: string, cellSize = 4, margin = 3): string {
  try {
    const qr = (qrcode as unknown as (n: number, ecl: string) => {
      addData: (d: string) => void
      make(): void
      getModuleCount(): number
      isDark(r: number, c: number): boolean
      createSvgTag(opts: { cellSize?: number; margin?: number; scalable?: boolean }): string
    })(0, 'L')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    if (!n || n < 21) return ''
    return qr.createSvgTag({ cellSize, margin, scalable: true })
  } catch {
    return ''
  }
}

type TunnelInfo = { status?: string; url?: string; pairCode?: string; lastError?: string }
type PairValue = { port: string; urls: { ip: string; url: string }[]; tunnel?: TunnelInfo }

/** 拉取 host 侧配对信息（含隧道状态/地址/配对码）。 */
function usePair(): { data: PairValue | null; error: string; loading: boolean; reload: () => void } {
  const [state, setState] = React.useState({ data: null as PairValue | null, error: '', loading: true })
  const load = React.useCallback(() => {
    setState((s: { data: PairValue | null; error: string; loading: boolean }) => ({ ...s, loading: true }))
    fetch('/mobile/api/pair')
      .then(r => r.json())
      .then((b: { ok?: boolean; value?: PairValue }) => {
        if (b && b.ok && b.value) setState({ data: b.value, error: '', loading: false })
        else setState({ data: null, error: '尚未授权（刷新页面后重试）', loading: false })
      })
      .catch((e: unknown) => setState({ data: null, error: String(e), loading: false }))
  }, [])
  React.useEffect(() => { load() }, [load])
  // 隧道还在 starting 时每 4s 自动刷新
  React.useEffect(() => {
    const t = setInterval(() => {
      const st = state.data?.tunnel?.status
      if (!state.data || st === 'starting' || st === 'disabled') load()
    }, 4000)
    return () => clearInterval(t)
  }, [state.data, load])
  return { ...state, reload: load }
}

function copy(text: string, onDone?: () => void): void {
  try {
    void navigator.clipboard?.writeText(text).then(() => onDone?.())
  } catch { /* ignore */ }
}

// ── 样式 ─────────────────────────────────────────────────────────────

const S = {
  wrap: { padding: '18px 20px', font: '13px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } as const,
  h1: { fontSize: '17px', fontWeight: 700, margin: '0 0 2px' } as const,
  dim: { opacity: 0.68 } as const,
  row: { display: 'flex', gap: '14px', alignItems: 'flex-start', marginTop: '14px', flexWrap: 'wrap' } as const,
  card: { border: '1px solid rgba(127,143,170,.28)', borderRadius: '12px', padding: '12px 14px', minWidth: '260px', flex: '1 1 300px', boxSizing: 'border-box' } as const,
  code: { background: 'rgba(127,143,170,.14)', padding: '2px 6px', borderRadius: '6px', fontSize: '12px', wordBreak: 'break-all' } as const,
  pill: (ok: boolean) => ({ display: 'inline-block', fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: ok ? 'rgba(52,211,153,.18)' : 'rgba(248,113,113,.18)', color: ok ? '#34d399' : '#f87171', marginLeft: '6px' }) as const,
  btn: { cursor: 'pointer', border: '1px solid rgba(127,143,170,.4)', background: 'transparent', color: 'inherit', borderRadius: '8px', padding: '5px 11px', marginRight: '6px', font: 'inherit' } as const,
  warn: { color: '#e6a23c', marginTop: '10px' } as const,
}

function Qr({ text, size = 132 }: { text: string; size?: number }): unknown {
  // 三态：null=尚未生成（占位） / ''=生成失败 / 字符串=SVG
  const [svg, setSvg] = React.useState(null as string | null)
  React.useEffect(() => { setSvg(qrSvg(text)) }, [text])
  const box = {
    width: size, height: size, flex: 'none', background: '#fff',
    borderRadius: 8, padding: 6, boxSizing: 'border-box',
  } as const
  if (svg === null) {
    return h('div', { style: { ...box, background: 'rgba(127,143,170,.15)' }, title: text })
  }
  if (svg === '') {
    return h('div', {
      style: { ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#8b96ab' },
      title: text,
    }, '二维码生成失败')
  }
  // 内联 SVG：不依赖 canvas / data: URL，任意尺寸都清晰
  return h('div', { style: box, dangerouslySetInnerHTML: { __html: svg } })
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }): unknown {
  const [done, setDone] = React.useState(false)
  return h('button', {
    type: 'button',
    style: S.btn,
    onClick: () => copy(text, () => { setDone(true); setTimeout(() => setDone(false), 1500) }),
  }, done ? '已复制 ✓' : label)
}

// ── 1. 独立主面板：手机遥控控制台 ────────────────────────────────────

function MobileConsole(): unknown {
  const { data, error, loading, reload } = usePair()
  const [showPreview, setShowPreview] = React.useState(true)
  const tunnel = data?.tunnel
  const ready = tunnel?.status === 'ready' && !!tunnel.url

  const lanCards = (data?.urls ?? []).map(u =>
    h('div', { key: u.ip, style: { ...S.card, display: 'flex', gap: 14 } },
      h(Qr, { text: u.url, key: 'qr' }),
      h('div', { key: 'info', style: { minWidth: 0, flex: 1 } },
        h('div', null, h('b', null, `局域网 · ${u.ip}`)),
        h('div', { style: S.dim }, '手机与电脑同一 WiFi 时扫这个'),
        h('div', { style: { marginTop: 6 } }, h('code', { style: S.code }, u.url)),
        h('div', { style: { marginTop: 6 } }, h(CopyButton, { text: u.url })))))

  const tunnelCard = h('div', { style: { ...S.card, display: 'flex', gap: 14 } },
    ready ? h(Qr, { key: 'qr', text: tunnel!.pairCode ? `${tunnel!.url}/mobile?pair=${tunnel!.pairCode}` : tunnel!.url! }) : null,
    h('div', { key: 'info', style: { minWidth: 0, flex: 1 } },
      h('div', null, h('b', null, '☁️ 云隧道 · 跨网可用'),
        h('span', { style: S.pill(ready) }, tunnel?.status ?? (loading ? '加载中' : '未启用'))),
      h('div', { style: S.dim }, ready
        ? '任何网络都能扫（无需装 App、无需同局域网）。地址随 DeepSeek Harness 进程生灭：关掉 Harness 后重新扫码即可。'
        : '隧道建立中；首次会下载 cloudflared（约 53MB，经官方 SHA256 校验后才采用）。'),
      ready ? h('div', { style: { marginTop: 6 } }, h('code', { style: S.code }, tunnel!.url!)) : null,
      ready ? h('div', { style: { marginTop: 6 } },
        '配对码：', h('b', { style: { fontSize: 18, letterSpacing: 3 } }, tunnel!.pairCode ?? '—'),
        h('span', { style: { ...S.dim, marginLeft: 6 } }, '（二维码已内嵌配对码；拍不到时手输）')) : null,
      ready ? h('div', { style: { marginTop: 6 } }, h(CopyButton, {
        text: tunnel!.pairCode ? `${tunnel!.url}/mobile?pair=${tunnel!.pairCode}` : tunnel!.url!,
        label: '复制连接地址',
      })) : null,
      tunnel?.lastError ? h('div', { style: S.warn }, `隧道错误：${tunnel.lastError}`) : null))

  return h('div', { style: S.wrap },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
      h('div', { key: 'title' },
        h('div', { style: S.h1 }, '📱 手机遥控'),
        h('div', { style: S.dim }, '扫码把手机接到这台电脑的 DeepSeek Harness —— 同一个 agent、同一批会话。')),
      h('div', { key: 'actions', style: { marginLeft: 'auto' } },
        h('button', { type: 'button', style: S.btn, onClick: reload }, loading ? '刷新中…' : '刷新'),
        h('button', {
          type: 'button', style: S.btn,
          onClick: () => window.open(data?.urls?.[0]?.url ?? '/mobile', '_blank'),
        }, '浏览器打开'),
        h('button', {
          type: 'button', style: S.btn,
          onClick: () => setShowPreview((v: boolean) => !v),
        }, showPreview ? '隐藏手机预览' : '显示手机预览'))),

    error ? h('div', { style: S.warn }, `读取配对信息失败：${error}`) : null,
    !data && loading ? h('div', { style: { marginTop: 14, ...S.dim } }, '正在读取本机地址与隧道状态…') : null,

    h('div', { style: S.row }, tunnelCard, ...lanCards),

    showPreview ? h('div', { style: { marginTop: 18 } },
      h('div', { style: { ...S.dim, marginBottom: 6 } }, '手机界面预览（手机打开 /mobile 看到的就是这一屏，可直接在这里点用）：'),
      h('iframe', {
        src: '/mobile',
        title: '手机端界面预览',
        style: { width: 390, height: 640, border: '1px solid rgba(127,143,170,.3)', borderRadius: 14, background: '#0b0f17' },
      })) : null)
}

/** 侧边栏图标（收 {size, active}）。 */
function MobilePanelIcon({ size = 18 }: { size?: number; active?: boolean }): unknown {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
  },
    h('rect', { key: 'body', x: 6, y: 2.5, width: 12, height: 19, rx: 3 }),
    h('line', { key: 'home', x1: 10.5, y1: 18, x2: 13.5, y2: 18 }))
}

// ── 2. 插件设置页：扫码配对卡 ────────────────────────────────────────

function SettingsQrPanel(): unknown {
  const { data, error, loading, reload } = usePair()
  const tunnel = data?.tunnel
  const ready = tunnel?.status === 'ready' && !!tunnel.url
  return h('div', { style: { font: '13px/1.6 system-ui,sans-serif', maxWidth: 620 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('b', { key: 't' }, '📱 扫码连接'),
      h('button', { key: 'r', type: 'button', style: S.btn, onClick: reload }, loading ? '刷新中…' : '刷新'),
      h('button', {
        key: 'o', type: 'button', style: S.btn,
        onClick: () => layoutRef?.selectPanel?.(PANEL_ID),
      }, '打开「手机遥控」面板')),
    h('div', { style: S.dim }, '完整控制台（二维码 + 手机界面预览）在左侧边栏的「手机遥控」面板里。'),
    error ? h('div', { style: S.warn }, error) : null,
    ready ? h('div', { style: S.row },
      h('div', { style: { ...S.card, display: 'flex', gap: 14 } },
        h(Qr, { key: 'qr', text: tunnel!.pairCode ? `${tunnel!.url}/mobile?pair=${tunnel!.pairCode}` : tunnel!.url! }),
        h('div', { key: 'info' },
          h('div', null, h('b', null, '☁️ 云隧道（跨网）')),
          h('code', { style: S.code }, tunnel!.url!),
          h('div', { style: { marginTop: 6 } }, '配对码 ', h('b', { style: { letterSpacing: 3 } }, tunnel!.pairCode ?? '—'))))) : null,
    ...(data?.urls ?? []).map(u => h('div', { key: u.ip, style: { ...S.card, display: 'flex', gap: 14, marginTop: 12 } },
      h(Qr, { key: 'qr', text: u.url, size: 110 }),
      h('div', { key: 'info' },
        h('div', null, h('b', null, `局域网 · ${u.ip}`)),
        h('code', { style: S.code }, u.url),
        h('div', { style: { marginTop: 6 } }, h(CopyButton, { text: u.url }))))))
}

// ── 3. 对话视图入口卡 ───────────────────────────────────────────────

function ConversationEntry(): unknown {
  const here = typeof location !== 'undefined' ? location.origin : ''
  return h('div', { style: { padding: 14, font: '13px/1.7 system-ui,sans-serif' } },
    h('div', null, '📱 手机远程操控：手机浏览器打开 ', h('b', null, `${here}/mobile`)),
    h('div', { style: S.dim }, '二维码 / 手机界面预览在左侧边栏「手机遥控」面板（或插件设置页）。'),
    h('button', {
      type: 'button', style: S.btn,
      onClick: () => layoutRef?.selectPanel?.(PANEL_ID),
    }, '打开手机遥控面板'))
}

// ── 注册 ─────────────────────────────────────────────────────────────

export function apply(ctx: {
  slots: { inject(slot: string, factory: unknown, tag?: string): void; register(def: unknown, comp: unknown): unknown }
  layout?: { selectPanel?: (id: string) => void }
  effect(fn: () => unknown, tag?: string): void
}): void {
  layoutRef = ctx.layout ?? null

  // 1) 独立主面板 + 侧边栏图标（id 与 main.key 必须一致）
  ctx.effect(() => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, MobileConsole), `${PLUGIN_ID}: main panel`)

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 50,
    label: () => '手机遥控',
  }, MobilePanelIcon)), `${PLUGIN_ID}: sidebar entry`)

  // 2) 插件设置页扫码卡
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PLUGIN_ID,
    label: () => '手机遥控（扫码连接）',
  }, SettingsQrPanel)), `${PLUGIN_ID}: settings qr`)

  // 3) 对话视图入口卡
  ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: `${PLUGIN_ID}-panel`,
    label: () => '手机遥控入口',
  }, ConversationEntry)), `${PLUGIN_ID}: conversation entry`)
}
