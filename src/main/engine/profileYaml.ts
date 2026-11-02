/**
 * profileYaml.ts —— 改 profile 目录里的 pnpm-workspace.yaml。
 *
 * 为什么需要它：
 *   pnpm 11 默认不执行任何包的生命周期脚本。装「git 仓库」形式的插件时，
 *   仓库里的 prepare / build 脚本会被拦下来，报
 *     ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
 *   并且什么都不装。要放行必须在 <profile>/pnpm-workspace.yaml 的
 *   allowBuilds 里写一条**精确 key**（带完整 tarball URL 的那种），
 *   这不是用户手动能猜出来的东西 —— 所以由我们从 pnpm 的报错里抠出来、
 *   写进去、再重试一次。
 *
 *   pnpm 的 minimumReleaseAge 供应链冷却策略同理：命中
 *   ERR_PNPM_MINIMUM_RELEASE_AGE 时要在 minimumReleaseAgeExclude 里
 *   加 `name@version` 豁免。DSH 官方的插件管理器也是这么干的。
 *
 * 设计约束：
 *   - 只用行扫描，不引 yaml 依赖。用户手写的其他键必须原样保留。
 *   - 写盘走「备份 → tmp → rename」，任何一步失败都不留半截文件。
 *   - 函数全部 try/catch，返回结果对象而不是抛异常：这些是「尽力而为」的
 *     修正，不能因为它把一次安装变成崩溃。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface YamlFixResult {
  ok: boolean
  /** yaml 文件路径 */
  path: string
  /** 这次新写进去的 key（已经存在的不会重复） */
  added: string[]
  /** 改前的备份路径（文件本来不存在则为 null） */
  backup: string | null
  error?: string
}

const FILE = 'pnpm-workspace.yaml'

function yamlPath(profileDir: string): string {
  return join(profileDir, FILE)
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

/** YAML 里当 key 用：带 : / # @ 空格 的东西一律单引号包起来 */
function yamlKey(key: string): string {
  const safe = /^[A-Za-z0-9._@/-]+$/.test(key) && !key.includes(': ')
  if (safe) return key
  return `'${key.replace(/'/g, "''")}'`
}

function backupYaml(profileDir: string): string | null {
  const src = yamlPath(profileDir)
  if (!existsSync(src)) return null
  const dir = join(profileDir, '.dsh-console', 'backup')
  try {
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, `${FILE}.${stamp()}.bak`)
    copyFileSync(src, dest)
    return dest
  } catch {
    return null
  }
}

function writeAtomic(dir: string, text: string): void {
  const target = yamlPath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8' })
    renameSync(tmp, target)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清不掉也没关系 */
    }
    throw err
  }
}

/** 找出顶层某个块键的行号与它子块的范围 */
function locateBlock(lines: string[], key: string): { header: number; end: number; rest: string } | null {
  const head = new RegExp(`^${key}:\\s*(.*)$`)
  for (let i = 0; i < lines.length; i += 1) {
    const m = head.exec(lines[i] ?? '')
    if (!m) continue
    const rest = (m[1] ?? '').trim()
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j] ?? ''
      if (raw.trim() === '') continue
      const indent = raw.length - raw.trimStart().length
      if (indent === 0) {
        end = j
        break
      }
    }
    return { header: i, end, rest }
  }
  return null
}

/** 把 key 集合塞进某个块键下面（块不存在就新建） */
function ensureBlock(profileDir: string, key: string, keys: string[], defaultValue: boolean): YamlFixResult {
  const path = yamlPath(profileDir)
  const exists = existsSync(path)
  let text = ''
  if (exists) {
    try {
      text = readFileSync(path, 'utf8')
    } catch (err) {
      return { ok: false, path, added: [], backup: null, error: `读不了 ${FILE}：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (!text.trim()) {
    text = `packages: ['.']\n`
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const block = locateBlock(lines, key)
  const added: string[] = []

  if (block && block.rest.startsWith('{')) {
    /* 行内 flow map：allowBuilds: { a: true } —— 在收尾的 } 前插 */
    const body = block.rest
    const inner = body.replace(/^\{/, '').replace(/\}\s*$/, '')
    const present = new Set(
      inner
        .split(',')
        .map((s) => s.split(':')[0]?.trim().replace(/^['"]|['"]$/g, '') ?? '')
        .filter(Boolean)
    )
    const extra = keys.filter((k) => !present.has(k))
    if (extra.length === 0) return { ok: true, path, added: [], backup: null }
    const pieces = inner.trim() ? [inner.trim()] : []
    for (const k of extra) pieces.push(`${yamlKey(k)}: ${defaultValue}`)
    lines[block.header] = `${key}: { ${pieces.join(', ')} }`
    added.push(...extra)
  } else if (block) {
    /* 块形式：找到已有子项的缩进，在块尾补齐 */
    const children = lines.slice(block.header + 1, block.end)
    const indentMatch = children.map((l) => /^(\s+)\S/.exec(l)).find(Boolean)
    const indent = indentMatch ? indentMatch[1] : '  '
    const present = new Set<string>()
    for (const line of children) {
      const m = /^\s+(.+?):\s/.exec(line)
      if (!m) continue
      present.add((m[1] ?? '').trim().replace(/^['"]|['"]$/g, ''))
    }
    const extra = keys.filter((k) => !present.has(k))
    if (extra.length === 0) return { ok: true, path, added: [], backup: null }
    const insert = extra.map((k) => `${indent}${yamlKey(k)}: ${defaultValue}`)
    /* 插在块内最后一个非空行后面，保持原有顺序与尾部空行 */
    let insertAt = block.header + 1
    for (let i = block.header + 1; i < block.end; i += 1) {
      if ((lines[i] ?? '').trim() !== '') insertAt = i + 1
    }
    lines.splice(insertAt, 0, ...insert)
    added.push(...extra)
  } else {
    /* 整个块都没有 */
    let tail = lines.join(eol)
    if (!tail.endsWith(eol)) tail += eol
    const blockText = [`${key}:`, ...keys.map((k) => `  ${yamlKey(k)}: ${defaultValue}`)].join(eol)
    text = `${tail}${eol}${blockText}${eol}`
    const backup0 = backupYaml(profileDir)
    try {
      writeAtomic(profileDir, text)
      return { ok: true, path, added: [...keys], backup: backup0 }
    } catch (err) {
      return { ok: false, path, added: [], backup: backup0, error: `写 ${FILE} 失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  const backup = backupYaml(profileDir)
  const merged = lines.join(eol)
  try {
    writeAtomic(profileDir, merged.endsWith(eol) ? merged : `${merged}${eol}`)
    return { ok: true, path, added, backup }
  } catch (err) {
    return { ok: false, path, added: [], backup, error: `写 ${FILE} 失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 放行 git 依赖的构建脚本。
 * @param keys pnpm 报错里给出的精确 key（形如 `pkg@https://codeload.../tar.gz/<sha>`）
 */
export function ensureAllowBuilds(profileDir: string, keys: string[]): YamlFixResult {
  const clean = Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)))
  if (clean.length === 0) return { ok: true, path: yamlPath(profileDir), added: [], backup: null }
  return ensureBlock(profileDir, 'allowBuilds', clean, true)
}

/**
 * 给 minimumReleaseAge 冷却策略加豁免。
 * @param keys `name@version` 形式
 */
export function ensureReleaseAgeExclude(profileDir: string, keys: string[]): YamlFixResult {
  const clean = Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)))
  if (clean.length === 0) return { ok: true, path: yamlPath(profileDir), added: [], backup: null }
  const path = yamlPath(profileDir)
  const exists = existsSync(path)
  let text = exists ? (() => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  })() : ''
  if (!text.trim()) text = `packages: ['.']\n`

  const block = locateBlock(text.split(/\r?\n/), 'minimumReleaseAgeExclude')
  if (block && block.rest.startsWith('[')) {
    /* 行内数组：minimumReleaseAgeExclude: [a, b] */
    const inner = block.rest.replace(/^\[/, '').replace(/\]\s*$/, '')
    const present = inner
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    const extra = clean.filter((k) => !present.includes(k))
    if (extra.length === 0) return { ok: true, path, added: [], backup: null }
    return ensureInlineArray(profileDir, text, 'minimumReleaseAgeExclude', [...present, ...extra], path)
  }
  if (block) {
    /* 序列形式（- item）或块形式：交给 ensureBlock 的通用逻辑会写成 key: true，不对。
       这里自己按序列处理。 */
    return ensureSequence(profileDir, text, 'minimumReleaseAgeExclude', clean, path)
  }
  /* 没有这个键：追加一个行内数组最省事 */
  let tail = text
  const eol = tail.includes('\r\n') ? '\r\n' : '\n'
  if (!tail.endsWith(eol)) tail += eol
  const body = `minimumReleaseAgeExclude: [${clean.map((k) => yamlKey(k)).join(', ')}]${eol}`
  const backup = backupYaml(profileDir)
  try {
    writeAtomic(profileDir, `${tail}${body}`)
    return { ok: true, path, added: clean, backup }
  } catch (err) {
    return { ok: false, path, added: [], backup, error: `写 ${FILE} 失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

function ensureInlineArray(profileDir: string, text: string, key: string, values: string[], path: string): YamlFixResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const block = locateBlock(lines, key)
  if (!block) return { ok: false, path, added: [], backup: null, error: `找不到 ${key}` }
  lines[block.header] = `${key}: [${values.map((v) => yamlKey(v)).join(', ')}]`
  const backup = backupYaml(profileDir)
  try {
    writeAtomic(profileDir, lines.join(eol))
    return { ok: true, path, added: values, backup }
  } catch (err) {
    return { ok: false, path, added: [], backup, error: `写 ${FILE} 失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

function ensureSequence(profileDir: string, text: string, key: string, values: string[], path: string): YamlFixResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const block = locateBlock(lines, key)
  if (!block) return { ok: false, path, added: [], backup: null, error: `找不到 ${key}` }
  const children = lines.slice(block.header + 1, block.end)
  const present = children
    .map((l) => /^\s*-\s*(.+)$/.exec(l)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '')
    .filter(Boolean)
  const extra = values.filter((v) => !present.includes(v))
  if (extra.length === 0) return { ok: true, path, added: [], backup: null }
  let insertAt = block.header + 1
  for (let i = block.header + 1; i < block.end; i += 1) {
    if ((lines[i] ?? '').trim() !== '') insertAt = i + 1
  }
  const indent = /^(\s*)-/.exec(children.find((l) => /^\s*-/.test(l)) ?? '  -')?.[1] ?? '  '
  lines.splice(insertAt, 0, ...extra.map((v) => `${indent}- ${yamlKey(v)}`))
  const backup = backupYaml(profileDir)
  try {
    writeAtomic(profileDir, lines.join(eol))
    return { ok: true, path, added: extra, backup }
  } catch (err) {
    return { ok: false, path, added: [], backup, error: `写 ${FILE} 失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/* ------------------------------------------------------------------ *
 * 从 pnpm 输出里认错误 → 推断该往 yaml 里补什么
 * ------------------------------------------------------------------ */

/** ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED → 精确 key 列表 */
export function parseGitPrepareKeys(log: string): string[] {
  if (!/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|needs to execute build scripts/i.test(log)) return []
  const keys = new Set<string>()

  /* 形态一：报错末尾的示例块
   *   allowBuilds:
   *     dshmarket@https://codeload.github.com/....tar.gz/<sha>: true
   */
  const lines = log.split(/\r?\n/)
  let inBlock = false
  for (const line of lines) {
    if (/^\s*allowBuilds:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    const m = /^\s+(\S.*?):\s*true\s*$/.exec(line)
    if (m) {
      keys.add((m[1] ?? '').trim().replace(/^['"]|['"]$/g, ''))
      continue
    }
    if (line.trim() === '') continue
    inBlock = false
  }

  /* 形态二：git-hosted package "name@version" needs to execute build scripts */
  const hosted = /git-hosted package "([^"]+)" needs to execute build scripts/g
  for (let m = hosted.exec(log); m; m = hosted.exec(log)) {
    if (m[1]) keys.add(m[1])
  }

  /* 形态三：[WARN] Ignored build scripts: a@1.0.0, b */
  const warn = /Ignored build scripts:\s*(.+)$/im.exec(log)
  if (warn?.[1]) {
    for (const bit of warn[1].split(',')) {
      const v = bit.trim()
      if (v) keys.add(v)
    }
  }

  return Array.from(keys)
}

/** ERR_PNPM_MINIMUM_RELEASE_AGE → name@version 列表 */
export function parseMinimumReleaseAgeKeys(log: string): string[] {
  if (!/ERR_PNPM_MINIMUM_RELEASE_AGE|minimumReleaseAge/i.test(log)) return []
  const keys = new Set<string>()
  const re = /([@A-Za-z0-9._/-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g
  for (let m = re.exec(log); m; m = re.exec(log)) {
    const name = m[1] ?? ''
    const ver = m[2] ?? ''
    if (!name || !ver) continue
    if (name === 'pnpm' || name === 'node') continue
    if (!/@|^[a-z0-9]/i.test(name)) continue
    keys.add(`${name}@${ver}`)
  }
  return Array.from(keys)
}