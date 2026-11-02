/**
 * engine/proxy.ts —— 代理地址归一化 + 代理可用性 / 延迟测速。
 *
 * 三条硬约束：
 *   一、`normalizeProxy` 只做字符串归一化，绝不联网、绝不抛异常；
 *   二、`testProxy` 是**纯 Node 实现**（node:http / node:https / node:tls），
 *       绝不碰 Electron 的 session 代理设置 —— 改 session 会污染正在跑的请求；
 *   三、**任何分支都不允许在代理失败时静默改走直连**。直连只用于「诊断本机网络」，
 *       而且必须满足两个前提才发起：代理确实失败了、且失败原因本身语焉不详
 *       （超时 / 连接被断 / 网络不可达）。它的结论只写进 error 文案，
 *       永远不参与 ok 判定 —— 否则用户会以为代理好好的，实际请求全在裸奔。
 *
 * 测速口径（为什么必须分两段量）：
 *   代理延迟 latencyMs = 本机 → 代理 TCP 握手 + CONNECT 应答耗时，这是用户点「测试」
 *   真正想知道的那个数；隧道建立之后的 TLS 握手 + 一次真实 HTTPS 往返只是
 *   「这条路真能通到外网」的活性证据，**绝不并进 latencyMs**。
 *   在本机 127.0.0.1 代理上实测到的分段（目标 registry.npmjs.org:443）：
 *     TCP 1~12ms + CONNECT 应答 2~16ms                ← 代理延迟，就这么多
 *     TLS 握手 1230~1385ms + HTTPS 首包 276~466ms     ← 这一截由境外站点与线路决定
 *   两段加起来的 ~1820ms 曾经被当成「代理延迟」显示，导致「换个更快的代理」这个
 *   判断彻底失效：同一条代理打国内目标端到端只要 ~190ms，而代理 hop 始终是 1ms。
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

import type { ProxyTestResult } from '../../shared/types'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 隧道目标：和 pnpm 实际走的域名一致 */
const TARGET_HOST = 'registry.npmjs.org'
const TARGET_PORT = 443
/** 隧道里请求的路径：这个路径在 registry 上注定 404，正好当活性探针用 */
const PING_PATH = '/dsh-plugin-console-ping'
/** 单次测速的总超时（毫秒）：整体 deadline，任何阶段都不会超过它 */
const TIMEOUT_MS = 8000
/** 失败后补做「直连对照」的预算上限；真的走这条分支时也不许把整体拖过 deadline */
const DIRECT_BUDGET_MS = 2500
/** 直连对照剩余预算低于这个值就别做了 —— 做完也来不及给出有用结论 */
const MIN_DIRECT_BUDGET_MS = 300
const USER_AGENT = 'dsh-plugin-console/proxy-test'
/** 响应头体积上限：超过说明对面在灌垃圾，早点收手 */
const MAX_HEADER_BYTES = 64 * 1024

/**
 * 隧道内拿到这些状态码 **不算通**：
 *   407 —— 代理要认证（凭据没给 / 给错，用户需要改地址）；
 *   403 —— 被拦了（代理出口被封 / 目标侧拒绝），pnpm 同样过不去；
 *   5xx —— 代理或上游故障的典型信号：Clash / V2Ray / Squid 这类代理连不上目标时
 *          会塞一张自产的 502 / 503 / 504 HTML 页，状态行依旧合法，光看「有没有响应」
 *          会把这种「代理自己坏了」判成「通了」。
 * 其余状态（2xx / 3xx / 4xx 含 404）都意味着请求真的到了目标站点，算通。
 */
function isReachableStatus(status: number): boolean {
  if (status === 407 || status === 403) return false
  return status < 500
}

/**
 * 导出只为把判据固定住、便于单测与评审阅读；不做其他用途。
 * 见文件头注释：这张表决定了「404 算通、502/407 不算通」。
 */
export { isReachableStatus }

/** 协议 → 默认端口；不认识就补端口（宁可给 80） */
const DEFAULT_PORTS: Record<string, number> = {
  http: 80,
  https: 443,
  socks: 1080,
  socks4: 1080,
  socks4a: 1080,
  socks5: 1080,
  socks5h: 1080
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

function defaultPortOf(scheme: string): number {
  return DEFAULT_PORTS[scheme] ?? 80
}

/**
 * 把用户随手输的代理地址洗成 `scheme://host:port[*]`。
 *
 *   "65535"            → http://127.0.0.1:65535
 *   ":65535"           → http://127.0.0.1:65535
 *   "127.0.0.1:65535"  → http://127.0.0.1:65535
 *   "localhost:65535"  → http://localhost:65535
 *   "http://h:1"       → http://h:1（原样）
 *   "https://h"        → https://h:443
 *   "socks5://127.0.0.1" → socks5://127.0.0.1:1080
 *   "http://h:1/"      → http://h:1（去尾斜杠）
 *   "::1"              → http://[::1]:80（裸 IPv6 补方括号，见下）
 *   "[::1]:8080"       → http://[::1]:8080
 *   ""                 → ""
 *
 * 只归一化，不判断可用性 —— 非 http/https 的协议交给 testProxy 去拒。
 */
export function normalizeProxy(input: string): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''

  /* 只输了一个端口号 */
  if (/^\d{1,5}$/.test(raw)) return `http://127.0.0.1:${raw}`

  /* 拆协议头；没写协议就默认 http */
  let scheme = 'http'
  let body = raw
  const head = /^([A-Za-z][A-Za-z0-9+._-]*):\/\//.exec(raw)
  if (head) {
    scheme = head[1]!.toLowerCase()
    body = raw.slice(head[0].length)
  }

  /* 去掉尾斜杠（连续多个也算）；只剩协议头的一律当归零 */
  body = body.replace(/\/+$/, '')
  if (!body) return ''

  /* 拆 host:port 和后面的路径/查询 */
  let hostport = body
  let tail = ''
  const sep = body.search(/[/?#]/)
  if (sep >= 0) {
    hostport = body.slice(0, sep)
    tail = body.slice(sep)
  }

  /* user:pass@host:port */
  let userinfo = ''
  const at = hostport.lastIndexOf('@')
  if (at >= 0) {
    userinfo = hostport.slice(0, at)
    hostport = hostport.slice(at + 1)
  }

  /* host / port；IPv6 字面量带方括号 */
  let host = hostport
  let port = ''
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']')
    if (end >= 0) {
      const inner = hostport.slice(1, end)
      const rest = hostport.slice(end + 1)
      if (rest.startsWith(':')) port = rest.slice(1)
      host = inner ? `[${inner}]` : ''
    }
  } else if (isIpv6Literal(hostport)) {
    /* 裸 IPv6（没写方括号）：
       先看最后一段像不像端口 —— 只有 2~5 位数字、且前面的部分本身还带 IPv6 形状
       （含 ':' 且含十六进制字符）时才算端口。这样 "::1:65535" 能拆成 [::1]:65535，
       而 "::1" 不会被误拆成 host=":" port=1（老代码就是这么错的）。
       只有整段「长得就像 IPv6」时才走这条分支，否则照旧按 host:port 拆 ——
       免得把 "not a url::" 这类垃圾输入括号成一个更看不懂的 target。 */
    const split = /^(.*):(\d{2,5})$/.exec(hostport)
    if (split && /[0-9a-fA-F]/.test(split[1]!) && split[1]!.includes(':')) {
      host = `[${split[1]!}]`
      port = split[2]!
    } else {
      host = `[${hostport}]`
    }
  } else {
    const colon = hostport.lastIndexOf(':')
    if (colon >= 0) {
      host = hostport.slice(0, colon)
      port = hostport.slice(colon + 1)
    }
  }

  if (!/^\d{1,5}$/.test(port)) port = ''
  if (!host) host = '127.0.0.1'
  if (!port) port = String(defaultPortOf(scheme))

  return `${scheme}://${userinfo ? `${userinfo}@` : ''}${host}:${port}${tail}`
}

/**
 * 这段 host 是不是「裸 IPv6 字面量」（没写方括号）。
 *
 * 判据收紧到「只由十六进制数字 / 冒号 / 点组成，且至少两个冒号」：
 * 真 IPv6（`::1`、`2001:db8::1`、`fe80::1:8080`）都满足；
 * 而 `not a url::` 这类含空格或其他字符的垃圾输入不满足，会照旧走 host:port 分支，
 * 由后面对空白字符的检查给出「地址里有空格」的明确错误，而不是被拼成奇怪的样子。
 */
function isIpv6Literal(hostport: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(hostport)) return false
  const first = hostport.indexOf(':')
  return first >= 0 && hostport.indexOf(':', first + 1) >= 0
}

/* ------------------------------------------------------------------ *
 * 解析归一化结果
 * ------------------------------------------------------------------ */

interface ProxyParts {
  scheme: string
  host: string
  port: number
  /** `user:pass`（原始形态，未解码）；没有就是 null */
  auth: string | null
}

function splitProxy(url: string): ProxyParts | null {
  const m = /^([A-Za-z][A-Za-z0-9+._-]*):\/\/([^/?#]*)/.exec(url)
  if (!m) return null
  const scheme = m[1]!.toLowerCase()
  let hostport = m[2] ?? ''

  /* user:pass@host —— 之前这里把凭据直接丢掉了，导致「填了账密也报 407」 */
  let auth: string | null = null
  const at = hostport.lastIndexOf('@')
  if (at >= 0) {
    auth = hostport.slice(0, at) || null
    hostport = hostport.slice(at + 1)
  }

  let host = hostport
  let portStr = ''
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']')
    if (end >= 0) {
      host = hostport.slice(0, end + 1)
      const rest = hostport.slice(end + 1)
      if (rest.startsWith(':')) portStr = rest.slice(1)
    }
  } else {
    const colon = hostport.lastIndexOf(':')
    if (colon >= 0) {
      host = hostport.slice(0, colon)
      portStr = hostport.slice(colon + 1)
    }
  }

  const port = /^\d{1,5}$/.test(portStr) ? Number(portStr) : defaultPortOf(scheme)
  if (!host) return null
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return { scheme, host, port, auth }
}

/**
 * 把 `user:pass` 编成 `Proxy-Authorization` 头的值。
 *
 * 地址里的 userinfo 按 URL 规范是百分号编码的（`p%40ss` 表示 `p@ss`），
 * 所以先解码再 base64，否则账号密码里有 `@` `:` 这类字符时会认证失败。
 */
function proxyAuthHeader(auth: string): string {
  const colon = auth.indexOf(':')
  const rawUser = colon >= 0 ? auth.slice(0, colon) : auth
  const rawPass = colon >= 0 ? auth.slice(colon + 1) : ''
  const decode = (v: string): string => {
    try {
      return decodeURIComponent(v)
    } catch {
      return v
    }
  }
  const token = Buffer.from(`${decode(rawUser)}:${decode(rawPass)}`, 'utf8').toString('base64')
  return `Basic ${token}`
}

/* ------------------------------------------------------------------ *
 * 错误文案
 * ------------------------------------------------------------------ */

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 这个失败「说不说得清」？
 *
 * 说不清的（超时、连接被断、网络不可达、TLS 握手失败）才有必要再花一次直连去分辨
 * 「是代理的问题」还是「本机根本没网」。
 * 说得清的（ECONNREFUSED = 端口没人听、ENOTFOUND = 代理域名解析不出来、
 * CONNECT 被拒 = 代理明确表态）就不要再做直连对照了 —— 那只是白白拖慢报错。
 */
function isAmbiguous(err: unknown): boolean {
  const code = codeOf(err)
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

/** 把 errno 翻成人话；认不出来的用 fallback + 原始 code */
function explain(err: unknown, fallback: string, host: string, port: number): string {
  const code = codeOf(err)
  switch (code) {
    case 'ECONNREFUSED':
      return `连不上 ${host}:${port}，代理没在跑？`
    case 'ETIMEDOUT':
      return '连接超时（8 秒）'
    case 'ENOTFOUND':
      return `解析不了代理域名（${host}）`
    case 'EAI_AGAIN':
      return `域名临时解析失败（${host}），检查 DNS`
    case 'ECONNRESET':
      return `代理把连接断掉了（ECONNRESET）`
    case 'EHOSTUNREACH':
      return `连不上 ${host}:${port}（主机不可达）`
    case 'ENETUNREACH':
      return `连不上 ${host}:${port}（网络不可达）`
    case 'EACCES':
      return `连不上 ${host}:${port}（权限被拒）`
    default:
      return code ? `${fallback}（${code}）` : fallback
  }
}

/* ------------------------------------------------------------------ *
 * 直连对照（只在需要时、只花有限预算）
 * ------------------------------------------------------------------ */

/**
 * 不设代理访问同一个地址，只用来判断「失败是不是本机网络的问题」。
 *
 * 老实现是**在测速一开始就无条件并行发起**的，两个毛病：
 *   一、用户设代理就是不想直连，成功路径上也白打一条直连请求 —— 那是实打实的裸奔流量；
 *   二、失败路径要等它出结论才 resolve，本机端口没人听（0ms 就能确定）也要多等 1 秒以上，
 *       最坏 8 秒。
 * 现在改成：只有代理失败、且失败原因语焉不详、且总 deadline 还剩预算时才调，
 * 结论只用于给 error 补一句诊断。
 */
function probeDirect(budgetMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let req: ReturnType<typeof httpsRequest> | null = null

    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      try {
        req?.destroy()
      } catch {
        /* 已经断了就算了 */
      }
      resolve({ ok })
    }

    timer = setTimeout(() => done(false), budgetMs)

    try {
      req = httpsRequest(
        {
          host: TARGET_HOST,
          port: TARGET_PORT,
          path: PING_PATH,
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Connection: 'close' }
        },
        (res) => {
          try {
            res.resume()
          } catch {
            /* 忽略 */
          }
          done(true)
        }
      )
    } catch {
      done(false)
      return
    }

    req.on('error', () => done(false))
    req.end()
  })
}

/* ------------------------------------------------------------------ *
 * 测速
 * ------------------------------------------------------------------ */

interface ProbeOutcome {
  ok: boolean
  latencyMs: number | null
  status: number | null
  error: string | null
  /** 失败原因是否值得再花预算做直连对照（见 isAmbiguous 的说明） */
  needDirect: boolean
}

/** 从 `HTTP/1.1 404 Not Found\r\n...` 里抠状态码 */
function statusOf(head: string): number | null {
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head.trim())
  return m ? Number(m[1]) : null
}

/**
 * 测一个代理通不通。返回结构见 ProxyTestResult。
 *
 * 口径：
 *   latencyMs = 代理 hop（TCP 握手 + CONNECT 应答），不含隧道内的 TLS 与 HTTPS 往返；
 *   ok        = CONNECT 200 **且** 隧道内真的拿到一个「到过目标站点」的 HTTP 状态
 *               （见 isReachableStatus：404 算通，407/403/5xx 不算）；
 *   超时      = 8000ms 单一 deadline，任何阶段都超不出；超时会主动 destroy 请求与隧道；
 *   失败      = 必要时补一次直连对照，直连也挂就补一句「可能是本机网络问题」。
 */
export function testProxy(input: string): Promise<ProxyTestResult> {
  const target = normalizeProxy(input)

  if (!target) {
    return Promise.resolve<ProxyTestResult>({
      ok: false,
      target: '',
      latencyMs: null,
      totalMs: null,
      status: null,
      error: '代理地址是空的'
    })
  }

  const parts = splitProxy(target)
  if (!parts) {
    return Promise.resolve<ProxyTestResult>({
      ok: false,
      target,
      latencyMs: null,
      totalMs: null,
      status: null,
      error: '代理地址无法解析，检查一下 host / port'
    })
  }

  if (parts.scheme !== 'http' && parts.scheme !== 'https') {
    return Promise.resolve<ProxyTestResult>({
      ok: false,
      target,
      latencyMs: null,
      totalMs: null,
      status: null,
      error: `只支持 http/https 代理（识别到的协议：${parts.scheme}）`
    })
  }

  const proxyHost = parts.host
  const proxyPort = parts.port

  /* host 里有空白/控制字符时补 http:// 会把一句人话变成域名，早点说清楚比丢给 DNS 强 */
  if (/[\s\u0000-\u001f]/.test(proxyHost)) {
    return Promise.resolve<ProxyTestResult>({
      ok: false,
      target,
      latencyMs: null,
      totalMs: null,
      status: null,
      error: '代理地址里有空格或不可见字符，检查一下 host'
    })
  }

  return new Promise<ProxyTestResult>((resolve) => {
    const startedAt = Date.now()
    const deadline = startedAt + TIMEOUT_MS
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let connectReq: ReturnType<typeof httpRequest> | null = null
    let tunnel: ReturnType<typeof tlsConnect> | null = null
    /** 代理 hop 耗时：CONNECT 响应头到手的那一刻定格 */
    let hopMs: number | null = null

    /**
     * 所有出参都从这里走，统一补上 totalMs（发起 → 出结果）。
     * 分布在七八个分支里逐条手写这个数，早晚会漏一处；包一层就不会。
     */
    const done = (o: Omit<ProxyTestResult, 'totalMs'>): void => {
      resolve({ ...o, totalMs: Math.max(0, Math.round(Date.now() - startedAt)) })
    }

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      try {
        connectReq?.destroy()
      } catch {
        /* 忽略 */
      }
      try {
        tunnel?.destroy()
      } catch {
        /* 忽略 */
      }

      if (outcome.ok) {
        done({
          ok: true,
          target,
          latencyMs: outcome.latencyMs ?? 0,
          status: outcome.status,
          error: null
        })
        return
      }

      const base = outcome.error ?? '未知原因'

      /* 失败原因已经说得很清楚 → 直接回，不再花时间做直连对照 */
      if (!outcome.needDirect) {
        done({ ok: false, target, latencyMs: null, status: outcome.status, error: base })
        return
      }

      /* 剩余预算 = deadline - now，且不超过 DIRECT_BUDGET_MS：总时长永远封顶在 TIMEOUT_MS */
      const budget = Math.min(DIRECT_BUDGET_MS, deadline - Date.now())
      if (budget < MIN_DIRECT_BUDGET_MS) {
        done({ ok: false, target, latencyMs: null, status: outcome.status, error: base })
        return
      }

      void probeDirect(budget)
        .then((d) => {
          done({
            ok: false,
            target,
            latencyMs: null,
            status: outcome.status,
            error: d.ok ? base : `${base}（直连同样失败，可能是本机网络问题）`
          })
        })
        .catch(() => {
          done({ ok: false, target, latencyMs: null, status: outcome.status, error: base })
        })
    }

    timer = setTimeout(() => {
      finish({ ok: false, latencyMs: null, status: null, error: '连接超时（8 秒）', needDirect: true })
    }, TIMEOUT_MS)

    try {
      const headers: Record<string, string> = {
        'Proxy-Connection': 'keep-alive',
        'User-Agent': USER_AGENT
      }
      /* 用户在地址里写了 user:pass@ 就带上，别让他填了等于没填 */
      if (parts.auth) headers['Proxy-Authorization'] = proxyAuthHeader(parts.auth)

      connectReq = httpRequest({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${TARGET_HOST}:${TARGET_PORT}`,
        headers
      })
    } catch (err) {
      finish({
        ok: false,
        latencyMs: null,
        status: null,
        error: explain(err, '无法向代理发起连接', proxyHost, proxyPort),
        needDirect: isAmbiguous(err)
      })
      return
    }

    connectReq.on('connect', (res, socket) => {
      const code = res.statusCode ?? 0
      /* hop 在「CONNECT 应答到手」这一刻定格：这才是代理延迟 */
      hopMs = Math.max(0, Math.round(Date.now() - startedAt))

      if (code !== 200) {
        try {
          socket.destroy()
        } catch {
          /* 忽略 */
        }
        finish({
          ok: false,
          latencyMs: null,
          status: code || null,
          error:
            code === 407
              ? parts.auth
                ? '代理认证失败（HTTP 407），检查地址里的账号密码'
                : '代理需要认证（HTTP 407），在地址里带上 user:pass@ 再试'
              : `代理拒绝了 CONNECT（HTTP ${code || '?'}）`,
          /* 代理已经明确表态，跟本机网络无关 */
          needDirect: false
        })
        return
      }

      /* 隧道通了：在隧道上做一次真实 HTTPS GET，只用来判活 */
      try {
        tunnel = tlsConnect({
          socket,
          servername: TARGET_HOST,
          /* 故意不校验证书：这条连接的唯一目的是判活，而不少 VPN / 企业代理会做
             TLS 中间人（自带根证书），打开严格校验会把它们误判成不通。
             代价是「能握手」不等于「对面是真 npm」，所以活性判据另加状态码白名单。 */
          rejectUnauthorized: false
        })
      } catch (err) {
        try {
          socket.destroy()
        } catch {
          /* 忽略 */
        }
        finish({
          ok: false,
          latencyMs: null,
          status: null,
          error: `隧道建立成功，但 TLS 握手发起失败：${codeOf(err) || messageOf(err)}`,
          needDirect: true
        })
        return
      }

      const sock = tunnel
      let buf = Buffer.alloc(0)

      sock.once('secureConnect', () => {
        try {
          sock.write(
            `GET ${PING_PATH} HTTP/1.1\r\n` +
              `Host: ${TARGET_HOST}\r\n` +
              `User-Agent: ${USER_AGENT}\r\n` +
              `Accept: */*\r\n` +
              `Connection: close\r\n\r\n`
          )
        } catch (err) {
          finish({
            ok: false,
            latencyMs: null,
            status: null,
            error: `隧道里写请求失败：${codeOf(err) || messageOf(err)}`,
            needDirect: true
          })
        }
      })

      sock.on('data', (chunk: Buffer) => {
        if (settled) return
        buf = Buffer.concat([buf, chunk])
        const text = buf.toString('latin1')
        const end = text.indexOf('\r\n\r\n')
        if (end < 0) {
          if (buf.length > MAX_HEADER_BYTES) {
            finish({
              ok: false,
              latencyMs: null,
              status: null,
              error: '代理返回的响应头异常（没有找到头部结束标记）',
              needDirect: true
            })
          }
          return
        }
        const status = statusOf(text.slice(0, end))
        if (status === null) {
          finish({
            ok: false,
            latencyMs: null,
            status: null,
            error: '代理返回了非 HTTP 响应',
            needDirect: true
          })
          return
        }

        /* 状态码不白名单内 → 隧道虽通，但代理到不了目标（自产 5xx / 要认证 / 被拦） */
        if (!isReachableStatus(status)) {
          finish({
            ok: false,
            latencyMs: null,
            status,
            error:
              status >= 500
                ? `隧道通了，但上游返回 HTTP ${status}（代理连不到目标站点）`
                : status === 407
                  ? '代理需要认证（HTTP 407），在地址里带上 user:pass@ 再试'
                  : `隧道通了，但请求被拦了（HTTP ${status}）`,
            needDirect: false
          })
          return
        }

        finish({
          ok: true,
          /* 只报代理 hop，不把隧道里的 TLS / HTTPS 往返算成「延迟」 */
          latencyMs: hopMs ?? Math.max(0, Math.round(Date.now() - startedAt)),
          status,
          error: null,
          needDirect: false
        })
      })

      sock.on('error', (err) => {
        finish({
          ok: false,
          latencyMs: null,
          status: null,
          error: explain(err, '隧道建立成功，但 HTTPS 握手 / 请求失败', proxyHost, proxyPort),
          needDirect: true
        })
      })

      sock.on('close', () => {
        if (settled) return
        finish({
          ok: false,
          latencyMs: null,
          status: null,
          error: '隧道建立后代理提前关闭了连接',
          needDirect: true
        })
      })
    })

    connectReq.on('error', (err) => {
      finish({
        ok: false,
        latencyMs: null,
        status: null,
        error: explain(err, '连不上代理', proxyHost, proxyPort),
        needDirect: isAmbiguous(err)
      })
    })

    connectReq.end()
  })
}
