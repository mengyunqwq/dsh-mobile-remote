#!/usr/bin/env node
/**
 * 客户端自检：在 Node 里用真 React 把 lib/client.js 注册的每个组件渲染一遍。
 *
 * 为什么需要它（2026-10-12 实测事故）：
 *   DSH 渲染器把 entry.component 直接当 React 组件用（jsx(Comp, props)）。
 *   旧脚手架的写法 `component: () => ({ render() { return document.createElement(...) } })`
 *   里 render() 返回的是**裸 DOM 节点**，不是合法 React child → 渲染抛错 →
 *   被 slot 错误边界静默吞掉 → **界面一片空白且没有任何可见报错**。
 *   这个脚本把"静默失败"变成"当场红字"，并把负向对照一起跑，证明检查有效。
 *
 * 用法：
 *   node tests/client-render-check.mjs            # 需能 require 到 react/react-dom
 *   NODE_PATH=<某个装了 react 的 node_modules> node tests/client-render-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

const fail = []
const ok = []
const check = (name, fn) => {
  try {
    const detail = fn()
    ok.push(`${name}${detail ? ' — ' + detail : ''}`)
  } catch (e) {
    fail.push(`${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── 0. 依赖与产物 ────────────────────────────────────────────────────
if (!existsSync(bundlePath)) {
  console.error(`✗ 找不到 ${bundlePath}：先构建（npm run build:client）`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
let React, renderToStaticMarkup
try {
  React = require('react')
  renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup
} catch (e) {
  console.error('✗ 需要 react / react-dom 才能自检（npm i -D react@18 react-dom@18，或用 NODE_PATH 指向已装它们的 node_modules）')
  console.error('  ' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}

// ── 1. 载入 bundle（模拟浏览器 ModuleLoader） ────────────────────────
const code = readFileSync(bundlePath, 'utf8')
let definition = null
const fakeWindow = { __ModuleLoader__: { load: (d) => { definition = d } } }

check('bundle 能被执行并注册到 __ModuleLoader__', () => {
  // 用 function 包一层：bundle 里以 window.__ModuleLoader__.load(...) 开头
  new Function('window', code)(fakeWindow)
  if (!definition) throw new Error('bundle 没有调用 window.__ModuleLoader__.load')
  if (typeof definition.factory !== 'function') throw new Error('definition.factory 不是函数')
  return `id=${definition.id}`
})

if (!definition) {
  report()
  process.exit(1)
}

let mod
check('factory(require) 能取到导出（react 走外部依赖）', () => {
  const req = (id) => {
    if (id === 'react') return React
    throw new Error(`bundle 试图 require 未预期的外部依赖：${id}`)
  }
  mod = definition.factory(req)
  if (typeof mod.apply !== 'function') throw new Error('缺少 apply 导出')
  if (!Array.isArray(mod.inject)) throw new Error('缺少 inject 导出')
  return `inject=[${mod.inject.join(', ')}]`
})

// ── 2. 注册（假 ctx，记录每次 register） ─────────────────────────────
const registrations = []
const panelsOpened = []
if (mod) {
  check('apply(假 ctx) 完成注册且不抛错', () => {
    const ctx = {
      layout: { selectPanel: (id) => panelsOpened.push(id) },
      slots: {
        inject: (slot, factory) => factory(),
        register: (opts, comp) => { registrations.push({ opts, comp }); return () => {} },
      },
      effect: (fn) => { fn(); return () => {} },
    }
    mod.apply(ctx)
    if (registrations.length === 0) throw new Error('没有注册任何 slot 条目')
    return registrations.map(r => `${r.opts.name}${r.opts.key ? '#' + r.opts.key : r.opts.id ? '#' + r.opts.id : ''}`).join(' | ')
  })
}

// ── 3. 契约检查：必需的四个界面 ──────────────────────────────────────
const byName = (n) => registrations.filter(r => r.opts.name === n)
check('注册了独立主面板 main（key=mobile-remote）', () => {
  const hit = byName('main').find(r => r.opts.key === 'mobile-remote')
  if (!hit) throw new Error('没有 main/key=mobile-remote 注册')
  return 'ok'
})
check('注册了侧边栏图标 sidebar.panellist（id=mobile-remote，与 main.key 一致）', () => {
  const hit = byName('sidebar.panellist').find(r => r.opts.id === 'mobile-remote')
  if (!hit) throw new Error('没有 sidebar.panellist/id=mobile-remote 注册')
  if (typeof hit.opts.label !== 'function' || !hit.opts.label()) throw new Error('label 缺失或为空')
  return `label=${hit.opts.label()}`
})
check('注册了插件设置页卡 plugins.bundle.config（key=包名）', () => {
  const hit = byName('plugins.bundle.config').find(r => r.opts.key === '@dsh-external/dsh-mobile-remote')
  if (!hit) throw new Error('没有 plugins.bundle.config/key=包名 注册')
  return 'ok'
})

// ── 4. 真渲染：每个组件都必须渲染出非空标记 ──────────────────────────
for (const r of registrations) {
  const label = `${r.opts.name}${r.opts.key ? '#' + r.opts.key : r.opts.id ? '#' + r.opts.id : ''}`
  check(`组件真渲染（renderToStaticMarkup）：${label}`, () => {
    if (typeof r.comp !== 'function') throw new Error(`component 不是函数（${typeof r.comp}）`)
    const markup = renderToStaticMarkup(React.createElement(r.comp, {
      size: 18, active: false, view: 'page',
    }))
    if (typeof markup !== 'string' || markup.length === 0) throw new Error('渲染结果为空')
    return `${markup.length} 字节标记`
  })
}

// ── 5. 二维码：真生成（这是"白方块"事故的守门检查） ──────────────────
check('qrSvg 真生成二维码（含 <svg> 与 <path> 模块数据）', () => {
  if (typeof mod?.qrSvg !== 'function') throw new Error('bundle 没有导出 qrSvg（无法自检二维码）')
  const urls = [
    'http://192.168.0.2:3080/mobile',
    'https://resistant-clear-unlimited-organizational.trycloudflare.com?pair=123456',
  ]
  for (const u of urls) {
    const svg = mod.qrSvg(u)
    if (!svg || !svg.includes('<svg')) throw new Error(`未生成 SVG：${u}`)
    if (!svg.includes('<path')) throw new Error(`SVG 缺少模块数据（空白二维码）：${u}`)
  }
  return `${urls.length} 个地址均生成成功`
})

check('负向对照：v1 的 qrcode-generator 用法必须失效（证明能识别 API 漂移）', () => {
  const lib = require('qrcode-generator')
  const qr = lib(0, 'L')
  qr.addData('https://example.com')
  qr.make()
  if (typeof qr.getModuleCount !== 'function') throw new Error('连 v2 的 getModuleCount 都不存在 —— 环境异常')
  if (qr.moduleCount !== undefined) throw new Error('该版本居然还有 v1 的 moduleCount —— 对照失效')
  if (typeof qr.isModule === 'function') throw new Error('该版本居然还有 v1 的 isModule —— 对照失效')
  return 'v1 用法确为 undefined（正是"白方块"的成因）'
})

// ── 6. 手机页（host 侧 HTML）：语法 + 关键能力断言 ───────────────────
// 这一节专门回答"某个功能到底做进去了没有"：直接解析产出的页面，断言能力真的在。
let pageHtml = ''
check('手机页可加载（lib/page.js → renderMobilePage）', () => {
  // Node 24 支持 require(ESM)；page.js 是同步 ESM（无顶层 await）
  const pageMod = require(join(here, '..', 'lib', 'page.js'))
  if (typeof pageMod.renderMobilePage !== 'function') throw new Error('lib/page.js 没有 renderMobilePage 导出')
  pageHtml = pageMod.renderMobilePage()
  if (!pageHtml || pageHtml.length < 500) throw new Error('页面内容异常（过短）')
  return `${pageHtml.length} 字节`
})

if (pageHtml) {
  const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(pageHtml)
  check('手机页内嵌 JS 语法可解析', () => {
    if (!scriptMatch) throw new Error('页面里找不到 <script>')
    // 语法检查：解析失败会抛 SyntaxError（拼错一个括号整页就白屏）
    new Function(scriptMatch[1])
    return `${scriptMatch[1].length} 字节 JS`
  })

  const mustHave = [
    ['浅色主题（白底黑字）', '--bg:#fff'],
    ['工作区/会话抽屉', '工作区 / 会话'],
    ['思考内容折叠块（半透明）', 'details.think'],
    ['模型切换按钮', 'id="modelBtn"'],
    ['模型来自 DSH 目录（models 接口）', "api('models'"],
    ['工作区与 DSH 同源（workspaces 接口）', "api('workspaces'"],
    ['归档过滤：抽屉列表', 'archived[s.sessionId]'],
    ['归档过滤：首屏自动打开的会话', 'if (!archived[items[i].sessionId])'],
    ['归档提示可见', '已隐藏 '],
    ['模型切换写回会话', "api('selectModel'"],
  ]
  for (const [label, needle] of mustHave) {
    check(`手机页能力：${label}`, () => {
      if (!pageHtml.includes(needle)) throw new Error(`页面里找不到：${needle}`)
      return 'ok'
    })
  }
  check('负向对照：旧的四个快捷指令按钮必须已移除', () => {
    if (pageHtml.includes('data-cmd')) throw new Error('仍存在快捷指令按钮（data-cmd）')
    return '已移除'
  })
  check('负向对照：模型输出不得走 innerHTML 注入', () => {
    // 只允许"清空容器"（box.innerHTML = ''）；其余赋值都算注入风险
    const bad = [...pageHtml.matchAll(/\.innerHTML\s*=\s*([^\n;]{0,16})/g)]
      .filter(m => m[1].trim() !== "''")
    if (bad.length > 0) throw new Error(`存在非清空的 innerHTML 赋值（${bad.length} 处）：${bad.map(m => m[1].trim()).join(' | ')}`)
    return '仅用 DOM API（innerHTML 只用于清空容器）'
  })
}

// ── 7. 负向对照：证明这个检查抓得住旧脚手架的写法 ────────────────────
check('负向对照：旧脚手架式组件必须被判为渲染失败（若这里 PASS 说明检查失效）', () => {
  // 旧脚手架的写法：函数组件返回"类实例"，其 render() 返回裸 DOM 节点。
  // React 18 会容忍"函数返回类实例"（仅告警并调用其 render()），
  // 但 render() 返回的 DOM 节点不是合法 React child → 抛错 → 被 slot 错误边界静默吞掉。
  const fake = () => ({
    render() {
      return { nodeType: 1, tagName: 'DIV', style: {}, innerHTML: '' } // 模拟 document.createElement 的产物
    },
  })
  let threw = false
  try {
    renderToStaticMarkup(React.createElement(fake, {}))
  } catch {
    threw = true
  }
  if (!threw) throw new Error('旧式组件竟然渲染成功了 —— 检查不可信')
  return '已正确捕获（裸 DOM 节点不是合法 React child）'
})

report()

function report() {
  console.log('===== dsh-mobile-remote 客户端自检 =====')
  for (const line of ok) console.log('  [PASS] ' + line)
  for (const line of fail) console.log('  [FAIL] ' + line)
  console.log(`----- ${ok.length} PASS / ${fail.length} FAIL -----`)
  if (fail.length > 0) process.exitCode = 1
}
