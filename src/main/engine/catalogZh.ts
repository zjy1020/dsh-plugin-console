/**
 * catalogZh —— 把插件市场目录里的**中文简介**接到「已安装插件」这一侧。
 *
 * 为什么单独有这么一层：
 * 列表里的简介来自每个包自己的 package.json，而社区插件的 description 基本都是英文；
 * 目录（catalog.json）恰恰每条都带一版中文（实测 9111 / 9111 条全有）。用户看不懂英文，
 * 就等于不知道这个插件是干什么的 —— 这一层就是为了给「简介」补上中文。
 *
 * 三条设计决定：
 *  1) **只读磁盘缓存，绝不在这里联网**。列表页要秒开，不能为了补一句中文就去连 npm；
 *     目录从没抓过（用户还没进过市场页）时返回 null，界面照旧显示包自己的英文简介 ——
 *     少一句中文是遗憾，卡一下列表才是事故。
 *  2) **一条目录条目注册多个索引键**：name、npm 字段、name 里 `#` 之后那段、以及各段的
 *     最后一级路径。因为目录里的名字有 `dsh-web#packages/dsh-better-sidebar` 这种子目录
 *     形态，而 profile 里装的名字是 `dsh-better-sidebar`；只按 name 精确匹配的话这些全对不上
 *     （实测 17 个已装包只命中 7 个，加多键后 14 个）。
 *  3) **用 mtime:size 当缓存键**：市场页「重新拉取」会重写这份 catalog.json，改完 mtime 就变，
 *     下一次查询自动读到新索引 —— 不需要谁来通知这一层「目录更新了」。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { PluginRecord, SearchHit } from '../../shared/types'
import { getSettingsPath } from './settings'

/** 与 market.ts 里那份磁盘缓存同名同目录（同一个文件，不是又存一份） */
const CACHE_FILE = 'catalog.json'

interface Memo {
  /** `${mtimeMs}:${size}` */
  key: string
  /** 小写索引键 → 中文简介 */
  index: Map<string, string>
}

let memo: Memo | null = null

/** 目录缓存文件路径；读不到设置路径就没有这一层 */
function cachePath(): string {
  try {
    return join(dirname(getSettingsPath()), CACHE_FILE)
  } catch {
    return ''
  }
}

/** 归一化一个候选键：小写、去空白、去首尾斜杠 */
function normKey(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.trim().toLowerCase().replace(/^\/+|\/+$/g, '')
}

/**
 * 一条目录条目能注册的全部键。
 * 例：name = `dsh-web#packages/dsh-better-sidebar`
 *   → `dsh-web#packages/dsh-better-sidebar`、`dsh-better-sidebar`
 * 若 npm = `@tt-a1i/archify-dsh`
 *   → `@tt-a1i/archify-dsh`、`archify-dsh`
 */
function keysOf(entry: Record<string, unknown>): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    const k = normKey(v)
    if (k !== '' && !out.includes(k)) out.push(k)
  }
  const pushAll = (v: unknown): void => {
    push(v)
    const k = normKey(v)
    if (k === '') return
    const hash = k.includes('#') ? (k.split('#').pop() ?? '') : k
    push(hash)
    // 最后一级路径：`@scope/name` → `name`、`packages/dsh-x` → `dsh-x`
    const base = hash.split('/').pop() ?? ''
    push(base)
  }

  pushAll(entry.name)
  pushAll(entry.npm)
  return out
}

/** 读目录缓存 → 建索引；文件不存在 / 坏了 / 结构不对都当「没有这一层」 */
function buildIndex(): Memo | null {
  const p = cachePath()
  if (!p || !existsSync(p)) return null

  let key = ''
  try {
    const st = statSync(p)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
  if (memo && memo.key === key) return memo

  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const list = Array.isArray(raw?.plugins) ? (raw.plugins as unknown[]) : []
    const index = new Map<string, string>()
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const desc = entry.description
      if (!desc || typeof desc !== 'object') continue
      const d = desc as Record<string, unknown>
      const zh = [d['zh-CN'], d['zh']].find((v) => typeof v === 'string' && v.trim() !== '')
      if (typeof zh !== 'string') continue
      const text = zh.trim()
      for (const k of keysOf(entry)) {
        // 先到先得：目录里偶尔有重名条目，第一个通常是最新收录的那条
        if (!index.has(k)) index.set(k, text)
      }
    }
    memo = { key, index }
    return memo
  } catch {
    return null
  }
}

/** 包名 → 目录里的中文简介；目录没抓过 / 对不上都是 null */
export function zhFor(name: string): string | null {
  const idx = buildIndex()
  if (!idx) return null
  const candidates: string[] = []
  const k = normKey(name)
  if (k === '') return null
  candidates.push(k)
  const base = k.split('/').pop() ?? ''
  if (base !== '' && base !== k) candidates.push(base)
  const afterHash = k.includes('#') ? (k.split('#').pop() ?? '') : ''
  if (afterHash !== '') candidates.push(afterHash)
  for (const c of candidates) {
    const hit = idx.index.get(c)
    if (hit) return hit
  }
  return null
}

/**
 * 给一批已装插件补中文简介。
 * 只补 `descZh`，其它字段一个不动 —— 调用方拿到的是同一批记录（就地改 + 原样返回）。
 */
export function annotatePlugins(records: PluginRecord[]): PluginRecord[] {
  if (!buildIndex()) return records
  for (const rec of records) {
    if (rec.descZh !== null) continue
    rec.descZh = zhFor(rec.name)
  }
  return records
}

/** 给一批 npm 搜索命中补中文简介（搜索接口只给英文） */
export function annotateHits(hits: SearchHit[]): SearchHit[] {
  if (!buildIndex()) return hits
  for (const hit of hits) {
    if (hit.descZh !== null) continue
    hit.descZh = zhFor(hit.name)
  }
  return hits
}

/** 目录缓存被重写之后（换源 / 强制刷新）主动丢掉索引；不调也没关系，mtime 会兜住 */
export function clearZhIndex(): void {
  memo = null
}
