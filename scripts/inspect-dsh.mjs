#!/usr/bin/env node
/**
 * inspect-dsh.mjs —— 本机 DSH 环境只读巡检
 *
 * 严格只读：
 *   - 只用 node:fs 的 读 API（readFileSync / readdirSync / statSync / existsSync / realpathSync）
 *   - 不写任何文件，不创建目录，不调用 pnpm / npm / dsh
 *   - 不联网
 *
 * 用法：
 *   node scripts\inspect-dsh.mjs
 *   node scripts\inspect-dsh.mjs --home "C:\Users\XXXX\.dsh"
 *   node scripts\inspect-dsh.mjs --json        # 额外输出一份 JSON
 *
 * 输出：
 *   1) DSH_HOME 探测结果
 *   2) 每个 profile：dependencies / dsh.profile.bundles / cordis.patch.yml 的 disabled id /
 *      .dsh-market/state.json / 每个包在 node_modules 里的真实版本
 *   3) 末尾「本机真实插件清单」表格
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ────────────────────────────────────────────────────────────────
// 0. 工具
// ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const argHome = pickArg('--home')
const wantJson = argv.includes('--json')

function pickArg(flag) {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? undefined : v
}

/** 读 UTF-8 文本，失败返回 null */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 读 JSON（自动剥 BOM），失败返回 { ok:false, error } */
function readJson(file) {
  const text = readText(file)
  if (text === null) return { ok: false, error: 'ENOENT/不可读' }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) }
  } catch (error) {
    return { ok: false, error: `JSON 解析失败: ${error.message}` }
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/** 极简 semver 比较（仅用于排序展示） */
function cmpVersion(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = String(b).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/** CJK 宽度 2 的显示宽度 */
function dispWidth(s) {
  let n = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    n +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1
  }
  return n
}

function pad(s, w, align = 'left') {
  const str = s === undefined || s === null ? '' : String(s)
  const d = w - dispWidth(str)
  if (d <= 0) return str
  return align === 'right' ? ' '.repeat(d) + str : str + ' '.repeat(d)
}

/** 表格里把超长 spec（file:/link: 全路径）截成尾部可见 */
function shortSpec(value, max = 46) {
  const str = String(value ?? '')
  if (dispWidth(str) <= max) return str
  let tail = ''
  for (const ch of [...str].reverse()) {
    if (dispWidth(tail + ch) > max - 1) break
    tail = ch + tail
  }
  return '…' + tail
}

const out = []
function line(s = '') {
  out.push(s)
  process.stdout.write(s + '\n')
}

function rule(title) {
  line('')
  line('─'.repeat(78))
  if (title) line(title)
  line('─'.repeat(78))
}

/** 打印一张自适应宽度的表 */
function table(headers, rows, aligns = []) {
  const widths = headers.map((h, i) =>
    Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[i] ?? ''))),
  )
  line(headers.map((h, i) => pad(h, widths[i], aligns[i])).join('  '))
  line(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const r of rows) line(r.map((c, i) => pad(c ?? '', widths[i], aligns[i])).join('  '))
}

// ────────────────────────────────────────────────────────────────
// 1. DSH_HOME 探测
// ────────────────────────────────────────────────────────────────

function resolveDshHome() {
  const candidates = []
  if (argHome) candidates.push({ source: '--home 参数', dir: argHome })
  if (process.env.DSH_HOME) candidates.push({ source: '环境变量 DSH_HOME', dir: process.env.DSH_HOME })
  if (process.env.DSH_HOME_DIR) candidates.push({ source: '环境变量 DSH_HOME_DIR', dir: process.env.DSH_HOME_DIR })
  candidates.push({ source: 'os.homedir() + .dsh（兜底）', dir: path.join(os.homedir(), '.dsh') })
  if (process.env.USERPROFILE) candidates.push({ source: 'USERPROFILE + .dsh', dir: path.join(process.env.USERPROFILE, '.dsh') })

  const probed = candidates.map((c) => ({ ...c, exists: isDir(c.dir) }))
  const hit = probed.find((c) => c.exists)
  return { probed, home: hit ? path.resolve(hit.dir) : null, source: hit ? hit.source : null }
}

// ────────────────────────────────────────────────────────────────
// 2. cordis.patch.yml 行扫描（与 dsh-market src/patch.ts:156 readUserPatchState 同构）
// ────────────────────────────────────────────────────────────────

const ROW_ID = '[A-Za-z0-9_.-]+'

function parsePatch(text) {
  const lines = text.split(/\r?\n/)
  const result = { totalLines: lines.length, rows: [], disabled: [], forced: [], inserted: [] }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]

    // - insert: 块下的条目（4 空格缩进）
    if (/^- insert:[ \t]*$/.test(raw)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[^ \t]/.test(lines[j]) && lines[j].trim() !== '') break
        const m = new RegExp(`^ {4}- id: (${ROW_ID})`).exec(lines[j])
        if (m) {
          result.inserted.push(m[1])
          result.rows.push({ id: m[1], disabled: null, kind: 'insert' })
        }
      }
      continue
    }

    // 顶层行 `- id: X`（可带引号）
    const rowMatch = new RegExp(
      `^- id: (?:(${ROW_ID})|'([^']+)'|"([^"]+)")[ \\t]*$`,
    ).exec(raw)
    if (!rowMatch) continue
    const id = rowMatch[1] ?? rowMatch[2] ?? rowMatch[3]

    // 下一条非空非注释行
    let flag = null
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue
      if (/^ {2}disabled:[ \t]*true[ \t]*$/.test(next)) flag = true
      else if (/^ {2}disabled:[ \t]*false[ \t]*$/.test(next)) flag = false
      break
    }

    if (flag === true) result.disabled.push(id)
    if (flag === false) result.forced.push(id)
    result.rows.push({ id, disabled: flag, kind: 'row' })
  }

  // 同一 id 多条时最后一条有 disabled 的说了算
  const lastFlag = new Map()
  for (const r of result.rows) if (r.kind === 'row' && r.disabled !== null) lastFlag.set(r.id, r.disabled)
  result.effectiveDisabled = [...lastFlag.entries()].filter(([, v]) => v === true).map(([k]) => k)
  result.effectiveForced = [...lastFlag.entries()].filter(([, v]) => v === false).map(([k]) => k)
  return result
}

// ────────────────────────────────────────────────────────────────
// 3. 单个 profile 的巡检
// ────────────────────────────────────────────────────────────────

/** 读 node_modules/<name>/package.json（支持 scoped） */
function readInstalledManifest(profileDir, name) {
  const dir = path.join(profileDir, 'node_modules', ...name.split('/'))
  const manifestPath = path.join(dir, 'package.json')
  const json = readJson(manifestPath)
  if (!json.ok) return { dir, manifestPath, ok: false, error: json.error }
  const m = json.value ?? {}
  const patchDecl = m?.dsh?.bundle?.patch
  return {
    dir,
    manifestPath,
    ok: true,
    name: typeof m.name === 'string' ? m.name : null,
    version: typeof m.version === 'string' ? m.version : null,
    hasDshField: m.dsh !== undefined,
    bundlePatch: patchDecl !== undefined ? patchDecl : null,
    isPlugin: patchDecl !== undefined,
    realDir: realpathOrNull(dir),
  }
}

/** node_modules 顶层包名（含 @scope 二层） */
function topLevelPackageNames(profileDir) {
  const nm = path.join(profileDir, 'node_modules')
  const names = []
  let entries = []
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true })
  } catch {
    return names
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (e.name.startsWith('.')) continue
    if (e.name.startsWith('@')) {
      try {
        for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
          if (s.isDirectory() || s.isSymbolicLink()) names.push(`${e.name}/${s.name}`)
        }
      } catch {
        /* ignore */
      }
    } else if (e.name !== 'node_modules') {
      names.push(e.name)
    }
  }
  return names.sort()
}

function inspectProfile(home, profileName) {
  const dir = path.join(home, 'profiles', profileName)
  const record = {
    profile: profileName,
    dir,
    ok: isDir(dir),
    deps: {},
    depsError: null,
    bundles: [],
    bundlesPresent: false,
    bundlesError: null,
    patch: null,
    patchPath: path.join(dir, 'cordis.patch.yml'),
    state: null,
    statePath: path.join(dir, '.dsh-market', 'state.json'),
    installed: [],
    orphans: [],
  }
  if (!record.ok) return record

  // package.json
  const manifestPath = path.join(dir, 'package.json')
  const json = readJson(manifestPath)
  if (!json.ok) {
    record.depsError = json.error
  } else {
    const m = json.value ?? {}
    record.deps = m.dependencies && typeof m.dependencies === 'object' ? m.dependencies : {}
    const bundles = m?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      record.bundlesPresent = true
      record.bundles = bundles.filter((x) => typeof x === 'string')
    } else if (bundles !== undefined) {
      record.bundlesPresent = true
      record.bundlesError = 'dsh.profile.bundles 存在但不是数组'
    }
  }

  // cordis.patch.yml
  const patchText = readText(record.patchPath)
  if (patchText !== null) record.patch = parsePatch(patchText)

  // .dsh-market/state.json
  const stateJson = readJson(record.statePath)
  if (stateJson.ok) {
    const s = stateJson.value ?? {}
    record.state = {
      disabled: Array.isArray(s.disabled) ? s.disabled : [],
      groups: s.groups && typeof s.groups === 'object' ? s.groups : {},
      groupOrder: Array.isArray(s.groupOrder) ? s.groupOrder : [],
      region: s.region ?? null,
      regionAuto: s.regionAuto ?? null,
      sidebarEntry: s.sidebarEntry ?? null,
      extraKeys: Object.keys(s).filter(
        (k) => !['disabled', 'groups', 'groupOrder', 'region', 'regionAuto', 'sidebarEntry'].includes(k),
      ),
    }
  } else {
    record.stateError = stateJson.error
  }

  // 每个依赖在 node_modules 里的真实版本
  for (const [name, spec] of Object.entries(record.deps)) {
    const inst = readInstalledManifest(dir, name)
    record.installed.push({
      name,
      spec: String(spec),
      ...inst,
      inBundles: record.bundles.includes(name),
      patchDisabled: record.patch ? record.patch.effectiveDisabled.includes(name) : false,
      stateDisabled: record.state ? record.state.disabled.includes(name) : false,
    })
  }
  record.installed.sort(
    (a, b) =>
      cmpVersion(b.version ?? '0.0.0', a.version ?? '0.0.0') || a.name.localeCompare(b.name),
  )

  // node_modules 里声明了 dsh.bundle.patch、但不在 dependencies 的包
  const depNames = new Set(Object.keys(record.deps))
  for (const name of topLevelPackageNames(dir)) {
    if (depNames.has(name)) continue
    if (name.startsWith('@deepseek-ai/')) continue // 内置 bundle，不列
    const inst = readInstalledManifest(dir, name)
    if (inst.ok && inst.isPlugin) {
      record.orphans.push({ name, version: inst.version, spec: '(未在 dependencies)' })
    }
  }

  return record
}

// ────────────────────────────────────────────────────────────────
// 4. 输出
// ────────────────────────────────────────────────────────────────

line('')
line('╔══════════════════════════════════════════════════════════════════════════════╗')
line('║  DSH 插件台 · 本机 DSH 环境只读巡检 (inspect-dsh.mjs)                        ║')
line('╚══════════════════════════════════════════════════════════════════════════════╝')
line('只读：仅使用 node:fs 读取，不写文件、不调用 pnpm/npm/dsh、不联网。')
line(`平台 ${process.platform} / Node ${process.version} / 时间 ${new Date().toISOString()}`)

// [1] DSH_HOME
const { probed, home, source } = resolveDshHome()

rule('[1] DSH_HOME 探测')
line(`候选路径（按优先级）：`)
for (const c of probed) line(`  ${c.exists ? '✔' : '✘'}  ${pad(c.source, 30)}  ${c.dir}`)
line('')
if (home === null) {
  line('✘ 没有找到可用的 DSH_HOME。可用 --home 显式指定。')
  process.exit(2)
}
line(`实际使用：${home}`)
line(`判定来源：${source}`)

const profilesRoot = path.join(home, 'profiles')
let profileNames = []
try {
  profileNames = fs
    .readdirSync(profilesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
} catch {
  profileNames = []
}

line('')
line(`DSH_HOME 顶层条目：`)
try {
  for (const e of fs.readdirSync(home, { withFileTypes: true })) {
    line(`  ${e.isDirectory() ? '[dir ]' : '[file]'} ${e.name}`)
  }
} catch {
  line('  (不可读)')
}
line('')
line(`profiles（${profileNames.length}）：${profileNames.join(', ') || '(空)'}`)

// [2] 每个 profile
const records = profileNames.map((p) => inspectProfile(home, p))

for (const r of records) {
  rule(`[2] profile: ${r.profile}`)
  line(`目录：${r.dir}`)
  if (!r.ok) {
    line('✘ 目录不存在或不可读')
    continue
  }

  const depEntries = Object.entries(r.deps)
  line('')
  line(`Dependencies（${depEntries.length}）${r.depsError ? `  ⚠ ${r.depsError}` : ''}`)
  for (const [n, s] of depEntries) line(`  - ${pad(n, 38)} ${s}`)

  line('')
  line(
    `dsh.profile.bundles（${r.bundles.length}）${r.bundlesPresent ? '' : '  ⚠ 字段不存在'}${r.bundlesError ? `  ⚠ ${r.bundlesError}` : ''}`,
  )
  r.bundles.forEach((b, i) => line(`  ${String(i + 1).padStart(2)}) ${b}`))

  line('')
  if (r.patch === null) {
    line(`cordis.patch.yml：不存在（${r.patchPath}）`)
  } else {
    const p = r.patch
    line(`cordis.patch.yml：${p.totalLines} 行 / 顶层行 ${p.rows.filter((x) => x.kind === 'row').length} / insert ${p.inserted.length}`)
    line(`  生效 disabled（去重后）：${p.effectiveDisabled.length ? p.effectiveDisabled.join(', ') : '(无)'}`)
    line(`  生效 forced(disabled:false)：${p.effectiveForced.length ? p.effectiveForced.join(', ') : '(无)'}`)
    line(`  insert 插入的 id：${p.inserted.length ? p.inserted.join(', ') : '(无)'}`)
  }

  line('')
  if (r.state) {
    const s = r.state
    const groups = Object.keys(s.groups)
    line(`.dsh-market/state.json`)
    line(`  disabled   (${s.disabled.length})：${s.disabled.length ? s.disabled.join(', ') : '(空)'}`)
    line(`  groups     (${groups.length})：${groups.length ? groups.map((g) => `${g}=[${(s.groups[g] ?? []).join('|')}]`).join('; ') : '(空)'}`)
    line(`  groupOrder (${s.groupOrder.length})：${s.groupOrder.length ? s.groupOrder.join(', ') : '(空)'}`)
    line(`  region=${s.region ?? '(缺失)'}  regionAuto=${String(s.regionAuto)}  sidebarEntry=${String(s.sidebarEntry)}`)
    if (s.extraKeys.length) line(`  其他字段：${s.extraKeys.join(', ')}`)
  } else {
    line(`.dsh-market/state.json：不可用（${r.stateError ?? '不存在'}）`)
  }

  line('')
  line(`node_modules 真实版本（${r.installed.length}）`)
  if (r.installed.length === 0) {
    line('  (无依赖)')
  } else {
    table(
      ['包名', 'manifest 声明', '实装版本', 'dsh.bundle.patch', 'inBundles', 'patch停用', 'state停用', '备注'],
      r.installed.map((i) => [
        i.name,
        shortSpec(i.spec),
        i.ok ? (i.version ?? '?') : '(未装)',
        i.ok ? (i.isPlugin ? 'yes' : 'no') : '-',
        i.inBundles ? 'yes' : '',
        i.patchDisabled ? 'yes' : '',
        i.stateDisabled ? 'yes' : '',
        i.ok && i.name && i.name !== i.name ? `manifest.name=${i.name}` : '',
      ]),
    )
  }

  if (r.orphans.length) {
    line('')
    line(`⚠ node_modules 里声明了 dsh.bundle.patch、但不在 dependencies 的包（${r.orphans.length}）`)
    for (const o of r.orphans) line(`  - ${pad(o.name, 38)} ${o.version ?? '?'}`)
  }
}

// [3] 本机真实插件清单
rule('[3] 本机真实插件清单（跨 profile 汇总）')
const tableRows = []
const pluginNames = new Set()
for (const r of records) {
  if (!r.ok) continue
  for (const i of r.installed) {
    pluginNames.add(i.name)
    tableRows.push([
      r.profile,
      i.name,
      shortSpec(i.spec),
      i.ok ? (i.version ?? '?') : '(未装)',
      i.ok ? (i.isPlugin ? 'yes' : 'no') : '?',
      i.inBundles ? 'yes' : '',
      i.patchDisabled ? 'yes' : '',
      i.stateDisabled ? 'yes' : '',
    ])
  }
}
if (tableRows.length === 0) {
  line('(没有发现任何已声明依赖)')
} else {
  table(['profile', '包名', 'manifest spec', '实装版本', 'DSH插件', '在bundles', 'patch停用', 'state停用'], tableRows)
}

// 摘要
const totalDeps = records.reduce((n, r) => n + r.installed.length, 0)
const totalPlugins = records.reduce((n, r) => n + r.installed.filter((i) => i.isPlugin).length, 0)
const totalDisabled = records.reduce((n, r) => n + (r.patch ? r.patch.effectiveDisabled.length : 0), 0)
const totalStateDisabled = records.reduce((n, r) => n + (r.state ? r.state.disabled.length : 0), 0)

line('')
line('── 摘要 ──────────────────────────────────────────────────────────────────')
line(`profiles            : ${records.length}（${records.filter((r) => r.ok).length} 个可读）`)
line(`依赖条目（全部 profile）: ${totalDeps}`)
line(`其中声明 dsh.bundle.patch: ${totalPlugins}`)
line(`cordis.patch.yml disabled 条目合计: ${totalDisabled}`)
line(`.dsh-market/state.json disabled 合计: ${totalStateDisabled}`)
line(`不同包名            : ${pluginNames.size}`)
line('')
line('提示：`DSH插件=no` 表示该依赖的 package.json 里没有 dsh.bundle.patch（宿主不会把它当插件装进 bundles）。')

if (wantJson) {
  rule('[4] JSON')
  line(
    JSON.stringify(
      {
        home,
        source,
        probed: probed.map((c) => ({ source: c.source, dir: c.dir, exists: c.exists })),
        profiles: records.map((r) => ({
          profile: r.profile,
          dir: r.dir,
          dependencies: r.deps,
          bundles: r.bundles,
          bundlesPresent: r.bundlesPresent,
          patch: r.patch
            ? {
                totalLines: r.patch.totalLines,
                disabled: r.patch.effectiveDisabled,
                forced: r.patch.effectiveForced,
                inserted: r.patch.inserted,
              }
            : null,
          state: r.state ?? null,
          installed: r.installed.map((i) => ({
            name: i.name,
            spec: i.spec,
            installed: i.ok,
            version: i.version ?? null,
            manifestName: i.name ?? null,
            isPlugin: i.isPlugin ?? null,
            inBundles: i.inBundles,
            patchDisabled: i.patchDisabled,
            stateDisabled: i.stateDisabled,
          })),
          orphans: r.orphans,
        })),
      },
      null,
      2,
    ),
  )
}