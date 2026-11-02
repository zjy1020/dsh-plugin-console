/**
 * engine/icon.ts —— 插件图标解析（三级降级）。
 *
 * 设计要点：
 *  1. 三级按「可靠性」排序：本地包内文件 → npm registry 元数据推出的 GitHub 仓库 → 本地 package.json 推出的 GitHub 仓库。
 *     任何一级命中就立刻返回，不再往下试。
 *  2. 本模块**永不抛异常**：所有失败都折成 { ok:false, error:'<中文原因>' }，让渲染层用 monogram 兜底。
 *  3. 模块级内存缓存（key = `${profile}\u0000${name}`，上限 200 条）+ 并发去重（同一个 key 共用一个在飞 Promise），
 *     列表里 31 个插件同时 mount 也不会打出 31 份重复请求。
 *  4. 只认白名单扩展名、单张 ≤ 512 KB；超限直接放弃并报错，绝不截断。
 *
 * 依赖方向：icon → env（profile 目录）、icon → net（registry 元数据）。不反向依赖。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import * as https from 'node:https'
import { net as electronNet } from 'electron'

import type { PluginIconResult } from '../../shared/types'
import { getProfileDir } from './env'
import * as net from './net'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 单张图标最大字节数：512 KB */
const MAX_ICON_BYTES = 512 * 1024

/** 缓存条数上限（超了删最早插入的那条） */
const CACHE_LIMIT = 200

/** 远端单次请求超时 */
const REMOTE_TIMEOUT_MS = 10000

const RAW_HOST = 'https://raw.githubusercontent.com'

const UA = 'DSH-Plugin-Console/0.1'

/** 只接受这些扩展名 → MIME */
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

/** package.json 里声明图标的位置（按优先级） */
const FIELD_NAMES = ['icon', 'logo', 'image'] as const

/** 包内常见候选文件名（字段没写时按这个顺序碰运气） */
const LOCAL_CANDIDATES = [
  'icon.png',
  'logo.png',
  'assets/icon.png',
  'assets/logo.png',
  'icon.svg',
  'logo.svg',
  'assets/icon.svg',
  'assets/logo.svg',
  'public/icon.png',
  'dist/icon.png'
]

/** GitHub 仓库里找图时请求的相对路径（前四个是契约里写死的，后三个是同风格补充） */
/**
 * 第 2 / 3 级在 GitHub 仓库根目录按这些相对路径找图。
 * public/ 与 build/ 是 Electron / Vite 系项目放图标的常见位置，别漏。
 */
const REPO_CANDIDATES = [
  'icon.png',
  'logo.png',
  'assets/icon.png',
  'docs/logo.png',
  'public/icon.png',
  'public/logo.png',
  'build/icon.png',
  'icon.svg',
  'logo.svg',
  'assets/logo.svg'
]

/* ------------------------------------------------------------------ *
 * 缓存 + 并发去重
 * ------------------------------------------------------------------ */

const cache = new Map<string, PluginIconResult>()
const inflight = new Map<string, Promise<PluginIconResult>>()

/**
 * 并发闸门：插件列表首屏会一次性问 20+ 个包，本地有图标的一瞬间就回，
 * 没图标的一路要打 npm registry + 十几次 raw.githubusercontent 探测。
 * 不设闸门的话同一时刻会有几十个外部请求排队，所以最多同时跑 MAX_CONCURRENT 个解析。
 */
const MAX_CONCURRENT = 4
let running = 0
const waiters: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolveSlot) => {
    waiters.push(resolveSlot)
  })
}

function releaseSlot(): void {
  running -= 1
  const next = waiters.shift()
  if (next) {
    running += 1
    next()
  }
}

function cacheKey(profile: string, name: string): string {
  return `${profile}\u0000${name}`
}

/** 写缓存；超过上限删最早插入的（Map 保持插入顺序） */
function remember(key: string, value: PluginIconResult): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** 清空图标缓存（给「刷新」按钮用） */
export function clearIconCache(): void {
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

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}

function fail(name: string, error: string): PluginIconResult {
  return { ok: false, name, dataUrl: null, source: null, error }
}

function hit(name: string, dataUrl: string, source: string): PluginIconResult {
  return { ok: true, name, dataUrl, source, error: null }
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

/** 字段值可能是字符串，也可能是 { path: '...' } 这种对象 */
function pathField(v: unknown): string | null {
  const direct = asText(v)
  if (direct) return direct
  const o = asObject(v)
  if (!o) return null
  for (const key of ['path', 'src', 'file', 'url', 'uri']) {
    const t = asText(o[key])
    if (t) return t
  }
  return null
}

/** 远端 / data URI 不算「包内文件」 */
function isRemoteRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref)
}

function extOf(ref: string): string {
  const clean = ref.split(/[?#]/)[0] ?? ref
  return extname(clean).toLowerCase()
}

function mimeOf(ext: string): string | null {
  return Object.prototype.hasOwnProperty.call(EXT_MIME, ext) ? EXT_MIME[ext] : null
}

/** `data:image/png;base64,...`（svg 走 svg 前缀） */
function toDataUrl(buf: Buffer, ext: string): string | null {
  const mime = mimeOf(ext)
  if (!mime) return null
  const head = ext === '.svg' ? 'data:image/svg+xml;base64,' : `data:${mime};base64,`
  return head + buf.toString('base64')
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

/* ------------------------------------------------------------------ *
 * 本地文件读取
 * ------------------------------------------------------------------ */

interface FileProbe {
  /** 命中且是合法图片 */
  ok: boolean
  dataUrl: string | null
  /** 命中但不可用（超限 / 空文件 / 扩展名不支持 / 读失败）时的中文原因 */
  error: string | null
  /** 文件是否存在 */
  exists: boolean
}

/**
 * 读一个本地图片文件。
 * 超限 / 扩展名不支持属于「命中但不可用」，调用方应当把 error 带出去（不要静默换下一个）。
 */
function probeFile(absPath: string, ext: string): FileProbe {
  const miss: FileProbe = { ok: false, dataUrl: null, error: null, exists: false }
  try {
    if (!existsSync(absPath)) return miss
    if (!mimeOf(ext)) {
      return { ok: false, dataUrl: null, error: `不支持的图标扩展名：${ext || '（没有扩展名）'}`, exists: true }
    }
    let size = 0
    try {
      const st = statSync(absPath)
      if (!st.isFile()) {
        return { ok: false, dataUrl: null, error: `图标路径不是文件：${absPath}`, exists: true }
      }
      size = st.size
    } catch (e) {
      return { ok: false, dataUrl: null, error: `读取图标文件信息失败：${shortMsg(e)}`, exists: true }
    }
    if (size > MAX_ICON_BYTES) {
      return {
        ok: false,
        dataUrl: null,
        error: `图标文件超过 512 KB（实际 ${kb(size)} KB），已放弃`,
        exists: true
      }
    }
    if (size === 0) {
      return { ok: false, dataUrl: null, error: '图标文件是空文件，已放弃', exists: true }
    }
    const buf = readFileSync(absPath)
    if (buf.length > MAX_ICON_BYTES) {
      return {
        ok: false,
        dataUrl: null,
        error: `图标文件超过 512 KB（实际 ${kb(buf.length)} KB），已放弃`,
        exists: true
      }
    }
    const dataUrl = toDataUrl(buf, ext)
    if (!dataUrl) {
      return { ok: false, dataUrl: null, error: `不支持的图标扩展名：${ext || '（没有扩展名）'}`, exists: true }
    }
    return { ok: true, dataUrl, error: null, exists: true }
  } catch (e) {
    return { ok: false, dataUrl: null, error: `读取图标文件失败：${shortMsg(e)}`, exists: true }
  }
}

/* ------------------------------------------------------------------ *
 * 第 1 级：包内文件
 * ------------------------------------------------------------------ */

/** 收集 package.json 里声明过图标路径的字段（按优先级，处理字符串 / { path } 两种写法） */
function fieldRefs(pkg: Record<string, unknown> | null): string[] {
  const out: string[] = []
  if (!pkg) return out

  const push = (v: unknown): void => {
    const p = pathField(v)
    if (p) out.push(p)
  }

  for (const f of FIELD_NAMES) push(pkg[f])

  const dsh = asObject(pkg.dsh)
  if (dsh) {
    for (const f of FIELD_NAMES) push(dsh[f])
    push(dsh.mark)
    const client = asObject(dsh.client)
    if (client) push(client.icon)
  }

  return out
}

interface LocalLookup {
  result: PluginIconResult | null
  /** 命中但不可用的原因（超限等），用于最终错误文案 */
  hardError: string | null
  notes: string[]
  pkgJson: Record<string, unknown> | null
}

/** 第 1 级：在 <profileDir>/node_modules/<name> 里找图 */
function lookupLocal(name: string, pkgDir: string): LocalLookup {
  const notes: string[] = []

  let pkgJson: Record<string, unknown> | null = null
  try {
    const text = readFileSync(join(pkgDir, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(text)
    pkgJson = asObject(parsed)
  } catch {
    // package.json 读不到不算致命：还有候选文件名可以碰
    pkgJson = null
  }
  const out: LocalLookup = { result: null, hardError: null, notes, pkgJson }

  /* 1a. package.json 声明的字段 */
  for (const raw of fieldRefs(pkgJson)) {
    if (isRemoteRef(raw)) {
      notes.push(`图标字段是远端地址，本地这级跳过：${raw}`)
      continue
    }
    const abs = resolve(pkgDir, raw)
    if (!isInsideDir(pkgDir, abs)) {
      notes.push(`图标字段指向包目录外，已忽略：${raw}`)
      continue
    }
    const probe = probeFile(abs, extOf(raw))
    if (probe.ok && probe.dataUrl) {
      out.result = hit(name, probe.dataUrl, 'package')
      return out
    }
    if (probe.exists && probe.error) {
      out.hardError = probe.error
      return out
    }
  }

  /* 1b. 常见候选文件名 */
  for (const rel of LOCAL_CANDIDATES) {
    const abs = join(pkgDir, rel)
    const probe = probeFile(abs, extOf(rel))
    if (probe.ok && probe.dataUrl) {
      out.result = hit(name, probe.dataUrl, 'package')
      return out
    }
    if (probe.exists && probe.error) {
      out.hardError = probe.error
      return out
    }
  }

  return out
}

/* ------------------------------------------------------------------ *
 * 第 2 / 3 级：GitHub 仓库
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

  // github:owner/repo
  const short = /^github:([^/\s]+)\/([^/\s]+)$/i.exec(s)
  if (short) return cleanRef(short[1]!, short[2]!)

  const m = /github\.com[:/]+([^/\s#?]+)\/([^/\s#?]+)/i.exec(s)
  if (!m) return null
  return cleanRef(m[1]!, m[2]!)
}

function repoText(v: unknown): string | null {
  const direct = asText(v)
  if (direct) return direct
  const o = asObject(v)
  if (o) return asText(o.url) ?? asText(o.web)
  return null
}

/** node:https 直连兜底（不代理） */
function httpsBuffer(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; buf: Buffer | null; error: string | null }> {
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

interface RemoteProbe {
  ok: boolean
  dataUrl: string | null
  /** 404 之类：这一条路径没有这个文件，继续试下一条 */
  miss: boolean
  error: string | null
}

/** 远端响应像不像 HTML 错误页（SVG 允许以 <?xml / <!DOCTYPE svg 开头，所以只挡 <html） */
function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString('utf8')
  return /<html[\s>]/i.test(head)
}

/** 拉一张远端图片并按契约校验（扩展名 / 大小 / 是不是真图片） */
async function fetchRemoteImage(url: string): Promise<RemoteProbe> {
  const ext = extOf(url)
  if (!mimeOf(ext)) return { ok: false, dataUrl: null, miss: true, error: null }

  let buf: Buffer | null = null
  try {
    const res = await electronNet.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
    })
    if (res.status === 404 || res.status === 410) return { ok: false, dataUrl: null, miss: true, error: null }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, dataUrl: null, miss: false, error: `HTTP ${res.status}` }
    }
    const ab = await res.arrayBuffer()
    buf = Buffer.from(ab)
  } catch (e) {
    const primary = shortMsg(e)
    const fallback = await httpsBuffer(url, Math.min(REMOTE_TIMEOUT_MS, 8000))
    if (fallback.status === 404 || fallback.status === 410) return { ok: false, dataUrl: null, miss: true, error: null }
    if (!fallback.ok || !fallback.buf) {
      return { ok: false, dataUrl: null, miss: false, error: `请求失败：${primary}；直连兜底也失败：${fallback.error ?? '未知原因'}` }
    }
    buf = fallback.buf
  }

  if (!buf || buf.length === 0) return { ok: false, dataUrl: null, miss: false, error: '远端返回了空内容' }
  if (buf.length > MAX_ICON_BYTES) {
    return { ok: false, dataUrl: null, miss: false, error: `远端图标超过 512 KB（实际 ${kb(buf.length)} KB），已放弃` }
  }
  if (looksLikeHtml(buf)) return { ok: false, dataUrl: null, miss: false, error: '远端返回的不是图片（像是 HTML 页面）' }

  const dataUrl = toDataUrl(buf, ext)
  if (!dataUrl) return { ok: false, dataUrl: null, miss: true, error: null }
  return { ok: true, dataUrl, miss: false, error: null }
}

/**
 * 第 2 / 3 级：在一个 GitHub 仓库里按 REPO_CANDIDATES 找图。
 * 命中返回结果；没命中返回 null 并把原因写进 notes。
 */
async function tryGithub(
  ref: GithubRef | null,
  source: string,
  name: string,
  seen: Set<string>,
  notes: string[]
): Promise<PluginIconResult | null> {
  if (!ref) return null
  const slug = `${ref.owner}/${ref.repo}`.toLowerCase()
  if (seen.has(slug)) return null
  seen.add(slug)

  for (const rel of REPO_CANDIDATES) {
    const url = `${RAW_HOST}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/HEAD/${rel}`
    const probe = await fetchRemoteImage(url)
    if (probe.ok && probe.dataUrl) return hit(name, probe.dataUrl, source)
    if (!probe.miss && probe.error) {
      notes.push(`${slug} 的 ${rel}：${probe.error}`)
      // 这一条路径不是「没有文件」而是「拿到了但不能用」，继续试下一条更稳
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 三级降级的真实实现 */
async function resolveIcon(cleanProfile: string, cleanName: string): Promise<PluginIconResult> {
  const nodeModulesDir = join(getProfileDir(cleanProfile), 'node_modules')
  const pkgDir = resolve(nodeModulesDir, cleanName)

  // 包名里带 .. / 绝对路径 → 直接当「没有这个包」
  if (!isInsideDir(nodeModulesDir, pkgDir)) {
    return fail(cleanName, '这个包在当前 profile 里没有 node_modules 目录')
  }

  let hasDir = false
  try {
    hasDir = existsSync(pkgDir) && statSync(pkgDir).isDirectory()
  } catch {
    hasDir = false
  }
  if (!hasDir) {
    return fail(cleanName, '这个包在当前 profile 里没有 node_modules 目录')
  }

  const notes: string[] = []

  /* ---- 第 1 级：包内文件 ---- */
  const local = lookupLocal(cleanName, pkgDir)
  notes.push(...local.notes)
  if (local.result) return local.result
  if (local.hardError) return fail(cleanName, local.hardError)

  /* ---- 第 2 级：npm registry 元数据 → GitHub 仓库 ---- */
  const seen = new Set<string>()
  try {
    const pack = await net.registryPackument(cleanName)
    const ref = parseGithubRef(pack.repository) ?? parseGithubRef(pack.homepage)
    if (ref) {
      const got = await tryGithub(ref, 'registry', cleanName, seen, notes)
      if (got) return got
    }
  } catch (e) {
    notes.push(`查 npm registry 失败：${shortMsg(e)}`)
  }

  /* ---- 第 3 级：本地 package.json 的 repository / homepage → GitHub 仓库 ---- */
  try {
    const ref = parseGithubRef(repoText(local.pkgJson?.repository)) ?? parseGithubRef(repoText(local.pkgJson?.homepage))
    if (ref) {
      const got = await tryGithub(ref, 'repo', cleanName, seen, notes)
      if (got) return got
    }
  } catch (e) {
    notes.push(`解析 package.json 里的仓库地址失败：${shortMsg(e)}`)
  }

  const tail = notes.slice(0, 3).join('；')
  return fail(
    cleanName,
    tail
      ? `没找到这个插件的图标（包内文件、npm registry、GitHub 都试过了）：${tail}`
      : '没找到这个插件的图标（package.json 图标字段、包内常见文件名、npm registry、GitHub 都试过了）'
  )
}

/**
 * 取插件图标。**永不抛异常**，永不返回 null。
 *
 * @param profile profile 名（如 desktop）
 * @param name    包名（如 dsh-context / @liustack/modsearch）
 */
export function pluginIcon(profile: string, name: string): Promise<PluginIconResult> {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  const cleanProfile = typeof profile === 'string' ? profile.trim() : ''
  if (!cleanName) return Promise.resolve(fail(cleanName, '包名为空，无法解析图标'))

  const key = cacheKey(cleanProfile, cleanName)

  const cached = cache.get(key)
  if (cached) return Promise.resolve({ ...cached })

  const going = inflight.get(key)
  if (going) return going

  const task = (async (): Promise<PluginIconResult> => {
    await acquireSlot()
    try {
      const out = await resolveIcon(cleanProfile, cleanName)
      remember(key, out)
      return out
    } catch (e) {
      const out = fail(cleanName, `解析图标时出错：${shortMsg(e)}`)
      remember(key, out)
      return out
    } finally {
      releaseSlot()
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}
