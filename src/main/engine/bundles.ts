/**
 * bundles.ts —— profile 的 package.json 读写层。
 *
 * 只做一件事：安全地读 / 改 `<profileDir>/package.json`，其中：
 *   - `dependencies`  = 装了什么；
 *   - `dsh.profile.bundles` = 实际会被加载的插件层（顺序有意义）。
 *
 * 写操作全部走「先备份 → 原子写（.tmp + rename）」；任何异常都转成返回值，不外抛。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface WriteResult {
  ok: boolean
  error: string | null
}

const PKG_NAME = 'package.json'
const BACKUP_DIR = '.dsh-console'
const BACKUP_SUBDIR = 'backup'

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

/** 同步读 profile 的 package.json；不存在 / 解析失败 → null */
export function readProfilePkg(profileDir: string): any | null {
  const file = path.join(profileDir, PKG_NAME)
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const json = JSON.parse(raw)
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null
    return json
  } catch {
    return null
  }
}

/** 取 `dsh.profile.bundles`，永远返回 string[] */
export function getBundles(profileDir: string): string[] {
  const json = readProfilePkg(profileDir)
  return readBundles(json)
}

function readBundles(json: any): string[] {
  try {
    const list = json?.dsh?.profile?.bundles
    if (!Array.isArray(list)) return []
    return list.filter((x: unknown): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function clone<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T
  } catch {
    return v
  }
}

/** 保证 dsh.profile.bundles 路径存在（在传入的副本上原地建） */
function ensureBundlePath(json: any): string[] {
  if (!json.dsh || typeof json.dsh !== 'object' || Array.isArray(json.dsh)) json.dsh = {}
  if (!json.dsh.profile || typeof json.dsh.profile !== 'object' || Array.isArray(json.dsh.profile)) {
    json.dsh.profile = {}
  }
  if (!Array.isArray(json.dsh.profile.bundles)) json.dsh.profile.bundles = []
  /* 清掉非字符串脏数据，保证后续 indexOf / splice 语义干净 */
  json.dsh.profile.bundles = json.dsh.profile.bundles.filter((x: unknown) => typeof x === 'string')
  return json.dsh.profile.bundles
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/** 原子写 package.json（2 空格缩进 / 结尾换行 / \n 行尾）；写前自动备份 */
export function writeProfilePkg(profileDir: string, json: any): WriteResult {
  const file = path.join(profileDir, PKG_NAME)
  const tmp = `${file}.tmp`
  try {
    if (!existsSync(profileDir)) {
      return { ok: false, error: `profile 目录不存在：${profileDir}` }
    }
    /* 先备份当前文件（有内容才备份） */
    backupProfilePkg(profileDir)

    const text = `${JSON.stringify(json, null, 2)}\n`
    writeFileSync(tmp, text, { encoding: 'utf8' })
    try {
      renameSync(tmp, file)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* 忽略 */
      }
      return { ok: false, error: `写入失败（rename）：${err instanceof Error ? err.message : String(err)}` }
    }
    return { ok: true, error: null }
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* 忽略 */
    }
    return { ok: false, error: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 把当前 package.json 拷到 `<profileDir>\.dsh-console\backup\package.json.<时间戳>.json`。
 * 返回备份文件绝对路径；没有源文件或拷贝失败 → null。
 */
export function backupProfilePkg(profileDir: string): string | null {
  const file = path.join(profileDir, PKG_NAME)
  try {
    if (!existsSync(file)) return null
    const dir = path.join(profileDir, BACKUP_DIR, BACKUP_SUBDIR)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '')
    const target = path.join(dir, `${PKG_NAME}.${stamp}.json`)
    copyFileSync(file, target)
    return target
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * bundles 增删改
 * ------------------------------------------------------------------ */

/** 只改 `dsh.profile.bundles`，dsh.profile 下其它字段与整个 package.json 原样保留 */
export function setBundles(profileDir: string, list: string[]): WriteResult {
  const json = readProfilePkg(profileDir)
  if (!json) {
    return { ok: false, error: `读不到 profile 的 package.json：${path.join(profileDir, PKG_NAME)}` }
  }
  const next = clone(json)
  const bundles = ensureBundlePath(next)
  const cleaned = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  bundles.length = 0
  for (const name of cleaned) bundles.push(name)
  return writeProfilePkg(profileDir, next)
}

/** 加一个 bundle 层；已存在直接返回（视为成功）。`at` 合法则插入该下标，否则 push 到末尾 */
export function addBundle(profileDir: string, name: string, at?: number): boolean {
  if (!name || typeof name !== 'string') return false
  const json = readProfilePkg(profileDir)
  if (!json) return false
  const next = clone(json)
  const bundles = ensureBundlePath(next)
  if (bundles.includes(name)) return true
  if (typeof at === 'number' && Number.isInteger(at) && at >= 0 && at <= bundles.length) {
    bundles.splice(at, 0, name)
  } else {
    bundles.push(name)
  }
  return writeProfilePkg(profileDir, next).ok
}

/** 从 bundles 移除；本来就不在也返回 true（幂等） */
export function removeBundle(profileDir: string, name: string): boolean {
  if (!name || typeof name !== 'string') return false
  const json = readProfilePkg(profileDir)
  if (!json) return false
  const next = clone(json)
  const bundles = ensureBundlePath(next)
  const idx = bundles.indexOf(name)
  if (idx < 0) return true
  bundles.splice(idx, 1)
  return writeProfilePkg(profileDir, next).ok
}

/** bundles 里第一个匹配的名字下标；不在返回 -1 */
export function bundleIndexOf(profileDir: string, name: string): number {
  try {
    return getBundles(profileDir).indexOf(name)
  } catch {
    return -1
  }
}

/** 该名字是否在 dependencies 里 */
export function hasDependency(profileDir: string, name: string): boolean {
  const json = readProfilePkg(profileDir)
  try {
    const deps = json?.dependencies
    return !!deps && typeof deps === 'object' && Object.prototype.hasOwnProperty.call(deps, name)
  } catch {
    return false
  }
}
