/**
 * updates.ts —— 更新检查。
 *
 * 只做「判定」，不做任何写操作：对每个包算出 latestVersion / updateAvailable /
 * updateKind / updateError / checkedAt，覆盖回 PluginRecord 返回给 UI。
 * 真正执行升级由 ops.ts 里的 pnpm 逻辑负责（updateKind 就是给它的提示）。
 *
 * 单包的任何异常都被吃掉，折成 updateError 中文说明；本模块不抛。
 */

import type { PluginRecord, SourceKind, UpdateCheckProgress, UpdateKind } from '../../shared/types'
import { listPlugins } from './inventory'
import { registryPackument } from './net'
import { latestGitTag } from './remote'
import { get as getSettings } from './settings'
import { classifySpec } from './spec'

/* ------------------------------------------------------------------ *
 * 版本比较
 * ------------------------------------------------------------------ */

/** 剥掉 `^ ~ >= <= > < =` 这些范围前缀和前后空格 */
function stripRange(v: string): string {
  return (v ?? '').trim().replace(/^[\s^~><=v]+/i, '').trim()
}

interface ParsedVersion {
  nums: number[]
  /** prerelease 标识符（`1.2.3-beta.1` → ['beta','1']） */
  pre: string[]
  /** 是否真的解析出了数字段 */
  numeric: boolean
}

function parseVersion(v: string): ParsedVersion {
  let s = stripRange(String(v ?? ''))
  const plus = s.indexOf('+') // build metadata 不参与比较
  if (plus >= 0) s = s.slice(0, plus)
  const dash = s.indexOf('-')
  const core = (dash >= 0 ? s.slice(0, dash) : s).trim()
  const preStr = dash >= 0 ? s.slice(dash + 1).trim() : ''

  const nums: number[] = []
  let numeric = false
  if (core) {
    for (const part of core.split('.')) {
      const m = /^\d+/.exec(part.trim())
      if (m) {
        numeric = true
        nums.push(Number(m[0]))
      } else {
        nums.push(0)
      }
    }
  }
  if (nums.length === 0) nums.push(0, 0, 0)
  while (nums.length < 3) nums.push(0)

  const pre = preStr ? preStr.split('.').filter((x) => x !== '') : []
  return { nums, pre, numeric }
}

/**
 * 版本比较：a > b 返回正数，a < b 返回负数，相等 0。
 * 支持 1.2.3 / 1.2 / 1 / 1.2.3-beta.1，以及 `^1.2.3` 这类带前缀的写法；
 * prerelease 小于同版本号的正式版（semver 规则）。
 */
export function compareVersions(a: string, b: string): number {
  const A = parseVersion(a)
  const B = parseVersion(b)

  // 完全解析不出数字（比如 'latest' vs 'beta'）→ 退回字符串比较，至少稳定
  if (!A.numeric && !B.numeric) {
    const sa = stripRange(String(a ?? ''))
    const sb = stripRange(String(b ?? ''))
    return sa === sb ? 0 : sa > sb ? 1 : -1
  }

  const len = Math.max(A.nums.length, B.nums.length)
  for (let i = 0; i < len; i++) {
    const x = A.nums[i] ?? 0
    const y = B.nums[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }

  // 数字段相同 → 比 prerelease：有 prerelease 的 < 没有的
  if (A.pre.length === 0 && B.pre.length === 0) return 0
  if (A.pre.length === 0) return 1
  if (B.pre.length === 0) return -1

  const n = Math.max(A.pre.length, B.pre.length)
  for (let i = 0; i < n; i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx > dy ? 1 : -1
      continue
    }
    if (xn !== yn) return xn ? -1 : 1 // 数字标识符优先级低于字母
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 40 位 commit sha（前后不接十六进制字符，避免误判普通字符串） */
const SHA40 = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{40})(?:$|[^0-9a-fA-F])/

const BUILTIN_PREFIX = '@deepseek-ai/'

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 160 ? `${t.slice(0, 160)}…` : t
}

function concurrencyOf(): number {
  let n = 6
  try {
    const raw = getSettings().concurrency
    if (typeof raw === 'number' && Number.isFinite(raw)) n = Math.floor(raw)
  } catch {
    /* 设置没就绪 → 默认 6 */
  }
  if (n < 1) return 1
  if (n > 16) return 16
  return n
}

function sourceKindOf(rec: PluginRecord): SourceKind {
  return rec.sourceKind ?? classifySpec(rec.spec)
}

interface CheckOutcome {
  record: PluginRecord
  result: 'ok' | 'error' | 'skipped'
}

/** 覆盖字段并返回新记录（不改原对象） */
function patchRecord(rec: PluginRecord, patch: Partial<PluginRecord>): PluginRecord {
  return { ...rec, ...patch, checkedAt: Date.now() }
}

/* ------------------------------------------------------------------ *
 * 单包判定
 * ------------------------------------------------------------------ */

async function checkOne(rec: PluginRecord): Promise<CheckOutcome> {
  const name = rec.name
  const kind = sourceKindOf(rec)

  /* --- 官方内置且没装（随 runtime 走，不用查） --- */
  if (name.startsWith(BUILTIN_PREFIX) && rec.installed === false) {
    return {
      result: 'skipped',
      record: patchRecord(rec, {
        latestVersion: null,
        updateAvailable: false,
        updateKind: 'none',
        updateError: null
      })
    }
  }

  switch (kind) {
    /* ---------------- npm：查 registry 比版本 ---------------- */
    case 'npm': {
      const pack = await registryPackument(name)

      if (pack.notFound) {
        return {
          result: 'error',
          record: patchRecord(rec, {
            latestVersion: null,
            updateAvailable: false,
            updateKind: 'npm',
            updateError: pack.error ?? 'npm registry 上没有这个包'
          })
        }
      }
      if (pack.error || !pack.latest) {
        return {
          result: 'error',
          record: patchRecord(rec, {
            latestVersion: null,
            updateAvailable: false,
            updateKind: 'npm',
            updateError: pack.error ?? '拿不到 npm registry 上的 latest 版本'
          })
        }
      }

      const latest = pack.latest
      const installed = rec.version
      if (!installed) {
        return {
          result: 'error',
          record: patchRecord(rec, {
            latestVersion: latest,
            updateAvailable: false,
            updateKind: 'npm',
            updateError: 'node_modules 里没有这个包，需要重新安装'
          })
        }
      }

      const cmp = compareVersions(latest, installed)
      return {
        result: 'ok',
        record: patchRecord(rec, {
          latestVersion: latest,
          updateAvailable: cmp > 0,
          updateKind: 'npm',
          updateError: null
        })
      }
    }

    /* ---------------- git：只能看 ref，没法比版本 ---------------- */
    case 'git': {
      const pinned = SHA40.test(rec.spec ?? '')
      return {
        result: pinned ? 'skipped' : 'ok',
        record: patchRecord(rec, {
          latestVersion: null,
          updateAvailable: false,
          updateKind: 'git',
          updateError: pinned ? '已锁定 commit，不自动更新' : null
        })
      }
    }

    /* ---------------- 远程 tarball：没版本概念 ---------------- */
    case 'tarball':
      return {
        result: 'skipped',
        record: patchRecord(rec, {
          latestVersion: null,
          updateAvailable: false,
          updateKind: 'none',
          updateError: '远程 tarball，无法比较版本'
        })
      }

    /* ---------------- file：本地 tarball —— 能追到远程就给更新 ---------------- */
    /*
     * 这是用户实测踩到的那一类：从 GitHub 装的插件，profile 里落的却是
     * `file:C:/…/pkgs/<sha>/x-1.6.69.tgz`。原来这里一律 updateAvailable=false，
     * 界面上既没按钮也没解释，用户只能看着一个 `FILE` 徽章发愣。
     *
     * 现在：包自己的 package.json 里若声明了远程出处（dsh.install.git / repository /
     * GitHub 首页），就顺着它问远端最新 tag —— 查得到就有更新按钮，查不到也把原因说出来。
     *
     * link / workspace 不走这条路：那两个是用户自己的源码目录，本地就是最新，
     * 拿远端 tag 去标「可更新」会把正在开发的东西指回旧发布版。
     */
    case 'file': {
      const remote = rec.remoteGitUrl
      if (!remote || !rec.installed) {
        return {
          result: 'skipped',
          record: patchRecord(rec, {
            latestVersion: null,
            updateAvailable: false,
            updateKind: 'none' as UpdateKind,
            remoteSpec: null,
            updateError: null
          })
        }
      }

      const ask = await latestGitTag(remote)
      if (!ask.ok) {
        return {
          result: 'error',
          record: patchRecord(rec, {
            latestVersion: null,
            updateAvailable: false,
            updateKind: 'git',
            remoteSpec: null,
            updateError: ask.error
          })
        }
      }

      const latest = ask.latest.version
      const installed = rec.version
      return {
        result: 'ok',
        record: patchRecord(rec, {
          latestVersion: latest,
          updateAvailable: installed ? compareVersions(latest, installed) > 0 : true,
          updateKind: 'git',
          remoteSpec: ask.latest.spec,
          updateError: null
        })
      }
    }

    /* ---------------- link：重新 link 一下就行 ---------------- */
    case 'link':
      return {
        result: 'skipped',
        record: patchRecord(rec, {
          latestVersion: null,
          updateAvailable: false,
          updateKind: 'relink',
          updateError: null
        })
      }

    /* ---------------- workspace / unknown：不管 ---------------- */
    case 'workspace':
    case 'unknown':
    default:
      return {
        result: 'skipped',
        record: patchRecord(rec, {
          latestVersion: null,
          updateAvailable: false,
          updateKind: 'none' as UpdateKind,
          updateError: null
        })
      }
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 检查更新。返回 `{ [包名]: 更新后的完整 PluginRecord }`，只含本次真正检查过的包。
 * names 传了就只查这些；不传则全量。
 */
export async function checkUpdates(
  profile: string,
  names: string[] | undefined,
  onProgress?: (p: UpdateCheckProgress) => void
): Promise<Record<string, PluginRecord>> {
  const out: Record<string, PluginRecord> = {}

  let all: PluginRecord[] = []
  try {
    const listed = await listPlugins(profile)
    if (Array.isArray(listed)) all = listed
  } catch (e) {
    console.warn('[updates] listPlugins 失败：', errText(e))
    return out
  }

  const wanted =
    names && names.length > 0 ? new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0)) : null
  const targets = wanted ? all.filter((r) => r && typeof r.name === 'string' && wanted.has(r.name)) : all

  const total = targets.length
  if (total === 0) return out

  const emit = (name: string, result: 'ok' | 'error' | 'skipped', doneCount: number): void => {
    if (!onProgress) return
    try {
      onProgress({ profile, done: doneCount, total, name, result })
    } catch {
      /* UI 回调出错不影响检查 */
    }
  }

  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++
      if (idx >= total) return
      const rec = targets[idx]!
      let outcome: CheckOutcome
      try {
        outcome = await checkOne(rec)
      } catch (e) {
        outcome = {
          result: 'error',
          record: patchRecord(rec, {
            latestVersion: null,
            updateAvailable: false,
            updateError: `检查失败：${errText(e)}`
          })
        }
      }
      out[rec.name] = outcome.record
      done++
      emit(rec.name, outcome.result, done)
    }
  }

  const lanes = Math.min(concurrencyOf(), total)
  await Promise.all(Array.from({ length: lanes }, () => worker()))

  return out
}
