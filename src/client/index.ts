/**
 * @dsh-external/dsh-mobile-remote — client 面板（conversation.view slot）。
 * 桌面 GUI 里显示手机端入口与登录链接（含 LAN 地址提示）。
 * ⚠️ 必坑（2026-08 实测）：apply 用 ctx.slots 必须 export const inject = ['slots']；
 * register 必须带 name 字段（= slot 名，如 conversation.view）。
 */
/** 与 dsh-client-ui-slots 运行时形状松耦合的最小面（导出名随版本会变，只用方法）。 */
type SlotsLike = {
  inject(slot: string, factory: unknown, tag?: string): void
  register(def: unknown): unknown
}

type ClientContext = {
  slots: SlotsLike
  effect(fn: () => unknown, tag?: string): void
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/dsh-mobile-remote-panel',
      label: () => '手机遥控入口',
      component: () => ({
        render() {
          const el = document.createElement('div')
          el.style.padding = '14px'
          el.style.fontFamily = 'system-ui, sans-serif'
          el.style.fontSize = '13px'
          el.style.lineHeight = '1.7'
          const here = new URL(location.href)
          const base = `${here.protocol}//${here.host}/mobile`
          el.innerHTML = `
            <div style="font-weight:700;font-size:14px;margin-bottom:6px">📱 手机远程操控</div>
            <div style="color:#89f">手机浏览器打开：<b>${base}</b></div>
            <div style="color:#abc;margin:6px 0">
              手机与本机需同网络（局域网）或已组虚拟网（Tailscale 等）。
              首次访问会出现「登录」引导页，点一下即可兑换浏览器 cookie。
            </div>
            <a href="${base}" target="_blank" style="display:inline-block;background:#2563eb;color:#fff;padding:8px 14px;border-radius:9px;text-decoration:none">打开手机面板</a>
          `
          return el
        },
      }),
    }),
  ), '@dsh-external/dsh-mobile-remote: panel')
}
