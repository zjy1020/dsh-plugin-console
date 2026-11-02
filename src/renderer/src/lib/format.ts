/**
 * format.ts —— 纯展示层格式化：字节 / 相对时间 / 版本比较 / 来源标签。
 * 这里只做「把数据变成能看的字符串」，不碰任何 IO。
 */

import type { SourceKind, UpdateKind } from '../../../shared/types'

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

const EMPTY = '—'

/* ------------------------------- 字节 ------------------------------- */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 人类可读的占用大小；null/undefined → 「—」 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return EMPTY
  if (bytes < 0) return EMPTY
  if (bytes < 1024) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}

/* ------------------------------- 时间 ------------------------------- */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地时间 YYYY-MM-DD HH:mm */
export function formatDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return EMPTY
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

/** 日志行用的时钟 HH:mm:ss */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 相对时间；超过 7 天回落成绝对时间 */
export function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return EMPTY
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day === 1) return '昨天'
  if (day < 7) return `${day} 天前`
  return formatDateTime(ts)
}

/** 时长 1.24s / 820ms */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return EMPTY
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
}

/* ------------------------------- 版本 ------------------------------- */

function parseVersion(v: string): { core: number[]; pre: string | null } {
  const trimmed = v.trim().replace(/^[v=]+/, '').split('+')[0]
  const dash = trimmed.indexOf('-')
  const corePart = dash === -1 ? trimmed : trimmed.slice(0, dash)
  const pre = dash === -1 ? null : trimmed.slice(dash + 1)
  const core = corePart.split('.').map((p) => {
    const n = Number.parseInt(p.replace(/[^0-9].*$/, ''), 10)
    return Number.isFinite(n) ? n : 0
  })
  return { core, pre: pre || null }
}

/**
 * 版本比较（semver-lite）：
 * a > b → 1；a < b → 0 以下 -1；相等 → 0。
 * 只比数字段 + 有无预发布后缀，不处理 build metadata。
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  const va = parseVersion(a)
  const vb = parseVersion(b)
  const len = Math.max(va.core.length, vb.core.length)
  for (let i = 0; i < len; i += 1) {
    const x = va.core[i] ?? 0
    const y = vb.core[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  if (va.pre && !vb.pre) return -1
  if (!va.pre && vb.pre) return 1
  if (va.pre && vb.pre && va.pre !== vb.pre) return va.pre > vb.pre ? 1 : -1
  return 0
}

/** latest 是否比 current 新 */
export function isNewer(
  latest: string | null | undefined,
  current: string | null | undefined
): boolean {
  if (!latest || !current) return false
  return compareVersions(latest, current) > 0
}

/* ------------------------------- 来源 / 更新类型 ------------------------------- */

const SOURCE_LABEL: Record<SourceKind, string> = {
  npm: 'npm',
  link: 'link',
  file: 'file',
  git: 'git',
  tarball: 'tarball',
  workspace: 'workspace',
  unknown: 'unknown'
}

const SOURCE_TONE: Record<SourceKind, Tone> = {
  npm: 'accent',
  link: 'ok',
  file: 'warn',
  git: 'accent',
  tarball: 'warn',
  workspace: 'ok',
  unknown: 'neutral'
}

export function describeSource(kind: SourceKind): { label: string; tone: Tone } {
  return { label: SOURCE_LABEL[kind] ?? 'unknown', tone: SOURCE_TONE[kind] ?? 'neutral' }
}

const UPDATE_KIND_LABEL: Record<UpdateKind, string> = {
  npm: 'registry 新版本',
  git: '远端有新提交',
  relink: '重新链接本地目录',
  none: '无需更新'
}

export function describeUpdateKind(kind: UpdateKind): string {
  return UPDATE_KIND_LABEL[kind] ?? '无需更新'
}

/* ------------------------------- 杂项 ------------------------------- */

/** 长路径中间省略，保留盘符与尾部 */
export function shortPath(path: string | null | undefined, max = 54): string {
  if (!path) return EMPTY
  if (path.length <= max) return path
  const head = path.slice(0, Math.max(8, Math.floor(max * 0.42)))
  const tail = path.slice(-Math.max(8, Math.floor(max * 0.5)))
  return `${head}…${tail}`
}

export function plural(n: number, unit: string): string {
  return `${n} ${unit}`
}

/** 「3 / 12」进度文本 */
export function formatProgress(done: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '准备中…'
  return `${done} / ${total}`
}

export function percentOf(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

/** 空值统一显示 */
export function orDash(value: string | null | undefined): string {
  if (value === null || value === undefined) return EMPTY
  const s = String(value).trim()
  return s.length ? s : EMPTY
}

export const EMPTY_TEXT = EMPTY
