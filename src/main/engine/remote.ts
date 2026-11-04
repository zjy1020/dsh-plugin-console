/**
 * remote.ts —— 给「本地来源」的包追回远程坐标。
 *
 * 要解决的问题（用户实测反馈）：
 *   一个从 GitHub 装的插件，profile 里的 spec 被写成了本地 tarball：
 *     dsh-purge-community = file:C:/Users/.../pkgs/<sha>/dsh-purge-community-1.6.69.tgz
 *   于是界面把它判成「本地文件」，既不给更新按钮，也不解释为什么。
 *   可那个包自己的 package.json 里明明写着远程出处：
 *     dsh.install.git     = https://github.com/kingcharleslzy-ai/dsh-purge.git
 *     dsh.install.tarball = https://github.com/.../releases/latest/download/...tgz
 *     repository.url      = git+https://github.com/kingcharleslzy-ai/dsh-purge.git
 *
 * 这里做的事：把这三处声明读出来，并提供一个「问远端最新 tag 是哪个」的能力，
 * 让 updates.ts 能把「本地 tarball」也纳入更新检查。
 *
 * 边界：
 *   - 只读、不写任何文件；不改 profile。
 *   - 永不抛异常，读不到就返回空坐标（调用方按「没有远程来源」处理）。
 *   - 不走 api.github.com（未认证额度早被打光）——只用本机 git ls-remote 与纯文本 URL。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import * as pnpm from './pnpm'
import { getProfileDir } from './env'
import { get as getSettings } from './settings'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 远程坐标从哪个字段读出来的（给界面一句人话说明用） */
export type RemoteFrom = 'dsh.install.git' | 'dsh.install.tarball' | 'repository' | 'homepage'

export interface RemoteCoords {
  /** 可以直接喂给 `pnpm add` 的 git URL（已去掉 git+ 前缀与 .git 尾巴保留） */
  gitUrl: string | null
  /** `owner/repo`（GitHub 形式才拆得出） */
  repoSlug: string | null
  /** releases 里的 tarball 地址（只能看，不能比版本） */
  tarballUrl: string | null
  /** 坐标来源字段 */
  from: RemoteFrom | null
}

export interface RemoteLatest {
  /** 远端最新 tag 原名（如 `v1.6.70`） */
  tag: string
  /** 从 tag 名里剥出来的版本号（如 `1.6.70`） */
  version: string
  /** 可直接拿去做 `pnpm add` 的 spec */
  spec: string
}

/* ------------------------------------------------------------------ *
 * 读包内的远程声明
 * ------------------------------------------------------------------ */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

/**
 * 把各种写法的仓库地址归一成 `https://host/owner/repo.git`。
 * 认得：git+https://…、git://…、git@github.com:owner/repo.git、owner/repo、github:owner/repo。
 */
export function normalizeGitUrl(raw: string | null): string | null {
  const s = strOf(raw)
  if (!s) return null

  let t = s.trim()

  // `git+https://…` / `git+ssh://…`
  if (t.startsWith('git+')) t = t.slice(4)

  // `github:owner/repo`
  if (t.startsWith('github:')) {
    const rest = t.slice('github:'.length)
    const cut = rest.split('#')[0] ?? rest
    return `https://github.com/${cut.replace(/\.git$/, '')}.git`
  }

  // `git@github.com:owner/repo.git`
  const scp = /^git@([^:]+):(.+)$/.exec(t)
  if (scp) {
    const host = scp[1]
    const path = (scp[2] ?? '').replace(/\.git$/, '')
    if (host && path) return `https://${host}/${path}.git`
  }

  // `git://host/owner/repo`
  if (t.startsWith('git://')) t = `https://${t.slice(6)}`

  // `https://host/owner/repo` —— 补 .git 尾巴（ls-remote 对两种都认，补上更稳）
  if (/^https?:\/\//i.test(t)) {
    const bare = t.split('#')[0] ?? t
    if (/\.git$/i.test(bare)) return bare
    return `${bare.replace(/\/+$/, '')}.git`
  }

  // `owner/repo` 简写（GitHub）
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t)) {
    return `https://github.com/${t}.git`
  }

  return null
}

/** 从 `https://github.com/owner/repo.git` 拆出 `owner/repo` */
export function repoSlugOf(gitUrl: string | null): string | null {
  const s = strOf(gitUrl)
  if (!s) return null
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(s)
  if (!m) return null
  const owner = m[1]
  const repo = m[2]
  return owner && repo ? `${owner}/${repo}` : null
}

/**
 * 读已装包的 package.json，把远程出处摸出来。
 *
 * 优先级为什么是这个顺序：
 *   dsh.install.git > dsh.install.tarball > repository.url > homepage
 * 前两个是插件作者**主动声明给安装器看的**（DSH 的装配流程就认这两个），
 * 比 repository 更像「该从哪儿装」；homepage 放最后，只能作为兜底猜测。
 */
export async function readRemoteCoords(profile: string, name: string): Promise<RemoteCoords> {
  const empty: RemoteCoords = { gitUrl: null, repoSlug: null, tarballUrl: null, from: null }

  let pkg: Record<string, unknown>
  try {
    const file = join(getProfileDir(profile), 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(file)) return empty
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObj(parsed)) return empty
    pkg = parsed
  } catch {
    return empty
  }

  const dsh = isObj(pkg['dsh']) ? pkg['dsh'] : null
  const install = dsh && isObj(dsh['install']) ? dsh['install'] : null

  // ① dsh.install.git
  const installGit = normalizeGitUrl(strOf(install?.['git']))
  if (installGit) {
    return { gitUrl: installGit, repoSlug: repoSlugOf(installGit), tarballUrl: strOf(install?.['tarball']), from: 'dsh.install.git' }
  }

  // ② dsh.install.tarball —— 只有 URL 没有仓库，比版本比不了，但至少能记下
  const installTarball = strOf(install?.['tarball'])

  // ③ repository.url / repository（字符串写法）
  const repoField = pkg['repository']
  const repoRaw = isObj(repoField) ? strOf(repoField['url']) : strOf(repoField)
  const repoGit = normalizeGitUrl(repoRaw)
  if (repoGit) {
    return { gitUrl: repoGit, repoSlug: repoSlugOf(repoGit), tarballUrl: installTarball, from: 'repository' }
  }

  // ④ homepage 兜底（只有首页是 GitHub 仓库地址时才有意义）
  const home = strOf(pkg['homepage'])
  if (home && /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i.test(home)) {
    const homeGit = normalizeGitUrl(home)
    if (homeGit) {
      return { gitUrl: homeGit, repoSlug: repoSlugOf(homeGit), tarballUrl: installTarball, from: 'homepage' }
    }
  }

  if (installTarball) {
    return { gitUrl: null, repoSlug: null, tarballUrl: installTarball, from: 'dsh.install.tarball' }
  }
  return empty
}

/* ------------------------------------------------------------------ *
 * 问远端：最新 tag 是哪个
 * ------------------------------------------------------------------ */

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

  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    out.push(join(dir, 'git.exe'))
    out.push(join(dir, 'git'))
  }
  return out
}

/** 找 git 绝对路径。不能直接给 pnpm.runCommand 传 'git'（它会 existsSync 判失败） */
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
      /* 单个候选探测失败不影响继续 */
    }
  }
  gitPathCache = found
  return found
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  try {
    const s = getSettings()
    const proxy = typeof s.proxy === 'string' && s.proxy.trim() !== '' ? s.proxy.trim() : null
    const url = proxy ? (/^\d+$/.test(proxy) ? `http://127.0.0.1:${proxy}` : proxy) : null
    if (url) {
      env.HTTP_PROXY = url
      env.HTTPS_PROXY = url
      env.http_proxy = url
      env.https_proxy = url
    }
  } catch {
    /* 设置读不到就不带代理，ls-remote 失败会走调用方的错误分支 */
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = 'echo'
  env.LC_ALL = 'C'
  return env
}

const GIT_TIMEOUT_MS = 20 * 1000

/**
 * 从 tag 名里剥出版本号。
 *
 * 必须严格：只认「以 semver 形态结尾」的 tag，且至少两段数字。
 * 这条规则是被真实数据打出来的 —— dsh-purge 那个仓库除了 v1.6.x 还有一条
 * `restore-issue-25`，早先的宽松正则会从里面抠出 `25`，于是界面报「可更新到 25」，
 * 而 25 > 1.6.69（数字段比较），更新按钮就指向一个根本不存在的发布版。
 *
 *   v1.6.70                       → '1.6.70'
 *   dsh-purge-community-v1.6.70   → '1.6.70'
 *   v1.1.12-beta.1                → '1.1.12-beta.1'
 *   restore-issue-25              → null（单段数字不算版本）
 *   25                            → null
 */
function versionOfTag(tag: string): string | null {
  const t = tag.trim()
  const m = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)$/.exec(t)
  return m?.[1] ?? null
}

/** 是不是预发布（带 -beta / -rc / -alpha 这类后缀） */
function isPrerelease(tag: string, version: string): boolean {
  if (/-/.test(version)) return true
  return /-(alpha|beta|rc|next|canary|dev|pre)\.?/i.test(tag)
}

/** 只要数字段，用来排序（`1.6.70` → [1,6,70]） */
function numParts(v: string): number[] {
  const core = v.split(/[-+]/)[0] ?? v
  return core.split('.').map((x) => {
    const m = /^\d+/.exec(x)
    return m ? Number(m[0]) : 0
  })
}

function cmpNums(a: string, b: string): number {
  const A = numParts(a)
  const B = numParts(b)
  const n = Math.max(A.length, B.length)
  for (let i = 0; i < n; i += 1) {
    const x = A[i] ?? 0
    const y = B[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  // 数字相同：带 prerelease 的算旧
  const aPre = /[-+]/.test(a)
  const bPre = /[-+]/.test(b)
  if (aPre === bPre) return 0
  return aPre ? -1 : 1
}

/**
 * 问远端最新版：`git ls-remote --tags --refs`，取 semver 最大的那个 tag。
 *
 * 为什么不用 `git ls-remote --symref … HEAD` 看默认分支：
 * 默认分支拿到的是 commit sha，没有版本号就没法跟已装版本比「谁新」；
 * 而 tag 名里的版本号正是「这个包发布到哪儿了」最直接的证据。
 *
 * @param opts.current 已装版本；传了就在返回里顺便说明是升还是同
 */
export async function latestGitTag(
  gitUrl: string,
  opts?: { current?: string | null }
): Promise<{ ok: true; latest: RemoteLatest } | { ok: false; error: string }> {
  const url = normalizeGitUrl(gitUrl)
  if (!url) return { ok: false, error: '这不是一个可用的 git 地址' }

  const gitPath = resolveGitPath()
  if (!gitPath) return { ok: false, error: '没找到 git 命令，读不到远端标签（装个 Git for Windows 就能用）' }

  const handle = pnpm.runCommand(gitPath, ['ls-remote', '--tags', '--refs', url], {
    cwd: tmpdir(),
    env: gitEnv(),
    timeoutMs: GIT_TIMEOUT_MS
  })
  const { code, log } = await handle.done

  if (code !== 0) {
    const tail = log.trim().split('\n').filter((l) => l.trim() !== '').slice(-3).join(' / ')
    return { ok: false, error: `读远端标签失败：${tail || `git 退出码 ${String(code)}`}` }
  }

  const tags: string[] = []
  for (const line of log.split('\n')) {
    const m = /refs\/tags\/(\S+)\s*$/.exec(line.trim())
    const tag = m?.[1]
    if (tag && tag !== '') tags.push(tag)
  }
  if (tags.length === 0) return { ok: false, error: '这个仓库没有打任何标签，没法判断新版本' }

  const versioned = tags
    .map((tag) => {
      const version = versionOfTag(tag)
      return version ? { tag, version, pre: isPrerelease(tag, version) } : null
    })
    .filter((x): x is { tag: string; version: string; pre: boolean } => x !== null)

  if (versioned.length === 0) return { ok: false, error: '仓库的标签里没有版本号，没法比较新旧' }

  /*
   * 稳定版优先：只在正式 tag 里挑最大的；一个正式 tag 都没有（仓库只发 beta）才退到预发布。
   * 跟 npm 的 `latest` dist-tag 语义一致 —— 稳定用户不该被悄悄推进 beta。
   */
  const stable = versioned.filter((x) => !x.pre)
  const pickFrom = stable.length > 0 ? stable : versioned
  pickFrom.sort((a, b) => cmpNums(b.version, a.version))
  const best = pickFrom[0]
  if (!best) return { ok: false, error: '仓库的标签里没有可用的版本号' }

  const slug = repoSlugOf(url)
  const spec = slug ? `github:${slug}#${best.tag}` : `${url}#${best.tag}`
  return { ok: true, latest: { tag: best.tag, version: best.version, spec } }
}

/** 只给 UI 一句话：这个包的远程出处是什么 */
export function describeRemote(coords: RemoteCoords): string | null {
  if (coords.repoSlug) return `github:${coords.repoSlug}`
  if (coords.gitUrl) return coords.gitUrl
  if (coords.tarballUrl) return coords.tarballUrl
  return null
}

/**
 * 清空 git 路径探测缓存（设置里改了 git 安装位置后调一下）。
 * 平时不用碰：探测只做一次，结果进程内复用。
 */
export function clearRemoteCache(): void {
  gitPathCache = undefined
}
/**
 * 从 spec 里直接读出仓库地址（`rec.remoteGitUrl` 为空时的兜底）。
 *
 * 什么时候会用到：从 GitHub 装的包，node_modules 里的 package.json 既没写
 * `dsh.install.git` 也没写 `repository` —— 元数据干净得很，但 spec 本身
 * （`github:owner/repo#v1.2.3`）就是坐标。不兜这一下，这类包的更新按钮永远出不来。
 */
export function gitUrlFromSpec(spec: string): string | null {
  const raw = String(spec || '').trim()
  if (raw === '') return null
  const bare = (raw.split('#')[0] ?? '').trim()
  if (bare === '') return null
  if (/^github:/i.test(bare) || /^(git\+|git:|https?:|ssh:|git@)/i.test(bare)) {
    return normalizeGitUrl(bare)
  }
  return null
}