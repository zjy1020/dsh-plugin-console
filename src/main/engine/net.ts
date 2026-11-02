/**
 * net.ts —— 网络层：npm registry + GitHub API。
 *
 * 一律走 Electron 的 `net.fetch`，这样自动继承系统代理 / 用户在设置里填的代理。
 * `net.fetch` 在 app 未 ready 等场景会直接抛，所以带一条 `node:https` 直连兜底（不代理）。
 * 本模块对外**永不抛异常**，所有失败都折成 { ok:false, status, data:null, error }。
 */

import { net, session } from 'electron'
import * as https from 'node:https'
import { URL } from 'node:url'

import { DEFAULT_SETTINGS } from '../../shared/ipc'
import type { AppSettings, RegistryPackument, SearchHit } from '../../shared/types'
import { get as getSettings } from './settings'

/* ------------------------------------------------------------------ *
 * 常量 / 缓存
 * ------------------------------------------------------------------ */

const DEFAULT_UA = 'DSH-Plugin-Console/0.1'
const DEFAULT_TIMEOUT = 12000
const CACHE_TTL = 5 * 60 * 1000
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const GITHUB_API = 'https://api.github.com'

export interface HttpOptions {
  timeoutMs?: number
  headers?: Record<string, string>
}

interface CacheEntry<T> {
  at: number
  value: T
}

const cache = new Map<string, CacheEntry<unknown>>()

function readCache<T>(key: string): T | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return hit.value as T
}

function writeCache<T>(key: string, value: T): void {
  cache.set(key, { at: Date.now(), value })
}

/** 清空全部内存缓存（设置里换 registry / 换代理后调） */
export function clearCache(): void {
  cache.clear()
}

/* ------------------------------------------------------------------ *
 * 设置 + 代理
 * ------------------------------------------------------------------ */

/** 设置模块还没就绪时给个安全兜底，别让网络层跟着炸 */
function settings(): AppSettings {
  try {
    const s = getSettings() as Partial<AppSettings> | undefined
    if (s && typeof s === 'object') return { ...DEFAULT_SETTINGS, ...s }
  } catch {
    /* 设置还没初始化，用默认值 */
  }
  return { ...DEFAULT_SETTINGS }
}

function registryBase(): string {
  const r = settings().registry
  const clean = typeof r === 'string' && r.trim() ? r.trim() : DEFAULT_REGISTRY
  return clean.replace(/\/+$/, '')
}

/** 已应用到 session 上的代理值；undefined = 从没设过（= 直连） */
let appliedProxy: string | undefined
/** 正在进行的应用动作；并发请求共用它，别互相覆盖 */
let applyPromise: Promise<void> | null = null

/**
 * 把设置里的代理同步到 session 上。
 *
 * 为什么返回 Promise：`setProxy` 是异步的，而原来的写法是 `void …setProxy(…)` 之后立刻
 * `net.fetch`。启动后的第一批请求会抢在代理生效之前发出去 —— 用户以为全都走了代理，
 * 实际上头几个包是裸连的。改成可以 await，调用方等它落定再发请求。
 *
 * 失败时不再静默（原来是 `.catch(() => undefined)`）：代理没设上却让请求悄悄走直连，
 * 是这类工具最不该有的一种「安静」。
 */
function applyProxy(): Promise<void> {
  const want = (settings().proxy ?? '').trim()
  if (applyPromise) return applyPromise
  const alreadyOk = want ? appliedProxy === want : appliedProxy === undefined
  if (alreadyOk) return Promise.resolve()

  applyPromise = (async (): Promise<void> => {
    try {
      if (want) {
        await session.defaultSession.setProxy({ proxyRules: want })
        appliedProxy = want
      } else {
        // 之前设过代理、现在被清空了 → 恢复直连（否则 session 会一直挂在旧代理上）
        await session.defaultSession.setProxy({ mode: 'direct' })
        appliedProxy = undefined
      }
    } catch (err) {
      console.warn(`[net] 应用代理失败（${want || '直连'}）：${shortMsg(err)}`)
    } finally {
      applyPromise = null
    }
  })()
  return applyPromise
}

/* ------------------------------------------------------------------ *
 * 底层请求
 * ------------------------------------------------------------------ */

function shortMsg(e: unknown): string {
  let s: string
  if (e instanceof Error) s = e.name === 'TimeoutError' || e.name === 'AbortError' ? `超时（${e.message || e.name}）` : e.message
  else s = String(e)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 180 ? `${s.slice(0, 180)}…` : s
}

function bodySnippet(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

function requestHeaders(opts?: HttpOptions): Record<string, string> {
  return {
    'User-Agent': DEFAULT_UA,
    Accept: 'application/json',
    ...(opts?.headers ?? {})
  }
}

interface JsonResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: string | null
}

function parseJsonText<T>(text: string, status: number): JsonResult<T> {
  try {
    return { ok: true, status, data: JSON.parse(text) as T, error: null }
  } catch {
    return { ok: false, status, data: null, error: '返回内容不是合法 JSON' }
  }
}

/** node:https 直连兜底（不走代理） */
function httpsJson<T>(url: string, headers: Record<string, string>, timeoutMs: number): Promise<JsonResult<T>> {
  return new Promise<JsonResult<T>>((resolve) => {
    let settled = false
    const done = (v: JsonResult<T>): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:') {
        done({ ok: false, status: 0, data: null, error: `直连兜底只支持 https（当前 ${u.protocol}）` })
        return
      }
      const req = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { ...headers, Host: u.host },
          timeout: timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            const text = Buffer.concat(chunks).toString('utf8')
            if (status < 200 || status >= 300) {
              const snip = bodySnippet(text)
              done({ ok: false, status, data: null, error: `HTTP ${status}${snip ? `：${snip}` : ''}` })
              return
            }
            done(parseJsonText<T>(text, status))
          })
          res.on('error', (e: unknown) => done({ ok: false, status: 0, data: null, error: `读取响应失败：${shortMsg(e)}` }))
        }
      )
      req.on('timeout', () => {
        req.destroy(new Error(`请求超时（${timeoutMs}ms）`))
      })
      req.on('error', (e: unknown) => done({ ok: false, status: 0, data: null, error: `直连请求失败：${shortMsg(e)}` }))
      req.end()
    } catch (e) {
      done({ ok: false, status: 0, data: null, error: `URL 解析失败：${shortMsg(e)}` })
    }
  })
}

/**
 * GET 一个 JSON。永远 resolve，绝不抛。
 * net.fetch 抛异常时降级 node:https 直连（不代理），再失败才认输。
 */
export async function httpJson<T = any>(
  url: string,
  opts?: HttpOptions
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  if (!url || typeof url !== 'string') {
    return { ok: false, status: 0, data: null, error: 'URL 为空' }
  }
  const timeoutMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT
  const headers = requestHeaders(opts)

  // 等代理真正落到 session 上再发请求：setProxy 是异步的，不等就会让启动后
  // 第一批请求抢在代理生效之前裸奔出去（用户以为全走代理，其实头几个包没走）。
  await applyProxy()

  try {
    const res = await net.fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const status = res.status
    const text = await res.text()
    if (status < 200 || status >= 300) {
      const snip = bodySnippet(text)
      return { ok: false, status, data: null, error: `HTTP ${status}${snip ? `：${snip}` : ''}` }
    }
    return parseJsonText<T>(text, status)
  } catch (e) {
    const primary = shortMsg(e)
    const using = (settings().proxy ?? '').trim()

    /**
     * 用户配了代理时**不做直连兜底**。
     *
     * 兜底看起来是「多一条活路」，实际是这个工具最坏的一种设计：代理挂了，请求悄悄从
     * 本机 IP 出去，数据还拿回来了，界面上一片正常 —— 用户永远不会知道自己的出口已经
     * 裸奔，也永远发现不了代理配置坏了。而这个工具的用户之所以配代理，本来就是因为他们
     * 直连不到 GitHub / npm。
     *
     * 所以这里宁可失败得明确：把代理写进错误文案，让人去查代理。
     */
    if (using) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: `请求失败：${primary}。当前配了代理 ${using}，不会退回直连 —— 先确认代理在运行。`
      }
    }

    // 没配代理时，net.fetch 本身就是直连，这里只是换 node:https 再试一次（它不受
    // Chromium 那套网络栈的限制，对个别奇怪证书 / 重定向更宽容）。
    const fallback = await httpsJson<T>(url, headers, timeoutMs)
    if (fallback.ok) return fallback
    return {
      ok: false,
      status: fallback.status,
      data: null,
      error: `请求失败：${primary}；直连兜底也失败：${fallback.error ?? '未知原因'}`
    }
  }
}

/* ------------------------------------------------------------------ *
 * 字段助手
 * ------------------------------------------------------------------ */

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function repoToString(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
    return (v as { url: string }).url.trim() || null
  }
  return null
}

function keywordsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

/* ------------------------------------------------------------------ *
 * npm registry
 * ------------------------------------------------------------------ */

const NOT_FOUND_MSG = 'npm registry 上没有这个包'

/**
 * 「这个包是不是加载层」的答案。
 *
 * packument 的 versions[latest] 就是完整的 package.json，所以读 dsh.bundle.patch
 * 不需要第二个请求。null = 没查到（网络失败 / 没这个包），false 才是「确实没声明」。
 */
const bundleFlags = new Map<string, boolean | null>()

export function packumentBundleFlag(name: string): boolean | null {
  return bundleFlags.get(normName(name)) ?? null
}

export async function registryPackument(name: string): Promise<RegistryPackument> {
  const clean = normName(name)
  const blank = (): RegistryPackument => ({
    name: clean,
    latest: null,
    distTags: {},
    description: null,
    homepage: null,
    repository: null,
    deprecated: null,
    notFound: false,
    error: null
  })

  if (!clean) return { ...blank(), error: '包名为空' }

  // scoped 名字里的 `/` 保留、`@` 不编码：https://registry.npmjs.org/@scope/name 是合法请求
  const url = `${registryBase()}/${clean}`
  const key = `packument:${url}`

  const cached = readCache<RegistryPackument>(key)
  if (cached) {
    if (!bundleFlags.has(clean)) bundleFlags.set(clean, null)
    return { ...cached }
  }

  const res = await httpJson<Record<string, unknown>>(url, { timeoutMs: 15000 })

  if (res.status === 404) {
    const out: RegistryPackument = { ...blank(), notFound: true, error: NOT_FOUND_MSG }
    writeCache(key, out)
    return out
  }

  if (!res.ok || !res.data) {
    return { ...blank(), error: res.error ?? '请求 npm registry 失败' }
  }

  const data = res.data
  const rawTags = data['dist-tags']
  const distTags: Record<string, string> = {}
  if (rawTags && typeof rawTags === 'object') {
    for (const [k, v] of Object.entries(rawTags as Record<string, unknown>)) {
      if (typeof v === 'string') distTags[k] = v
    }
  }
  const latest = distTags.latest ?? null

  const versions = data.versions
  let ver: Record<string, unknown> | null = null
  if (latest && versions && typeof versions === 'object') {
    const v = (versions as Record<string, unknown>)[latest]
    if (v && typeof v === 'object') ver = v as Record<string, unknown>
  }

  bundleFlags.set(clean, declaresBundlePatch(ver ?? {}))

  const out: RegistryPackument = {
    name: str(data.name) ?? clean,
    latest,
    distTags,
    description: str(ver?.description),
    homepage: str(ver?.homepage),
    repository: repoToString(ver?.repository),
    deprecated: str(ver?.deprecated),
    notFound: false,
    error: null
  }
  writeCache(key, out)
  return out
}

function normName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : ''
}

export async function npmSearch(query: string, limit: number): Promise<SearchHit[]> {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return []

  let size = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 25
  if (size < 1) size = 1
  if (size > 250) size = 250

  const url = `${registryBase()}/-/v1/search?text=${encodeURIComponent(q)}&size=${size}`
  const key = `search:${url}`

  const cached = readCache<SearchHit[]>(key)
  if (cached) return cached.slice() // 别把缓存数组本身交给调用方

  const res = await httpJson<Record<string, unknown>>(url, { timeoutMs: 15000 })
  if (!res.ok || !res.data) return []

  const objects = res.data.objects
  if (!Array.isArray(objects)) return []

  const hits: SearchHit[] = []
  for (const raw of objects) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { package?: unknown; score?: unknown }
    const pkg = entry.package
    if (!pkg || typeof pkg !== 'object') continue
    const p = pkg as Record<string, unknown>
    const name = str(p.name)
    if (!name) continue
    const links = (p.links && typeof p.links === 'object' ? p.links : {}) as Record<string, unknown>
    const publisher = p.publisher && typeof p.publisher === 'object' ? (p.publisher as Record<string, unknown>) : null
    const score = entry.score && typeof entry.score === 'object' ? (entry.score as Record<string, unknown>) : null
    const finalScore = score && typeof score.final === 'number' ? score.final : 0
    hits.push({
      name,
      version: str(p.version) ?? '',
      description: str(p.description),
      keywords: keywordsOf(p.keywords),
      publisher: publisher ? str(publisher.username) ?? str(publisher.name) : null,
      updatedAt: str(p.date),
      score: finalScore,
      links: {
        npm: str(links.npm),
        homepage: str(links.homepage),
        repository: str(links.repository)
      }
    })
  }

  writeCache(key, hits)
  return hits
}

/* ------------------------------------------------------------------ *
 * GitHub
 * ------------------------------------------------------------------ */

export interface GithubRepoInfo {
  ok: boolean
  fullName: string | null
  defaultBranch: string | null
  description: string | null
  homepage: string | null
  stars: number | null
  archived: boolean
  error: string | null
}

export async function githubRepo(owner: string, repo: string): Promise<GithubRepoInfo> {
  const o = typeof owner === 'string' ? owner.trim() : ''
  const r = typeof repo === 'string' ? repo.trim().replace(/\.git$/i, '') : ''

  const fail = (error: string): GithubRepoInfo => ({
    ok: false,
    fullName: o && r ? `${o}/${r}` : null,
    defaultBranch: null,
    description: null,
    homepage: null,
    stars: null,
    archived: false,
    error
  })

  if (!o || !r) return fail('仓库 owner/repo 为空')

  const url = `${GITHUB_API}/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`
  const key = `github:${url}`

  const cached = readCache<GithubRepoInfo>(key)
  if (cached) return { ...cached }

  const res = await httpJson<Record<string, unknown>>(url, {
    timeoutMs: 15000,
    headers: { Accept: 'application/vnd.github+json' }
  })

  if (res.status === 403 || res.status === 429) return fail('GitHub API 限流，稍后再试或挂代理')
  if (res.status === 404) return fail('GitHub 上找不到这个仓库')
  if (!res.ok || !res.data) return fail(res.error ?? '请求 GitHub API 失败')

  const d = res.data
  const out: GithubRepoInfo = {
    ok: true,
    fullName: str(d.full_name) ?? `${o}/${r}`,
    defaultBranch: str(d.default_branch),
    description: str(d.description),
    homepage: str(d.homepage),
    stars: typeof d.stargazers_count === 'number' ? d.stargazers_count : null,
    archived: d.archived === true,
    error: null
  }
  writeCache(key, out)
  return out
}

/* ───────────────────────── raw.githubusercontent 兜底 ───────────────────────── */

/**
 * 直接读仓库里的 package.json。
 *
 * 为什么不只靠 api.github.com：未认证的 60 次/小时一撞就打光（实测就是 403），
 * 而 raw 域名基本不限流，还能顺带拿到包名 / 版本 / 有没有 dsh.bundle.patch ——
 * 这三样正是预检卡最需要展示的东西。api 只用来补 description 和默认分支。
 */
export interface RepoManifest {
  ok: boolean
  name: string | null
  version: string | null
  description: string | null
  isBundle: boolean
  ref: string | null
  error: string | null
}

const RAW_HOST = 'https://raw.githubusercontent.com'

/** 分支名里的 / 不能被编码（要保留成路径分隔符），其余段照常编码 */
function rawPath(value: string): string {
  return value
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function declaresBundlePatch(pkg: Record<string, unknown>): boolean {
  const dsh = pkg.dsh
  if (!dsh || typeof dsh !== 'object') return false
  const bundle = (dsh as Record<string, unknown>).bundle
  if (!bundle || typeof bundle !== 'object') return false
  const patch = (bundle as Record<string, unknown>).patch
  if (typeof patch === 'string') return patch.trim().length > 0
  if (Array.isArray(patch)) return patch.length > 0
  return patch !== undefined && patch !== null
}

export async function repoManifest(owner: string, repo: string, ref?: string | null): Promise<RepoManifest> {
  const o = typeof owner === 'string' ? owner.trim() : ''
  const r = typeof repo === 'string' ? repo.trim().replace(/\.git$/i, '') : ''

  const fail = (error: string): RepoManifest => ({
    ok: false,
    name: null,
    version: null,
    description: null,
    isBundle: false,
    ref: ref ?? null,
    error
  })

  if (!o || !r) return fail('仓库 owner/repo 为空')

  /* 先试指定 ref，再兜 HEAD / main / master —— HEAD 少数情况不认，多给两条最省事 */
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const candidate of [ref, 'HEAD', 'main', 'master']) {
    const s = typeof candidate === 'string' ? candidate.trim() : ''
    if (s && !seen.has(s)) {
      seen.add(s)
      candidates.push(s)
    }
  }

  let lastError = '远端没读到 package.json'
  for (const candidate of candidates) {
    const url = `${RAW_HOST}/${encodeURIComponent(o)}/${encodeURIComponent(r)}/${rawPath(candidate)}/package.json`
    const key = `raw:${url}`

    const cached = readCache<RepoManifest>(key)
    if (cached) return { ...cached }

    const res = await httpJson<Record<string, unknown>>(url, {
      timeoutMs: 15000,
      headers: { Accept: 'application/json, text/plain' }
    })
    if (res.status === 404) {
      lastError = '这个仓库里没有 package.json'
      continue
    }
    if (!res.ok || !res.data) {
      lastError = `读取 package.json 失败：${res.error ?? '未知原因'}`
      continue
    }

    const pkg = res.data
    const out: RepoManifest = {
      ok: true,
      name: str(pkg.name),
      version: str(pkg.version),
      description: str(pkg.description),
      isBundle: declaresBundlePatch(pkg),
      ref: candidate,
      error: null
    }
    writeCache(key, out)
    return out
  }
  return fail(lastError)
}
