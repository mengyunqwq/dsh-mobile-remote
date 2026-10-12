# @dsh-external/dsh-mobile-remote

**DSH（DeepSeek Harness）手机远程遥控插件** —— 在手机浏览器里打开一个为竖屏优化的控制面板，直接连回你电脑上的 DSH：看会话、读对话流、发消息、下指令、取消运行中的任务。**与桌面 GUI 并存、共用同一套认证与安全栅栏，不改 DSH 本体。**

```
手机浏览器 ──▶ 局域网 / Tailscale 虚拟网 / 公网 HTTPS 隧道
                    │
              DSH Web Server（同一端口）
              ├─ /mobile         手机面板（单文件页，零外部依赖）
              ├─ /mobile/stream  会话事件流（SSE）
              └─ /mobile/api/*   会话列表 / 新建 / 发消息 / 取消 / 历史页
```

## 功能

- 📱 **会话列表抽屉**：全部会话（标题、运行状态、工作目录），一键切换；一键新建会话
- 💬 **实时对话流**：SSE 跟随，用户消息 / 助手回复 / 工具调用卡片 / 打字指示
- ⌨️ **发消息**（steer/queue 两种模式都能发）+ ■ **取消正在运行的任务**
- ⚡ **快捷指令栏**：「继续」「查看插件状态」「后台任务」等一键发送
- 🔐 **复用 DSH 官方认证**：Host/Origin 栅栏 + 签名 cookie，未登录会看到自动登录引导页（一次点击完成配对）
- 🧩 桌面 GUI 的对话视图里会出现「手机遥控入口」卡片（显示面板地址）

## 三种接入方式

| 模式 | 场景 | 需要做什么 |
|---|---|---|
| **A 局域网直连** | 手机与电脑同一 WiFi | 把 webserver 监听改 `0.0.0.0` + trustedHosts 加本机内网 IP（见下） |
| **B Tailscale / ZeroTier** | 跨网络、最安全（推荐） | 手机电脑都装 Tailscale，用虚拟 IP 访问；trustedHosts 加该虚拟 IP |
| **C 公网 HTTPS 隧道** | 无外网出口限制（自担风险） | cloudflared / frp + HTTPS；必须保证 trustedHosts 与认证开启 |

> 服务端不暴露任何端口给陌生人的前提下，模式 A/B 的安全等价于桌面 GUI 本身。

### 让 DSH 可被局域网/虚拟网访问（模式 A/B 共同步骤）

在 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml`（macOS/Linux 为 `~/.dsh/profiles/<profile>/`）追加两段：

```yaml
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  config:
    host: "0.0.0.0"          # 监听所有网卡

- id: connection
  name: "@deepseek-ai/dsh-client-connection"
  config:
    trustedHosts:
      - "192.168.1.23"       # 电脑的局域网/虚拟网 IP（不带端口=该 IP 任意端口）
```

改成你自己的 IP 后重启 DSH。手机访问 `http://<电脑IP>:3080/mobile`，首次会出现登录引导页，点一下就能自动完成配对（token 兑换签名 cookie，之后免登录）。

## 安装部署

### 方式一：把部署交给 AI（一键）

见 [DEPLOY.md](./DEPLOY.md) —— 专门写给大模型的逐步部署指令。你只需要对任何能操作终端的 AI Agent 说：

> 读取 https://github.com/mengyunqwq/dsh-mobile-remote/blob/main/DEPLOY.md ，按文档把 DSH 手机遥控插件部署到本机，完成后把手机访问地址告诉我。

### 方式二：手动

```bash
# 1. 下载 Release 的 tgz（含编译产物 lib/，无需本地构建）
#    https://github.com/mengyunqwq/dsh-mobile-remote/releases
curl -LO https://github.com/mengyunqwq/dsh-mobile-remote/releases/latest/download/dsh-external-dsh-mobile-remote-0.1.0.tgz

# 2. 解压到任意目录（目录里应有 package.json + lib/）
mkdir -p ~/.dsh/plugins/dsh-mobile-remote
tar -xzf dsh-external-dsh-mobile-remote-0.1.0.tgz -C ~/.dsh/plugins/dsh-mobile-remote

# 3. 装配（二选一）
#  - 装有 dsh-super-injector 的环境：让 agent 执行 dev_inject_plugin <上面目录>
#  - 标准 DSH：在 profile 的 cordis.patch.yml 加 loader entry：
#      - id: dsh-mobile-remote
#        name: "@dsh-external/dsh-mobile-remote"
#    并重启 DSH（或按你版本的 dsh plugin CLI 安装 GitHub Release）
```

> `package.json` 的 `peerDependencies` 只声明范围、不携带版本；所有依赖都在 DSH 运行环境里自带，插件本体零安装依赖。

### 方式三：从源码构建（开发）

```bash
git clone https://github.com/mengyunqwq/dsh-mobile-remote
cd dsh-mobile-remote
export DSH_CHECKOUT=/path/to/deepseek-harness   # DSH 源码 checkout（含 packages/ 与 vendor/）
bash scripts/build.sh          # host 侧：junction + tsc → lib/
npm run build:client           # client 侧：tsdown → lib/client.js
```

## 安全模型（重要）

- `/mobile*` 全部路由强制过 **DSH 官方认证**：Host/Origin 栅栏（防 DNS rebinding、防跨站）+ 签名 HttpOnly cookie；无凭据一律 401。
- **launch token 只存在于服务器进程内存**，登录引导页由服务器按请求现场生成，不落盘、不进 URL 日志。
- 手机拿到的权限 = **操作员（operator）**，等同于账号本身。**不要把 `/mobile` 地址发给别人**；部署在公网时务必走 HTTPS 隧道并保持认证开启。
- 桌面 GUI 的插件管理里可随时停用本插件，停用即所有 `/mobile*` 路由消失。
- 受控调试口：`/mobile/__debug` 仅当 ①请求来自 loopback 且 ②插件 lib 目录存在 `debug.flag` 文件时才响应（供 agent 自测用）。平时保持两个条件不满足。

## 已验证链路（本机实测记录）

- 未认证 → 401 / 登录引导页；token → cookie 兑换 ✓
- `sessions`（标题/运行状态/工作目录）✓、`create` ✓、`prompt`（accepted → agent 真实起 turn）✓、`page` ✓、SSE snapshot + 实时事件（user / assistant / tool）✓
- 热重载安全：路由全部挂 `ctx.effect`，卸载/热重载不留残路由 ✓

## License

BSD-3-Clause
