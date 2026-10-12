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

编辑 `<PROFILE>/cordis.patch.yml`，追加两段（IP 先用 `ipconfig`/`ip addr` 查用户当前内网 IP，或询问用户）：

```yaml
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  config:
    host: "0.0.0.0"

- id: connection
  name: "@deepseek-ai/dsh-client-connection"
  config:
    trustedHosts:
      - "<电脑的内网or虚拟网IP>"    # 不带端口 = 该 IP 任意端口
```

> 注意：YAML 顶层是 patch 数组；每段是独立列表元素。若已有同 id 条目，并入其 `config`，不要重复 id。
> 模式 B（Tailscale）时 trustedHosts 填 Tailscale 虚拟 IP（100.x.y.z）即可，附建议安装 Tailscale。

重启 DSH 后验证（把 `<电脑IP>` 换成上面那个 IP）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<电脑IP>:3080/mobile   # 预期 200
```

## 第 5 步：交付给用户

明确告诉用户：

1. **手机地址**：`http://<电脑IP>:3080/mobile`
2. 首次打开会出现「手机端登录」引导页 → 点链接即自动配对，随后免登录。
3. 手机与电脑必须同局域网（或已组 Tailscale）。跨网建议模式 B。
4. `http://<电脑IP>:3080/mobile` **等同于账号遥控权限**，不要分享给他人。

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
