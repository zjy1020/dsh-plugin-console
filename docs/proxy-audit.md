# 代理延迟测试（proxy.ts）实现审计

审计对象：`src/main/engine/proxy.ts`（唯一被修改的源码文件）
被测现象：本机代理 `http://127.0.0.1:65535`，UI 点「延迟」按钮 → 约 1.8~2.1 秒后显示 `1820 ms`
审计方式：**只读**通读调用链文件 + 用 node v24 的 TS type-stripping 直接加载未编译的 `proxy.ts` 做真机/假代理端到端实测（不启动 Electron、不跑构建、不 commit）
审计时间：2026-11-02

---

## 0. 结论摘要

**一句话：这个「1820 ms」数字本身没量错，量错的是口径 —— 它把「本机 → 代理 hop」和「代理 → Cloudflare → npm registry 跨境一截」混在了一起；真正报给用户的 `latencyMs` 应当只是代理 hop（同机实测 **1~26 ms**）。另外旧实现在成功路径上无条件并行打了一条**绕过代理的直连请求**，并且在**判定上「拿到任何 HTTP 状态行就算通」**，会把代理返回的 403/407/502 登录页/网关错误一律报成「通」。**

| # | 问题 | 严重度 | 是否已修（在 proxy.ts 内） |
|---|------|--------|-----------------------------|
| 1 | `latencyMs` 口径错误：混入 DNS/上游拨号/TLS 握手/HTTPS 往返，把跨境 RTT 报成「代理延迟」（1820 ms 中约 1300 ms 是 TLS、280~440 ms 是 HTTPS 首包，代理 hop 只占 2~26 ms） | **P0** | ✅ 已修（`hopMs` 定格在 CONNECT 应答到手时） |
| 2 | 判定「拿到合法状态行就算通」：407/403/5xx/HTML 登录页全部被报成「通」 | **P0** | ✅ 已修（`isReachableStatus()` 白名单） |
| 3 | 成功路径上无条件并行发起**直连请求**（`probeDirect()`）：用户设了代理，后台仍有一条不经过代理的裸流量 | **P1** | ✅ 已修（改为懒执行 + 有预算，仅失败诊断时用） |
| 4 | 失败路径被「等直连对照」拖时间：`65534`（代理没在跑）实际 0 ms 就 ECONNREFUSED，却要 **1080 ms** 才报错 | **P1** | ✅ 已修（原因明确的错误直接返回，实测 1~2 ms） |
| 5 | 用户填的 `user:pass@` 被 `splitProxy` 直接丢弃，带认证的代理**必然**误报 407 | **P1** | ✅ 已修（新增 `auth` 回传 + `Proxy-Authorization`，假代理实测凭据真的发出去了） |
| 6 | CONNECT 非 200 时 `status` 恒为 `null`，UI 拿不到状态码 | **P2** | ✅ 已修（回填 `status`） |
| 7 | 裸 IPv6 无端口地址被拆错：`::1` → `host=':'`、`port=1` | **P2** | ✅ 已修（`isIpv6Literal()` + 补方括号） |
| 8 | 带空格/控制字符的垃圾地址被丢给 DNS，报「域名解析失败」这种看不懂的话 | **P2** | ✅ 已修（提前判空字符，文案指导用户改 host） |
| 9 | `DEFAULT_PORTS` 里有重复/拼错键 `socks4a_` | **P2** | ✅ 已修（清理） |
| 10 | **`net.ts` 的静默直连回落**：`httpJson()` 在 `net.fetch`（走 session 代理）失败时改走 `httpsJson` 直连，且把直连结果当成功返回 | **P0** | ❌ **未修（不在本次写范围内，已上报主控）** |
| — | 「`[::1]` 带方括号连不上」的怀疑 | — | ❌ **不改**：Node 24 实测 `net.connect({host:'[::1]'})` 能连上，见 §2.6 |

判定口径一句话：**`ok` = 代理 hop 通 + 隧道内 TLS 通 + 目标端点给了「可达」语义的状态码；`latencyMs` = 纯代理 hop。**

---

## 1. 调用链（UI 按钮 → socket）

| 步骤 | 位置 | 说明 |
|------|------|------|
| 1 | `src/renderer/src/components/SidebarShell.tsx:488-497` | 侧栏「测」按钮，`onClick={() => void testProxy()}`，`disabled={testing}` |
| 2 | `src/renderer/src/components/SidebarShell.tsx:224-238` | `const r = await api().proxyTest(settings.proxy)`；`setLatency(r.ok ? { ms: r.latencyMs, error: null } : { ms: null, error: r.error })` |
| 3 | `src/renderer/src/components/SidebarShell.tsx:473-486` | 读数渲染：`latency.ms !== null` → `1820 ms`；否则 `延迟 未测` / `延迟 测试中` / `延迟 —`（`error` 走 `title`） |
| 4 | `src/preload/index.ts:80` | `proxyTest: (input) => ipcRenderer.invoke(CH.proxyTest, input) as Promise<ProxyTestResult>` |
| 5 | `src/shared/ipc.ts:59` / `:138` | 通道 `proxyTest: 'api:proxy-test'` + 类型声明 |
| 6 | `src/main/ipc.ts:165` | `ipcMain.handle(CH.proxyTest, async (_e, input: string) => proxy.testProxy(input))` |
| 7 | `src/main/engine/proxy.ts:417` | `export function testProxy(input: string): Promise<ProxyTestResult>` |
| 8 | `src/main/engine/proxy.ts:418-463` | 归一化 → `splitProxy` → 协议白名单 → host 空格检查（全部同步返回，不联网） |
| 9 | `src/main/engine/proxy.ts:536-556` | `httpRequest({ host: proxyHost, port: proxyPort, method: 'CONNECT', path: 'registry.npmjs.org:443' })` —— **手写 CONNECT，socket 直连代理端口** |
| 10 | `src/main/engine/proxy.ts:568-587` | `on('connect')`：非 200 → `destroy()` + 明确错误（回填 `status`） |
| 11 | `src/main/engine/proxy.ts:589-666` | 200 → `tlsConnect({ socket, servername: TARGET_HOST })` **复用同一条 socket** → `secureConnect` 后写 `GET /dsh-plugin-console-ping` |
| 12 | `src/main/engine/proxy.ts:668-690` | 收到完整响应头 → `isReachableStatus(status)` 判定 → `finish({ ok, latencyMs: hopMs, status })` |
| 13 | `src/shared/types.ts:359-366` | 契约 `ProxyTestResult { ok, target, latencyMs, status, error }`（**只有 5 个字段，未加字段**） |

补充：`src/renderer/src/components/SettingsDialog.tsx:82-99` 与 `:287-312` 是设置面板里的第二个调用点（`✓ 通了 · {latencyMs} ms` + `HTTP {status}`），与侧栏共用同一 handler。

**只有 `src/main/ipc.ts` 引用本文件**（grep 全仓确认），没有第二个调用方。

---

## 2. 六个问题的逐条回答

### 2.1 它到底有没有真的走代理？有没有静默回落直连？

**在 `proxy.ts` 内部：真的走代理，没有回落直连。**

依据（行号为改动后文件）：

```ts
// proxy.ts:536-556（节选）
const connectReq = httpRequest(
  {
    host: proxyHost,          // ← splitProxy 解析出的代理地址，不是目标站点
    port: proxyPort,
    method: 'CONNECT',
    path: `${TARGET_HOST}:${TARGET_PORT}`,
    headers: { 'Proxy-Connection': 'keep-alive', 'User-Agent': USER_AGENT }
  },
  ...
)
```

- 用 `node:http` 的 `http.request` 直连**代理端口**，发 `CONNECT registry.npmjs.org:443`；没有 `global-agent`、没有 `session.defaultSession`、没有 `Proxy-Agent` 之类中间层 → 是**手写隧道**。
- 隧道里的 TLS 用 `tlsConnect({ socket, servername: TARGET_HOST })`（proxy.ts:589-`secureConnect`）复用**同一条** socket → 隧道内的字节只可能走代理。
- `testProxy` 内**没有任何**把请求改写成「直连目标站点」的分支。唯一的直连代码是 `probeDirect()`（proxy.ts:339），它返回 `{ok:boolean}`，**只被用来拼一句 error 文案**（proxy.ts:510-528）。

**但旧实现确实有一条「绕过代理」的流量**：改动前 `testProxy` 第一行就 `const direct = probeDirect()`（旧 337），**无条件并行发起**，成功也在跑。工程师视角它是「诊断对照」，用户视角就是「我设了代理，这软件还是打了一条不走代理的请求出去」。已改为懒执行，见 §3。

**真正的静默回落不在本文件**（P0，报告但不改）：

```ts
// src/main/engine/net.ts:200-241（httpJson 节选）
try {
  const res = await net.fetch(url, { headers, ... })   // 继承 session 代理
  ...
} catch {
  const fallback = await httpsJson<T>(url, headers, timeoutMs)  // net.ts:147-198，node:https 直连兜底（不走代理）
  if (fallback.ok) return fallback                                // net.ts:233 ← 调用方拿到 ok:true，完全不知道裸奔了
  throw ...
}
```

`net.ts:83-104` 的 `applyProxy()` 还有一处静默吞异常：`session.defaultSession.setProxy({ proxyRules: want }).catch(() => undefined)`（net.ts:89-91）—— 代理设置失败时用户无感知。

### 2.2 `latencyMs` 量的是哪一段时间？1820 ms 是真的慢还是量错了？

**旧口径**：`startedAt = Date.now()` 在**发出 CONNECT 之前**（旧 proxy.ts:330），`finish({ latencyMs: Date.now() - startedAt })` 在**收到 HTTP 响应头**时（旧 494-499）。所以覆盖：TCP 建连 → CONNECT 应答 → **TLS 握手** → 隧道内 HTTPS GET 的**首包**。

**同机分段实测（目标 `127.0.0.1:65535` → `registry.npmjs.org:443`，5 次）**：

| 分段 | 耗时 |
|------|------|
| TCP 连到代理 | 1~12 ms |
| CONNECT 应答到手 | 2~16 ms |
| TLS 握手（隧道内） | **1226~1339 ms** |
| HTTPS 首包（`GET /dsh-plugin-console-ping`） | 276~466 ms |
| 合计 | **1510~1787 ms** |

与主控量到的 `1820/1824` 同一量级，也与旧实现直跑实测 `1913 / 1768 / 1782` 吻合。

**结论：数字是真慢，但语义是错的。**
- 计时起点没写错，也没有把固定 `setTimeout`、重试、DNS 缓存之类算进去（UI 的 1.8~2.1 s 与返回值同量级，正好说明没有额外延迟混进来）。
- 1.8 s 里 **约 1.3 s 是 TLS 握手**。原因看 §2.3 的伪主机实验：这条代理（Clash 系行为）在**收到 CONNECT 就立刻回 200**（伪主机也是 2 ms 回 200），真正的上游拨号发生在之后 —— 所以 TLS 阶段的 1.3 s 里，**大部分是代理去拨 registry.npmjs.org 的时间**，不是加密运算。
- 因此对 `127.0.0.1` 上的本地代理来说，**1.8 s 作为「代理延迟」是荒谬的**（同机 hop 只有 2 ms），作为「到 npm registry 的端到端可用性」才是正常的。

**改法**：`hopMs` 在 CONNECT 应答到手那一刻定格（proxy.ts:565 `hopMs = Math.round(Date.now() - startedAt)`），`latencyMs` 只报 hop（proxy.ts:687 `latencyMs: hopMs ?? ...`）。隧道内 TLS + HTTP 依旧走完（活性验证不能省），所以 **UI 按钮的 wall time 仍是 ~1.7 s，但显示的数字变成个位数 ms**。

### 2.3 测试目标是什么？为什么是它？1.8 s 是目标造成的吗？

```ts
// proxy.ts:35-38
const TARGET_HOST = 'registry.npmjs.org'
const TARGET_PORT = 443
const PING_PATH = '/dsh-plugin-console-ping'
```

选它的理由写在文件头注释里：这是 pnpm / npm 实际走的域名，代表用户装插件时真正要经过的路径。`PING_PATH` 是一个**刻意不存在**的路径，用来拿一个稳定 404。

**是目标造成的，不是测量造成的。** 同一条代理打不同目标的实测对照：

| 目标 | tcp | CONNECT | TLS | HTTP 首包 | 总计 | 状态 |
|------|-----|---------|-----|-----------|------|------|
| `www.baidu.com:443`（境内） | 2 ms | 3 ms | 159 ms | 27 ms | **189 ms** | 200 |
| `registry.npmmirror.com:443`（境内镜像） | 1 ms | 2 ms | 177 ms | 115 ms | **294 ms** | 404 |
| `registry.npmjs.org:443`（境外 Cloudflare） | 10 ms | 12 ms | 1385 ms | 437 ms | **1834 ms** | 404 |

境外目标 + `TLSv1.2`（实测 `version: "TLSv1.2"`、`alpn: false`，意味着 TLS 要多跑一轮）→ 1.8 s 完全合理。

**目标本身我没有改。** 理由：既然 `latencyMs` 已改成「只报 hop」，境外/境内目标都不再影响那个数字；而换成境内目标属于额外变更（会改变「这条链路能不能装插件」的语义），需要主控决定。

顺带一个反向证据（说明整体超时为什么不能省）：`registry.npmjs.org:444`（黑洞端口）在一个**没有超时**的探针脚本里跑到了 **61210 ms** 才 ECONNRESET。

### 2.4 「404 就算通」合不合理？

**思路是对的，边界太宽。**

旧判定原文（旧 proxy.ts:494-499 的 `finish` 调用处）：

```ts
const status = statusOf(head)
if (status !== null) {
  finish({ ok: true, latencyMs: Date.now() - startedAt, status, error: null })
}
```

即：**只要在隧道里拿到一个格式合法的 `HTTP/x.y NNN` 状态行，就算通**。文件头注释也写着「这条路径钉死在 404，但 404 恰好证明隧道 + TLS 都活着」——这句话本身没错：**404 必须算通**（它是本探针的预期答案）。

**但它会漏报这些情况**（全部是「代理在线、但用户拿不到目标站点」）：

| 隧道内状态 | 实际含义 | 旧实现 | 现在 |
|-----------|---------|--------|------|
| `407` | 代理需求认证（credentials 被丢，见 §2.5） | 报「通」❌ | 「代理需要认证…带上 user:pass@」 |
| `403` | 代理/网关拦截（策略、地域、套餐限制） | 报「通」❌ | 「隧道通了，但请求被拦了」 |
| `5xx`（502/503/504） | 代理自己生成的网关错误（连不到上游） | 报「通」❌ | 「上游返回 HTTP 502（代理连不到目标站点）」 |
| `200` + HTML 登录页 | 企业代理/母亲门户（captive portal） | 报「通」❌ | 仍报「通」（见下） |

**已采用的判据**：

```ts
// proxy.ts:58-67
function isReachableStatus(status: number): boolean {
  if (status === 403 || status === 407) return false   // 被拦 / 要认证
  if (status >= 500 && status <= 599) return false     // 网关错误：代理自己没能连上目标
  return true                                          // 2xx/3xx/4xx（含预期的 404）= 隧道与 TLS 都活着
}
```

单测覆盖：`200/204/301/404/400/401/451 → true`；`403/407/500/502/503/504 → false`。

**明确不修的一类**：TLS-MITM 型代理对任意域名回 `200` + 一段 HTML。此时状态码语义上确实「可达」，靠状态码分不出来，要额外解析响应体特征才行——那会给一个**只做连通性测试**的函数引入内容判定和额外读取，得不偿失（且真目标的 `200` 也是合法的）。已知边界，写在这里备查。

### 2.5 超时与错误路径

| 检查项 | 旧实现 | 现在 |
|--------|--------|------|
| 整体超时 | 有：全局 `setTimeout(TIMEOUT_MS)`（旧 382-384），哑代理实测 **8008 ms** 返回，不挂死 | 有，且改为 `deadline` 基准（proxy.ts:467/533），实测 **8015 ms** 返回 |
| `ECONNREFUSED` | 覆盖，文案 `连不上 127.0.0.1:65534，代理没在跑？` | 覆盖；额外**不再做直连对照** → 报错从 1080 ms 提速到 **1~2 ms** |
| `ETIMEDOUT` | 覆盖 → `连接超时（8 秒）` | 覆盖（proxy.ts:307） |
| `ENOTFOUND` | 覆盖，但文案是笼统的「域名解析失败」 | 覆盖，改为 `解析不了代理域名（${host}）`，直接指出是**代理**的域名 |
| `EAI_AGAIN` | 覆盖，文案无 host | 覆盖，带 host |
| 代理返回非 200 CONNECT | 有错误，但 **`status` 恒为 `null`** | 回填 `status`；407 分「没填凭据 / 凭据错」两种文案 |
| TLS 阶段错误 | 有（旧 502-509） | 有（proxy.ts:700-711），`ECONNRESET` → `代理把连接断掉了（ECONNRESET）` |
| socket 提前关闭 | 有（旧 511-519）`隧道建立后代理提前关闭了连接` | 有（proxy.ts:710） |
| `AbortController` / `req.setTimeout` | **没用** | **仍然没用，判定为正确** |

关于最后一行为什么不算缺陷：整体 `deadline` + `settled` 守卫 + 每条错误路径都 `destroy()`，已经覆盖了「不挂死 + 不泄漏句柄」两个目标；再叠一层 `AbortController` 只会增加两条互相竞争的取消源（谁能赢取决于事件顺序），反而更难推理。实测进程能自然退出、无悬挂句柄。

**「错误吞掉」的判定**：`proxy.ts` 内没有吞错误 —— `probeDirect` 的 `catch` 只影响它自己那句诊断（且它的结论**只进文案，不进 `ok`**）。旧的吞错误点在 `net.ts:89-91`（`.catch(() => undefined)`）与 `net.ts:232-233`（直连兜底当成功），见 §2.1。

错误文案现在是中文 + 可操作：`代理需要认证（HTTP 407），在地址里带上 user:pass@ 再试`、`代理地址里有空格或不可见字符，检查一下 host`、`只支持 http/https 代理（识别到的协议：socks5）`。

### 2.6 IPv6：`127.0.0.1` / `::1` / `localhost` 归一化，以及解析失败分支

**先说一个「看起来怪但其实是对的」的地方：`[::1]` 保留了方括号，我没有去掉。**

实测（本机 `net.createServer` 监听 `::1:64111`）：
- `net.connect({ host: '::1' })` → CONNECTED
- `net.connect({ host: '[::1]' })` → **同样 CONNECTED**

Node 24 能接受带方括号的 IPv6 字面量，所以旧代码把 `[::1]` 原样传给 `host` 不会误报，**不是 bug**，不改。（这也是为什么 `http.request({host:'[::1]'})` 一直能工作。）

**真 bug 是「裸 IPv6 无端口」**：旧 `normalizeProxy` 把 `::1` 按 `host:port` 拆 → `host=':'`、`port='1'` → `http://:1`。已修（proxy.ts:153-172 + `isIpv6Literal()` proxy.ts:190）：只在「多冒号且全部字符属于 `[0-9a-fA-F:.]`」时才补方括号，避免把 `not a url::` 这种垃圾输入也括号化。实测：

| 输入 | 归一化结果 |
|------|-----------|
| `65535` / `:65535` / `127.0.0.1:65535` | `http://127.0.0.1:65535` |
| `[::1]:8080` | `http://[::1]:8080` |
| `::1` | `http://[::1]:80` |
| `::1:65535` | `http://[::1]:65535` |
| `2001:db8::1` | `http://[2001:db8::1]:80` |
| `fe80::1:8080` | `http://[fe80::1]:8080` |
| `http://not a url::` | `http://not a url::80`（不括号化，交给空格检查） |
| `socks5://127.0.0.1` | `socks5://127.0.0.1:1080` |
| `https://h` | `https://h:443` |

**「URL 解析失败」走哪条分支**：本模块**不使用 `new URL()`**（它会把垃圾输入静默改写成奇怪的东西），用的是正则 `splitProxy()`（proxy.ts:208-249）。失败分支：

1. 空字符串 → `代理地址是空的`（proxy.ts:420-428）
2. `splitProxy` 返回 `null` → `代理地址无法解析，检查一下 host / port`（proxy.ts:430-439）
3. scheme 不是 http/https → `只支持 http/https 代理（识别到的协议：socks5）`（proxy.ts:441-449）
4. host 含空白/控制字符 → `代理地址里有空格或不可见字符，检查一下 host`（proxy.ts:454-463）

旧实现在第 4 种输入上报的是 `域名解析失败`（把 `not a url` 丢给 DNS 之后的结论），现已提前拦下。

---

## 3. 已修改内容（`src/main/engine/proxy.ts`，533 行 → 728 行）

只修客观错误，没有为了好看改数字，没有引入新依赖，**没有改动 `ProxyTestResult` 的字段（types.ts 不在写范围内）**。

| 位置（改后行号） | 关键改动 | 为什么 |
|-----------------|---------|--------|
| `proxy.ts:1-30` 文件头 | 新增第三条硬约束：「任何分支都不允许在代理失败时静默改走直连」，并写明测速口径是分段报 hop | 旧注释只说「不碰 Electron session 代理」，没把「不许回落直连」写死；口径也要留档 |
| `proxy.ts:41-44` | 新增常量 `DIRECT_BUDGET_MS = 2500`、`MIN_DIRECT_BUDGET_MS = 300` | 直连诊断必须有预算上限，否则报错时间不可控 |
| `proxy.ts:58-67` | `isReachableStatus()` + `export { isReachableStatus }` | 用白名单替代「有状态行就算通」；导出仅为可测试性（已注释） |
| `proxy.ts:70-79` | `DEFAULT_PORTS` 删掉重复/拼错键 `socks4a_` | 脏数据，清理 |
| `proxy.ts:105-172,190` | 裸 IPv6 补方括号 + `isIpv6Literal()` | 修 `::1` → `http://:1` 的错拆，同时不误伤垃圾输入 |
| `proxy.ts:200-249` | `splitProxy` 返回值加 `auth`（原始 userinfo，不再丢弃） | 认证代理之前必然误报 407，凭据都没发出去 |
| `proxy.ts:251-268` | `proxyAuthHeader()`：`decodeURIComponent` + Basic base64 | 地址里 URL 编码的账号密码（`u%40x:p%3A1`）要能还原 |
| `proxy.ts:282-296` | `isAmbiguous(err)`：说清原因的错（ECONNREFUSED/ENOTFOUND/CONNECT 被拒）不再做直连对照 | 这才是 `65534` 报错要等 1080 ms 的根因 |
| `proxy.ts:301-320` | `explain()` 的 `ENOTFOUND` / `EAI_AGAIN` 文案带 host | 「域名解析失败」分不清是代理域名还是目标域名 |
| `proxy.ts:326-388` | `probeDirect(budgetMs)` 改为**懒执行 + 带预算** | 消除成功路径上的裸直连流量 + 控制失败路径总时长 |
| `proxy.ts:392-399` | `ProbeOutcome` 加 `needDirect` 字段 | 让「要不要补诊断」成为显式决策，而不是无条件动作 |
| `proxy.ts:417-467` | `testProxy` 加文档注释、`deadline` 基准、host 空格检查 | 明确契约；`deadline` 让所有后续等待共享同一预算 |
| `proxy.ts:473,565,687` | `hopMs` 在 CONNECT 应答到手时定格，`latencyMs` 改报它 | **核心修复**：1820 ms → 1~26 ms，语义变成真正的代理延迟 |
| `proxy.ts:504-528` | 失败时先判 `needDirect`，剩余预算不足 300 ms 就跳过诊断；直连结论只进 error 文案 | 报错提速 + 总时长仍封顶 8 s |
| `proxy.ts:533` | 全局超时文案 `连接超时（8 秒）` | 保留原行为（本来是对的） |
| `proxy.ts:542-543` | 有凭据时加 `Proxy-Authorization` 头 | 真发凭据（假代理实测 CONNECT 200） |
| `proxy.ts:568-587` | CONNECT 非 200：回填 `status`；407 分「没凭据 / 凭据错」两种文案 | 状态码要能到 UI；文案要能指导下一步动作 |
| `proxy.ts:668-681` | 用 `isReachableStatus` 判定，并按类型给具体原因 | 见 §2.4 |
| `proxy.ts:610,633,650,662,700,711,722` | 各错误路径显式给出 `needDirect` | 决策可见、可审 |

**回归验证（全部通过）**

- `& $node "node_modules/typescript/bin/tsc" --noEmit -p tsconfig.node.json` → **exit 0**（改动前后各验一次，均 0）
- 真代理 `65535`：`{ok:true, latencyMs:2, status:404}`（另一次 26）
- 代理没在跑 `65534`：wall **1~2 ms**（旧 1080 ms），文案不变且正确
- 认证代理（无凭据 / 错凭据 / 对凭据）：4~17 ms / 2 ms / CONNECT **200**（凭据确实发出）
- 假代理 CONNECT 502：`status:502` + `代理拒绝了 CONNECT（HTTP 502）`
- 哑代理（收下不回应）：wall **8015 ms**（总时长仍封顶 8 s，不挂死）
- `isReachableStatus` 单测 11 例全过；归一化 10 例全过

备注：按写范围限制，本次未更新 `docs/_log.md`。

---

## 4. 未核实项（查不出的，不编）

1. **没有在真实 Electron 进程里做端到端验证。** 约束禁止启动 Electron（单实例锁）与跑构建。本报告的端到端结论来自「用 node v24 type-stripping 直接加载未编译的 `src/main/engine/proxy.ts`」+ 本地假代理服务器。IPC 层（preload / handler / UI）只做了静态通读，未运行。
2. **「隧道内 403/407/5xx 被判通」这条缺陷没有端到端复现。** 本机无 openssl，`node_modules` 下 glob `**/*.{pem,key,crt}` 无结果，造不出自签证书起 TLS-MITM 假代理。该缺陷由代码路径 + `isReachableStatus` 单测固定，未用真实 502 页面验证。
3. **代理「先回 200 再异步拨上游」是行为推断，不是抓包结论。** 证据：伪主机 `this-host-does-not-exist-9999.invalid:443` 在 **2 ms** 就拿到 CONNECT 200，1275 ms 后 TLS 阶段 `ECONNRESET`。没有 tcpdump/Wireshark 抓包佐证，也没有确认代理具体实现（Clash 系特征，未证实）。
4. **没有 git 历史。** 工作目录不是 git 仓库（`git status` → `fatal: not a git repository`），无法对比历史版本。本报告里「旧实现」的行为数据全部是我在改动前对当前文件实跑得到的。
5. **`net.ts` 的两处静默回落未修**（§2.1，P0），因为写范围只到 `proxy.ts`。需要主控决策：是删掉 `httpsJson` 兜底，还是至少让它在直连成功时给出可观测标记。
6. **用户本机 VPN 的具体实现、`65535` 端口上跑的是哪个程序未确认**，只知道它监听 `127.0.0.1:65535`、支持 CONNECT、不做 TLS 中间人（严格校验下证书链真实：`issuer: Google Trust Services`、`subject: npmjs.org`、`authorized: true`）。
7. **目标 host 是否要换成境内镜像未决。** 若主控希望「延迟」这个数字也覆盖跨境一截，正确做法是改 UI 文案/字段语义（`SidebarShell.tsx` / `types.ts`，均不在写范围），而不是把端到端时间塞回 `latencyMs`。
