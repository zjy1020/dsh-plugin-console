/**
 * engine/inventory.ts —— profile / 插件清单。
 *
 * 数据源（唯一真相）：
 *   <dshHome>/profiles/<profile>/package.json
 *     ├─ dependencies          装了哪些包、写的什么 spec
 *     └─ dsh.profile.bundles   实际会被加载的层（顺序 = 加载顺序）
 *
 * 两条来源取并集：只在 bundles 里、没进 dependencies 的包也会产出一条记录
 * （spec 记空串），这样 UI 上不会有「在加载但看不见」的幽灵包。
 *
 * 本模块只读，不写任何文件；所有 IO 都兜住异常，绝不抛到 IPC 层。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { PluginRecord, ProfileSummary, SourceKind } from '../../shared/types'
import { classifySpec, specVersionOf } from './spec'
import { getDshHome, getProfileDir } from './env'
import { readConsoleState } from './state'
import { readPatchDisabledIds } from './patch'

/* ------------------------------------------------------------------ *
 * 基础 IO
 * ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function readJsonFile(path: string): Record<string, any> | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8')
    if (!text.trim()) return null
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
}

/** author 可能是 "a <a@b>" 也可能是 { name, email, url } */
function normalizeAuthor(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (isPlainObject(v)) {
    const name = asStringOrNull(v.name)
    if (name) return name
    const email = asStringOrNull(v.email)
    if (email) return email
  }
  return null
}

/**
 * repository 归一化：
 *   git+https://github.com/a/b.git → https://github.com/a/b
 *   git@github.com:a/b.git         → https://github.com/a/b
 *   ssh://git@github.com/a/b       → https://github.com/a/b
 */
function normalizeRepository(v: unknown): string | null {
  let url = typeof v === 'string' ? v.trim() : isPlainObject(v) ? asStringOrNull(v.url) : null
  if (!url) return null
  url = url.replace(/^git\+/i, '')
  url = url.replace(/^git:\/\//i, 'https://')
  url = url.replace(/^ssh:\/\/git@/i, 'https://')
  url = url.replace(/^ssh:\/\//i, 'https://')
  url = url.replace(/^git@([^:/]+):/i, 'https://$1/')
  url = url.replace(/\.git$/i, '')
  url = url.replace(/[/\\]+$/, '')
  return url || null
}

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/** <profileDir>/node_modules/<name>（带 scope 的包名 join 也会展开成两段） */
export function pkgDir(profileDir: string, name: string): string {
  return join(String(profileDir ?? ''), 'node_modules', String(name ?? ''))
}

/** 这个包在 node_modules 里是否真的落了地（存在目录即可） */
export function isInstalledPkg(profileDir: string, name: string): boolean {
  try {
    if (!name) return false
    return existsSync(pkgDir(profileDir, name))
  } catch {
    return false
  }
}

/** 读已装包的 package.json（不存在 / 解析失败 → null） */
export function readInstalledPkgJson(profileDir: string, name: string): Record<string, any> | null {
  try {
    if (!name) return null
    return readJsonFile(join(pkgDir(profileDir, name), 'package.json'))
  } catch {
    return null
  }
}

/** 同步读 <profileDir>/package.json（UI 也能直接拿去用） */
export function readProfileJson(profile: string): Record<string, any> | null {
  try {
    return readJsonFile(join(getProfileDir(profile), 'package.json'))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * profiles 概览
 * ------------------------------------------------------------------ */

/** 枚举 <dshHome>/profiles/*，只要「是目录 + 有 package.json」的 */
export async function listProfiles(): Promise<ProfileSummary[]> {
  const out: ProfileSummary[] = []
  try {
    const root = join(getDshHome(), 'profiles')
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const dir = join(root, e.name)
      const packageJsonPath = join(dir, 'package.json')
      if (!existsSync(packageJsonPath)) continue
      const json = readJsonFile(packageJsonPath) ?? {}
      const deps = isPlainObject(json.dependencies) ? json.dependencies : {}
      const bundles = isPlainObject(json.dsh) && isPlainObject(json.dsh.profile) ? json.dsh.profile.bundles : null
      out.push({
        name: e.name,
        dir,
        packageJsonPath,
        hasNodeModules: existsSync(join(dir, 'node_modules')),
        depCount: Object.keys(deps).length,
        bundleCount: Array.isArray(bundles) ? bundles.filter((b: unknown) => typeof b === 'string').length : 0
      })
    }
  } catch {
    return out
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

/* ------------------------------------------------------------------ *
 * 目录体积（deep 模式）
 * ------------------------------------------------------------------ */

const SIZE_FILE_BUDGET = 20000
const SIZE_TIME_BUDGET_MS = 8000

/**
 * 递归统计目录字节数。
 * - 跳过符号链接（避免 link / 环）
 * - 超过 20000 个条目或 8s 直接返回 null（宁可不报体积，也不卡住 UI）
 */
function dirSize(root: string): number | null {
  const deadline = Date.now() + SIZE_TIME_BUDGET_MS
  let entries = 0
  let total = 0
  const stack: string[] = [root]
  try {
    while (stack.length) {
      if (Date.now() > deadline) return null
      const dir = stack.pop() as string
      let list: import('node:fs').Dirent[]
      try {
        list = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of list) {
        if (++entries > SIZE_FILE_BUDGET) return null
        const p = join(dir, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) {
          stack.push(p)
          continue
        }
        if (e.isFile()) {
          try {
            total += statSync(p).size
          } catch {
            /* 单个文件读不到就跳过 */
          }
        }
      }
    }
  } catch {
    return null
  }
  return total
}

/* ------------------------------------------------------------------ *
 * 插件清单
 * ------------------------------------------------------------------ */

function safeClassify(spec: string): SourceKind {
  try {
    const kind = classifySpec(spec)
    return kind ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function safeSpecVersion(spec: string): string | null {
  try {
    const v = specVersionOf(spec)
    return typeof v === 'string' && v.trim() !== '' ? v : null
  } catch {
    return null
  }
}

function bundleIndexOf(bundles: string[], name: string): number | null {
  for (let i = 0; i < bundles.length; i++) {
    if (bundles[i] === name) return i
  }
  return null
}

/**
 * cordis.patch.yml 里停用的是 **cordis entry id**，不是包名。
 * 实测 desktop profile：entry `custom-brand` ↔ 包 `dsh-custom-brand`，
 * entry `raccoon-merge` ↔ 包 `dsh-raccoon-merge`。所以除精确名字外还要试变体。
 * 命中只是给 UI 一个「补丁层停用了它」的徽标，误命中不影响任何写操作。
 */
function patchDisables(patchIds: Set<string>, name: string): boolean {
  if (patchIds.size === 0) return false
  if (patchIds.has(name)) return true
  const unscoped = name.replace(/^@[^/]+\//, '')
  if (patchIds.has(unscoped)) return true
  if (unscoped.startsWith('dsh-')) {
    const bare = unscoped.slice(4)
    if (patchIds.has(bare)) return true
    // entry 里常见连字符写法：dsh-foo-bar → fooBar / foo-bar 都试一遍
    const camel = bare.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    if (camel !== bare && patchIds.has(camel)) return true
  }
  return false
}

function buildRecord(args: {
  profile: string
  profileDir: string
  name: string
  spec: string
  bundles: string[]
  disabledMap: Record<string, number | null>
  patchIds: Set<string>
  deep: boolean
}): PluginRecord {
  const { profile, profileDir, name, spec, bundles, disabledMap, patchIds, deep } = args

  const installed = isInstalledPkg(profileDir, name)
  const pkg = installed ? readInstalledPkgJson(profileDir, name) : null
  const dir = pkgDir(profileDir, name)
  const bundleIndex = bundleIndexOf(bundles, name)
  const inBundles = bundleIndex !== null
  const builtin = name.startsWith('@deepseek-ai/')

  const dsh = isPlainObject(pkg?.dsh) ? (pkg?.dsh as Record<string, any>) : {}
  const hasServer = !!(dsh.bundle || dsh.profile || dsh.plugin || dsh.server)
  const isBundlePackage = !!dsh.bundle

  const disabled = name in disabledMap || (installed && !inBundles && !builtin)

  let installedAt: number | null = null
  if (installed) {
    try {
      installedAt = statSync(dir).mtimeMs
    } catch {
      installedAt = null
    }
  }

  const sizeBytes = deep && installed ? dirSize(dir) : null

  return {
    id: `${profile}::${name}`,
    profile,
    name,
    spec,
    sourceKind: spec === '' ? 'unknown' : safeClassify(spec),

    installed,
    version: asStringOrNull(pkg?.version),
    specVersion: spec === '' ? null : safeSpecVersion(spec),

    latestVersion: null,
    updateAvailable: false,
    updateKind: 'none',
    updateError: null,
    checkedAt: null,

    description: asStringOrNull(pkg?.description),
    homepage: asStringOrNull(pkg?.homepage),
    repository: normalizeRepository(pkg?.repository),
    author: normalizeAuthor(pkg?.author),
    license: asStringOrNull(pkg?.license),
    keywords: asStringArray(pkg?.keywords),
    hasClient: !!dsh.client,
    hasServer,
    isBundlePackage,

    inBundles,
    bundleIndex,
    disabled,
    disabledInPatch: patchDisables(patchIds, name),
    builtin,
    removable: installed && !builtin,

    depsCount: isPlainObject(pkg?.dependencies) ? Object.keys(pkg?.dependencies as object).length : 0,
    sizeBytes,
    installedAt,
    path: installed ? dir : null
  }
}

/**
 * 一个 profile 的完整插件清单。
 *
 * 数据源 = dependencies ∪ dsh.profile.bundles；排序：第三方优先 → inBundles 降序 → name 字典序。
 * 任何一环炸掉都退化成空数组（不外抛）。
 */
export async function listPlugins(profile: string, opts?: { deep?: boolean }): Promise<PluginRecord[]> {
  const out: PluginRecord[] = []
  try {
    const deep = opts?.deep === true
    const profileDir = getProfileDir(profile)
    const json = readJsonFile(join(profileDir, 'package.json'))
    if (!json) return out

    const deps = isPlainObject(json.dependencies) ? (json.dependencies as Record<string, unknown>) : {}
    const rawBundles = isPlainObject(json.dsh) && isPlainObject(json.dsh.profile) ? json.dsh.profile.bundles : null
    const bundles = Array.isArray(rawBundles) ? rawBundles.filter((b: unknown): b is string => typeof b === 'string') : []

    const state = readConsoleState(profileDir)
    const patchIds = readPatchDisabledIds(profileDir)

    // 并集（去重、保持「deps 在前、bundles 独有的在后」）
    const names: string[] = []
    const seen = new Set<string>()
    for (const n of Object.keys(deps)) {
      if (!n || seen.has(n)) continue
      seen.add(n)
      names.push(n)
    }
    for (const n of bundles) {
      if (!n || seen.has(n)) continue
      seen.add(n)
      names.push(n)
    }

    for (const name of names) {
      const rawSpec = deps[name]
      const spec = typeof rawSpec === 'string' ? rawSpec : ''
      out.push(
        buildRecord({
          profile,
          profileDir,
          name,
          spec,
          bundles,
          disabledMap: state.disabled,
          patchIds,
          deep
        })
      )
    }

    out.sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? 1 : -1
      if (a.inBundles !== b.inBundles) return a.inBundles ? -1 : 1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  } catch {
    return out
  }
  return out
}