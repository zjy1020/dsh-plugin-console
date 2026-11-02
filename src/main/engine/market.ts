/**
 * engine/market.ts —— DSH 插件市场的目录取数层。
 *
 * 目录内容就是 `dsh-plugin-catalog` 这个 npm 包里携带的 `plugins.json`
 * （dshmarket 自己的取数方式，这里照搬它的源顺序）：
 *
 *   1. GET <settings.registry>/dsh-plugin-catalog/latest → 拿 dist.tarball → 下载
 *      → gunzip → 解 tar → 取出 package/plugins.json；
 *   2. 同上，换成国内公共镜像 https://registry.npmmirror.com；
 *   3. 直接 GET https://awesome-dsh-plugin.com/plugins.json（官网原件）。
 *
 * 每个源都 try/catch，成功即停；全失败给中文 error 并列出试过哪些源、各自为什么失败。
 *
 * 设计要点（跟 net.ts / icon.ts 保持一致）：
 * - 只借 `net.httpJson` 做 JSON 请求 —— 它内部会 `applyProxy()`，所以「设置 → 代理」自动生效；
 *   二进制的 tarball 走 electron `net.fetch`（同一个 session，代理同样生效），
 *   抛异常时降级 node:https 直连，再失败才认输。
 * - 模块级内存缓存 + inflight 并发去重 + 磁盘缓存，任何失败路径都不抛，只给中文串。
 * - 磁盘缓存只在**抓到非空 plugins** 时才写（半截数据不许覆盖掉一份好目录）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as https from 'node:https'
import { net as electronNet } from 'electron'

import type { MarketCategory, MarketEntry, MarketList } from '../../shared/types'
import { listPlugins } from './inventory'
import { httpJson } from './net'
import { get as getSettings, getSettingsPath } from './settings'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 携带 plugins.json 的 npm 包名 */
const CATALOG_PKG = 'dsh-plugin-catalog'
/** tarball 里目录条目的路径 */
const CATALOG_ENTRY = 'package/plugins.json'
/** 目录的官网原件（国内经公共 GitHub 代理常被 403，所以只当兜底） */
const CATALOG_ORIGIN = 'https://awesome-dsh-plugin.com/plugins.json'
/** 国内公共镜像（第二个源） */
const NPM_MIRROR = 'https://registry.npmmirror.com'
/** 公共 UA —— 跟 net.ts / icon.ts 用同一个 */
const UA = 'DSH-Plugin-Console/0.1'
/** 目录包本身 5MB+、解包后 9.5MB 级，20s 是实测能跑通的超时 */
const DOWNLOAD_TIMEOUT_MS = 20_000
/** 磁盘缓存有效期 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
/** 磁盘缓存文件名（落在 <userData> 下，跟 settings.json 同一个目录） */
const CACHE_FILE = 'catalog.json'

/* tar 头字段（POSIX ustar，512 字节一块），跟 dshmarket 的 catalog-npm.ts 一致 */
const NAME_OFFSET = 0
const NAME_LENGTH = 100
const SIZE_OFFSET = 124
const SIZE_LENGTH = 12
const TYPE_OFFSET = 156
const BLOCK = 512

/** 数据实际从哪来的 */
type MarketSource = 'npm-package' | 'origin'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 目录原始条目（只声明我们真正读的字段，其余一律忽略） */
interface RegistryPlugin {
  name?: unknown
  owner?: unknown
  url?: unknown
  category?: unknown
  description?: unknown
  npm?: unknown
  stars?: unknown
  downloads?: unknown
  version?: unknown
  icon?: unknown
  install?: unknown
  added?: unknown
  deprecated?: unknown
  replacement?: unknown
  capabilities?: unknown
  capabilityCheckedAt?: unknown
}

/** 归一后的整份目录 */
interface Catalog {
  /** 拉取/写入缓存的时间戳 */
  fetchedAt: number
  /** 目录构建时间（原样透传） */
  updated: string | null
  /** 条目数 */
  count: number
  /** 分类 id → { 语言码: 显示名 } */
  categories: Record<string, Record<string, string>>
  /** 目录原始条目，原样存 */
  plugins: unknown[]
  /** 从哪里拿到的（缓存命中时也照实说出来） */
  source: MarketSource | null
}

/** 磁盘缓存文件的形状 */
interface CachedFile {
  fetchedAt?: unknown
  updated?: unknown
  count?: unknown
  categories?: unknown
  plugins?: unknown
  source?: unknown
}

/** marketList 的入参：force 忽略缓存；profile 只影响 installed 判定 */
export interface MarketListOptions {
  force?: boolean
  profile?: string
}

/** 一个源的尝试结果 */
interface SourceResult {
  ok: boolean
  catalog: Catalog | null
  error: string | null
}

/* ------------------------------------------------------------------ *
 * 模块级状态
 * ------------------------------------------------------------------ */

/** 最近一份目录（进程内复用，避免一次次读 9.5MB 的 JSON） */
let memo: Catalog | null = null
/** inflight 并发去重：同一类请求同时来只发一次 */
const inflight = new Map<string, Promise<MarketList>>()

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 永不抛的中文错误短句 */
function shortMsg(e: unknown): string {
  let s: string
  if (e instanceof Error) s = e.message || e.name
  else s = String(e)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 160)}…` : s || '未知原因'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 字符串字段：非字符串 / 空白一律给空串 */
function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 可空字符串字段 */
function asNullableText(v: unknown): string | null {
  const s = asText(v)
  return s === '' ? null : s
}

/** 可空数字字段 */
function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** 字符串数组（丢空串 / 非字符串，保序去重） */
function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (s === '' || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/** 多语言描述表：只留非空的字符串值 */
function asDescriptionMap(v: unknown): Record<string, string> {
  if (!isPlainObject(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && val.trim() !== '') out[k] = val.trim()
  }
  return out
}

/** 分类表：只留 id → 非空字符串映射 */
function asCategoryMap(v: unknown): Record<string, Record<string, string>> {
  if (!isPlainObject(v)) return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [id, labels] of Object.entries(v)) {
    if (typeof id !== 'string' || id.trim() === '') continue
    out[id] = asDescriptionMap(labels)
  }
  return out
}

/** category 字段：一个字符串或一个数组，归一成去重数组 */
function normalizeCategories(v: unknown): string[] {
  if (typeof v === 'string') {
    const s = v.trim()
    return s === '' ? [] : [s]
  }
  return asStringList(v)
}

/** registry 基址：去尾部斜杠 */
function baseOf(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ *
 * 磁盘缓存
 * ------------------------------------------------------------------ */

function cachePath(): string {
  try {
    return join(dirname(getSettingsPath()), CACHE_FILE)
  } catch {
    return ''
  }
}

/** 读磁盘缓存；过期 / 结构不对 / 空目录一律当没有 */
function readCache(): Catalog | null {
  const p = cachePath()
  if (!p) return null
  try {
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as CachedFile
    if (!isPlainObject(raw)) return null
    const plugins = Array.isArray(raw.plugins) ? raw.plugins : []
    // 空目录不算缓存命中：宁可重拉，也不要拿一份坏数据糊弄界面
    if (plugins.length === 0) return null
    const fetchedAt = asNumberOrNull(raw.fetchedAt)
    if (fetchedAt === null || Date.now() - fetchedAt > CACHE_TTL_MS) return null
    const source = raw.source === 'npm-package' || raw.source === 'origin' ? raw.source : null
    return {
      fetchedAt,
      updated: asNullableText(raw.updated),
      count: asNumberOrNull(raw.count) ?? plugins.length,
      categories: asCategoryMap(raw.categories),
      plugins,
      source
    }
  } catch {
    return null
  }
}

/** 只写非空目录；写盘失败静默兜底，绝不影响本次返回 */
function writeCache(c: Catalog): void {
  const p = cachePath()
  if (!p || c.plugins.length === 0) return
  const body = JSON.stringify({
    fetchedAt: c.fetchedAt,
    updated: c.updated,
    count: c.count,
    categories: c.categories,
    // source 不在契约里，但缓存命中时界面要能说清数据来自哪 —— 多存一个字段最省事
    source: c.source,
    plugins: c.plugins
  })
  try {
    mkdirSync(dirname(p), { recursive: true })
  } catch {
    /* 目录建不出来下面写盘也会失败，安静兜底 */
  }
  try {
    const tmp = `${p}.tmp`
    writeFileSync(tmp, body, 'utf8')
    try {
      renameSync(tmp, p)
    } catch {
      writeFileSync(p, body, 'utf8')
    }
  } catch {
    try {
      writeFileSync(p, body, 'utf8')
    } catch {
      /* 静默兜底：写不动就算了，内存里那份已经生效 */
    }
  }
}

/** 清空市场缓存（内存 + 磁盘）。设置里换 registry / 换代理后可以调。 */
export function clearMarketCache(): void {
  memo = null
  const p = cachePath()
  if (!p) return
  try {
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* 删不掉就算了 */
  }
}

/* ------------------------------------------------------------------ *
 * 网络：二进制下载 + 零依赖 tar 读取
 * ------------------------------------------------------------------ */

/** node:https 直连兜底（不代理），跟 icon.ts 的做法一致 */
function httpsBuffer(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; buf: Buffer | null; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: { ok: boolean; status: number; buf: Buffer | null; error: string | null }): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const u = new URL(url)
      const req = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { 'User-Agent': UA, Accept: '*/*', Host: u.host },
          timeout: timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              done({ ok: false, status, buf: null, error: `HTTP ${status}` })
              return
            }
            done({ ok: true, status, buf: Buffer.concat(chunks), error: null })
          })
          res.on('error', (e: unknown) =>
            done({ ok: false, status: 0, buf: null, error: `读取响应失败：${shortMsg(e)}` })
          )
        }
      )
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
      req.on('error', (e: unknown) => done({ ok: false, status: 0, buf: null, error: `直连请求失败：${shortMsg(e)}` }))
      req.end()
    } catch (e) {
      done({ ok: false, status: 0, buf: null, error: `URL 解析失败：${shortMsg(e)}` })
    }
  })
}

/** 下载一个二进制（走 electron net，因此吃 session 代理）；永不抛 */
async function httpBuffer(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; buf: Buffer | null; error: string | null }> {
  try {
    const res = await electronNet.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const status = res.status
    if (status < 200 || status >= 300) return { ok: false, status, buf: null, error: `HTTP ${status}` }
    const ab = await res.arrayBuffer()
    return { ok: true, status, buf: Buffer.from(ab), error: null }
  } catch (e) {
    const primary = shortMsg(e)
    const fallback = await httpsBuffer(url, timeoutMs)
    if (fallback.ok) return fallback
    return {
      ok: false,
      status: fallback.status,
      buf: null,
      error: `请求失败：${primary}；直连兜底也失败：${fallback.error ?? '未知原因'}`
    }
  }
}

/**
 * 从一个 gzip 过的 tar 里取出某个条目（零依赖：自己读 512 字节头）。
 *
 * 布局：name 在 offset 0 长 100；八进制 size 在 offset 124 长 12；type 在 156。
 * 只认普通文件（type '0' 或 '\0'），其余（目录 / pax 头 / 长名扩展）跳过。
 */
function fileFromTarball(gz: Buffer, wanted: string): Buffer | null {
  const buf = gunzipSync(gz)
  let off = 0
  while (off + BLOCK <= buf.length) {
    const rawName = buf.toString('utf8', off + NAME_OFFSET, off + NAME_OFFSET + NAME_LENGTH)
    const name = rawName.replace(/\0.*$/s, '')
    if (name === '') break // 全零块 = 归档结束
    const sizeRaw = buf.toString('ascii', off + SIZE_OFFSET, off + SIZE_OFFSET + SIZE_LENGTH).replace(/\0.*$/s, '').trim()
    const size = Number.parseInt(sizeRaw || '0', 8) || 0
    const type = buf.toString('ascii', off + TYPE_OFFSET, off + TYPE_OFFSET + 1)
    if ((type === '0' || type === '\0') && name === wanted) {
      return buf.subarray(off + BLOCK, off + BLOCK + size)
    }
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 目录校验
 * ------------------------------------------------------------------ */

/** 目录必须是个对象，且 plugins 是非空数组 —— 否则这份数据不能用 */
function asCatalog(value: unknown, source: MarketSource): { ok: boolean; data: Catalog | null; error: string | null } {
  if (!isPlainObject(value)) return { ok: false, data: null, error: '返回的内容不是对象' }
  const plugins = value.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) {
    return { ok: false, data: null, error: '目录内容为空（plugins 不是非空数组）' }
  }
  return {
    ok: true,
    error: null,
    data: {
      fetchedAt: Date.now(),
      updated: asNullableText(value.updated),
      count: asNumberOrNull(value.count) ?? plugins.length,
      categories: asCategoryMap(value.categories),
      plugins,
      source
    }
  }
}

/* ------------------------------------------------------------------ *
 * 三个源
 * ------------------------------------------------------------------ */

/** 从某个 npm registry 拉目录包并解出 plugins.json */
async function fromNpm(registry: string): Promise<SourceResult> {
  const base = baseOf(registry)
  if (!base) return { ok: false, catalog: null, error: 'registry 地址为空' }

  const meta = await httpJson<Record<string, unknown>>(`${base}/${CATALOG_PKG}/latest`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS
  })
  if (!meta.ok || !isPlainObject(meta.data)) {
    return { ok: false, catalog: null, error: `读取包信息失败：${meta.error ?? '没有返回数据'}` }
  }

  // dist.tarball 按响应里的实际值走：镜像会把它重写成自己的 host
  const dist = meta.data.dist
  const tarball = isPlainObject(dist) ? asText(dist.tarball) : ''
  if (!tarball) return { ok: false, catalog: null, error: `包信息里没有 dist.tarball（版本 ${asText(meta.data.version) || '未知'}）` }

  const bin = await httpBuffer(tarball, DOWNLOAD_TIMEOUT_MS)
  if (!bin.ok || !bin.buf) {
    return { ok: false, catalog: null, error: `下载 ${tarball} 失败：${bin.error ?? '没有返回数据'}` }
  }

  let inner: Buffer | null | undefined
  try {
    inner = fileFromTarball(bin.buf, CATALOG_ENTRY)
  } catch (e) {
    return { ok: false, catalog: null, error: `解包 ${tarball} 失败：${shortMsg(e)}` }
  }
  if (!inner || inner.length === 0) {
    return { ok: false, catalog: null, error: `${tarball} 里没有 ${CATALOG_ENTRY}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(inner.toString('utf8'))
  } catch (e) {
    return { ok: false, catalog: null, error: `${CATALOG_ENTRY} 不是合法 JSON：${shortMsg(e)}` }
  }

  const checked = asCatalog(parsed, 'npm-package')
  return checked.ok ? { ok: true, catalog: checked.data, error: null } : { ok: false, catalog: null, error: checked.error }
}

/** 直接取官网原件 */
async function fromOrigin(): Promise<SourceResult> {
  const res = await httpJson<unknown>(CATALOG_ORIGIN, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
  if (!res.ok || res.data === null) {
    return { ok: false, catalog: null, error: res.error ?? '没有返回数据' }
  }
  const checked = asCatalog(res.data, 'origin')
  return checked.ok ? { ok: true, catalog: checked.data, error: null } : { ok: false, catalog: null, error: checked.error }
}

/** 一次完整的取数：缓存 → 源链 → 写缓存。绝不抛。 */
async function loadCatalog(
  force: boolean
): Promise<{ catalog: Catalog | null; cached: boolean; warnings: string[]; error: string | null }> {
  const warnings: string[] = []

  if (!force) {
    if (memo && Date.now() - memo.fetchedAt <= CACHE_TTL_MS) {
      return { catalog: memo, cached: true, warnings, error: null }
    }
    const disk = readCache()
    if (disk) {
      memo = disk
      return { catalog: disk, cached: true, warnings, error: null }
    }
  }

  const registry = baseOf(getSettings().registry ?? '')
  const chain: { label: string; run: () => Promise<SourceResult> }[] = []
  if (registry) chain.push({ label: `npm 包（${registry}）`, run: () => fromNpm(registry) })
  if (baseOf(NPM_MIRROR) !== registry) {
    chain.push({ label: `npm 镜像（${NPM_MIRROR}）`, run: () => fromNpm(NPM_MIRROR) })
  }
  chain.push({ label: `官网（${CATALOG_ORIGIN}）`, run: () => fromOrigin() })

  const tried: string[] = []
  for (const step of chain) {
    let res: SourceResult
    try {
      res = await step.run()
    } catch (e) {
      res = { ok: false, catalog: null, error: shortMsg(e) }
    }
    if (res.ok && res.catalog) {
      if (tried.length > 0) warnings.push(`${tried.join('、')} 没拿到目录，已换用「${step.label}」`)
      memo = res.catalog
      writeCache(res.catalog)
      return { catalog: res.catalog, cached: false, warnings, error: null }
    }
    const why = res.error ?? '未知原因'
    tried.push(`${step.label}：${why}`)
  }

  return {
    catalog: null,
    cached: false,
    warnings,
    error: `插件目录拉取失败，试过的源都没给出内容。${tried.map((t, i) => `${'①②③④⑤'[i] ?? `(${i + 1})`} ${t}`).join('；')}。检查「设置 → 网络代理」能不能连上 npm，再点「重新拉取」。`
  }
}

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */

/** 当前 profile 里已经装了的包名集合（小写） */
async function installedNames(profile: string): Promise<Set<string>> {
  const set = new Set<string>()
  if (!profile) return set
  try {
    const list = await listPlugins(profile)
    for (const p of list) {
      if (p && p.installed && typeof p.name === 'string' && p.name.trim() !== '') set.add(p.name.trim().toLowerCase())
    }
  } catch {
    /* 读不到已装列表就当作没装 —— 只影响徽章，别把它变成错误 */
  }
  return set
}

/** 原始条目 → MarketEntry；name 都空的条目直接丢掉 */
function mapPlugin(raw: unknown, installed: Set<string>): MarketEntry | null {
  if (!isPlainObject(raw)) return null
  const name = asText(raw.name)
  if (name === '') return null

  const npm = asNullableText(raw.npm)
  const description = asDescriptionMap(raw.description)
  return {
    name,
    url: asText(raw.url),
    owner: asText(raw.owner),
    categories: normalizeCategories(raw.category),
    description,
    npm,
    icon: asNullableText(raw.icon),
    version: asNullableText(raw.version),
    stars: asNumberOrNull(raw.stars),
    downloads: asNumberOrNull(raw.downloads),
    install: asText(raw.install),
    added: asText(raw.added),
    deprecated: raw.deprecated === true,
    replacement: asNullableText(raw.replacement),
    // 缺省给 []：字段缺失 = 没扫过，空数组 = 扫过没检出（两者的文案在界面上不一样）
    capabilities: asStringList(raw.capabilities),
    capabilityCheckedAt: asNullableText(raw.capabilityCheckedAt),
    installed: installed.has((npm ?? name).toLowerCase())
  }
}

/** 分类列表：按目录里实际用到的分类统计条数，只留 count > 0，按 count 降序 */
function buildCategories(declared: Record<string, Record<string, string>>, plugins: MarketEntry[]): MarketCategory[] {
  const counts = new Map<string, number>()
  for (const p of plugins) {
    for (const id of p.categories) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const out: MarketCategory[] = []
  for (const [id, count] of counts) {
    if (count > 0) out.push({ id, labels: declared[id] ?? {}, count })
  }
  out.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  return out
}

/** 空 / 失败时也要是一份结构完整的 MarketList */
function emptyList(error: string | null, warnings: string[], cached = false): MarketList {
  return {
    ok: false,
    updated: null,
    total: 0,
    categories: [],
    plugins: [],
    source: null,
    cached,
    fetchedAt: Date.now(),
    warnings,
    error
  }
}

/* ------------------------------------------------------------------ *
 * 对外的入口
 * ------------------------------------------------------------------ */

/**
 * 取一份插件目录。
 *
 * - `force === true` 时忽略缓存重拉；
 * - `profile` 只用来判断 installed（不传就用设置里的默认 profile）；
 * - 任何失败都返回结构完整的 MarketList（ok: false + 中文 error），绝不抛。
 *
 * 只做「取数 + 映射」，不做搜索/过滤 —— 那是渲染层的事。
 */
export async function marketList(opts?: MarketListOptions): Promise<MarketList> {
  const force = opts?.force === true
  const key = force ? 'force' : 'plain'
  const running = inflight.get(key)
  if (running) return running

  const task = (async (): Promise<MarketList> => {
    try {
      const profile = (opts?.profile ?? getSettings().defaultProfile ?? '') || ''
      const loaded = await loadCatalog(force)
      if (!loaded.catalog) return emptyList(loaded.error, loaded.warnings)

      const installed = await installedNames(profile)
      const plugins: MarketEntry[] = []
      for (const raw of loaded.catalog.plugins) {
        const entry = mapPlugin(raw, installed)
        if (entry) plugins.push(entry)
      }
      // 稳定顺序：按 added 倒序（新的在前）；added 相同保持目录原序
      plugins.sort((a, b) => b.added.localeCompare(a.added))

      return {
        ok: true,
        updated: loaded.catalog.updated,
        total: plugins.length,
        categories: buildCategories(loaded.catalog.categories, plugins),
        plugins,
        source: loaded.catalog.source ?? null,
        cached: loaded.cached,
        fetchedAt: loaded.catalog.fetchedAt,
        warnings: loaded.warnings,
        error: null
      }
    } catch (e) {
      return emptyList(`插件目录读取失败：${shortMsg(e)}`, [])
    }
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}
