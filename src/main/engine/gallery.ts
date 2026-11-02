/**
 * engine/gallery.ts —— 插件图集：把插件 README 里的截图抓成 data: URL。
 *
 * 设计要点（与 engine/icon.ts 同构）：
 *  1. 三级按「命中率」排序：npm registry 的 readme 字段 → 包内 README → GitHub raw 的 README。
 *     哪一级先抽出可用图片就用哪一级，剩下的不再跑。
 *  2. 本模块**永不抛异常**：所有失败都折成 { ok:false, error:'<中文原因>' }。
 *     注意区分两种「没图」：ok:true + images 为空 = README 读到了但里面没有截图（正常状态）；
 *     ok:false = 连 README 都没读到（网络 / 包不存在）。
 *  3. 模块级内存缓存（key = `${profile}\u0000${name}`，上限 40 条，TTL 10 分钟）
 *     + 并发去重（同一个 key 共用一个在飞 Promise）+ 两道并发闸门：
 *     解析闸门（最多 4 个插件同时解析）与取字节闸门（最多 4 张图同时下载）。
 *  4. 只认 .png/.jpg/.jpeg/.webp/.gif（.svg 全是徽章，一律丢），单张 ≤ 1.5 MB，
 *     还要过 magic bytes 校验才算真图片。
 *  5. 联网一律走 net（httpJson 会按设置里的 proxy 切 Electron session 代理）；
 *     与 icon.ts 一样，二进制 / 纯文本走 electronNet.fetch 并带一条 node:https 直连兜底。
 *
 * 依赖方向：gallery → env（profile 目录）、gallery → inventory（pkgDir）、gallery → net（packument）。不反向依赖。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import * as https from 'node:https'
import { net as electronNet } from 'electron'

import { DEFAULT_SETTINGS } from '../../shared/ipc'
import type { AppSettings, GalleryImage, GalleryResult } from '../../shared/types'
import { getProfileDir } from './env'
import { pkgDir } from './inventory'
import * as net from './net'
import { get as getSettings } from './settings'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 单张截图最大字节数：1.5 MB（超了丢掉并记 warning，绝不截断） */
const MAX_IMAGE_BYTES = Math.round(1.5 * 1024 * 1024)

/** 一个插件最多返回几张图（多了取正文里靠前的） */
const MAX_IMAGES = 8

/**
 * 最多尝试下载几个候选。
 * README 里的图偶尔会 404 / 超限 / 不是真图片，这些槽位不能让死链白占，
 * 所以候选池比 MAX_IMAGES 大：挨个下，凑够 MAX_IMAGES 张成功的就停。
 */
const MAX_IMAGE_ATTEMPTS = 16

/** README 里最多整理几条外链 */
const MAX_LINKS = 6

/** 缓存 TTL：10 分钟 */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 缓存条数上限（超了删最早插入的那条） */
const CACHE_LIMIT = 40

/** 远端单次请求超时 */
const REMOTE_TIMEOUT_MS = 10000

/** README 文本解析上限：超过就只解析前 512 KB */
const MAX_README_BYTES = 512 * 1024

/** 远端 README 超过这个大小直接放弃下载 */
const MAX_README_FETCH_BYTES = 2 * 1024 * 1024

/** 解析闸门 / 取字节闸门的并发上限 */
const MAX_CONCURRENT = 4

const UA = 'DSH-Plugin-Console/0.1'
const RAW_HOST = 'https://raw.githubusercontent.com'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** GitHub raw 上按这个顺序碰 ref */
const GIT_REFS = ['HEAD', 'main', 'master'] as const

/** 包内按这个顺序找 README */
const LOCAL_READMES = ['README.md', 'readme.md', 'README_EN.md', 'README.zh-CN.md', 'docs/README.md'] as const

/** 只认这些扩展名（.svg 一律丢：README 里的 svg 基本都是徽章） */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/**
 * 徽章 / 装饰图：域名或路径命中任意一条就丢。
 * 这些都是 README 顶部「一排小圆标」的常见来源，不是截图。
 */
const BADGE_PATTERNS: RegExp[] = [
  /shields\.io/i,
  /badge/i,
  /badgen/i,
  /codecov/i,
  /travis-ci/i,
  /circleci/i,
  /github\.com\/.*\/workflows\//i,
  /img\.shields/i,
  /opencollective/i,
  /npmjs\.com\/package\/.*\/badge/i,
  /coveralls/i,
  /snyk\.io/i,
  /deepwiki/i,
  /star-history/i,
  /visitor/i,
  /metrics/i
]

/* ------------------------------------------------------------------ *
 * 缓存 + 并发去重
 * ------------------------------------------------------------------ */

interface CacheEntry {
  at: number
  value: GalleryResult
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<GalleryResult>>()

/**
 * 并发闸门。插件列表首屏可能一次问好几个包，每个包一路要打 registry + 十几个远端请求，
 * 所以解析与取字节各设一道闸门，最多同时跑 MAX_CONCURRENT 个。
 * 两道闸门互不嵌套（解析在等取字节时不会再申请解析槽），不会死锁。
 */
function makeGate(limit: number): { acquire: () => Promise<void>; release: () => void } {
  let running = 0
  const waiters: Array<() => void> = []
  return {
    acquire(): Promise<void> {
      if (running < limit) {
        running += 1
        return Promise.resolve()
      }
      return new Promise<void>((resolveSlot) => {
        waiters.push(resolveSlot)
      })
    },
    release(): void {
      running -= 1
      const next = waiters.shift()
      if (next) {
        running += 1
        next()
      }
    }
  }
}

/** 解析闸门：同时最多解析 MAX_CONCURRENT 个插件 */
const resolveGate = makeGate(MAX_CONCURRENT)
/** 取字节闸门：同时最多下载 MAX_CONCURRENT 张图 */
const bytesGate = makeGate(MAX_CONCURRENT)

function cacheKey(profile: string, name: string): string {
  return `${profile}\u0000${name}`
}

function readCache(key: string): GalleryResult | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

/** 写缓存；超过上限删最早插入的（Map 保持插入顺序） */
function remember(key: string, value: GalleryResult): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** 清空图集缓存（给「重试」按钮用） */
export function clearGalleryCache(): void {
  cache.clear()
}

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

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2)
}

function fail(name: string, error: string, warnings: string[] = []): GalleryResult {
  return { ok: false, name, images: [], origin: null, links: [], warnings, error }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asObject(v: unknown): Record<string, unknown> | null {
  return isPlainObject(v) ? v : null
}

function asText(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim()
    return t || null
  }
  return null
}

/** repository 可能是字符串，也可能是 { url: '...' } */
function repoText(v: unknown): string | null {
  const direct = asText(v)
  if (direct) return direct
  const o = asObject(v)
  if (o) return asText(o.url) ?? asText(o.web)
  return null
}

/** child 是否真的在 parent 目录里（挡目录穿越） */
function isInsideDir(parentDir: string, childPath: string): boolean {
  try {
    const parent = resolve(parentDir)
    const child = resolve(childPath)
    if (parent.toLowerCase() === child.toLowerCase()) return true
    const rel = relative(parent, child)
    if (!rel) return true
    if (isAbsolute(rel)) return false
    return !rel.split(/[\\/]/).includes('..')
  } catch {
    return false
  }
}

function registryBase(): string {
  try {
    const s = getSettings() as Partial<AppSettings> | undefined
    const r = s && typeof s === 'object' ? s.registry : null
    const clean = typeof r === 'string' && r.trim() ? r.trim() : DEFAULT_REGISTRY
    return clean.replace(/\/+$/, '')
  } catch {
    /* 设置还没初始化 → 用默认 registry */
    return DEFAULT_SETTINGS.registry.replace(/\/+$/, '')
  }
}

/** 扩展名（只看路径段，忽略 ?query 与 #hash） */
function extOf(ref: string): string {
  const clean = ref.split(/[?#]/)[0] ?? ref
  const at = clean.lastIndexOf('.')
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (at <= slash) return ''
  return clean.slice(at).toLowerCase()
}

function isBadgeUrl(url: string): boolean {
  return BADGE_PATTERNS.some((re) => re.test(url))
}

/* ------------------------------------------------------------------ *
 * 网络
 * ------------------------------------------------------------------ */

interface TextResult {
  ok: boolean
  /** 远端明确说「没有这个文件」（404 / 410）→ 换下一个候选 */
  miss: boolean
  text: string | null
  error: string | null
}

/** node:https 直连兜底（不代理） */
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
      if (u.protocol !== 'https:') {
        done({ ok: false, status: 0, buf: null, error: `直连兜底只支持 https（当前 ${u.protocol}）` })
        return
      }
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
          res.on('error', (e: unknown) => done({ ok: false, status: 0, buf: null, error: `读取响应失败：${shortMsg(e)}` }))
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

/** 抓二进制：electronNet.fetch 优先（继承代理），失败退 node:https 直连 */
async function fetchBuffer(
  url: string,
  maxBytes: number,
  accept: string
): Promise<{ ok: boolean; miss: boolean; buf: Buffer | null; error: string | null }> {
  const tooBig = (size: number): string => `文件超过 ${mb(maxBytes)} MB（实际 ${mb(size)} MB），已放弃`

  let buf: Buffer | null = null
  try {
    const res = await electronNet.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
    })
    if (res.status === 404 || res.status === 410) return { ok: false, miss: true, buf: null, error: null }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, miss: false, buf: null, error: `HTTP ${res.status}` }
    }
    const len = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(len) && len > maxBytes) return { ok: false, miss: false, buf: null, error: tooBig(len) }
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    const primary = shortMsg(e)
    const fallback = await httpsBuffer(url, Math.min(REMOTE_TIMEOUT_MS, 8000))
    if (fallback.status === 404 || fallback.status === 410) return { ok: false, miss: true, buf: null, error: null }
    if (!fallback.ok || !fallback.buf) {
      return {
        ok: false,
        miss: false,
        buf: null,
        error: `请求失败：${primary}；直连兜底也失败：${fallback.error ?? '未知原因'}`
      }
    }
    buf = fallback.buf
  }

  if (!buf || buf.length === 0) return { ok: false, miss: false, buf: null, error: '远端返回了空内容' }
  if (buf.length > maxBytes) return { ok: false, miss: false, buf: null, error: tooBig(buf.length) }
  return { ok: true, miss: false, buf, error: null }
}

/** 抓纯文本（README）。注意不能走 net.httpJson —— 它会把 README 当 JSON 解析掉。 */
async function fetchText(url: string): Promise<TextResult> {
  const got = await fetchBuffer(url, MAX_README_FETCH_BYTES, 'text/plain,text/markdown,*/*;q=0.8')
  if (!got.ok || !got.buf) return { ok: false, miss: got.miss, text: null, error: got.error }
  return { ok: true, miss: false, text: got.buf.toString('utf8'), error: null }
}

/* ------------------------------------------------------------------ *
 * 图片字节校验：magic bytes + 宽高
 * ------------------------------------------------------------------ */

interface Dims {
  width: number | null
  height: number | null
}

/** 按 magic bytes 认图，认不出返回 null（PNG / JPEG / GIF / WebP） */
function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** PNG：IHDR 的宽高在固定偏移（16 / 20），最好读 */
function readPngSize(buf: Buffer): Dims | null {
  if (buf.length < 24) return null
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (!w || !h) return null
  return { width: w, height: h }
}

/** GIF：逻辑屏幕宽高在固定偏移（6 / 8），小端 */
function readGifSize(buf: Buffer): Dims | null {
  if (buf.length < 10) return null
  const w = buf.readUInt16LE(6)
  const h = buf.readUInt16LE(8)
  if (!w || !h) return null
  return { width: w, height: h }
}

/** SOF 段（带尺寸的帧头），注意排除 DHT/JPG/DAC */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

/** JPEG：扫到 SOF 段拿宽高；扫不到给 null（不为这个引依赖） */
function readJpegSize(buf: Buffer): Dims | null {
  let off = 2 // 跳过 SOI (FF D8)
  while (off + 3 < buf.length) {
    if (buf[off] !== 0xff) {
      off += 1
      continue
    }
    const marker = buf[off + 1]
    if (marker === undefined || marker === 0xff) {
      off += 1
      continue
    }
    // 无长度字段的标记：RSTn / SOI / EOI / TEM
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2
      continue
    }
    if (off + 4 > buf.length) return null
    const len = buf.readUInt16BE(off + 2)
    if (len < 2) return null
    if (SOF_MARKERS.has(marker)) {
      if (off + 9 > buf.length) return null
      const h = buf.readUInt16BE(off + 5)
      const w = buf.readUInt16BE(off + 7)
      if (!w || !h) return null
      return { width: w, height: h }
    }
    off += 2 + len
  }
  return null
}

/** WebP：VP8X（扩展）/ VP8（有损）/ VP8L（无损）三种头都读一下 */
function readWebpSize(buf: Buffer): Dims | null {
  if (buf.length < 25) return null
  const fourcc = buf.toString('ascii', 12, 16)
  if (fourcc === 'VP8X' && buf.length >= 30) {
    const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16))
    const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
    return { width: w, height: h }
  }
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    const w = buf.readUInt16LE(26) & 0x3fff
    const h = buf.readUInt16LE(28) & 0x3fff
    if (!w || !h) return null
    return { width: w, height: h }
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function readSize(buf: Buffer, mime: string): Dims {
  const none: Dims = { width: null, height: null }
  try {
    if (mime === 'image/png') return readPngSize(buf) ?? none
    if (mime === 'image/jpeg') return readJpegSize(buf) ?? none
    if (mime === 'image/gif') return readGifSize(buf) ?? none
    if (mime === 'image/webp') return readWebpSize(buf) ?? none
    return none
  } catch {
    return none
  }
}

/* ------------------------------------------------------------------ *
 * README 里抽图 + 抽外链
 * ------------------------------------------------------------------ */

interface GithubRef {
  owner: string
  repo: string
}

function cleanRef(ownerRaw: string, repoRaw: string): GithubRef | null {
  const owner = ownerRaw.replace(/\.git$/i, '').replace(/[?#].*$/, '').trim()
  const repo = repoRaw.replace(/\.git$/i, '').replace(/[?#].*$/, '').trim()
  if (!owner || !repo) return null
  if (owner === '.' || repo === '.') return null
  return { owner, repo }
}

/** 从 homepage / repository 里挖出 github owner/repo；挖不到给 null */
function parseGithubRef(raw: string | null | undefined): GithubRef | null {
  const s0 = asText(raw)
  if (!s0) return null
  const s = s0.replace(/^git\+/i, '').trim()

  const short = /^github:([^/\s]+)\/([^/\s]+)$/i.exec(s)
  if (short) return cleanRef(short[1]!, short[2]!)

  const m = /github\.com[:/]+([^/\s#?]+)\/([^/\s#?]+)/i.exec(s)
  if (!m) return null
  return cleanRef(m[1]!, m[2]!)
}

/** 逐段编码（路径里的 / 要保留成分隔符） */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((p) => p.length > 0)
    .map((p) => encodeURIComponent(p))
    .join('/')
}

/** 把相对路径解析成 GitHub raw 的绝对地址；没有 owner/repo 或协议不支持 → null */
function resolveImageUrl(raw: string, ref: GithubRef | null): string | null {
  let s = raw.trim().replace(/^<|>$/g, '')
  if (!s) return null
  s = s.replace(/&amp;/g, '&').replace(/^\.\//, '')

  if (/^data:/i.test(s)) return null
  if (s.startsWith('//')) return `https:${s}`
  if (/^https?:\/\//i.test(s)) return s
  // 其它协议（mailto / ftp / app 等）不认
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null

  // 到这里是相对路径：必须知道仓库才能拼成 raw 地址
  if (!ref) return null
  const path = s.replace(/^[./\\]+/, '')
  const encoded = encodePath(path)
  if (!encoded) return null
  return `${RAW_HOST}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/HEAD/${encoded}`
}

interface RawImage {
  /** 解析后的绝对 URL */
  url: string
  alt: string | null
  /** 在 README 里的字符下标，用来「取正文里靠前的」 */
  index: number
}

const MD_IMAGE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
const HTML_IMG = /<img\b[^>]*>/gi
const MD_LINK = /(?<!!)\[([^\]]*)\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
const HTML_A = /<a\b[^>]*>([\s\S]*?)<\/a>/gi

/** 取 HTML 标签里的属性（双引号 / 单引号 / 裸值三种写法） */
function attrOf(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const m = re.exec(tag)
  if (!m) return null
  return m[1] ?? m[2] ?? m[3] ?? null
}

function tidyAlt(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t || null
}

/**
 * 从 README 里抽图：markdown 的 `![alt](url)` 与 HTML 的 `<img src>`，
 * 只留真截图（扩展名白名单 + 非徽章 + 非 data:），并按正文出现顺序排。
 */
function extractImages(readme: string, ref: GithubRef | null): RawImage[] {
  const found: RawImage[] = []

  const push = (urlRaw: string | null, altRaw: string | null, index: number): void => {
    if (!urlRaw) return
    const abs = resolveImageUrl(urlRaw, ref)
    if (!abs) return
    if (!IMAGE_EXTS.has(extOf(abs))) return
    if (isBadgeUrl(abs)) return
    found.push({ url: abs, alt: tidyAlt(altRaw), index })
  }

  MD_IMAGE.lastIndex = 0
  for (let m = MD_IMAGE.exec(readme); m; m = MD_IMAGE.exec(readme)) {
    push(m[2] ?? null, m[1] ?? null, m.index)
  }

  HTML_IMG.lastIndex = 0
  for (let m = HTML_IMG.exec(readme); m; m = HTML_IMG.exec(readme)) {
    const tag = m[0]
    push(attrOf(tag, 'src'), attrOf(tag, 'alt') ?? attrOf(tag, 'title'), m.index)
  }

  // 按正文顺序，再按解析后的绝对 URL 去重
  found.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: RawImage[] = []
  for (const img of found) {
    if (seen.has(img.url)) continue
    seen.add(img.url)
    out.push(img)
  }
  return out
}

/** 从 README 里整理外链（过滤图片链接与徽章域名，按正文顺序，最多 MAX_LINKS 条） */
function extractLinks(readme: string): { label: string; url: string }[] {
  const found: { label: string; url: string; index: number }[] = []

  const push = (label: string, urlRaw: string | null, index: number): void => {
    if (!urlRaw) return
    const text = tidyAlt(label)
    let s = urlRaw.trim().replace(/^<|>$/g, '')
    if (!s) return
    if (s.startsWith('//')) s = `https:${s}`
    if (!/^https?:\/\//i.test(s)) return
    if (isBadgeUrl(s)) return
    if (IMAGE_EXTS.has(extOf(s))) return
    if (!text) return
    found.push({ label: text, url: s, index })
  }

  MD_LINK.lastIndex = 0
  for (let m = MD_LINK.exec(readme); m; m = MD_LINK.exec(readme)) {
    push(m[1] ?? '', m[2] ?? null, m.index)
  }

  HTML_A.lastIndex = 0
  for (let m = HTML_A.exec(readme); m; m = HTML_A.exec(readme)) {
    const tag = m[0]
    const href = attrOf(tag, 'href')
    // 锚点链接（<a name> / 纯占位）没有 href，直接跳过
    if (!href) continue
    const inner = tidyAlt((m[1] ?? '').replace(/<[^>]*>/g, ' ')) ?? href
    push(inner, href, m.index)
  }

  found.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: { label: string; url: string }[] = []
  for (const link of found) {
    if (seen.has(link.url)) continue
    seen.add(link.url)
    out.push({ label: link.label, url: link.url })
    if (out.length >= MAX_LINKS) break
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 取字节 → data URL
 * ------------------------------------------------------------------ */

interface LoadedImages {
  images: GalleryImage[]
  warnings: string[]
}

/** 下载一张图并转 data URL；任何一步不达标都返回 null + 中文原因 */
async function loadImage(
  img: RawImage,
  source: GalleryImage['source']
): Promise<{ image: GalleryImage | null; warning: string | null }> {
  await bytesGate.acquire()
  try {
    const got = await fetchBuffer(img.url, MAX_IMAGE_BYTES, 'image/*,*/*;q=0.8')
    if (!got.ok || !got.buf) {
      if (got.miss) return { image: null, warning: `这张图 404 了，已跳过：${img.url}` }
      return { image: null, warning: `这张图没取到（${got.error ?? '未知原因'}）：${img.url}` }
    }
    const mime = sniffImage(got.buf)
    if (!mime) return { image: null, warning: `拿到的字节不是图片（magic bytes 不匹配），已跳过：${img.url}` }
    const dims = readSize(got.buf, mime)
    return {
      image: {
        dataUrl: `data:${mime};base64,${got.buf.toString('base64')}`,
        url: img.url,
        width: dims.width,
        height: dims.height,
        source,
        alt: img.alt,
        bytes: got.buf.length
      },
      warning: null
    }
  } catch (e) {
    return { image: null, warning: `下载这张图时出错（${shortMsg(e)}）：${img.url}` }
  } finally {
    bytesGate.release()
  }
}

/**
 * 并发下载（闸门已限制同时在飞的数量）：候选按正文顺序排队，凑够 MAX_IMAGES 张成功的才收工。
 * 保序返回——谁在 README 里靠前，谁就在前面。
 */
async function loadAll(candidates: RawImage[], source: GalleryImage['source']): Promise<LoadedImages> {
  const warnings: string[] = []
  const queue = candidates.slice(0, MAX_IMAGE_ATTEMPTS)
  const hits: Array<{ index: number; image: GalleryImage }> = []
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (hits.length >= MAX_IMAGES) return
      const index = cursor
      cursor += 1
      const img = queue[index]
      if (!img) return
      const slot = await loadImage(img, source)
      if (slot.warning) warnings.push(slot.warning)
      if (slot.image && hits.length < MAX_IMAGES) hits.push({ index, image: slot.image })
    }
  }

  const workers = Math.min(MAX_CONCURRENT, queue.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))

  hits.sort((a, b) => a.index - b.index)
  return { images: hits.slice(0, MAX_IMAGES).map((h) => h.image), warnings }
}

/* ------------------------------------------------------------------ *
 * 第 1 级：npm registry 的 readme 字段
 * ------------------------------------------------------------------ */

interface RegistryReadme {
  readme: string | null
  ref: GithubRef | null
  error: string | null
}

async function lookupRegistryReadme(name: string): Promise<RegistryReadme> {
  // scoped 名字里的 `/` 保留、`@` 不编码：https://registry.npmjs.org/@scope/name 是合法请求
  const url = `${registryBase()}/${name}`
  const res = await net.httpJson<Record<string, unknown>>(url, {
    timeoutMs: 15000,
    headers: { Accept: 'application/json' }
  })
  if (res.status === 404) return { readme: null, ref: null, error: 'npm registry 上没有这个包' }
  if (!res.ok || !res.data) return { readme: null, ref: null, error: res.error ?? '请求 npm registry 失败' }

  const data = res.data
  const versions = asObject(data.versions)
  const latest = asText(asObject(data['dist-tags'])?.latest)
  const ver = latest && versions ? asObject(versions[latest]) : null

  const readme = asText(data.readme) ?? asText(ver?.readme)
  const ref =
    parseGithubRef(repoText(ver?.repository)) ??
    parseGithubRef(asText(ver?.homepage)) ??
    parseGithubRef(repoText(data.repository)) ??
    parseGithubRef(asText(data.homepage))

  return { readme, ref, error: null }
}

/* ------------------------------------------------------------------ *
 * 第 2 级：包内 README
 * ------------------------------------------------------------------ */

interface LocalReadme {
  text: string | null
  /** 命中的相对路径，如 `README.md` */
  rel: string | null
  error: string | null
}

function lookupLocalReadme(dir: string): LocalReadme {
  let lastError: string | null = null
  for (const rel of LOCAL_READMES) {
    const abs = join(dir, rel)
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue
      const text = readFileSync(abs, 'utf8')
      if (!text.trim()) {
        lastError = `包内 ${rel} 是空文件`
        continue
      }
      return { text, rel, error: null }
    } catch (e) {
      lastError = `读包内 ${rel} 失败：${shortMsg(e)}`
    }
  }
  return { text: null, rel: null, error: lastError }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 一份 README 抽图抽链的通用步骤：抽到候选就取字节，取到就收工 */
async function harvest(
  readme: string,
  origin: string,
  source: GalleryImage['source'],
  ref: GithubRef | null,
  warnings: string[]
): Promise<GalleryResult | null> {
  // 截图都在正文靠前的位置，超长 README 只解析前 512 KB，省掉无谓的正则扫描
  if (readme.length > MAX_README_BYTES) {
    warnings.push(`README 太长（${Math.round(readme.length / 1024)} KB），只解析前 512 KB`)
    readme = readme.slice(0, MAX_README_BYTES)
  }

  const all = extractImages(readme, ref)
  if (all.length === 0) return null

  const links = extractLinks(readme)
  const candidates = all.slice(0, MAX_IMAGE_ATTEMPTS)
  if (all.length > MAX_IMAGES) {
    warnings.push(`README 里有 ${all.length} 张图，最多取正文里靠前的 ${MAX_IMAGES} 张`)
  }

  const loaded = await loadAll(candidates, source)
  warnings.push(...loaded.warnings)
  if (loaded.images.length === 0) return null

  return {
    ok: true,
    name: '',
    images: loaded.images,
    origin,
    links,
    warnings,
    error: null
  }
}

/** 三级降级的真实实现 —— 永不抛 */
async function resolveGallery(cleanProfile: string, cleanName: string): Promise<GalleryResult> {
  const warnings: string[] = []

  /* ---- 本地包目录（第 2 级的输入，也是 package.json 的来源） ---- */
  const profileDir = getProfileDir(cleanProfile)
  const nodeModulesDir = join(profileDir, 'node_modules')
  const dir = pkgDir(profileDir, cleanName)

  // 包名里带 .. / 绝对路径 → 直接当「没有这个包」，别去读 profile 目录外的东西
  if (!isInsideDir(nodeModulesDir, dir)) {
    return fail(cleanName, '包名不合法，指向了 node_modules 目录之外')
  }

  let hasDir = false
  try {
    hasDir = existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    hasDir = false
  }

  let pkgJson: Record<string, unknown> | null = null
  if (hasDir) {
    try {
      const text = readFileSync(join(dir, 'package.json'), 'utf8')
      pkgJson = asObject(JSON.parse(text) as unknown)
    } catch {
      pkgJson = null // 读不到不算致命：还有 registry 与 GitHub 两级
    }
  } else {
    // 快速路径：包目录不存在就别再探本地文件了，直接走 registry
    warnings.push('这个包在当前 profile 的 node_modules 里没有目录，跳过包内 README')
  }

  const localRef =
    parseGithubRef(repoText(pkgJson?.repository)) ?? parseGithubRef(repoText(pkgJson?.homepage))

  /* ---- 第 1 级：npm registry 的 readme 字段（命中率最高） ---- */
  let registryReadme: string | null = null
  let ref: GithubRef | null = localRef
  /** 读到过、但没抽出可用截图的第一份 README：用它给「这个插件没有截图」提供正文与外链 */
  let readmeText: string | null = null
  let readmeOrigin: string | null = null
  try {
    const pack = await lookupRegistryReadme(cleanName)
    if (pack.error) warnings.push(`查 npm registry 失败：${pack.error}`)
    registryReadme = pack.readme
    ref = localRef ?? pack.ref
    if (registryReadme) {
      readmeText = registryReadme
      readmeOrigin = 'npm registry 的 readme 字段'
      const hit = await harvest(registryReadme, 'npm registry 的 readme 字段', 'npm-readme', ref, warnings)
      if (hit) return { ...hit, name: cleanName }
    }
  } catch (e) {
    warnings.push(`查 npm registry 时出错：${shortMsg(e)}`)
  }

  /* ---- 第 2 级：包内 README ---- */
  if (hasDir) {
    try {
      const local = lookupLocalReadme(dir)
      if (local.text && local.rel) {
        // 包内 README 比 registry 的 readme 字段更「新」，但只当兜底：没有图就别抢 origins
        if (!readmeText) {
          readmeText = local.text
          readmeOrigin = `包内 ${local.rel}`
        }
        const hit = await harvest(local.text, `包内 ${local.rel}`, 'readme', ref, warnings)
        if (hit) return { ...hit, name: cleanName }
      } else if (local.error) {
        warnings.push(local.error)
      }
    } catch (e) {
      warnings.push(`读包内 README 时出错：${shortMsg(e)}`)
    }
  }

  /* ---- 第 3 级：GitHub raw 的 README（不用 api.github.com：匿名额度已经打光） ---- */
  if (ref) {
    try {
      for (const gitRef of GIT_REFS) {
        const url = `${RAW_HOST}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${encodeURIComponent(gitRef)}/README.md`
        const got = await fetchText(url)
        if (!got.ok || !got.text) continue
        const hit = await harvest(got.text, `GitHub raw 的 README.md（${gitRef}）`, 'readme', ref, warnings)
        if (hit) return { ...hit, name: cleanName }
        // 读到了 README 但里面没有可用截图 → 换 ref 也是同一份文件，直接把这份当「最接近的一段正文」
        readmeText = got.text
        readmeOrigin = `GitHub raw 的 README.md（${gitRef}）`
        break
      }
    } catch (e) {
      warnings.push(`读 GitHub raw 的 README 时出错：${shortMsg(e)}`)
    }
  } else if (!hasDir && !registryReadme) {
    warnings.push('没能从这个包的 package.json 或 registry 元数据里推出 GitHub 仓库，跳过 GitHub 这一级')
  }

  /* ---- 三级都没抽到图：区分「README 读到了但没截图」与「连 README 都没读到」 ---- */
  if (readmeText) {
    warnings.push('这份 README 里没有可用的截图')
    return {
      ok: true,
      name: cleanName,
      images: [],
      origin: readmeOrigin,
      links: extractLinks(readmeText),
      warnings,
      error: null
    }
  }
  const tail = warnings.slice(0, 3).join('；')
  return fail(
    cleanName,
    tail
      ? `没读到这个插件的 README（npm registry 的 readme 字段、包内 README、GitHub raw 都试过了）：${tail}`
      : '没读到这个插件的 README（npm registry 的 readme 字段、包内 README、GitHub raw 都试过了）',
    warnings
  )
}

/**
 * 取插件图集（README 截图，已转成 data: URL）。**永不抛异常**，永不返回 null。
 *
 * @param profile profile 名（如 desktop）
 * @param name    包名（如 dsh-pet / @liustack/modsearch）
 */
export function pluginGallery(profile: string, name: string): Promise<GalleryResult> {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  const cleanProfile = typeof profile === 'string' ? profile.trim() : ''
  if (!cleanName) return Promise.resolve(fail(cleanName, '包名为空，无法解析图集'))

  const key = cacheKey(cleanProfile, cleanName)

  const cached = readCache(key)
  if (cached) return Promise.resolve({ ...cached })

  const going = inflight.get(key)
  if (going) return going

  const task = (async (): Promise<GalleryResult> => {
    await resolveGate.acquire()
    try {
      const out = await resolveGallery(cleanProfile, cleanName)
      remember(key, out)
      return out
    } catch (e) {
      const out = fail(cleanName, `解析图集时出错：${shortMsg(e)}`)
      remember(key, out)
      return out
    } finally {
      resolveGate.release()
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}
