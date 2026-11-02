/**
 * spec.ts —— 依赖 spec 的来源识别与归一化。
 *
 * 两个用途：
 *  1. `classifySpec` / `specVersionOf` 读 profile 的 package.json dependencies，
 *     判断每条依赖是什么来源、钉了什么版本（inventory 用）。
 *  2. `parseSpec` 把用户手输的东西归一化成可以直接喂 `pnpm add` 的 spec（安装向导用）。
 *
 * 约定：normalized 只保证「pnpm add 能吃掉」，不做正确性兜底；reason 用中文人话说明判定。
 */

import type { ParsedSpec, SourceKind } from '../../shared/types'

/* ------------------------------------------------------------------ *
 * 基础正则
 * ------------------------------------------------------------------ */

/** 仓库 owner / repo 单段允许的字符 */
const NAME_SEG = /^[A-Za-z0-9._-]+$/
/** `@scope/name` */
const SCOPED_NAME = /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
/** 纯版本：1 / 1.2 / 1.2.3 / 1.2.3-beta.1 / v1.2.3 / ^1.2.3 / >=1.2.3 */
const VERSION_ONLY = /^[~^><=*\s]*v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.+-]+)?$/
/** 裸 dist-tag：latest / next / beta ... */
const DIST_TAG = /^(latest|next|beta|alpha|canary|stable|rc)$/i

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function norm(input: unknown): string {
  return typeof input === 'string' ? input.trim() : ''
}

/** 去掉 query / hash，再判断是不是 tarball 直链 */
function isTarballUrl(u: string): boolean {
  const clean = u.split('#')[0]!.split('?')[0]!.trim()
  return /\.(tgz|tar\.gz)$/i.test(clean)
}

/**
 * 把各种写法的仓库地址洗成 `github.com/<path...>`（可能仍带 query/hash）。
 * 只做归一化，不做合法性判断。
 */
function normalizeHostPath(input: string): string {
  let s = input.trim()
  s = s.replace(/^git\+/i, '')
  s = s.replace(/^(https?|ssh|git):\/\//i, '')
  s = s.replace(/^[A-Za-z0-9._-]+@/, '') // git@ / user@
  s = s.replace(/^www\./i, '')
  s = s.replace(/^github\.com:/i, 'github.com/') // scp 形态 git@github.com:owner/repo
  return s
}

/** 是不是 GitHub 网页地址（含 owner/repo 两段） */
function looksLikeGithubUrl(input: string): boolean {
  const s = normalizeHostPath(input)
  return /^github\.com\/[^/\s?#]+\/[^/\s?#]+/i.test(s)
}

/** 只给版本号、没给包名 */
function isVersionOnly(s: string): boolean {
  const t = s.trim()
  return VERSION_ONLY.test(t) || DIST_TAG.test(t)
}

/**
 * 拆 npm 包名 + 版本：`lodash` / `lodash@4` / `@scope/x` / `@scope/x@^1.2.3`
 * 拆不动返回 null。注意 scoped 名字里天然带 `@`，所以必须先判开头。
 */
function splitNpmSpec(spec: string): { name: string; version: string | null } | null {
  const s = spec.trim()
  if (!s) return null
  if (s.startsWith('@')) {
    const m = /^(@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:@([^\s@]+))?$/.exec(s)
    if (!m) return null
    return { name: m[1]!, version: m[2] ?? null }
  }
  const m = /^([A-Za-z0-9._-]+)(?:@([^\s@]+))?$/.exec(s)
  if (!m) return null
  return { name: m[1]!, version: m[2] ?? null }
}

/**
 * 拆 GitHub 简写 `owner/repo` / `owner/repo#ref` / `owner/repo@ref`。
 * 规则：一个斜杠、无空格、无冒号、不以 `@` 开头；两段都合法且 owner 不含 `.`
 * （`x.y/z` 更像域名，交给上层判 unknown）。`@scope/name` 因为以 `@` 开头会被这里拒掉。
 */
function splitShorthand(spec: string): { owner: string; repo: string; ref: string | null } | null {
  let s = spec.trim().replace(/\/+$/, '')
  if (!s || s.startsWith('@')) return null
  if (/\s/.test(s) || s.includes(':')) return null
  const hashAt = s.indexOf('#')
  let ref: string | null = hashAt >= 0 ? s.slice(hashAt + 1).trim() || null : null
  const body = (hashAt >= 0 ? s.slice(0, hashAt) : s).replace(/\.git$/i, '')
  const parts = body.split('/')
  if (parts.length !== 2) return null
  let [owner, repo] = parts as [string, string]
  if (!owner || !repo) return null
  if (!NAME_SEG.test(owner) || !NAME_SEG.test(repo)) return null
  if (owner.includes('.')) return null
  if (/\.(tgz|tar\.gz)$/i.test(repo)) return null // 更像文件路径
  const at = repo.indexOf('@')
  if (at > 0) {
    const r = repo.slice(at + 1)
    repo = repo.slice(0, at)
    if (r) ref = r
  }
  if (!NAME_SEG.test(repo)) return null
  return { owner, repo, ref }
}

/**
 * 解析 GitHub 地址：https://github.com/o/r[.git][?ref=][#ref][@ref][/tree/<branch>/<subdir>]
 * 解析不动（不是 github.com 或不是 owner/repo）返回 null。
 */
function parseGithubUrl(
  input: string
): { owner: string; repo: string; ref: string | null; subdir: string | null } | null {
  const host = normalizeHostPath(input)
  if (!/^github\.com\//i.test(host)) return null
  let rest = host.slice('github.com/'.length)

  let ref: string | null = null
  let subdir: string | null = null

  const qi = rest.indexOf('?')
  if (qi >= 0) {
    const q = rest.slice(qi + 1)
    rest = rest.slice(0, qi)
    const m = /(?:^|&)ref=([^&]*)/.exec(q)
    if (m && m[1]) {
      try {
        ref = decodeURIComponent(m[1])
      } catch {
        ref = m[1]
      }
    }
  }

  const hi = rest.indexOf('#')
  if (hi >= 0) {
    const h = rest.slice(hi + 1).trim()
    rest = rest.slice(0, hi)
    if (h) ref = h // hash 比 ?ref= 更明确，覆盖它
  }

  rest = rest.replace(/\/+$/, '')
  const segs = rest.split('/').filter((x) => x.length > 0)
  if (segs.length < 2) return null

  const owner = segs[0]!
  let repo = segs[1]!
  const at = repo.indexOf('@')
  if (at > 0) {
    const r = repo.slice(at + 1)
    repo = repo.slice(0, at)
    if (r) ref = r
  }
  repo = repo.replace(/\.git$/i, '')
  if (!NAME_SEG.test(owner) || !NAME_SEG.test(repo)) return null

  if (segs.length > 2 && segs[2] === 'tree') {
    const branch = segs[3]
    if (branch) {
      ref = branch // /tree/<branch> 是显式的，覆盖前面拿到的
      if (segs.length > 4) subdir = segs.slice(4).join('/')
    }
  }
  // 其它多余路径段（/issues/1、/releases…）忽略，只认前两段。

  return { owner, repo, ref, subdir }
}

/* ------------------------------------------------------------------ *
 * ParsedSpec 构造
 * ------------------------------------------------------------------ */

function makeParsed(patch: Partial<ParsedSpec> & { raw: string }): ParsedSpec {
  return {
    ok: patch.ok ?? false,
    raw: patch.raw,
    kind: patch.kind ?? 'invalid',
    normalized: patch.normalized ?? null,
    owner: patch.owner ?? null,
    repo: patch.repo ?? null,
    ref: patch.ref ?? null,
    subdir: patch.subdir ?? null,
    packageName: patch.packageName ?? null,
    reason: patch.reason ?? '',
    error: patch.error ?? null
  }
}

function fail(raw: string, error: string): ParsedSpec {
  return makeParsed({ raw, reason: error, error })
}

function githubParsed(
  raw: string,
  owner: string,
  repo: string,
  ref: string | null,
  subdir: string | null
): ParsedSpec {
  const cleanRepo = repo.replace(/\.git$/i, '')
  const normalized = `github:${owner}/${cleanRepo}${ref ? `#${ref}` : ''}`
  const bits = [
    ref
      ? `识别为 GitHub 仓库：${owner}/${cleanRepo}（ref=${ref}）`
      : `识别为 GitHub 仓库：${owner}/${cleanRepo}（未指定 ref，用仓库默认分支）`
  ]
  if (subdir) bits.push(`pnpm 不支持指定子目录，将安装整个仓库（原路径子目录 ${subdir}）`)
  return makeParsed({
    raw,
    ok: true,
    kind: 'git',
    normalized,
    owner,
    repo: cleanRepo,
    ref,
    subdir,
    reason: bits.join('；')
  })
}

function npmParsed(raw: string, name: string, version: string | null): ParsedSpec {
  return makeParsed({
    raw,
    ok: true,
    kind: 'npm',
    normalized: version ? `${name}@${version}` : name,
    packageName: name,
    reason: `识别为 npm 包：${name}（版本 ${version ?? 'latest'}）`
  })
}

/* ------------------------------------------------------------------ *
 * classifySpec —— 判 package.json 里某条依赖是什么来源
 * ------------------------------------------------------------------ */

export function classifySpec(spec: string): SourceKind {
  const s = norm(spec)
  if (!s) return 'unknown'

  if (/^link:/i.test(s)) return 'link'
  if (/^file:/i.test(s)) return 'file'
  if (/^workspace:/i.test(s)) return 'workspace'

  if (/^github:/i.test(s)) return 'git'
  if (/^git\+/i.test(s)) return 'git'
  if (/^git:/i.test(s)) return 'git'
  if (/^git@/i.test(s)) return 'git'

  if (/^https?:\/\//i.test(s)) {
    if (isTarballUrl(s)) return 'tarball'
    if (looksLikeGithubUrl(s)) return 'git'
    return 'unknown' // registry 网页 / 随便一个网址
  }

  if (/^npm:/i.test(s)) return 'npm'

  if (splitShorthand(s)) return 'git'
  if (looksLikeGithubUrl(s)) return 'git' // github.com/owner/repo（无协议、www 前缀）

  // 依赖表里成对出现时，单边只有版本约束（如 dshmarket 的 "^1.66.5"）—— 包名来自 key，
  // 这里只要认出「这是 npm 语义」就够了，别掉进 unknown 让版本检查整条哑掉。
  if (isVersionOnly(s)) return 'npm'

  if (splitNpmSpec(s)) return 'npm'

  return 'unknown'
}

/* ------------------------------------------------------------------ *
 * specVersionOf —— 从 spec 里抠出版本约束
 * ------------------------------------------------------------------ */

export function specVersionOf(spec: string): string | null {
  const s = norm(spec)
  if (!s) return null

  // 这些形态本身不携带 npm 版本约束
  if (/^(link|file|workspace):/i.test(s)) return null
  if (/^github:/i.test(s)) return null
  if (/^git\+/i.test(s) || /^git:/i.test(s) || /^git@/i.test(s)) return null
  if (/^https?:\/\//i.test(s)) return null
  if (/^www\./i.test(s) || /^github\.com\//i.test(s)) return null

  let body = s
  if (/^npm:/i.test(s)) body = s.slice(4).trim()
  if (!body) return null

  if (isVersionOnly(body)) return body // `1.2.3` / `^1.2.3` / `>=1.2.3` / `latest`

  if (splitShorthand(body)) return null

  const p = splitNpmSpec(body)
  if (p) return p.version

  return null
}

/* ------------------------------------------------------------------ *
 * parseSpec —— 用户输入 → 可喂 pnpm add 的 spec
 * ------------------------------------------------------------------ */

export function parseSpec(input: string): ParsedSpec {
  const raw = typeof input === 'string' ? input : ''
  const s = raw.trim()

  if (!s) {
    return fail(raw, '输入为空，请填 npm 包名、GitHub 仓库地址或本地路径')
  }

  /* ---------- 带前缀的本地依赖（路径里可能有空格，先于空格校验） ---------- */

  if (/^link:/i.test(s)) {
    const target = s.slice('link:'.length).trim()
    if (!target) return fail(raw, 'link: 后面没有路径')
    return makeParsed({
      raw,
      ok: true,
      kind: 'link',
      normalized: s,
      reason: `识别为本地目录 link：${target}（node_modules 里是指向该目录的软链，改代码立即生效）`
    })
  }

  if (/^file:/i.test(s)) {
    const target = s.slice('file:'.length).trim()
    if (!target) return fail(raw, 'file: 后面没有路径')
    return makeParsed({
      raw,
      ok: true,
      kind: 'file',
      normalized: s,
      reason: /\.(tgz|tar\.gz)$/i.test(target)
        ? `识别为本地 tarball：${target}`
        : `识别为本地文件/目录依赖：${target}`
    })
  }

  if (/^workspace:/i.test(s)) {
    const range = s.slice('workspace:'.length).trim() || '*'
    return makeParsed({
      raw,
      ok: true,
      kind: 'workspace',
      normalized: s,
      reason: `识别为 workspace 协议依赖（范围 ${range}）：只在 monorepo 内部有效，装到 profile 里通常解析失败`
    })
  }

  /* ---------- 基本合法性 ---------- */

  if (/[\u0000-\u001f\u007f]/.test(s)) return fail(raw, '输入里有控制字符')
  if (/\s/.test(s)) {
    return fail(raw, `输入里有空格，无法识别为包名或仓库地址：${s}（本地路径请加 file:/link: 前缀）`)
  }

  /* ---------- github: 前缀 ---------- */

  if (/^github:/i.test(s)) {
    const rest = s.slice('github:'.length)
    const hashAt = rest.indexOf('#')
    const ref = hashAt >= 0 ? rest.slice(hashAt + 1).trim() || null : null
    const body = (hashAt >= 0 ? rest.slice(0, hashAt) : rest).replace(/\.git$/i, '').replace(/\/+$/, '')
    const parts = body.split('/').filter((x) => x.length > 0)
    if (parts.length < 2) return fail(raw, `github: 后面要跟 owner/repo：${s}`)
    const owner = parts[0]!
    const repo = parts[1]!
    if (!NAME_SEG.test(owner) || !NAME_SEG.test(repo)) {
      return fail(raw, `github: 后面的 owner/repo 含有非法字符：${owner}/${repo}`)
    }
    const subdir = parts.length > 2 ? parts.slice(2).join('/') : null
    return githubParsed(raw, owner, repo, ref, subdir)
  }

  /* ---------- git+ / git: / git@ 形态：原样透传 ---------- */

  if (/^git[\+:@]/i.test(s)) {
    const gh = parseGithubUrl(s)
    return makeParsed({
      raw,
      ok: true,
      kind: 'git',
      normalized: s,
      owner: gh?.owner ?? null,
      repo: gh?.repo ?? null,
      ref: gh?.ref ?? null,
      subdir: gh?.subdir ?? null,
      reason: gh
        ? `识别为 git 仓库：${gh.owner}/${gh.repo}${gh.ref ? `（ref=${gh.ref}）` : ''}，原始地址原样透传给 pnpm`
        : `识别为 git 仓库地址：${s}（原样透传给 pnpm）`
    })
  }

  /* ---------- URL 形态 ---------- */

  if (/^https?:\/\//i.test(s) || /^www\./i.test(s) || /^github\.com\//i.test(s)) {
    if (isTarballUrl(s)) {
      return makeParsed({
        raw,
        ok: true,
        kind: 'tarball',
        normalized: s,
        reason: `识别为远程 tarball 直链：${s}（每次安装重新下载，没有版本号可比）`
      })
    }
    const gh = parseGithubUrl(s)
    if (gh) return githubParsed(raw, gh.owner, gh.repo, gh.ref, gh.subdir)
    if (/^https?:\/\//i.test(s)) {
      return makeParsed({
        raw,
        ok: true,
        kind: 'unknown',
        normalized: s,
        reason: `识别为普通网址：${s}（既不是 GitHub 仓库地址，也不是 .tgz/.tar.gz 直链，pnpm 大概率装不上）`
      })
    }
    return fail(raw, `无法识别的地址：${s}（只支持 GitHub 仓库地址或 tarball 直链）`)
  }

  /* ---------- npm: 前缀 ---------- */

  if (/^npm:/i.test(s)) {
    const body = s.slice('npm:'.length)
    const p = splitNpmSpec(body)
    if (!p) return fail(raw, `npm: 后面不是合法包名：${body}`)
    return npmParsed(raw, p.name, p.version)
  }

  /* ---------- GitHub 简写 owner/repo[#ref] ---------- */

  const sh = splitShorthand(s)
  if (sh) return githubParsed(raw, sh.owner, sh.repo, sh.ref, null)

  /* ---------- 裸版本号 → 缺包名 ---------- */

  if (isVersionOnly(s)) return fail(raw, `只有版本号、没有包名：${s}`)

  /* ---------- 裸包名 ---------- */

  const p = splitNpmSpec(s)
  if (p) {
    if (SCOPED_NAME.test(p.name) || /^[A-Za-z0-9._-]+$/.test(p.name)) return npmParsed(raw, p.name, p.version)
  }

  /* ---------- 兜底 ---------- */

  return fail(
    raw,
    `无法识别的输入：${s}。支持：npm 包名（含 @scope/name@版本）、GitHub 地址（owner/repo、github:owner/repo#ref、https://github.com/owner/repo）、git URL、.tgz 直链，本地路径请用 file:/link: 前缀`
  )
}
