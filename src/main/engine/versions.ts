/**
 * versions.ts —— 可安装版本 / 标签 / 分支的枚举（版本选择 + 降级的基础设施）。
 *
 * 两条分支：
 *   - npm 分支：拉完整 packument（`<registry>/<包名>`），把 dist-tags 与全部正式版本
 *     折成 VersionOption 列表；版本排序与升降判断一律走 updates.compareVersions。
 *   - git 分支：**不走 api.github.com**（未认证 60 次/小时，实测出口 IP 早被打光），
 *     改用本机 `git ls-remote --symref --refs --heads --tags <url>` 拿 refs。
 *
 * 约定：
 *   - 本模块对外**永不抛异常**，任何失败都返回结构完整的 VersionList（ok:false + 中文 error）。
 *   - 成功结果进 60 秒进程内缓存（用户在列表里来回切包时不必每次都打网络），失败不缓存。
 *   - 所有条目只描述事实，不做安装动作；真正执行由 ops.ts 负责。
 */

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { ParsedSpec, VersionList, VersionOption } from '../../shared/types'
import { listPlugins } from './inventory'
import * as net from './net'
import * as pnpm from './pnpm'
import { get as getSettings } from './settings'
import { parseSpec } from './spec'
import { compareVersions } from './updates'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** 成功结果缓存时长：60 秒 */
const CACHE_TTL_MS = 60 * 1000

/** packument 请求超时 */
const PACKUMENT_TIMEOUT_MS = 20 * 1000
/** packument 体积上限（用 JSON 文本长度粗判，不为了这个去改 net.ts） */
const MAX_PACKUMENT_CHARS = 8 * 1024 * 1024

/** 展示的正式版本上限（dist-tag 不算在内） */
const MAX_VERSION_OPTIONS = 60
/**
 * git 每个类别（标签 / 分支）各 80 条上限。
 *
 * 为什么不合成一个「总共 80 个 ref」：semver 标签动辄一两百个（实测目标仓库 195 个标签 / 28 个分支），
 * 合并计数会被标签吃满、分支一条都不剩 —— 而「给 GitHub 链接挑分支安装」正是本功能的主用途之一。
 * 所以按类别各自封顶，被砍就置 truncated。
 */
const MAX_GIT_TAGS = 80
const MAX_GIT_BRANCHES = 80

const GIT_TIMEOUT_MS = 60 * 1000
const GIT_HEAD_TIMEOUT_MS = 30 * 1000
/** 错误信息里截取的日志长度 */
const LOG_SNIPPET_MAX = 200

const GIT_WARN = '私有仓库需要配置 SSH 凭据；公开仓库请确认代理可用。'
const REGISTRY_WARN = '可以检查一下设置里的代理和 registry。'

/* ------------------------------------------------------------------ *
 * 缓存（只缓存成功结果）
 * ------------------------------------------------------------------ */

interface CacheEntry {
  at: number
  data: VersionList
}

const cache = new Map<string, CacheEntry>()

function cloneList(v: VersionList): VersionList {
  return {
    ...v,
    options: v.options.map((o) => ({ ...o })),
    warnings: v.warnings.slice()
  }
}

function readCache(key: string): VersionList | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return cloneList(hit.data)
}

function writeCache(key: string, data: VersionList): void {
  if (!data.ok) return // 失败不缓存：用户点「重试」必须真的重新打网络
  cache.set(key, { at: Date.now(), data: cloneList(data) })
}

/** 清空版本列表缓存（换 registry / 换代理 / 手动刷新时调） */
export function clearVersionsCache(): void {
  cache.clear()
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message || e.name : String(e)
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > 160 ? `${t.slice(0, 160)}…` : t || '未知原因'
}

/** 日志尾部摘要（只留最后几行，够定位就行） */
function snippet(text: string): string {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const tail = lines.slice(-4).join(' / ')
  if (!tail) return '没有输出'
  return tail.length > LOG_SNIPPET_MAX ? `${tail.slice(0, LOG_SNIPPET_MAX)}…` : tail
}

function registryBase(): string {
  try {
    const r = getSettings().registry
    const clean = typeof r === 'string' && r.trim() ? r.trim() : DEFAULT_REGISTRY
    return clean.replace(/\/+$/, '') || DEFAULT_REGISTRY
  } catch {
    return DEFAULT_REGISTRY
  }
}

function proxyOf(): string | null {
  try {
    const p = getSettings().proxy
    return typeof p === 'string' && p.trim() ? p.trim() : null
  } catch {
    return null
  }
}

/** 去掉 `^ ~ >= <= > < =` 前缀与前后空格 */
function stripRange(v: string): string {
  return (v ?? '').trim().replace(/^[\s^~><=v]+/i, '').trim()
}

/** prerelease = 版本号里带 `-`（build metadata 的 `+` 不算） */
function isPrerelease(v: string | null): boolean {
  if (!v) return false
  const s = stripRange(v)
  const plus = s.indexOf('+')
  return (plus >= 0 ? s.slice(0, plus) : s).includes('-')
}

/** 能不能被当成「数字版本」比较（compareVersions 无法解析时会退化成字符串比较，那不算） */
function isNumericVersion(v: string | null): boolean {
  if (!v) return false
  return /^\d+(\.\d+)*/.test(stripRange(v))
}

/**
 * 相对当前已装版本的方向。
 * 注意 compareVersions(a, b) 是「a 相对 b」，所以这里传的是 (候选项, 当前)。
 * 任一边解析不出数字版本 → null（不是 'same'）。
 */
function directionOf(candidate: string | null, current: string | null): VersionOption['direction'] {
  if (!isNumericVersion(candidate) || !isNumericVersion(current)) return null
  const cmp = compareVersions(stripRange(candidate ?? ''), stripRange(current ?? ''))
  if (cmp > 0) return 'up'
  if (cmp < 0) return 'down'
  return 'same'
}

/* ------------------------------------------------------------------ *
 * VersionList 构造
 * ------------------------------------------------------------------ */

function makeList(
  patch: Partial<VersionList> & { kind: VersionList['kind']; name: string; current: string | null }
): VersionList {
  return {
    ok: patch.ok ?? false,
    kind: patch.kind,
    name: patch.name,
    latest: patch.latest ?? null,
    current: patch.current,
    options: patch.options ?? [],
    truncated: patch.truncated ?? false,
    warnings: patch.warnings ?? [],
    error: patch.error ?? null
  }
}

/* ------------------------------------------------------------------ *
 * 来源判定
 * ------------------------------------------------------------------ */

type Source = 'npm' | 'git' | 'unknown'

function sourceOf(raw: string, parsed: ParsedSpec): Source {
  if (parsed.kind === 'git') return 'git'
  if (parsed.kind === 'npm') return parsed.packageName ? 'npm' : 'unknown' // 只有版本号、没包名
  // 解析不动的再兜一层：带 github.com，或形如 owner/repo
  if (/github\.com/i.test(raw)) return 'git'
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:[#@].*)?$/.test(raw)) return 'git'
  return 'unknown'
}

/** git 形态的展示名：owner/repo，拿不到就用原始输入 */
function repoNameOf(parsed: ParsedSpec, raw: string): string {
  if (parsed.owner && parsed.repo) return `${parsed.owner}/${parsed.repo}`
  return raw
}

/** 交给 git 的真实地址（`github:owner/repo#ref` 这种 pnpm 语法 git 不认） */
function remoteUrlOf(raw: string, parsed: ParsedSpec): string {
  if (parsed.owner && parsed.repo) return `https://github.com/${parsed.owner}/${parsed.repo}.git`

  let s = raw.trim().replace(/^git\+/i, '')
  if (/^github:/i.test(s)) {
    const body = s.slice('github:'.length)
    const hash = body.indexOf('#')
    const path = (hash >= 0 ? body.slice(0, hash) : body).replace(/\.git$/i, '')
    return `https://github.com/${path}.git`
  }
  return s
}

/**
 * 当前已装版本：渲染层给了就用它（优先），没给才回退去 profile 里查。
 * `opts.current === undefined` 才是「没给」；显式传 null 表示「确实没有已装版本」。
 */
async function resolveCurrent(opts: {
  profile?: string
  current?: string | null
}, name: string, source: Source): Promise<string | null> {
  if (typeof opts.current === 'string') {
    const v = opts.current.trim()
    return v || null
  }
  if (opts.current === null) return null
  if (!opts.profile) return null

  try {
    const list = await listPlugins(opts.profile)
    if (!Array.isArray(list)) return null
    const hit = list.find((r) => r && r.name === name)
    const version = hit && typeof hit.version === 'string' ? hit.version.trim() : ''
    if (version) return version

    // git 形态：profile 里的键名不一定等于 owner/repo（通常只写仓库名）
    if (source === 'git') {
      const short = name.split('/').pop()
      if (short) {
        const alt = list.find((r) => r && r.name === short)
        const altVersion = alt && typeof alt.version === 'string' ? alt.version.trim() : ''
        if (altVersion) return altVersion
      }
    }
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * npm 分支
 * ------------------------------------------------------------------ */

async function npmList(pkgName: string, current: string | null): Promise<VersionList> {
  // scoped 名字里的 `/` 保留、`@` 不编码：https://registry.npmjs.org/@scope/name 是合法请求
  const url = `${registryBase()}/${pkgName}`

  const res = await net.httpJson<Record<string, unknown>>(url, { timeoutMs: PACKUMENT_TIMEOUT_MS })

  if (res.status === 404) {
    return makeList({
      kind: 'npm',
      name: pkgName,
      current,
      error: '这个包在 npm 上不存在'
    })
  }

  if (!res.ok || !res.data) {
    return makeList({
      kind: 'npm',
      name: pkgName,
      current,
      error: `读取 npm registry 失败：${res.error ?? '未知原因'}`,
      warnings: [REGISTRY_WARN]
    })
  }

  /* 体积保护：巨大 packument 解析出来会把界面拖死，宁可不给 */
  let chars = 0
  try {
    chars = JSON.stringify(res.data).length
  } catch {
    chars = 0
  }
  if (chars > MAX_PACKUMENT_CHARS) {
    return makeList({
      kind: 'npm',
      name: pkgName,
      current,
      error: '这个包的元数据太大（>8MB），暂时读不了'
    })
  }

  const data = res.data

  /* ---------- 原始数据 ---------- */

  const versionsObj = isObj(data.versions) ? data.versions : {}
  const allVersions = Object.keys(versionsObj).filter((v) => v.trim().length > 0)

  const timeObj = isObj(data.time) ? data.time : {}
  const publishedAtOf = (version: string | null): string | null => (version ? strOf(timeObj[version]) : null)

  const rawTags = data['dist-tags']
  const distTags: Record<string, string> = {}
  if (isObj(rawTags)) {
    for (const [k, v] of Object.entries(rawTags)) {
      const tag = k.trim()
      const target = strOf(v)
      if (tag && target) distTags[tag] = target
    }
  }

  const latest = distTags.latest ?? null
  const tagTargets = new Set<string>(Object.values(distTags))

  /* ---------- 1. dist-tags（latest 第一，其余按字母序） ---------- */

  const options: VersionOption[] = []
  const tagNames = Object.keys(distTags)
  tagNames.sort((a, b) => {
    if (a === 'latest') return b === 'latest' ? 0 : -1
    if (b === 'latest') return 1
    return a.localeCompare(b)
  })
  for (const tag of tagNames) {
    const target = distTags[tag] ?? null
    options.push({
      spec: `${pkgName}@${tag}`,
      label: tag,
      value: tag,
      kind: 'dist-tag',
      publishedAt: publishedAtOf(target),
      direction: directionOf(target, current)
    })
  }

  /* ---------- 2. 正式版本：compareVersions 降序 ---------- */

  const currentIsPre = isPrerelease(current)
  const eligible = allVersions
    .slice()
    .sort((a, b) => compareVersions(b, a))
    .filter((v) => {
      // prerelease 噪声默认不展示（0.3.0-beta.11 这种会把列表刷屏）；
      // 例外：当前装的就是 prerelease，或这个 prerelease 正好被某个 dist-tag 指着。
      if (!isPrerelease(v)) return true
      return currentIsPre || tagTargets.has(v)
    })

  const shownVersions = eligible.slice(0, MAX_VERSION_OPTIONS)
  for (const v of shownVersions) {
    options.push({
      spec: `${pkgName}@${v}`,
      label: v,
      value: v,
      kind: 'version',
      publishedAt: publishedAtOf(v),
      direction: directionOf(v, current)
    })
  }

  return makeList({
    ok: true,
    kind: 'npm',
    name: pkgName,
    latest,
    current,
    options,
    truncated: eligible.length > shownVersions.length,
    warnings: [],
    error: null
  })
}

/* ------------------------------------------------------------------ *
 * git 分支
 * ------------------------------------------------------------------ */

/** git 的绝对路径缓存（undefined = 还没探过；null = 探过没有） */
let gitPathCache: string | null | undefined

function gitCandidates(): string[] {
  const out: string[] = []
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const local = process.env['LOCALAPPDATA']

  if (pf) {
    out.push(join(pf, 'Git', 'cmd', 'git.exe'))
    out.push(join(pf, 'Git', 'bin', 'git.exe'))
  }
  if (pf86) {
    out.push(join(pf86, 'Git', 'cmd', 'git.exe'))
    out.push(join(pf86, 'Git', 'bin', 'git.exe'))
  }
  if (local) out.push(join(local, 'Programs', 'Git', 'cmd', 'git.exe'))
  out.push(join(homedir(), 'scoop', 'shims', 'git.exe'))
  out.push(join(homedir(), '.local', 'bin', 'git.exe'))

  // PATH 里再扫一遍（装到非标准位置的机器）
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    out.push(join(dir, 'git.exe'))
    out.push(join(dir, 'git'))
  }
  return out
}

/**
 * 找 git 可执行文件。
 *
 * 为什么不能直接把 'git' 丢给 pnpm.runCommand：它会先做 existsSync(cmd) ，
 * 相对路径在 Electron 里必然查不到，会直接以「找不到自带 node/pnpm」收尾 —— 那是给 node/pnpm 的提示，
 * 对 git 是误导。所以这里先解析成绝对路径。
 */
function resolveGitPath(): string | null {
  if (gitPathCache !== undefined) return gitPathCache
  let found: string | null = null
  for (const candidate of gitCandidates()) {
    try {
      if (candidate && existsSync(candidate)) {
        found = candidate
        break
      }
    } catch {
      /* 单个候选路径探测失败不影响继续找 */
    }
  }
  gitPathCache = found
  return found
}

/** 子进程 env：显式带代理 + 关掉一切交互式提示 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const proxy = proxyOf()
  if (proxy) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
  }
  env.GIT_TERMINAL_PROMPT = '0' // 私有仓库别卡在密码提示上
  env.GIT_ASKPASS = 'echo'
  env.LC_ALL = 'C' // 输出保持英文，好解析
  return env
}

interface GitRefs {
  defaultBranch: string | null
  branches: string[]
  tags: string[]
}

/** 解析 `git ls-remote` 输出；`refs/tags/X^{}` 与 `refs/tags/X` 同时出现时只留一条 */
function parseLsRemote(text: string): GitRefs {
  const branches: string[] = []
  const seenBranch = new Set<string>()
  const tags: string[] = []
  const seenTag = new Set<string>()
  let defaultBranch: string | null = null

  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    /* ref: refs/heads/main\tHEAD  —— 默认分支（`--refs` 有些版本会把它滤掉） */
    const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line)
    if (sym && sym[1]) {
      defaultBranch = sym[1]
      continue
    }

    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const ref = line.slice(tab + 1).trim()

    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length)
      if (name && !seenBranch.has(name)) {
        seenBranch.add(name)
        branches.push(name)
      }
      continue
    }

    if (ref.startsWith('refs/tags/')) {
      const peeled = ref.endsWith('^{}')
      const name = peeled ? ref.slice('refs/tags/'.length, -3) : ref.slice('refs/tags/'.length)
      if (name && !seenTag.has(name)) {
        seenTag.add(name)
        tags.push(name)
      }
      continue
    }
  }

  return { defaultBranch, branches, tags }
}

/** 标签名去前导 v（只有 `v` 后面跟数字才算，避免把 `version-2` 削成 `ersion-2`） */
function tagVersionOf(tag: string): string {
  return tag.replace(/^v(?=\d)/i, '')
}

function byNameAsc(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

/** `--refs` 会把 HEAD 的 symref 行滤掉，那就单独问一次 HEAD */
async function askDefaultBranch(gitPath: string, url: string): Promise<string | null> {
  try {
    const handle = pnpm.runCommand(gitPath, ['ls-remote', '--symref', url, 'HEAD'], {
      cwd: tmpdir(),
      env: gitEnv(),
      timeoutMs: GIT_HEAD_TIMEOUT_MS
    })
    const { code, log } = await handle.done
    if (code !== 0) return null
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(log ?? '')
    return m && m[1] ? m[1] : null
  } catch {
    return null
  }
}

async function gitList(raw: string, parsed: ParsedSpec, current: string | null): Promise<VersionList> {
  const name = repoNameOf(parsed, raw)
  const url = remoteUrlOf(raw, parsed)

  const gitPath = resolveGitPath()
  if (!gitPath) {
    return makeList({
      kind: 'git',
      name,
      current,
      error: '读取远端分支和标签失败：没找到 git 命令（试过常见安装位置和 PATH）',
      warnings: [GIT_WARN]
    })
  }

  const handle = pnpm.runCommand(gitPath, ['ls-remote', '--symref', '--refs', '--heads', '--tags', url], {
    cwd: tmpdir(),
    env: gitEnv(),
    timeoutMs: GIT_TIMEOUT_MS
  })
  const { code, log } = await handle.done

  if (code !== 0) {
    return makeList({
      kind: 'git',
      name,
      current,
      error: `读取远端分支和标签失败：${snippet(log)}`,
      warnings: [GIT_WARN]
    })
  }

  const refs = parseLsRemote(log)
  if (refs.branches.length === 0 && refs.tags.length === 0) {
    return makeList({
      kind: 'git',
      name,
      current,
      error: '这个仓库没有可用的分支或标签'
    })
  }

  const defaultBranch = refs.defaultBranch ?? (await askDefaultBranch(gitPath, url))

  /* ---------- 标签：semver 降序在前，解析不出的按名字倒序跟在后面 ---------- */

  const semverTags: string[] = []
  const otherTags: string[] = []
  for (const tag of refs.tags) {
    if (isNumericVersion(tagVersionOf(tag))) semverTags.push(tag)
    else otherTags.push(tag)
  }
  semverTags.sort((a, b) => compareVersions(tagVersionOf(b), tagVersionOf(a)))
  otherTags.sort((a, b) => -byNameAsc(a, b))

  const orderedTags = [...semverTags, ...otherTags]

  /* ---------- 分支：默认分支第一，其余按名字升序 ---------- */

  const restBranches = refs.branches.filter((b) => b !== defaultBranch).sort(byNameAsc)
  const orderedBranches = defaultBranch && refs.branches.includes(defaultBranch) ? [defaultBranch, ...restBranches] : restBranches

  /* ---------- 组装 ---------- */

  const specOf = (ref: string): string =>
    parsed.owner && parsed.repo ? `github:${parsed.owner}/${parsed.repo}#${ref}` : `${url}#${ref}`

  const shownTags = orderedTags.slice(0, MAX_GIT_TAGS)
  const shownBranches = orderedBranches.slice(0, MAX_GIT_BRANCHES)

  const options: VersionOption[] = []
  for (const tag of shownTags) {
    options.push({
      spec: specOf(tag),
      label: tag,
      value: tag,
      kind: 'tag',
      publishedAt: null, // git 没有发布时间
      direction: null // ref 之间没法比大小
    })
  }
  for (const branch of shownBranches) {
    options.push({
      spec: specOf(branch),
      label: branch,
      value: branch,
      kind: 'branch',
      publishedAt: null,
      direction: null
    })
  }

  const truncated = orderedTags.length > shownTags.length || orderedBranches.length > shownBranches.length

  return makeList({
    ok: true,
    kind: 'git',
    name,
    latest: defaultBranch,
    current,
    options,
    truncated,
    warnings: [],
    error: null
  })
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 列出可安装的版本 / 标签 / 分支。
 *
 * @param input 包名、npm spec（`name@1.2.3`）或 GitHub 链接 / 简写
 * @param opts  `profile` 用来在渲染层没给 current 时回查已装版本；`current` 由渲染层直接传，优先用它
 */
export async function listVersions(
  input: string,
  opts: { profile?: string; current?: string | null }
): Promise<VersionList> {
  const options = opts ?? {}
  const raw = typeof input === 'string' ? input.trim() : ''

  /* ---------- 空输入 ---------- */

  if (!raw) {
    return makeList({
      kind: 'unknown',
      name: '',
      current: options.current ?? null,
      error: '请输入包名或 GitHub 链接'
    })
  }

  /* ---------- 判定来源 ---------- */

  try {
    const parsed = parseSpec(raw)
    const source = sourceOf(raw, parsed)

    if (source === 'unknown') {
      return makeList({
        kind: 'unknown',
        name: '',
        current: options.current ?? null,
        error:
          parsed.error ??
          `无法识别的输入：${raw}。支持：npm 包名（含 @scope/name@版本）、GitHub 地址（owner/repo、github:owner/repo#ref、https://github.com/owner/repo）`
      })
    }

    const name = source === 'npm' ? parsed.packageName ?? raw : repoNameOf(parsed, raw)
    const current = await resolveCurrent(options, name, source)

    /* ---------- 缓存 ---------- */

    const key = `${source}|${name}|${current ?? ''}`
    const cached = readCache(key)
    if (cached) return cached

    const result = source === 'npm' ? await npmList(name, current) : await gitList(raw, parsed, current)
    writeCache(key, result)
    return result
  } catch (e) {
    return makeList({
      kind: 'unknown',
      name: '',
      current: options.current ?? null,
      error: `读取版本列表失败：${errText(e)}`
    })
  }
}
