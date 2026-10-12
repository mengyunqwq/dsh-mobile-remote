/**
 * cloudflared 快速隧道管理（零配置免账号 quick tunnel）。
 *  - 二进制：优先用用户提供的 cloudflaredPath；否则自动从 GitHub Releases 下载到
 *    <插件数据目录>/bin/cloudflared(.exe)（首次一次，后续复用）。
 *  - 运行：`cloudflared tunnel --url http://127.0.0.1:<port>`，从 stdout 解析
 *    `https://<random>.trycloudflare.com`。
 *  - 生命周期：随 harness 进程生灭；进程被杀即隧道失效（= 关闭 Harness 需重新扫码）。
 *  - 安全：隧道只是搬运，认证仍走 DSH 官方 cookie（云上无凭据只有登录引导页）。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { appendFileSync, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { get } from 'node:https'

export type TunnelStatus = 'off' | 'starting' | 'ready' | 'failed' | 'disabled'

export class CloudflareTunnel {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null
  private binPath = ''
  private target = ''
  private url = ''
  private state: TunnelStatus = 'disabled'
  private logBuf: string[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private intendedStop = false
  /** 最近一次失败的可读原因（pair/health 直接可见）。 */
  lastError = ''
  /** 云端是否已确认注册（域名出现 ≠ 可用：注册前访问会 530）。 */
  private registered = false

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
  }

  get status(): TunnelStatus {
    return this.state
  }

  get publicUrl(): string {
    // 只有"云端已注册"才对外给地址：域名刚出现时访问会 530（实测 21s 窗口）
    return this.state === 'ready' && this.registered ? this.url : ''
  }

  /** 已发现但尚未注册的地址（给面板显示"注册中"用，不建议直接扫码）。 */
  get pendingUrl(): string {
    return this.url
  }

  get isRegistered(): boolean {
    return this.registered
  }

  tail(): string[] {
    return this.logBuf.slice(-6)
  }

  private log(line: string): void {
    const stamp = new Date().toISOString()
    this.logBuf.push(`[${stamp}] ${line}`)
    if (this.logBuf.length > 80) this.logBuf.splice(0, this.logBuf.length - 80)
    try { appendFileSync(this.logFile(), `[${stamp}] ${line}\n`) } catch { /* ignore */ }
  }

  private logFile(): string {
    return join(this.dataDir, 'tunnel.log')
  }

  /** 启动/确保运行。幂等；已 ready 或 starting 时直接返回当前 url。 */
  async ensure(target: string, explicitBinPath = ''): Promise<{ url: string; state: TunnelStatus }> {
    if (this.state === 'ready' || this.state === 'starting') return { url: this.publicUrl, state: this.state }
    this.target = target
    this.state = 'starting'
    this.lastError = ''
    try {
      this.binPath = explicitBinPath || this.binPath || await this.ensureBinary()
    } catch (e) {
      this.state = 'failed'
      this.lastError = 'binary bootstrap failed: ' + String(e instanceof Error ? e.message : e)
      this.log(this.lastError)
      return { url: '', state: this.state }
    }
    if (!existsSync(this.binPath)) {
      this.state = 'failed'
      this.lastError = 'cloudflared binary missing at ' + this.binPath
      this.log(this.lastError)
      return { url: '', state: this.state }
    }
    this.launch()
    // 最多等 60s 到"云端已注册"（域名出现后还要 ~20s 才注册，之前会 530）
    const url = await new Promise<string>(resolve => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (this.url && this.registered) { clearInterval(timer); resolve(this.url); return }
        if (this.state === 'failed' || Date.now() - started > 60_000) { clearInterval(timer); resolve('') }
      }, 500)
    })
    if (url && this.state === 'starting') this.state = 'ready'
    if (!url && !this.proc) {
      // 进程已死且没有 URL：把可读原因补上（进程失败路径已在 exit/error 里记录）
      if (!this.lastError) this.lastError = 'cloudflared 进程未能启动或立即退出'
      this.log('ensure gave up without url (state=' + this.state + ')')
    }
    this.log(url
      ? `tunnel ready: ${this.url}`
      : `tunnel not ready yet (state=${this.state}, url=${this.url || '-'}, registered=${this.registered}${this.lastError ? ', err=' + this.lastError : ''})`)
    return { url: this.publicUrl, state: this.state }
  }

  stop(): void {
    this.intendedStop = true
    this.state = 'disabled'
    this.url = ''
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    try { this.proc?.kill() } catch { /* ignore */ }
    this.proc = null
  }

  /** 用户改配置热更：重启到新 target */
  async retarget(target: string): Promise<void> {
    const same = this.target === target
    if (same && (this.state === 'ready' || this.state === 'starting')) return
    this.stop()
    this.intendedStop = false
    this.state = 'starting'
    this.target = target
    this.launch()
  }

  private launch(): void {
    this.url = ''
    this.registered = false
    this.intendedStop = false
    if (this.proc) return
    // Host 统一改写到隔离 authority（dsh-tunnel:3080）：
    //  - fence 有该域在 trustedHosts（profile patch 静态授予）→ 隧道请求可过栅栏
    //  - cookie authority 稳定 → 隧道换域名 cookie 不失效
    //  - 区分"来自隧道"（配对码门）与局域网/本机访问
    const hostRewrite = 'dsh-tunnel:3080'
    this.log(`launching: cloudflared tunnel --url ${this.target} --http-host-header ${hostRewrite}`)
    const proc = spawn(this.binPath, ['tunnel', '--url', this.target, '--http-host-header', hostRewrite, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc = proc
    const feed = (buf: string): void => {
      for (const line of buf.split(/\r?\n/)) {
        if (!line.trim()) continue
        if (line.length > 300) continue
        // ① 云端确认注册 → 才算真的可用（此前访问会 530）
        if (/Registered tunnel connection/i.test(line)) {
          this.registered = true
          if (this.state === 'starting') this.state = 'ready'
          this.log('tunnel registered (可用): ' + this.url)
          continue
        }
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line)
        if (m) {
          this.url = m[0]
          // 只发现域名还不够：保持 starting，等 Registered tunnel connection
          this.log('tunnel url discovered (等待注册): ' + this.url)
          continue
        }
        // 只记录非噪音行
        if (/error|fail|retry|failover|connect|serv/i.test(line)) {
          this.log(line.slice(0, 200))
          if (/failed|退出|exit/i.test(line) && !this.url) this.state = 'failed'
        }
      }
    }
    proc.stdout.on('data', (d: Buffer) => feed(d.toString('utf8')))
    proc.stderr.on('data', (d: Buffer) => feed(d.toString('utf8')))
    proc.on('exit', (code) => {
      this.proc = null
      if (this.intendedStop) return
      this.log(`cloudflared exited (code=${code})`)
      if (this.state !== 'disabled') {
        this.state = 'failed'
        this.lastError = `cloudflared 进程退出（code=${code}）`
        // 简单自愈：8s 后拉起（配合外层调用者决定是否续命）
        this.restartTimer = setTimeout(() => {
          if (this.intendedStop || this.state === 'disabled') return
          this.url = ''
          this.state = 'starting'
          this.launch()
        }, 8000)
      }
    })
    proc.on('error', (e) => {
      this.log('spawn error: ' + String(e))
      this.state = 'failed'
      this.lastError = 'spawn error: ' + String(e)
    })
  }

  private binDir(): string {
    return join(this.dataDir, 'bin')
  }

  private async ensureBinary(): Promise<string> {
    const ext = process.platform === 'win32' ? '.exe' : ''
    const path = join(this.binDir(), `cloudflared${ext}`)
    if (existsSync(path)) return path
    this.log('downloading cloudflared from GitHub Releases …')
    mkdirSync(this.binDir(), { recursive: true })
    const url = await this.latestBinaryUrl()
    this.log('download url: ' + url)
    try {
      await download(url, path)
    } catch (e) {
      this.log('node download failed (' + String(e instanceof Error ? e.message : e) + '), falling back to system curl')
      await downloadViaCurl(url, path)
    }
    this.log('downloaded → ' + path)
    return path
  }

  private async latestBinaryUrl(): Promise<string> {
    // 官方下载端点稳定且免鉴权：latest 直链
    if (process.platform === 'win32') {
      return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    }
    if (process.platform === 'darwin') {
      return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz'
    }
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
  }
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    let hops = 0
    const go = (u: string): void => {
      if (hops > 6) { file.close(); reject(new Error('too many redirects')); return }
      const req = get(u, res => {
        if ((res.statusCode ?? 500) >= 300 && res.headers.location) {
          hops += 1
          res.resume()
          go(res.headers.location)
          return
        }
        if ((res.statusCode ?? 500) !== 200) {
          file.close()
          reject(new Error(`download http ${res.statusCode}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(err => err ? reject(err) : resolve()))
      })
      req.on('error', e => { file.close(); reject(e) })
    }
    go(url)
  })
}

function downloadViaCurl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 系统 curl：证书校验走 OS 信任库（带内/企业代理环境更稳）；失败即失败，不做危险放宽
    const cmd = process.platform === 'win32' ? 'curl.exe' : 'curl'
    const proc = spawn(cmd, ['-fL', '--retry', '2', '--connect-timeout', '30', '-o', dest, url], {
      stdio: 'ignore',
      windowsHide: true,
    })
    proc.on('exit', code => {
      if (code === 0 && existsSync(dest)) resolve()
      else reject(new Error(`curl download failed (exit ${code})`))
    })
    proc.on('error', e => reject(e))
  })
}

