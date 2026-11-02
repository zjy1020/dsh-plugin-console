/**
 * engine/state.ts —— 插件台自己的 profile 侧写（停用记录）。
 *
 * 落盘位置：<profileDir>\.dsh-console\state.json
 *
 * 为什么需要它：cordis.patch.yml 是 DSH 自己的补丁层，格式受 DSH 约束；
 * 插件台的「停用」语义是「从 dsh.profile.bundles 里移出」——移出前它排在第几位
 * 得自己记下来，才能原样恢复。所以用一份自己的小账本存 disabled 的下标。
 *
 * 读写全程 try/catch：失败返回空账本，绝不抛到 IPC 层。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ConsoleProfileState {
  /** 包名 → 被移出 bundles 前所在下标（不知道就 null） */
  disabled: Record<string, number | null>
  updatedAt: number
}

function emptyState(): ConsoleProfileState {
  return { disabled: {}, updatedAt: 0 }
}

/** <profileDir>/.dsh-console/state.json */
export function getStatePath(profileDir: string): string {
  return join(String(profileDir ?? ''), '.dsh-console', 'state.json')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 只保留「字符串键 → number | null」的条目 */
function normalizeDisabled(raw: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  if (!isPlainObject(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (!k) continue
    if (v === null || v === undefined) {
      out[k] = null
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.trunc(v)
    } else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      out[k] = Math.trunc(Number(v))
    }
    // 其它类型一律丢弃
  }
  return out
}

/** 读侧写账本；文件不存在 / 解析失败 / 读不动 → 空账本 */
export function readConsoleState(profileDir: string): ConsoleProfileState {
  try {
    const p = getStatePath(profileDir)
    if (!p || !existsSync(p)) return emptyState()
    const text = readFileSync(p, 'utf8')
    if (!text.trim()) return emptyState()
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) return emptyState()
    const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
    return { disabled: normalizeDisabled(parsed.disabled), updatedAt }
  } catch {
    return emptyState()
  }
}

/** 写侧写账本；失败静默兜底（调用方拿到的是「尝试写过了」的口径） */
export function writeConsoleState(profileDir: string, s: ConsoleProfileState): void {
  try {
    const p = getStatePath(profileDir)
    if (!p) return
    const payload: ConsoleProfileState = {
      disabled: normalizeDisabled(s?.disabled),
      updatedAt: typeof s?.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : Date.now()
    }
    try {
      mkdirSync(dirname(p), { recursive: true })
    } catch {
      /* 目录建不出来，下面写盘也会失败 */
    }
    const body = JSON.stringify(payload, null, 2)
    const tmp = `${p}.tmp`
    try {
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, p)
    } catch {
      writeFileSync(p, body, 'utf8')
    }
  } catch {
    /* 静默兜底 */
  }
}
