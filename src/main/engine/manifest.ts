/**
 * engine/manifest.ts —— 插件清单（快照）导出 / 校验 / 导入预览。
 *
 * 清单解决的事：一台机器上当前 profile 装了哪些**第三方**插件，
 * 导成一份 JSON，换台机器 / 换个 profile 后一键装回来。
 *
 * 三条原则：
 *   一、只收 `installed && removable` 的包 —— 也就是排除 `@deepseek-ai/*` 官方内置层，
 *       那部分是随 DSH 一起发的，不该进清单，也没法用 pnpm 重装；
 *   二、`spec` **保真** —— 优先用 profile `package.json` dependencies 里的原始值
 *       （`^1.66.5` / `link:D:\...` / `github:o/r`），否则本地路径来源的包装不回来；
 *   三、解析要**宽容** —— 缺 `kind` 的 `{ plugins: [...] }` 也认，只给 warning。
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { dialog } from 'electron'

import * as env from './env'
import * as inventory from './inventory'
import { classifySpec } from './spec'

import type {
  ManifestEntry,
  ManifestExportResult,
  ManifestFile,
  ManifestPreview,
  PluginRecord
} from '../../shared/types'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 清单文件的身份标记 */
const MANIFEST_KIND = 'dsh-plugin-console/manifest'

/** `link:` / `file:` 这类本地路径来源 —— 换机器基本装不上，要提前警告 */
const LOCAL_SOURCE_KINDS = new Set(['link', 'file', 'workspace'])

/** 不带范围前缀的精确版本，如 `1.2.3` / `1.2.3-beta.1` */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function textOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 有意义的非空字符串 */
function nonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** dsh-plugins-desktop-20261102-1203.json */
function defaultFileName(profile: string): string {
  const d = new Date()
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  const safe = String(profile || 'profile').replace(/[\\/:*?"<>|]/g, '_')
  return `dsh-plugins-${safe}-${stamp}.json`
}

/** 读 <profileDir>/package.json 的 dependencies（拿原始 spec 用） */
function depsOfProfile(profile: string): Record<string, string> {
  try {
    const pkg = inventory.readProfileJson(profile)
    const deps = pkg?.['dependencies']
    if (deps && typeof deps === 'object') return deps as Record<string, string>
  } catch {
    /* 读不到就用空表，spec 从 PluginRecord 兜底 */
  }
  return {}
}

/* ------------------------------------------------------------------ *
 * build
 * ------------------------------------------------------------------ */

/**
 * 判断一个已装插件该不该写进导出清单。
 *
 * 三条都要满足：
 * 1. `installed` —— 真的装在这个 profile 里；
 * 2. `removable` —— 排掉 @deepseek-ai/* 官方内置层（它们随 runtime 发布，不在依赖表里，写进去也装不回来）；
 * 3. 来源不是本机路径 —— `link:` / `file:` / `workspace:` 指向的是这台机器上的目录，
 *    清单拿去另一台机器就断了。**导出清单的用途是「能一键装回来」，所以这些一律不写**，
 *    它们的名字通过 {@link ManifestBuildResult.skipped} 带出去给提示用。
 */
export function isExportable(record: PluginRecord): boolean {
  if (record.installed !== true || record.removable !== true) return false
  return !LOCAL_SOURCE_KINDS.has(record.sourceKind ?? 'unknown')
}

export interface ManifestBuildResult {
  ok: boolean
  file: ManifestFile | null
  json: string
  count: number
  /** 因为来源是本机路径（link: / file:）而没写进清单的包名，按名字排序 */
  skipped: string[]
  error: string | null
}

/**
 * 给某个 profile 生成清单快照。
 * `dshVersion` 取随包 runtime 版本（拿不到就给 null，不阻断导出）。
 */
export async function build(profile: string): Promise<ManifestBuildResult> {
  try {
    const list = await inventory.listPlugins(profile)
    const deps = depsOfProfile(profile)

    const plugins: ManifestEntry[] = []
    /** 本机路径来源的包：不写进清单，但要把名字说出来 */
    const skipped: string[] = []
    for (const rec of Array.isArray(list) ? list : []) {
      if (!rec) continue
      const skippedName = nonEmpty(rec.name)
      if (skippedName && rec.installed === true && rec.removable === true
        && LOCAL_SOURCE_KINDS.has(rec.sourceKind ?? 'unknown')) {
        skipped.push(skippedName)
      }
      if (!isExportable(rec)) continue
      const name = skippedName
      if (!name) continue

      const rawSpec = nonEmpty(deps[name]) ?? nonEmpty(rec.spec) ?? ''
      /* spec 缺失（比如只存在于 bundles 里）：退化成包名，至少保证能装 */
      const spec = rawSpec || name

      plugins.push({
        name,
        spec,
        sourceKind: rec.sourceKind ?? safeClassify(spec),
        version: nonEmpty(rec.version),
        inBundles: rec.inBundles === true,
        disabled: rec.disabled === true
      })
    }

    /* 名字排序，方便人肉 diff 两份清单 */
    plugins.sort((a, b) => a.name.localeCompare(b.name))
    skipped.sort((a, b) => a.localeCompare(b))

    let dshVersion: string | null = null
    try {
      const info = await env.getRuntimeInfo()
      dshVersion = nonEmpty(info?.runtimeVersion)
    } catch {
      dshVersion = null
    }

    const file: ManifestFile = {
      kind: MANIFEST_KIND,
      version: 1,
      exportedAt: new Date().toISOString(),
      dshVersion,
      profile: String(profile ?? ''),
      plugins
    }

    return {
      ok: true,
      file,
      json: JSON.stringify(file, null, 2),
      count: plugins.length,
      skipped,
      error: null
    }
  } catch (err) {
    return { ok: false, file: null, json: '', count: 0, skipped: [], error: textOf(err) }
  }
}

/** classifySpec 不该抛，但兜一层更省心 */
function safeClassify(spec: string): ManifestEntry['sourceKind'] {
  try {
    return classifySpec(spec)
  } catch {
    return 'unknown'
  }
}

/* ------------------------------------------------------------------ *
 * parse
 * ------------------------------------------------------------------ */

export interface ManifestParseResult {
  ok: boolean
  file: ManifestFile | null
  error: string | null
  warnings: string[]
}

function normalizeEntry(raw: unknown): ManifestEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const name = nonEmpty(o['name'])
  if (!name) return null

  const rawSpec = nonEmpty(o['spec'])
  const spec = rawSpec ?? name
  const kind = nonEmpty(o['sourceKind'])

  return {
    name,
    spec,
    sourceKind: (kind as ManifestEntry['sourceKind']) ?? safeClassify(spec),
    version: nonEmpty(o['version']),
    inBundles: o['inBundles'] === true,
    disabled: o['disabled'] === true
  }
}

/**
 * 解析清单文本。
 * - `kind` 不匹配 → 给 warning 照收（宽容）；`plugins` 不是数组 → 硬拒。
 * - 单条非法 → 丢弃并记 warning；只有整体不可用时才 `ok:false`。
 */
export function parse(text: string): ManifestParseResult {
  const warnings: string[] = []

  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) {
    return { ok: false, file: null, error: '清单内容是空的', warnings }
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    return { ok: false, file: null, error: `清单不是合法的 JSON：${textOf(err)}`, warnings }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, file: null, error: '清单格式不对：顶层不是对象', warnings }
  }

  const o = data as Record<string, unknown>

  const pluginsRaw = o['plugins']
  if (!Array.isArray(pluginsRaw)) {
    return { ok: false, file: null, error: '清单格式不对：缺少 plugins 数组', warnings }
  }

  const kind = nonEmpty(o['kind'])
  if (kind && kind !== MANIFEST_KIND) {
    warnings.push(`清单的 kind 是「${kind}」，不是本工具导出的格式，按兼容模式解析`)
  } else if (!kind) {
    warnings.push('清单缺少 kind 字段，按兼容模式解析')
  }

  const plugins: ManifestEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  let deduped = 0

  for (const item of pluginsRaw) {
    const entry = normalizeEntry(item)
    if (!entry) {
      dropped++
      continue
    }
    if (seen.has(entry.name)) {
      deduped++
      continue
    }
    seen.add(entry.name)
    plugins.push(entry)
  }

  if (dropped > 0) warnings.push(`清单里有 ${dropped} 条条目缺少有效的 name，已丢弃`)
  if (deduped > 0) warnings.push(`清单里有 ${deduped} 条重复的包名，已只保留第一条`)
  if (plugins.length === 0) warnings.push('清单里没有可用的插件条目')

  const file: ManifestFile = {
    kind: MANIFEST_KIND,
    version: 1,
    exportedAt: nonEmpty(o['exportedAt']) ?? '',
    dshVersion: nonEmpty(o['dshVersion']),
    profile: nonEmpty(o['profile']) ?? '',
    plugins
  }

  return { ok: true, file, error: null, warnings }
}

/* ------------------------------------------------------------------ *
 * specsOf
 * ------------------------------------------------------------------ */

/**
 * 决定导入时每条包交给 pnpm 什么 spec。
 *
 * - `npm`：清单导入的语义是「把这批插件装上」，装到最新更合理 → 只用包名。
 *   但如果清单里的 spec 本身就是精确版本（`1.2.3`，不带 `^` `~` 前缀）→ 尊重它，
 *   给 `name@1.2.3`，免得「照着清单重建环境」却装出别的版本。
 * - `link` / `file` / `git` / `tarball`：原样用 spec，本地路径和 git 来源必须保真。
 */
export function specsOf(entries: ManifestEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (!e || !e.name) continue
    const spec = String(e.spec ?? '').trim()

    if (e.sourceKind === 'npm') {
      if (EXACT_VERSION_RE.test(spec)) {
        out.push(`${e.name}@${spec}`)
      } else {
        out.push(e.name)
      }
      continue
    }

    /* 非 npm 来源：原样保真；spec 为空（异常清单）就退化成包名 */
    out.push(spec || e.name)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * saveToFile
 * ------------------------------------------------------------------ */

/**
 * 弹另存为对话框并落盘。
 * 取消 / 失败都返回 ok:false + 中文原因，不抛。
 */
export async function saveToFile(
  win: import('electron').BrowserWindow,
  profile: string
): Promise<ManifestExportResult> {
  const built = await build(profile)

  if (!built.ok || !built.file || built.file.plugins.length === 0) {
    return {
      ok: false,
      path: null,
      count: 0,
      /* 一个都没写进文件，但被跳过的本地来源仍要说出来，否则只会看到一个没头没尾的报错 */
      skipped: built.skipped,
      error: built.error ?? (built.skipped.length > 0
        ? `这个 profile 里只有本地路径来源的插件（${built.skipped.join('、')}），换台机器装不上，没有可导出的条目`
        : '当前 profile 没有可导出的第三方插件')
    }
  }

  let filePath: string | null = null
  try {
    const picked = await dialog.showSaveDialog(win, {
      title: '导出插件清单',
      defaultPath: defaultFileName(profile),
      filters: [{ name: 'JSON 清单', extensions: ['json'] }]
    })
    if (picked.canceled || !picked.filePath) {
      return { ok: false, path: null, count: 0, skipped: built.skipped, error: '已取消' }
    }
    filePath = picked.filePath
  } catch (err) {
    return { ok: false, path: null, count: 0, skipped: built.skipped, error: `打开保存对话框失败：${textOf(err)}` }
  }

  try {
    writeFileSync(filePath, built.json, 'utf8')
  } catch (err) {
    return { ok: false, path: null, count: 0, skipped: built.skipped, error: `写清单文件失败：${textOf(err)}` }
  }

  return { ok: true, path: filePath, count: built.count, skipped: built.skipped, error: null }
}

/* ------------------------------------------------------------------ *
 * preview
 * ------------------------------------------------------------------ */

function emptyPreview(profile: string, error: string): ManifestPreview {
  return {
    ok: false,
    profile,
    total: 0,
    present: [],
    missing: [],
    specs: [],
    warnings: [],
    error
  }
}

/**
 * 导入前预览：这份清单里哪些已经装了、哪些缺、以及要给 pnpm 什么 spec。
 * 只读，绝不改 profile。
 */
export async function preview(profile: string, text: string): Promise<ManifestPreview> {
  const parsed = parse(text)
  if (!parsed.ok || !parsed.file) {
    return emptyPreview(profile, parsed.error ?? '清单解析失败')
  }

  const target = String(profile ?? '')
  const file = parsed.file
  const warnings = parsed.warnings.slice()

  /* 当前 profile 已装的包名集合 */
  const installed = new Set<string>()
  let list: PluginRecord[] = []
  try {
    list = await inventory.listPlugins(target)
  } catch {
    list = []
  }
  for (const rec of Array.isArray(list) ? list : []) {
    if (rec && rec.installed === true && rec.name) installed.add(rec.name)
  }

  const present: string[] = []
  const missing: ManifestEntry[] = []
  for (const e of file.plugins) {
    if (installed.has(e.name)) present.push(e.name)
    else missing.push(e)
  }

  const specs = specsOf(missing)

  /* 人话警告 */
  const localCount = missing.filter((e) => LOCAL_SOURCE_KINDS.has(e.sourceKind)).length
  if (localCount > 0) {
    warnings.push(
      `清单里有 ${localCount} 个本地路径来源的包（link: / file:），换台机器装不上，除非那些路径也存在`
    )
  }

  const gitCount = missing.filter((e) => e.sourceKind === 'git').length
  if (gitCount > 0) {
    warnings.push(`清单里有 ${gitCount} 个 git 来源的包，安装时需要能访问 GitHub`)
  }

  if (file.profile && file.profile !== target) {
    warnings.push(`这份清单是从 ${file.profile} 导出的，当前是 ${target}`)
  }

  /* 全部已装不算 warning，missing 为空即可，渲染层会显示「没有需要安装的包」 */

  return {
    ok: true,
    profile: target,
    total: file.plugins.length,
    present,
    missing,
    specs,
    warnings,
    error: null
  }
}

/* ------------------------------------------------------------------ *
 * 杂项导出
 * ------------------------------------------------------------------ */

/** 给别处复用：读一个文件当清单文本（比如拖拽进来的路径） */
export function readManifestFile(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

export { MANIFEST_KIND }
