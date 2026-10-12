# DEPLOY.md — 给大模型的部署指令

> **读这份文档的是 AI Agent。** 你的任务：按下面的步骤，把 `@dsh-external/dsh-mobile-remote`（DSH 手机遥控插件）部署到用户本机的 DeepSeek Harness（下称 DSH），并把手机访问地址告诉用户。
> 原则：先探测环境再动手；每一步验证通过后才进行下一步；绝不修改 DSH 本体源码；绝不把凭据写进任何会被提交/上传的文件。

---

## 第 0 步：环境探测（在任何修改之前完成）

逐项确认并记录结果（Windows 用 PowerShell，macOS/Linux 用 bash）：

1. **DSH 是否存在、在跑**：
   - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/` → 预期 200 或 401（都说明 web 在跑）。
   - 连不上 = DSH 没装或没跑。装 DSH 不在本文范围——告知用户先安装/启动 DSH（`npx @deepseek-ai/dsh web` 或官方说明），装好后再继续。
2. **DSH_HOME 与 profile**：
   - Windows 找环境变量 `DSH_HOME`（常见 `C:\Users\<user>\.dsh` 或自定义如 `D:\dsh\data`）。
   - 找 `$DSH_HOME/profiles/` 下有哪些 profile；确定 **web profile** 目录（含 `cordis.patch.yml`、`package.json`）。记为 `<PROFILE>`。
3. **是否装有 dsh-super-injector**：看对话上下文/工具列表里有没有 `dev_inject_plugin` 等工具。
   - 有 → 部署走 **极速路径**（第 2 步 A）。
   - 无 → 走 **标准路径**（第 2 步 B）。

## 第 1 步：取得插件包（含编译产物，无需构建）

推荐下载 GitHub Release 的 tgz（免 Node 构建环境）：

```bash
# 预创建目录
mkdir -p ~/.dsh/plugins/dsh-mobile-remote   # 目录可自定；记录为 <PLUGINDIR>

# 下载 release 资产（版本号以 app/package.json 为准，latest 重定向亦可）
curl -L -o /tmp/mobile-remote.tgz \
  https://github.com/mengyunqwq/dsh-mobile-remote/releases/latest/download/dsh-external-dsh-mobile-remote-0.1.0.tgz

# 解压：<PLUGINDIR> 里应有 package.json 与 lib/index.js、lib/client.js
tar -xzf /tmp/mobile-remote.tgz -C ~/.dsh/plugins/dsh-mobile-remote --strip-components=1
```

若 latest 资产名对不上，用 `gh api repos/mengyunqwq/dsh-mobile-remote/releases/latest --jq .assets[].browser_download_url` 列出再下载。

## 第 2 步：装配进 DSH

### A. 极速路径（有 dsh-super-injector，推荐）

在你的工具里直接执行：

```
dev_inject_plugin <PLUGINDIR 的绝对路径>
```

成功标志：输出 `host ✓`。随后 `dev_plugin_status` 里出现 `@dsh-external/dsh-mobile-remote` 且状态 `active`。

### B. 标准路径（改 profile patch）

在 `<PROFILE>/cordis.patch.yml` 末尾**追加**（不要覆盖已有内容；YAML 顶层是数组）：

```yaml
- id: dsh-mobile-remote
  name: "@dsh-external/dsh-mobile-remote"
```

同时确认插件目录能被 DSH 进程 resolve：最简单是新建 junction/symlink：

```bash
# Windows (PowerShell)
New-Item -ItemType Junction -Path "<PROFILE>/node_modules/@dsh-external/dsh-mobile-remote" -Target <PLUGINDIR>
# macOS/Linux
mkdir -p "<PROFILE>/node_modules/@dsh-external"
ln -sfn <PLUGINDIR> "<PROFILE>/node_modules/@dsh-external/dsh-mobile-remote"
```

然后**重启 DSH**（这是标准路径必须的；极速路径免重启）。

## 第 3 步：验证插件已生效（未开局域网也能验证）

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/mobile
# 预期 200，且 body 里含「手机端登录」或「DSH 手机遥控」字样 ——
# 未登录状态下这是插件下发的登录引导页，路由已生效。
```

安全回归检查：`curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3080/mobile/api/ping` 必须是 **401**（没有凭据不准过）。

## 第 4 步：开启局域网/虚拟网访问（问用户要接入模式，默认建议 A 或 B）

编辑 `<PROFILE>/cordis.patch.yml`，追加两段（⚠ patch 同 id 条目**整条替换** base config，webserver 必须逐项重述，漏 required 字段会让 Web 起不来）：

```yaml
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  inject: [ webStartup ]
  config:
    host: !!js (ctx.webStartup.host === '127.0.0.1' || ctx.webStartup.host === 'localhost') ? '0.0.0.0' : ctx.webStartup.host
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024

- id: connection
  name: "@deepseek-ai/dsh-client-connection"
  inject: [ webRuntime ]
  config:
    trustedHosts: !!js [...(ctx.webRuntime.trustedHosts || []), 'dsh-tunnel:3080']
```

> 注意：YAML 顶层是 patch 数组；`dsh-tunnel:3080` 是云隧道的隔离 authority（插件会用 cloudflared `--http-host-header` 把隧道流量 Host 统一改写到它），**必须保留这一段**，跨网扫码与稳定 cookie 都依赖它。

重启 DSH 后验证：

```bash
# 局域网（把 <IP> 换成电脑内网 IP）
curl -s -o /dev/null -w '%{http_code}\n' http://<IP>:3080/mobile   # 200 或 401（引导页）都=通

# 云隧道：在桌面 GUI「插件设置 → dsh-mobile-remote」页读 ☁️ 二维码/配对码；
# 或（桌面已登录）从 Pair API 拿地址：fetch('/mobile/api/pair') → value.tunnel.url
```

## 第 5 步：交付给用户

明确告诉用户：

1. **局域网**：手机浏览器打开 `http://<电脑IP>:3080/mobile`（首次免码自动配对）
2. **跨网（云隧道 ☁️）**：在电脑 GUI「插件设置」打开 dsh-mobile-remote，手机扫 ☁️ 二维码即可；生成地址随 Harness 进程生灭——Harness 关闭后重新扫码即可
3. 手机提示输入配对码（仅拍不到二维码时）：配对码显示在同一设置页
4. `…/mobile` **等同于账号遥控权限**，云隧道地址/配对码不要片发给别人

## 故障排查（答复用户之前自己先跑一遍）

| 症状 | 检查 |
|---|---|
| 403 forbidden | Host/Origin 栅栏拦截：确认请求 Host 就是 trustedHosts 里的 IP/端口；不要用第三方代理/改写 Host |
| 页面 401 且点登录无效 | 极少见；确认 127.0.0.1 直连可用 → 说明 connection 服务正常；检查手机 Host 是否在 trustedHosts |
| 插件不出现 | 极速路径看 `dev_plugin_status`；标准路径看 DSH 启动日志里 loader 错误 |
| `session page through seq ... past cursor` | 正常防护：`page` 的 `throughSeq` 必须先用 SSE snapshot 的 `cursor` 拿到 |
| 调用 agent 的回复一直没出现 | 任务在排队/运行；A/SSE 的 `assistant-stream` 有打字流；用面板的 ■ 取消后重试 |

---

## 关于本插件的技术事实（写给你参考）

- 路由：`GET /mobile`（页面）、`GET /mobile/stream?sid=`（SSE follow）、`POST /mobile/api/{ping,sessions,create,prompt,cancel,page,search}`。
- 认证：全部复用 `ctx.connection.requestRejection`（Host/Origin 栅栏 + 签名 HttpOnly cookie）；登录兑换只在 `GET /?token=` 生效（DSH 官方机制），引导页用 `ctx.connection.authenticatedUrl` 现场生成。
- 流页面对 `sessions` 的标题来自 projections 的 `values.title`（字符串或 {text}）。
- 调试口 `/mobile/__debug`：仅 loopback + 插件 lib 目录存在 `debug.flag` 才响应，返回 `{loginUrl}`。不要把 flag 文件留在生产环境。
- 插件对 DSH 的依赖全部是 peerDependencies；旧版本 DSH（<0.1.x）不可用。
