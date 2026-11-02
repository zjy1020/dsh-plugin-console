/**
 * engine/env.ts —— DSH 运行环境探测。
 *
 * 探测目标（本机参考值）：
 *   dshHome     = C:\Users\YBY\.dsh
 *   installRoot = D:\Dowloads\DeepSeekHarness
 *   nodePath    = C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
 *   pnpmPath    = C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs
 *
 * 依赖方向：env → settings（单向）。settings 不反过来 import env，避免循环。
 * 所有探测函数都不抛异常：失败一律退化成 null / 空数组，并往 warnings 里塞人话。
 *
 * ── installRoot 为什么要有这么多路由 ──────────────────────────────────────
 * 老机器上能过，是因为 <dshHome>\dsh-purge\desktop-install.txt 里记着安装路径；
 * 新电脑这个文件不存在，而写死的候选名又都是「无空格」写法（DeepSeekHarness），
 * 真实目录名却是「DeepSeek Harness」（带空格，与 exe 同名）→ 直接 null。
 * 所以探测不能靠猜名字，要按「明确来源 → 固定猜测 → 枚举父目录 → 快捷方式 → 磁盘扫描」
 * 逐级降级，拿不到就交给异步富化（注册表 / 运行中的进程）兜底。
 *
 * 同步路由的顺序就是「从便宜到贵」的顺序，而且贵的那几条只在前面全没命中时才走：
 * 枚举父目录 = 3 次 readdir；快捷方式 = 最多 24 个 .lnk 的二进制字符串扫描；
 * 磁盘扫描 = 有界遍历（时间闸 1.2s、一级目录上限 200、readdir 上限 260）。
 * 注册表 / PowerShell 这类必须起子进程的路由一律不放进同步路径 —— 这条路径被
 * getInstallRoot() 到处调用，几百毫秒的阻塞会把界面卡住。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'

import type { AppSettings, DiscoveryStep, RuntimeInfo } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/ipc'
import * as settingsStore from './settings'

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function safeSettings(): AppSettings {
  try {
    const s = settingsStore.get()
    if (s && typeof s === 'object') return s
  } catch {
    /* 落到默认值 */
  }
  return { ...DEFAULT_SETTINGS }
}

/** 反斜杠归一化 + 去尾部 \ （保留 C:\ / / 这类根） */
function toNativePath(raw: string): string {
  let p = typeof raw === 'string' ? raw.trim() : ''
  if (!p) return ''
  if (process.platform === 'win32') p = p.replace(/\//g, '\\')
  let guard = 0
  while (p.length > 1 && guard++ < 128 && (p.endsWith('\\') || p.endsWith('/'))) {
    if (/^[A-Za-z]:[\\/]$/.test(p)) break
    if (p === '\\\\') break
    p = p.slice(0, -1)
  }
  return p
}

/** 存在性探测（读不到一律 false，不抛） */
function pathExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

function readJson(path: string): Record<string, any> | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8')
    if (!text.trim()) return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null
  } catch {
    return null
  }
}

function readJsonVersion(path: string): string | null {
  const json = readJson(path)
  const v = json?.version
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** profile / 目录名清洗：挡掉路径穿越 */
function safeSegment(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/[\\/]/g, '')
    .replace(/\.\./g, '')
}

function nodeExecutableName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/** 环境变量里的目录（带引号的要剥掉，PATH 上经常是 "C:\Program Files\nodejs"） */
function envDir(name: string): string {
  const raw = process.env[name]
  if (typeof raw !== 'string') return ''
  const v = raw.trim().replace(/^"|"$/g, '')
  return v ? toNativePath(v) : ''
}

function isWin(): boolean {
  return process.platform === 'win32'
}

/* ------------------------------------------------------------------ *
 * 诊断轨迹
 * ------------------------------------------------------------------ */

/** 每个 group 的轨迹上限：磁盘扫描可能产生几百条，IPC 传一个几 MB 的数组没有意义 */
const MAX_STEPS_PER_GROUP = 40

/**
 * 轨迹收集器。
 * 为什么做成类而不是裸数组：同一个 group 会被多条路由追加（磁盘扫描一个盘几十条），
 * 上限必须按 group 统一算，超出的要合并成一句「另有 N 条」而不是静默丢掉 ——
 * 静默丢掉会让人以为「只试了 40 个」，那就变成误导性诊断了。
 */
class DiscoveryLog {
  private readonly counts = new Map<string, number>()
  private readonly omitted = new Map<string, number>()

  constructor(private readonly sink?: DiscoveryStep[]) {}

  add(group: string, path: string, ok: boolean, detail: string): void {
    if (!this.sink) return
    const n = this.counts.get(group) ?? 0
    this.counts.set(group, n + 1)
    if (n >= MAX_STEPS_PER_GROUP) {
      this.omitted.set(group, (this.omitted.get(group) ?? 0) + 1)
      return
    }
    this.sink.push({ group, path, ok, detail })
  }

  /** 收尾：把「省略了多少条」补成一条 */
  finish(): void {
    if (!this.sink) return
    for (const [group, n] of this.omitted) {
      this.sink.push({ group, path: '', ok: false, detail: `…另有 ${n} 条同类，已省略` })
    }
    this.omitted.clear()
  }
}

/** 把已经拼好的轨迹再过一次上限（同步段 + 异步段合起来用） */
export function clampDiscoverySteps(steps: DiscoveryStep[]): DiscoveryStep[] {
  const out: DiscoveryStep[] = []
  const log = new DiscoveryLog(out)
  for (const s of steps) log.add(s.group, s.path, s.ok, s.detail)
  log.finish()
  return out
}

/* ------------------------------------------------------------------ *
 * DSH_HOME
 * ------------------------------------------------------------------ */

/**
 * DSH_HOME 的「像不像」判据。
 * 为什么不只看「目录存在」：~/.dsh 这种路径几乎人人都有残留（装过又卸了），
 * 只看存在性会把一个空壳当成 DSH_HOME，然后就再也找不到真正的 dsh-runtimes。
 */
function looksLikeDshHome(dir: string): boolean {
  if (!dir || !pathExists(dir)) return false
  for (const sub of ['dsh-runtimes', 'profiles', 'plugins']) {
    if (pathExists(join(dir, sub))) return true
  }
  for (const f of ['config.json', 'settings.json']) {
    if (pathExists(join(dir, f))) return true
  }
  return false
}

let dshHomeCache: { home: string; from: string } | null = null

/**
 * 探测顺序：settings.dshHome → DSH_HOME → %USERPROFILE%\.dsh → ~/.deepseek →
 * %APPDATA%\dsh → %LOCALAPPDATA%\dsh → %APPDATA%\DeepSeek Harness →
 * %LOCALAPPDATA%\DeepSeek Harness → ~/.dsh-desktop；全不通过退回 ~/.dsh。
 *
 * 明确来源（设置 / 环境变量）只要「目录真的存在」就认，不要求过判据 ——
 * 用户手填的东西被静默丢掉是最坏的行为（他会以为设置没生效）；
 * 猜测来源必须过判据，否则等于把一堆同名空目录当 DSH_HOME。
 */
function resolveDshHome(): { home: string; from: string } {
  if (dshHomeCache) return dshHomeCache

  const s = safeSettings()
  const explicit: Array<{ path: string; from: string }> = []
  const fromSettings = typeof s.dshHome === 'string' ? toNativePath(s.dshHome) : ''
  if (fromSettings) explicit.push({ path: fromSettings, from: '设置' })
  const fromEnvVar = typeof process.env.DSH_HOME === 'string' ? toNativePath(process.env.DSH_HOME.trim()) : ''
  if (fromEnvVar) explicit.push({ path: fromEnvVar, from: 'DSH_HOME 环境变量' })

  const home = homedir()
  const localAppData = envDir('LOCALAPPDATA')
  const appData = envDir('APPDATA')
  const guesses: Array<{ path: string; from: string }> = [
    { path: join(home, '.dsh'), from: '默认 <home>/.dsh' },
    { path: join(home, '.deepseek'), from: '扫描命中' },
    { path: join(home, '.dsh-desktop'), from: '扫描命中' }
  ]
  if (appData) {
    guesses.push({ path: join(appData, 'dsh'), from: '扫描命中' })
    guesses.push({ path: join(appData, 'DeepSeek Harness'), from: '扫描命中' })
  }
  if (localAppData) {
    guesses.push({ path: join(localAppData, 'dsh'), from: '扫描命中' })
    guesses.push({ path: join(localAppData, 'DeepSeek Harness'), from: '扫描命中' })
  }

  for (const c of explicit) {
    if (c.path && pathExists(c.path)) {
      dshHomeCache = { home: c.path, from: c.from }
      return dshHomeCache
    }
  }
  for (const c of [...explicit, ...guesses]) {
    if (looksLikeDshHome(c.path)) {
      dshHomeCache = { home: c.path, from: c.from === '默认 <home>/.dsh' ? c.from : '扫描命中' }
      return dshHomeCache
    }
  }

  dshHomeCache = { home: join(home, '.dsh'), from: '默认 <home>/.dsh' }
  return dshHomeCache
}

/**
 * settings.dshHome → DSH_HOME 环境变量 → 一系列默认位置（过判据）→ ~/.dsh
 * 返回类型必须是 string（调用方到处假设它永远有值），所以永远不返回 null。
 */
export function getDshHome(): string {
  return resolveDshHome().home
}

/** 这次 DSH_HOME 是从哪来的（「设置」「DSH_HOME 环境变量」「默认 <home>/.dsh」「扫描命中」） */
export function getDshHomeFrom(): string {
  return resolveDshHome().from
}

/* ------------------------------------------------------------------ *
 * installRoot
 * ------------------------------------------------------------------ */

interface InstallRootCandidate {
  path: string
  from: string
  group: string
}

/** 校验：<候选>/resources/app/package.json 存在且 name === '@deepseek-ai/dsh-desktop' */
function isValidInstallRoot(dir: string): boolean {
  if (!dir) return false
  const json = readJson(join(dir, 'resources', 'app', 'package.json'))
  return json?.name === '@deepseek-ai/dsh-desktop'
}

/**
 * 带记忆的校验器。
 * 为什么要记忆：枚举父目录 / 磁盘扫描会造出几百个候选，而「先看看目前有没有命中」
 * 这种短路判断会被反复调用，不缓存就会把同一批无效路径读上几十遍（几十万次 stat）。
 */
function makeValidityCache(): (path: string) => boolean {
  const cache = new Map<string, boolean>()
  return (p: string) => {
    const key = String(p ?? '').toLowerCase()
    if (!key) return false
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const v = isValidInstallRoot(p)
    cache.set(key, v)
    return v
  }
}

interface RouteCtx {
  push: (raw: string, from: string, group: string) => void
  /** 目前已经攒下的候选里有没有能用的（走缓存，很便宜） */
  anyValid: () => boolean
  log: DiscoveryLog
}

/* ---- A. 明确来源 ---------------------------------------------------- */

function hintFileRoots(): Array<{ path: string; from: string }> {
  const out: Array<{ path: string; from: string }> = []
  try {
    const hintFile = join(getDshHome(), 'dsh-purge', 'desktop-install.txt')
    if (existsSync(hintFile)) {
      const first = readFileSync(hintFile, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)[0]
      if (first) out.push({ path: first.replace(/\//g, '\\'), from: 'desktop-install.txt' })
    }
  } catch {
    /* 读不到就当没有这一条 */
  }
  return out
}

/* ---- B. 固定猜测（名字变体） ---------------------------------------- */

const NAME_VARIANTS = ['DeepSeek Harness', 'DeepSeekHarness', 'DSH Desktop', 'deepseek-harness']

function fixedGuessRoots(): Array<{ path: string; from: string }> {
  const out: Array<{ path: string; from: string }> = []
  const localAppData = envDir('LOCALAPPDATA')
  const programFiles = envDir('ProgramFiles')
  const programFilesX86 = envDir('ProgramFiles(x86)')

  // %LOCALAPPDATA%\Programs\<变体> —— 新版 Electron 安装器（NSIS per-user）的默认落点
  const userPrograms = localAppData ? join(localAppData, 'Programs') : ''
  if (userPrograms) for (const n of NAME_VARIANTS) out.push({ path: join(userPrograms, n), from: '常见安装位置' })

  // %PROGRAMFILES% / %PROGRAMFILES(X86)%\<变体>
  for (const base of [programFiles, programFilesX86]) {
    if (!base) continue
    for (const n of ['DeepSeek Harness', 'DeepSeekHarness']) out.push({ path: join(base, n), from: '常见安装位置' })
  }

  // %LOCALAPPDATA% 直下
  if (localAppData) {
    out.push({ path: join(localAppData, 'deepseek-harness'), from: '常见安装位置' })
    out.push({ path: join(localAppData, 'DeepSeek Harness'), from: '常见安装位置' })
  }

  // 旧值保留：以前的安装包就装在这儿
  out.push({ path: 'C:\\Program Files\\DeepSeekHarness', from: '常见安装位置' })
  return out
}

/* ---- C. 枚举父目录（不猜名字） -------------------------------------- */

function parentDirsToEnumerate(): string[] {
  const out: string[] = []
  const localAppData = envDir('LOCALAPPDATA')
  if (localAppData) out.push(join(localAppData, 'Programs'))
  const pf = envDir('ProgramFiles')
  if (pf) out.push(pf)
  const pfx86 = envDir('ProgramFiles(x86)')
  if (pfx86) out.push(pfx86)
  return out
}

/* ---- D. 快捷方式 ---------------------------------------------------- */

const LNK_MAX_FILES = 24
const LNK_MAX_DIRS = 150
const LNK_MAX_DEPTH = 3

function lnkSearchDirs(): string[] {
  const home = homedir()
  const appData = envDir('APPDATA')
  const programData = envDir('ProgramData')
  const dirs = [join(home, 'Desktop')]
  if (appData) dirs.push(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  if (programData) dirs.push(join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  return dirs
}

/**
 * 收桌面 / 开始菜单里名字对得上的 .lnk（含子目录：老机器的图标放在 Desktop\桌面图标\ 里）。
 * 为什么要有上限：桌面可能有 100+ 个快捷方式，遍历本身也要 readdir，
 * 用「目录数 + 命中数 + 深度」三个闸把最坏情况钉死。
 */
function collectLnkFiles(log: DiscoveryLog): string[] {
  const out: string[] = []
  const budget = { dirs: 0, files: 0 }
  const walk = (dir: string, depth: number): void => {
    if (budget.dirs >= LNK_MAX_DIRS || budget.files >= LNK_MAX_FILES || depth > LNK_MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    budget.dirs++
    const subdirs: string[] = []
    for (const e of entries) {
      if (budget.files >= LNK_MAX_FILES) break
      if (e.isDirectory()) {
        subdirs.push(join(dir, e.name))
        continue
      }
      if (!e.isFile() || !/\.lnk$/i.test(e.name)) continue
      if (!/deepseek|harness|dsh/i.test(e.name)) continue
      budget.files++
      out.push(join(dir, e.name))
    }
    for (const s of subdirs) walk(s, depth + 1)
  }
  for (const dir of lnkSearchDirs()) walk(dir, 0)
  if (budget.dirs >= LNK_MAX_DIRS || budget.files >= LNK_MAX_FILES) {
    log.add('快捷方式', '', false, `快捷方式扫描触到上限（目录 ${budget.dirs} / 命中 ${budget.files}），可能有遗漏`)
  }
  return out
}

/**
 * 从 .lnk 二进制里抠出「可能的目标路径」。
 *
 * 为什么不能用一条贪婪正则：.lnk 的字符串区不保证 NUL 分隔，实测拿到的是一整段
 *   `...plugins.D:\Dowloads\DeepSeekHarness0D:\Dowloads\DeepSeekHarness\DeepSeek Harness.exe`
 * —— 路径和描述文字、长度字段粘在一起，贪婪匹配会把它们连成一串，dirname 之后必然无效。
 * 所以按「盘符起点」[A-Za-z]:\ 把所有出现位置切成若干段，每段只取到第一个 .exe 为止（懒惰），
 * 再把每段沿 dirname 逐级上溯 —— 中间总有一段就是真正的安装目录。
 */
function lnkPathVariants(lnkFile: string): string[] {
  const out: string[] = []
  let text = ''
  try {
    text = readFileSync(lnkFile).toString('utf16le').replace(/\u0000/g, '')
  } catch {
    return out
  }
  if (!text) return out

  const starts: number[] = []
  const re = /[A-Za-z]:\\/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) starts.push(m.index)

  for (let i = 0; i < starts.length; i++) {
    const seg = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length)
    const exeHit = /^[A-Za-z]:\\[^:*?"<>|\u0001-\u001f]*?\.exe/i.exec(seg)
    const seed = (exeHit ? exeHit[0] : seg).replace(/[\u0001-\u001f]/g, '').trim()
    if (!seed) continue

    let cur = seed
    for (let hop = 0; hop < 8; hop++) {
      const dir = /\.exe$/i.test(cur) ? dirname(cur) : cur
      if (dir && dir !== cur) out.push(dir)
      else if (cur) out.push(cur)
      const parent = dirname(dir || cur)
      if (!parent || parent === dir || parent === cur) break
      cur = parent
    }
  }
  return out
}

/* ---- E. 磁盘扫描（有界兜底） ---------------------------------------- */

const DRIVE_LETTERS = ['C', 'D', 'E', 'F', 'G', 'H']

/**
 * 系统目录绝不可能装 DSH，先排掉能省掉一大半 readdir 预算。
 * 为什么连 $RECYCLE.BIN / System Volume Information / node_modules 都排：
 * 它们是「一定能枚举但一定不是安装根」的目录，readdir 还可能因为权限/超时卡住。
 */
const SYSTEM_DIR_NAMES = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'users',
  '$recycle.bin',
  'system volume information',
  'recovery',
  'perflogs',
  'msocache',
  'boot',
  'config.msi',
  '$windows.~bt',
  '$windows.~ws',
  'documents and settings',
  'windows.old',
  'intel',
  'amd',
  'nvidia',
  'temp',
  'tmp',
  'node_modules'
])

/** 一眼就像 DSH 的目录名（直接测 + 一定往下探一层） */
const DISK_SCAN_NAME_RE = /deepseek|harness|dsh/i

/**
 * 「值得再往下探一层」的意图词。
 *
 * 为什么不能只认 deepseek/harness/dsh：便携版常被放在 <盘>\<存放软件的目录>\<应用> 里，
 * 而中间那层叫什么都可能 —— 本机就是 `D:\Dowloads\DeepSeekHarness`（用户把 Downloads 拼成了
 * Dowloads）。只按名字判「值得下探」时，`Dowloads` 不匹配 → 第二层永远打不开 → 找不到。
 * 所以这里把「下载 / 软件 / 程序 / 工具 / 便携」这类存放软件的意图词一并算进来，
 * 顺带把自己拼错的 dowload（以及 down）也放进去 —— 这类错拼在真实用户机器上很常见。
 */
const DISK_SCAN_INTENT_RE =
  /deepseek|harness|dsh|download|dowload|down|software|program|apps?|tools?|portable|green|setup|install|bin|下载|软件|程序|便携|绿色|工具|安装包/i

/**
 * 磁盘扫描的四道闸（最坏情况必须能算出来）：
 *   1. 时间闸 DISK_SCAN_MAX_MS：超过就停，没扫到的算认命；
 *   2. 每个盘的一级目录上限 DISK_SCAN_MAX_TOP_DIRS；
 *   3. 全局 readdir 次数上限 DISK_SCAN_MAX_DIRS；
 *   4. 每个「值得下探」的目录最多再列 DISK_SCAN_MAX_KIDS 个子目录。
 * 最坏 = 6 个盘（DRIVE_LETTERS）× 200 顶层目录 × 1 次 existsSync（读 package.json 前先看存在性），
 * 外加 ≤260 次 readdir，任何一项先到就停；时间闸 1.2s 硬封顶。
 * 实测见 docs/env-discovery.md 第 4 节（本机 C/D/E/F 四盘 ≈ 百毫秒级）。
 *
 * 为什么要「第一层每个目录都直接测一次」：几百次 existsSync + 小文件读的代价可以忽略，
 * 而换来的是「不管用户把目录起成什么名字都能撞上」—— 命名约定这条路已经证明不够用了。
 * 第二层只对「值得下探」的目录开，第三层不再扫：再深的结构，快捷方式/注册表早就指过来了。
 */
const DISK_SCAN_MAX_MS = 1200
const DISK_SCAN_MAX_TOP_DIRS = 200
const DISK_SCAN_MAX_DIRS = 260
const DISK_SCAN_MAX_KIDS = 50

function diskScanRoots(ctx: RouteCtx): void {
  const deadline = Date.now() + DISK_SCAN_MAX_MS
  const budget = { dirs: 0 }
  const overBudget = (): boolean => Date.now() > deadline || budget.dirs >= DISK_SCAN_MAX_DIRS

  const listDir = (dir: string): Dirent[] | null => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      budget.dirs++
      return entries
    } catch {
      return null
    }
  }

  const skipName = (name: string): boolean =>
    name.startsWith('$') || SYSTEM_DIR_NAMES.has(name.toLowerCase())

  /** 值不值得再往下探一层：名字像 DSH / 像「放软件的目录」/ 自己就带 resources */
  const worthDeeper = (full: string, name: string): boolean => {
    if (DISK_SCAN_INTENT_RE.test(name)) return true
    try {
      if (existsSync(join(full, 'resources'))) return true
    } catch {
      /* 读不到就当不值得 */
    }
    return false
  }

  for (const letter of DRIVE_LETTERS) {
    const drive = `${letter}:\\`
    if (!pathExists(drive)) continue
    if (ctx.anyValid() || overBudget()) break

    // 先试最常见的一层命名（一次就读到，省掉整个扫描）
    ctx.push(join(drive, 'DeepSeekHarness'), '磁盘扫描', '磁盘扫描')
    ctx.push(join(drive, 'DeepSeek Harness'), '磁盘扫描', '磁盘扫描')

    const top = listDir(drive)
    if (!top) {
      ctx.log.add('磁盘扫描', drive, false, '读不到根目录（无权限 / 不是固定盘）')
      continue
    }

    /* 第一层：每个顶层目录都直接测一次（名字无关 —— 用户可能改成任何名字） */
    const deeper: string[] = []
    let topCount = 0
    for (const e of top) {
      if (topCount >= DISK_SCAN_MAX_TOP_DIRS || overBudget()) break
      if (!e.isDirectory() || skipName(e.name)) continue
      topCount++
      const full = join(drive, e.name)
      ctx.push(full, '磁盘扫描', '磁盘扫描')
      if (DISK_SCAN_NAME_RE.test(e.name) || worthDeeper(full, e.name)) deeper.push(full)
    }

    /* 第二层：<盘>\<放软件的目录>\<应用>（本机就是 D:\Dowloads\DeepSeekHarness） */
    for (const dir of deeper) {
      if (overBudget() || ctx.anyValid()) break
      const kids = listDir(dir)
      if (!kids) continue
      let n = 0
      for (const k of kids) {
        if (n >= DISK_SCAN_MAX_KIDS || overBudget()) break
        if (!k.isDirectory() || skipName(k.name)) continue
        n++
        ctx.push(join(dir, k.name), '磁盘扫描', '磁盘扫描')
      }
    }
  }
}

/* ---- 候选总装 ------------------------------------------------------- */

/**
 * 按优先级把所有 installRoot 候选摊开。每条候选都带 group（诊断轨迹用）。
 *
 * 这里的 anyValid() 短路不是「偷懒跳过校验」，而是「跳过生成」：
 * 快捷方式要读 24 个 .lnk，磁盘扫描要 readdir 两三百次，
 * 既然设置里 / 明确来源已经有能用的路径了，就没必要为诊断多花这几十毫秒。
 * 短路时往轨迹里补一条说明，免得看轨迹的人以为这些路由「一条都没试」。
 */
function installRootCandidates(log: DiscoveryLog, valid: (p: string) => boolean): InstallRootCandidate[] {
  const out: InstallRootCandidate[] = []
  const seen = new Set<string>()
  const push = (raw: string, from: string, group: string): void => {
    const p = toNativePath(raw)
    if (!p) return
    const key = p.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path: p, from, group })
  }
  const ctx: RouteCtx = { push, anyValid: () => out.some((c) => valid(c.path)), log }

  // A. 明确来源
  const s = safeSettings()
  if (typeof s.installRoot === 'string' && s.installRoot.trim()) push(s.installRoot, '设置', '设置')
  const fromEnv = process.env.DSH_INSTALL_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim()) push(fromEnv, 'DSH_INSTALL_ROOT 环境变量', '环境变量')
  for (const h of hintFileRoots()) push(h.path, h.from, '提示文件')

  // B. 固定猜测
  for (const g of fixedGuessRoots()) push(g.path, g.from, '固定猜测')

  // C. 枚举父目录（不猜名字，一次覆盖所有命名变体）
  for (const parent of parentDirsToEnumerate()) {
    let entries: Dirent[] = []
    try {
      entries = readdirSync(parent, { withFileTypes: true })
    } catch {
      log.add('父目录枚举', parent, false, '读不到该目录（不存在或无权限）')
      continue
    }
    let n = 0
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (n++ >= 80) break
      push(join(parent, e.name), '父目录枚举', '父目录枚举')
    }
  }

  // D. 快捷方式（二进制解析，不开子进程）
  if (ctx.anyValid()) {
    log.add('快捷方式', '', false, '跳过：前面的候选里已经命中有效安装根，省掉 .lnk 解析')
  } else {
    const lnks = collectLnkFiles(log)
    if (!lnks.length) {
      log.add('快捷方式', '', false, '桌面 / 开始菜单里没有名字带 deepseek / harness / dsh 的 .lnk')
    }
    for (const lnk of lnks) {
      for (const cand of lnkPathVariants(lnk)) push(cand, '快捷方式', '快捷方式')
    }
    log.add('快捷方式', lnks[0] ?? '', !!lnks.length, `二进制字符串扫描了 ${lnks.length} 个快捷方式（同步，不启动子进程）`)
  }

  // E. 磁盘扫描（有界兜底）
  if (ctx.anyValid()) {
    log.add('磁盘扫描', '', false, '跳过：前面的候选里已经命中有效安装根，省掉整盘遍历')
  } else {
    diskScanRoots(ctx)
  }

  return out
}

/**
 * 第一个通过校验的候选；都没有返回 null。
 * 传 warnings 时会把「设置里的无效」「一个都没找到」写进去。
 * 传 steps 时把「试过哪些、成没成」累积成诊断轨迹。
 */
function resolveInstallRoot(
  warnings?: string[],
  steps?: DiscoveryStep[],
  log?: DiscoveryLog
): { root: string | null; from: string | null } {
  const sink = log ?? new DiscoveryLog(steps)
  const valid = makeValidityCache()
  const candidates = installRootCandidates(sink, valid)

  const fromSettings = candidates.find((c) => c.from === '设置')
  if (fromSettings) {
    if (!pathExists(fromSettings.path)) {
      /* 目录都不存在（多半是打错字或盘符不对）—— 这是唯一拒绝用户手填的情形。 */
      warnings?.push(`设置里的安装根目录不存在：${fromSettings.path} —— 检查一下路径有没有打错。`)
    } else if (!valid(fromSettings.path)) {
      /* ★ 目录在、但结构不标准（没有 resources/app/package.json）。
       *   典型场景：从别的电脑整目录拷来的绿色版、或目录名变了体。
       *   旧逻辑把用户手填的值当普通候选一样丢掉 → installRoot 变 null →
       *   启动报「<安装目录未知>」—— 用户明明指了路，却被当成没指。
       *   现在：**用户填的目录存在就用**。启动 / 退出 DSH 只需要在那里找到
       *   exe（dshproc.locateExePath 自己会扫顶层）；结构不标准只影响官方通道
       *   （dshpm 找 <root>/resources/app/dsh/node_modules）—— 它会退化到
       *   插件台自带的 pnpm，装插件不受影响。 */
      warnings?.push(
        `已按设置里的目录用上 DSH：${fromSettings.path}（结构不标准：没有 resources/app/package.json —— 启动 / 退出 DSH 没问题，装插件走自带运行时，不受影响）`
      )
    }
  }

  let root: string | null = null
  let from: string | null = null
  for (const c of candidates) {
    /* ★ 「设置」是用户亲手填的，免结构校验 —— 目录存在即采纳；
     *   其余候选（环境变量 / 提示文件 / 固定猜测 / 快捷方式 / 磁盘扫描）都是猜的，
     *   必须过结构校验才可信。两类候选两个判据，不能一刀切 ——
     *   一刀切的结果就是「用户指了路，程序不认」。 */
    const ok = c.from === '设置' ? pathExists(c.path) : valid(c.path)
    sink.add(
      c.group,
      c.path,
      ok,
      ok
        ? c.from === '设置'
          ? '用户手填的目录，已直接采纳（启动 / 退出 DSH 时在这里找 exe；结构是否标准不影响采纳）'
          : '命中：resources/app/package.json 的 name = @deepseek-ai/dsh-desktop'
        : '没有 resources/app/package.json，或包名不是 @deepseek-ai/dsh-desktop'
    )
    if (ok) {
      root = c.path
      from = c.from
      break
    }
  }

  sink.finish()
  /* 注意措辞：没找到安装根**不是错误**，只是「启动 / 退出 DSH」两个按钮用不上。
   * 这里以前写「请到设置里手动指定」，读起来像环境坏了 —— 而装插件根本不看它。 */
  if (!root) warnings?.push('没找到 DSH 桌面端的安装目录（不影响装插件，只影响「启动 / 退出 DSH」）')
  return { root, from }
}

/** value = 找到的根；from = 哪条路由找到的（同步路由名 / 注册表 / 运行中的进程 / 快捷方式） */
let installRootCache: { value: string | null; from: string | null } | null = null

/** 同步拿安装根（带缓存；invalidate 后重算） */
export function getInstallRoot(): string | null {
  if (installRootCache) return installRootCache.value
  const { root, from } = resolveInstallRoot()
  installRootCache = { value: root, from }
  return root
}

/** 这次 installRoot 是从哪条路由来的（没命中返回 null） */
function getInstallRootFrom(): string | null {
  getInstallRoot()
  return installRootCache?.from ?? null
}

/* ------------------------------------------------------------------ *
 * node / pnpm
 * ------------------------------------------------------------------ */

function runtimeDirs(): string[] {
  try {
    const root = join(getDshHome(), 'dsh-runtimes')
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => join(root, d.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * <dshHome> 的兄弟目录及其下两级里找 dsh-runtimes。
 * 为什么要有这一条：老版本把运行时放在别处（例如 %USERPROFILE%\dsh-runtimes），
 * 而 DSH_HOME 是用户后来才指到 .dsh 的，这样一挪就对不上了。
 */
let siblingRuntimesCache: { home: string; dirs: string[] } | null = null

function siblingRuntimeRoots(): string[] {
  const dshHome = getDshHome()
  if (siblingRuntimesCache && siblingRuntimesCache.home === dshHome) return siblingRuntimesCache.dirs

  const dirs: string[] = []
  const parent = dirname(dshHome)
  if (parent && parent !== dshHome) {
    let sibs: Dirent[] = []
    try {
      sibs = readdirSync(parent, { withFileTypes: true })
    } catch {
      sibs = []
    }
    let n = 0
    const check = (dir: string): void => {
      const rt = join(dir, 'dsh-runtimes')
      if (pathExists(rt)) dirs.push(rt)
    }
    for (const s of sibs) {
      if (n >= 40) break
      if (!s.isDirectory()) continue
      const full = join(parent, s.name)
      n++
      check(full)
      let kids: Dirent[] = []
      try {
        kids = readdirSync(full, { withFileTypes: true })
      } catch {
        kids = []
      }
      for (const k of kids) {
        if (n >= 80) break
        if (!k.isDirectory()) continue
        n++
        check(join(full, k.name))
      }
    }
  }
  siblingRuntimesCache = { home: dshHome, dirs }
  return dirs
}

/**
 * 有限深度找 node.exe。
 * 为什么不用全盘递归：node_modules 那种目录一层就是几万个文件，
 * 所以边走边数（目录数上限 + 时间闸），到点就放弃 —— 这条路本来就是兜底。
 */
function findNodeUnder(rootDir: string, maxDepth: number, deadline: number): string | null {
  if (!rootDir || !pathExists(rootDir)) return null
  const exe = nodeExecutableName()
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]
  let visited = 0
  while (stack.length) {
    if (visited > 400 || Date.now() > deadline) return null
    const cur = stack.pop()
    if (!cur || !cur.dir || cur.depth > maxDepth) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(cur.dir, { withFileTypes: true })
    } catch {
      continue
    }
    visited++
    for (const e of entries) {
      if (e.isDirectory()) stack.push({ dir: join(cur.dir, e.name), depth: cur.depth + 1 })
      else if (e.name.toLowerCase() === exe.toLowerCase()) return join(cur.dir, e.name)
    }
  }
  return null
}

/** 在某个 dsh-runtimes 目录下按「主运行时优先」的顺序找 node.exe */
function nodeUnderRuntimes(rt: string, deadline: number): string | null {
  const exe = nodeExecutableName()
  const primary = join(rt, 'dsh-primary-runtime', 'dependencies', 'node', 'bin', exe)
  if (pathExists(primary)) return primary
  let dirs: string[] = []
  try {
    dirs = readdirSync(rt, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => join(rt, d.name))
      .sort()
  } catch {
    dirs = []
  }
  for (const d of dirs) {
    const p = join(d, 'dependencies', 'node', 'bin', exe)
    if (pathExists(p)) return p
  }
  // 有的版本把 node 埋在更深处，最后一层兜底（有界）
  return findNodeUnder(rt, 3, deadline)
}

/**
 * node 查找顺序：
 *   1. <dshHome>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe（主运行时）
 *   2. <dshHome>\dsh-runtimes\*\dependencies\node\bin\node.exe
 *   3. <installRoot> 里随包的 node（只在这几个子路径里递归，深度 ≤4）
 *   4. <dshHome> 的兄弟目录及其下两级的 dsh-runtimes
 *   5. 系统 node（PATH → %PROGRAMFILES%\nodejs → %LOCALAPPDATA%\Programs\nodejs）
 *
 * 为什么要缓存：buildChildEnv() 每次起 pnpm 子进程都会调它，第 3/4 条要 readdir 几百次。
 * 正结果一直有效到 invalidate()；负结果给 20 秒的短 TTL —— 用户可能就是刚装完 DSH
 * （dsh-runtimes 才展开），不能把「没有」永久钉死。
 */
const NODE_MISS_TTL_MS = 20_000
let nodePathCache: { value: string | null; at: number } | null = null
const SCRIPT_ROOT_SUBPATHS = [
  'resources',
  join('resources', 'app'),
  join('resources', 'app', 'dsh'),
  join('resources', 'app', 'dsh', 'dsh-runtimes'),
  'dsh-runtimes'
]

function resolveNodePath(steps?: DiscoveryStep[]): string | null {
  if (!steps && nodePathCache) {
    if (nodePathCache.value) return nodePathCache.value
    if (Date.now() - nodePathCache.at < NODE_MISS_TTL_MS) return null
  }

  const log = new DiscoveryLog(steps)
  const deadline = Date.now() + 1500
  const exe = nodeExecutableName()
  let found: string | null = null

  const probe = (group: string, p: string, detail: string): void => {
    if (found) return
    const ok = pathExists(p)
    log.add(group, p, ok, ok ? detail : detail + '（不存在）')
    if (ok) found = p
  }

  // 1 / 2：DSH_HOME 下的 dsh-runtimes
  const dshHome = getDshHome()
  for (const rt of [join(dshHome, 'dsh-runtimes'), ...siblingRuntimeRoots()]) {
    if (found) break
    const hit = nodeUnderRuntimes(rt, deadline)
    log.add('运行时', rt, !!hit, hit ? `在 ${rt} 下找到随包 node` : `在 ${rt} 下没找到 node（含主运行时与各 runtime 子目录）`)
    if (hit) found = hit
  }

  // 3：安装目录里随包的 node
  if (!found) {
    const installRoot = getInstallRoot()
    if (!installRoot) {
      log.add('运行时', '', false, '跳过「安装目录随包 node」：还没找到安装目录')
    } else {
      for (const sub of SCRIPT_ROOT_SUBPATHS) {
        if (found) break
        const hit = findNodeUnder(join(installRoot, sub), 4, deadline)
        log.add('运行时', join(installRoot, sub), !!hit, hit ? `在安装目录的 ${sub} 下找到 node` : `安装目录的 ${sub} 下（深度 ≤4）没有 node.exe`)
        if (hit) found = hit
      }
    }
  }

  // 5：系统 node
  if (!found) {
    const segs = String(process.env.PATH ?? '')
      .split(delimiter)
      .map((x) => x.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
    for (const seg of segs) {
      if (found) break
      const p = join(seg, exe)
      if (pathExists(p)) {
        log.add('运行时', p, true, 'PATH 上的系统 node（兜底：不是 DSH 随包版本）')
        found = p
      }
    }
    if (!found) {
      for (const guess of [join(envDir('ProgramFiles'), 'nodejs', exe), join(envDir('LOCALAPPDATA'), 'Programs', 'nodejs', exe)]) {
        if (!guess || found) continue
        probe('运行时', guess, '系统 node 的常见安装位置')
      }
    }
    if (!found) log.add('运行时', '', false, `PATH（${segs.length} 段）与常见 nodejs 目录里都没有 ${exe}`)
  }

  log.finish()
  nodePathCache = { value: found, at: Date.now() }
  return found
}

/**
 * pnpm 入口查找顺序：nodePath 上溯 3 层（<deps>）→ 所有 dsh-runtimes\*\dependencies →
 * nodePath 上溯 2 层（有的版本就放在 node 旁边）→ 兄弟 dsh-runtimes 的 dependencies →
 * PATH 上的 pnpm.cjs。
 */
function resolvePnpmPath(nodePath: string | null, steps?: DiscoveryStep[]): string | null {
  const log = new DiscoveryLog(steps)
  const names = ['pnpm.cjs', 'pnpm.mjs']
  const roots: string[] = []

  if (nodePath) {
    roots.push(dirname(dirname(dirname(nodePath))))
    roots.push(dirname(dirname(nodePath)))
  }
  for (const dir of runtimeDirs()) roots.push(join(dir, 'dependencies'))
  for (const dir of runtimeDirs()) roots.push(dir)
  for (const rt of siblingRuntimeRoots()) roots.push(join(rt, 'dependencies'))

  const seen = new Set<string>()
  for (const root of roots) {
    if (!root) continue
    const key = root.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    for (const n of names) {
      const p = join(root, 'pnpm', 'bin', n)
      if (pathExists(p)) {
        log.add('运行时', p, true, `找到 pnpm 入口（在 ${root} 下）`)
        log.finish()
        return p
      }
    }
    log.add('运行时', join(root, 'pnpm', 'bin'), false, '这一层没有 pnpm/bin/pnpm.cjs')
  }

  // PATH 上直接有 pnpm.cjs（全局安装的 pnpm / npx 环境）
  const segs = String(process.env.PATH ?? '')
    .split(delimiter)
    .map((x) => x.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  for (const seg of segs) {
    for (const cand of [join(seg, 'pnpm.cjs'), join(seg, 'pnpm', 'bin', 'pnpm.cjs')]) {
      if (pathExists(cand)) {
        log.add('运行时', cand, true, 'PATH 上的 pnpm 入口（兜底）')
        log.finish()
        return cand
      }
    }
  }

  log.add('运行时', '', false, '所有候选目录与 PATH 里都没有 pnpm/bin/pnpm.cjs')
  log.finish()
  return null
}

export function getNodePath(): string | null {
  return resolveNodePath()
}

export function getPnpmPath(): string | null {
  return resolvePnpmPath(getNodePath())
}

/* ------------------------------------------------------------------ *
 * 自带运行时（bundled runtime）—— 最后一道、也是最可靠的一道
 * ------------------------------------------------------------------ */

/**
 * 为什么要自带 pnpm：**「补全前置」这条路以前从根上就是错的。**
 *
 * 老设计是「找不到 DSH 桌面端安装目录 → 拿不到随包载荷 → 补不了」，于是没装桌面端的
 * 机器上（新电脑、或者桌面端装在别处）引导卡里那个「一键补全运行时」按钮永远不出现，
 * 用户只能看到一句「没找到 DSH 桌面端的安装目录」，而这句话对「装插件」其实无关 ——
 * 这正是用户报的「有时候还会缺前置，需要补全前置功能」。
 *
 * 真正的答案：插件台自己就是 Electron 应用，**Electron 自带一份 Node**（本机实测
 * v24.22.1，`ELECTRON_RUN_AS_NODE=1` 下 `process.versions.node` 就是它）。所以
 * 「Node 运行时」这一环我们可以 100% 自给，不需要问系统、不需要问 DSH。
 *
 * pnpm 是纯 JS（15.78 MB，5 个文件：bin/pnpm.cjs、bin/pnpm.mjs、dist/pnpm.mjs、
 * dist/worker.js、package.json），作为 extraResources 打进安装包，同样 100% 自给。
 * 本机实测：用 `electron.exe` 当 node 跑这份精简 pnpm，`pnpm add dsh-pet` 真装成功
 * （4.7 秒，exit 0）。
 *
 * 于是运行时优先级变成：
 *   1. DSH 随包的 node + pnpm（版本最贴，官方通道也认它）
 *   2. **自带**：electron.exe（当 node）+ resources/pnpm（永远可用）
 * 第二条兜住了「什么都没装」的机器，这才是「补全前置」该有的样子。
 */
export interface BundledRuntime {
  /** 当 node 用的可执行文件（打包后是 electron.exe 自己） */
  nodePath: string
  /** 自带 pnpm 的入口（pnpm.cjs） */
  pnpmPath: string
  /** 这份 pnpm 的版本，用于界面显示 */
  pnpmVersion: string | null
}

let bundledCache: BundledRuntime | null | undefined

/**
 * 定位自带 pnpm。找不到返回 null（只有安装包被手工删过才会这样）。
 *
 * 打包后：<process.resourcesPath>/resources/pnpm/bin/pnpm.cjs
 * 开发时：<工程根>/resources/pnpm/bin/pnpm.cjs
 *
 * 为什么不放在 asar 里：pnpm 要 spawn 子进程去写 node_modules，asar 是只读的虚拟
 * 文件系统，从里面跑起来的进程拿不到真实路径。所以走 extraResources（与托盘图标同一套）。
 */
function resolveBundledRuntime(): BundledRuntime | null {
  if (bundledCache !== undefined) return bundledCache

  const tryPaths = (): string[] => {
    const list: string[] = []
    /* electron 的 resources 根：打包后是 <安装目录>/resources，开发时是 node_modules/electron/dist/resources */
    const resRoot = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
    if (resRoot) list.push(join(resRoot, 'resources', 'pnpm', 'bin', 'pnpm.cjs'))
    /* 开发时按工程根兜底（process.resourcesPath 在 dev 下指向 electron 自己的 resources，没有我们的东西） */
    try {
      list.push(join(appRoot(), 'resources', 'pnpm', 'bin', 'pnpm.cjs'))
    } catch {
      /* 拿不到工程根就算了 */
    }
    return list
  }

  let pnpmPath: string | null = null
  for (const p of tryPaths()) {
    if (pathExists(p)) {
      pnpmPath = p
      break
    }
  }
  if (!pnpmPath) {
    bundledCache = null
    return null
  }

  /* node 就是当前这个可执行文件。开发时是 node_modules/electron/dist/electron.exe，
     打包后是 DSHPluginConsole.exe —— 两者都能在 ELECTRON_RUN_AS_NODE=1 下当 node 用。 */
  const nodePath = process.execPath
  if (!nodePath || !pathExists(nodePath)) {
    bundledCache = null
    return null
  }

  /* 读一下版本，界面要显示（读不到不影响可用性） */
  let pnpmVersion: string | null = null
  try {
    const raw = readFileSync(join(dirname(dirname(pnpmPath)), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string') pnpmVersion = parsed.version
  } catch {
    pnpmVersion = null
  }

  bundledCache = { nodePath, pnpmPath, pnpmVersion }
  return bundledCache
}

/** 工程根（开发时用）。打包后 app.getAppPath() 指向 asar，里面没有 resources/pnpm。 */
function appRoot(): string {
  try {
    if (app?.isPackaged) return dirname(process.resourcesPath)
    return app?.getAppPath() ?? process.cwd()
  } catch {
    return process.cwd()
  }
}

/** 自带运行时是否可用（界面用它决定要不要显示「补全」按钮） */
export function getBundledRuntime(): BundledRuntime | null {
  return resolveBundledRuntime()
}

/**
 * 真正用来跑 pnpm 的那一对 (node, pnpm)。
 *
 * 与 getNodePath / getPnpmPath 的区别：那两个是「DSH 给了什么」，这个是「我们能跑什么」。
 * 顺序：DSH 随包 → 自带。**永远不返回 null**（自带那份在安装包里，删不掉）。
 */
export function getRunnableRuntime(): { nodePath: string; pnpmPath: string; source: 'dsh' | 'bundled'; version: string | null } {
  const dshNode = getNodePath()
  const dshPnpm = getPnpmPath()
  if (dshNode && dshPnpm) {
    return { nodePath: dshNode, pnpmPath: dshPnpm, source: 'dsh', version: null }
  }
  const bundled = resolveBundledRuntime()
  if (bundled) {
    return { nodePath: bundled.nodePath, pnpmPath: bundled.pnpmPath, source: 'bundled', version: bundled.pnpmVersion }
  }
  /* 两条都没有（理论上只有安装包被拆过）：返回空串让调用方走既有的报错路径 */
  return { nodePath: '', pnpmPath: '', source: 'bundled', version: null }
}

/* ------------------------------------------------------------------ *
 * 写操作前的预检
 * ------------------------------------------------------------------ */

export interface RuntimeCheck {
  ok: boolean
  /** 缺的是哪一环；都齐时 null */
  missing: 'install-root' | 'node' | 'pnpm' | null
  /** 给人看的一句话，说清缺什么、去哪里补 */
  message: string
  /** 一句可操作的建议 */
  fix: string
}

/**
 * 装插件需要什么？**只需要一对能跑起来的 (node, pnpm)，不需要安装目录。**
 *
 * 这条边界被写错过两次：
 *
 * 第一次：把「没找到 DSH 桌面端安装目录」当成第一道硬拦。插件装进的是
 * `<DSH_HOME>/profiles/<name>`，跑的是 node 与 pnpm，整条路径跟安装目录无关。
 * 安装目录只在 `dshproc`（启动/退出 exe）与 `dshpm`（官方通道找 node_modules）用得上，
 * 那两处各有降级，不该反过来把装插件一起堵死。
 *
 * 第二次（本轮）：只认「DSH 随包的 node/pnpm」。可用户的新电脑上根本没装桌面端，
 * 于是 `checkRuntime()` 永远不 ok，引导卡里的「一键补全运行时」永远不出现 ——
 * 用户看到的是「缺 pnpm」，而界面上没有任何一条路能把它补上。
 *
 * 现在判据是 `getRunnableRuntime()`：DSH 随包**或**插件台自带（electron 当 node +
 * resources/pnpm）任一可用即可。自带那份在安装包里，所以这条预检在真机上恒为 ok，
 * 「补全前置」不再依赖用户先装一个别的东西。
 *
 * 为什么必须同步：调用点在 spawnProcess() 这类地方，它们本来就在同步上下文里，
 * 而且拿的是缓存值（invalidate 后重算），一次调用只有几个 stat。
 */
export function checkRuntime(): RuntimeCheck {
  try {
    const rt = getRunnableRuntime()
    if (!rt.nodePath) {
      return {
        ok: false,
        missing: 'node',
        message: '没有可用的 Node 运行时',
        fix: '插件台自带的那一份也没找到 —— 安装包可能被手工删过文件，重新安装一次插件台即可'
      }
    }
    if (!rt.pnpmPath) {
      return {
        ok: false,
        missing: 'pnpm',
        message: '没有可用的 pnpm',
        fix: '插件台自带的那一份也没找到 —— 安装包可能被手工删过文件，重新安装一次插件台即可'
      }
    }
    return { ok: true, missing: null, message: '运行环境就绪', fix: '' }
  } catch {
    return {
      ok: false,
      missing: 'node',
      message: '运行环境探测异常',
      fix: '重新启动插件台；还不行就重新安装一次'
    }
  }
}

/* ------------------------------------------------------------------ *
 * 版本探测
 * ------------------------------------------------------------------ */

/**
 * 跑 `cmd args... -v` 取第一行版本号。
 *
 * asNode=true 时会塞 ELECTRON_RUN_AS_NODE=1 —— 自带运行时用 electron.exe 当 node，
 * 不设这个变量它会去开一个窗口而不是跑脚本（表现为「没有输出、探测失败」）。
 */
function runVersion(cmd: string, args: string[], asNode = false): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const env = asNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
      execFile(
        cmd,
        args,
        { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env },
        (err: Error | null, stdout: string) => {
          if (err) {
            resolve(null)
            return
          }
          const line = String(stdout ?? '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)[0]
          if (!line) {
            resolve(null)
            return
          }
          resolve(line.replace(/^v(?=\d)/, ''))
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/* ------------------------------------------------------------------ *
 * 命令行工具的探测（异步富化用）
 * ------------------------------------------------------------------ */

/**
 * 系统工具（reg.exe / powershell.exe）的 stdout 走的是控制台代码页，中文系统上是 GBK。
 * 按 utf8 解会把「软件」「插件台」这类中文变成乱码，而路径里完全可能有中文目录名。
 * Electron 自带完整 ICU，所以先试 GBK；解不了（阉割版 ICU）退回 latin1 ——
 * latin1 至少保证 ASCII 部分原样，关键字匹配与英文路径判断都不受影响。
 * 回调里 stdout 的类型写成 Buffer | string 是为了兼容 encoding 被推断成 string 的情况。
 */
function decodeToolOutput(buf: Buffer): string {
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return buf.toString('latin1')
  }
}

function execCapture(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' as const },
        (_err: Error | null, stdout: Buffer | string) => {
          // 出错但有半截输出也留着 —— reg.exe 遇到不存在的主键就是非 0 退出，不该当失败；
          // 真正的失败（起不来 / 超时）由调用方看空字符串处理。
          resolve(typeof stdout === 'string' ? stdout : stdout ? decodeToolOutput(stdout) : '')
        }
      )
    } catch {
      resolve('')
    }
  })
}

/* ------------------------------------------------------------------ *
 * 异步富化：注册表 / 运行中的进程 / WScript 精确解析快捷方式
 * ------------------------------------------------------------------ */

const REG_UNINSTALL_HIVES = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]

interface RegEntry {
  key: string
  displayName: string
  values: Map<string, string>
}

/** reg.exe query /s 的输出是「一个主键一块，块里每行一个值」，按块切回来 */
function parseRegOutput(text: string): RegEntry[] {
  const entries: RegEntry[] = []
  let cur: RegEntry | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (/^(HKEY_|HKCR|HKLM|HKCU|HKU)/i.test(line.trim()) && !/^\s/.test(raw)) {
      cur = { key: line.trim(), displayName: '', values: new Map() }
      entries.push(cur)
      continue
    }
    if (!cur) continue
    const m = /^\s+(.+?)\s{2,}REG_\w+\s*(.*)$/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    const value = m[2]
    if (name === 'DisplayName') cur.displayName = value
    cur.values.set(name, value)
  }
  return entries
}

/** 剥掉 reg.exe 输出里可能的引号（值本身可能带引号） */
function stripQuotes(v: string): string {
  return String(v ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .trim()
}

/**
 * 从一条卸载项里反推安装目录。
 * 为什么不能只读 InstallLocation：我们自己的安装包那条注册表项 InstallLocation 是空串，
 * 只有 UninstallString / DisplayIcon 可用 —— 所以必须能从后两者反推。
 */
function rootsFromRegEntry(e: RegEntry): Array<{ path: string; how: string }> {
  const out: Array<{ path: string; how: string }> = []
  const loc = stripQuotes(e.values.get('InstallLocation') ?? '')
  if (loc) out.push({ path: loc, how: 'InstallLocation' })

  const un = e.values.get('UninstallString') ?? ''
  const quoted = /"([^"]+\.exe)"/i.exec(un)
  const bare = quoted ? null : /([A-Za-z]:\\[^\s"]*?\.exe)/i.exec(un)
  const unExe = quoted?.[1] ?? bare?.[1]
  if (unExe) out.push({ path: dirname(stripQuotes(unExe)), how: 'UninstallString 反推' })

  const iconRaw = stripQuotes(e.values.get('DisplayIcon') ?? '')
  const icon = iconRaw.replace(/,\s*-?\d+$/, '').trim()
  if (icon && /\.exe$/i.test(icon)) out.push({ path: dirname(icon), how: 'DisplayIcon 反推' })

  return out
}

function entryLooksLikeDsh(e: RegEntry): boolean {
  if (/deepseek|harness|dsh/i.test(e.displayName)) return true
  for (const [, v] of e.values) {
    if (/deepseek|harness/i.test(v)) return true
  }
  return false
}

async function registryRoots(log: DiscoveryLog, valid: (p: string) => boolean): Promise<string | null> {
  if (!isWin()) return null
  const outputs = await Promise.all(REG_UNINSTALL_HIVES.map((h) => execCapture('reg.exe', ['query', h, '/s'], 8000)))
  let found: string | null = null

  for (let i = 0; i < REG_UNINSTALL_HIVES.length; i++) {
    const hive = REG_UNINSTALL_HIVES[i]
    const text = outputs[i]
    if (!text.trim()) {
      log.add('注册表', hive, false, 'reg.exe 没有输出（该主键不存在或无权读取）')
      continue
    }
    const entries = parseRegOutput(text).filter(entryLooksLikeDsh)
    if (!entries.length) {
      log.add('注册表', hive, false, `扫到卸载项，但没有 DisplayName / 路径里带 DeepSeek、Harness 的条目`)
      continue
    }
    for (const e of entries) {
      for (const c of rootsFromRegEntry(e)) {
        const p = toNativePath(c.path)
        if (!p) continue
        const ok = valid(p)
        log.add('注册表', p, ok, ok ? `命中：来自「${e.displayName || e.key}」的 ${c.how}` : `「${e.displayName || e.key}」的 ${c.how} 不是安装根`)
        if (ok && !found) found = p
      }
    }
    if (!found && entries.length) log.add('注册表', hive, false, '该主键下的 DSH 条目都没能反推出安装根')
  }
  return found
}

/**
 * 运行中的进程。
 * 过滤用 Name LIKE 而不是写死 'DeepSeek Harness.exe'：不同版本 exe 名可能是
 * DeepSeekHarness.exe / DSH Desktop.exe，写死一个名字就漏了。
 * 顺带排除我们自己的进程（插件台的 exe 名里也带 DSH）。
 *
 * ★ 进程是所有路由里唯一「操作系统报告的事实」：那个 exe 正在跑，路径就是真的。
 *   所以这条路由**免结构校验**（目录存在即采纳）—— 结构校验只配用来筛猜测路由；
 *   拿事实去过猜测的关卡，绿色版 / 拷贝版的进程明明在跑也会被否决，
 *   用户看到的就成了「明明 DSH 开着，插件台却说找不到」。（Master 实机踩中。）
 *   多个候选时按「exe 名长得像主程序」排序：DeepSeek Harness.exe 在前，
 *   名字里只沾了个 dsh 的第三方进程垫底 —— 免得一次误采纳把好结果占住。
 */
async function processRoots(log: DiscoveryLog): Promise<string | null> {
  if (!isWin()) return null
  const script =
    'Get-CimInstance Win32_Process -Filter "Name LIKE \'%DeepSeek%\' OR Name LIKE \'%Harness%\' OR Name LIKE \'%dsh%\'" | ' +
    'Select-Object -ExpandProperty ExecutablePath'
  const out = await execCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000)
  const self = process.execPath ? process.execPath.toLowerCase() : ''
  const selfBase = self ? (self.split('\\').pop() ?? '') : ''
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) {
    log.add('运行中的进程', '', false, '没有名字带 DeepSeek / Harness / dsh 的进程在跑')
    return null
  }

  interface ProcCand {
    dir: string
    exe: string
    score: number
  }
  const cands: ProcCand[] = []
  for (const line of lines) {
    const p = toNativePath(stripQuotes(line))
    if (!p) continue
    const lower = p.toLowerCase()
    // 排除：自己这个进程、插件台的其它实例（同名 exe）、卸载器/更新器
    if (self && lower === self) {
      log.add('运行中的进程', p, false, '跳过：这是插件台自己的进程')
      continue
    }
    if (selfBase && (lower.split('\\').pop() ?? '') === selfBase) {
      log.add('运行中的进程', p, false, '跳过：插件台的另一个实例')
      continue
    }
    if (/uninstall|unins\d*|setup|update/i.test(lower)) {
      log.add('运行中的进程', p, false, '跳过：看名字是卸载器 / 更新器，不是主程序')
      continue
    }
    const dir = dirname(p)
    if (!pathExists(dir)) {
      log.add('运行中的进程', dir, false, `进程 ${p} 报的目录居然不存在 —— 当作噪音丢弃`)
      continue
    }
    const base = (lower.split('\\').pop() ?? '').replace(/\.exe$/, '')
    // 越像主程序分越高：全名命中 > harness > deepseek > 光沾个 dsh
    const score = /deepseek.{0,3}harness/.test(base)
      ? 100
      : /harness/.test(base)
        ? 70
        : /deepseek/.test(base)
          ? 50
          : 10
    cands.push({ dir, exe: p, score })
  }
  if (!cands.length) {
    log.add('运行中的进程', '', false, '有名字匹配的进程，但都不是能用的（插件台自己 / 卸载器 / 路径异常）')
    return null
  }
  cands.sort((a, b) => b.score - a.score)
  const best = cands[0]
  log.add(
    '运行中的进程',
    best.dir,
    true,
    `命中：${best.exe} 正在运行，它的目录就是安装位置（进程路径是操作系统报告的事实，直接采纳；结构是否标准不影响 —— 「启动 / 退出 DSH」只需要在这里找到 exe）`
  )
  return best.dir
}

/**
 * WScript 精确解析快捷方式（只在同步的二进制解析没找到时才跑）。
 * 逐个 lnk 起进程太慢，所以把多个 lnk 拼进一条 PowerShell 命令里，
 * 每条目标前面插一个 <<序号>> 标记 —— 目标为空时不会错位。
 */
async function wscriptLnkRoots(log: DiscoveryLog, valid: (p: string) => boolean): Promise<string | null> {
  if (!isWin()) return null
  const files = collectLnkFiles(log).slice(0, 20)
  if (!files.length) return null

  const parts: string[] = ['$s = New-Object -ComObject WScript.Shell']
  files.forEach((f, i) => {
    const esc = f.replace(/'/g, "''")
    parts.push(`Write-Output ('<<${i}>>')`)
    parts.push(`Write-Output $s.CreateShortcut('${esc}').TargetPath`)
  })
  const out = await execCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parts.join('; ')], 10000)

  let idx = -1
  let found: string | null = null
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    const m = /^<<(\d+)>>$/.exec(line)
    if (m) {
      idx = Number(m[1])
      continue
    }
    if (!line || idx < 0) continue
    const lnk = files[idx] ?? ''
    const target = stripQuotes(line)
    const dir = dirname(toNativePath(target))
    const ok = valid(dir)
    log.add('快捷方式', dir || target, ok, ok ? `命中：WScript 解析 ${lnk} 得到目标 ${target}` : `WScript 解析 ${lnk} 得到 ${target || '(空)'}，不是安装根`)
    if (ok && !found) found = dir
  }
  if (!found) log.add('快捷方式', '', false, 'WScript 解析完所有候选 .lnk，目标都不是安装根')
  return found
}

/**
 * 异步深挖：注册表 + 运行中的进程 + WScript 精确解析快捷方式。
 *
 * 为什么不放在 getInstallRoot() 里：那是同步的、被到处调用（热路径）。
 * 这里的每条都要起 PowerShell / reg.exe，几百毫秒起步。所以拆成两段：
 * 同步的先把能拿的拿到（保证应用能起来），异步的随后补一刀；
 * 找到了就写进本模块的 installRootCache（调用方再决定要不要落到 settings），
 * 之后所有人走缓存。
 *
 * 注意：这里只更新「进程内缓存」，不写 settings —— 落盘由 IPC 层统一做（只写空值、
 * 绝不覆盖用户手填）。这样探测函数保持纯粹，落盘规则只有一处。
 */
export async function enrichInstallRoot(): Promise<{ root: string | null; from: string | null; steps: DiscoveryStep[] }> {
  const steps: DiscoveryStep[] = []
  const log = new DiscoveryLog(steps)
  const valid = makeValidityCache()

  const syncRoot = getInstallRoot()
  log.add(
    '设置',
    syncRoot ?? '',
    !!syncRoot,
    syncRoot ? `同步路由已经拿到安装根：${syncRoot}（异步路由继续跑，用于诊断与兜底）` : '同步路由没拿到安装根，转异步路由'
  )

  let root: string | null = null
  let from: string | null = null

  try {
    const reg = await registryRoots(log, valid)
    if (reg) {
      root = reg
      from = '注册表'
    }
  } catch (e) {
    log.add('注册表', '', false, `注册表路由异常：${String((e as Error)?.message ?? e)}`)
  }

  try {
    // 进程路由免结构校验（函数内部自带理由），签名不再吃 valid。
    const proc = await processRoots(log)
    if (proc && !root) {
      root = proc
      from = '运行中的进程'
    }
  } catch (e) {
    log.add('运行中的进程', '', false, `进程路由异常：${String((e as Error)?.message ?? e)}`)
  }

  if (!root && !syncRoot) {
    try {
      const lnk = await wscriptLnkRoots(log, valid)
      if (lnk) {
        root = lnk
        from = '快捷方式'
      }
    } catch (e) {
      log.add('快捷方式', '', false, `WScript 路由异常：${String((e as Error)?.message ?? e)}`)
    }
  } else if (!root) {
    log.add('快捷方式', '', false, '跳过：同步路由已经拿到安装根了')
  }

  if (root) {
    installRootCache = { value: root, from }
    log.add('设置', root, true, `异步路由命中安装根（来源：${from}），已写入进程内缓存`)
  }

  log.finish()
  return { root, from, steps }
}

/* ------------------------------------------------------------------ *
 * RuntimeInfo
 * ------------------------------------------------------------------ */

let infoCache: Promise<RuntimeInfo> | null = null

/** 清缓存；设置变更后由 IPC 层调用 */
export function invalidate(): void {
  bundledCache = undefined
  infoCache = null
  installRootCache = null
  dshHomeCache = null
  nodePathCache = null
  siblingRuntimesCache = null
}

function fallbackRuntimeInfo(): RuntimeInfo {
  return {
    dshHome: getDshHome(),
    dshHomeFrom: getDshHomeFrom(),
    installRoot: null,
    installRootFrom: null,
    discovery: [],
    desktopVersion: null,
    runtimeVersion: null,
    dshCliPath: null,
    nodePath: null,
    nodeVersion: null,
    pnpmPath: null,
    pnpmVersion: null,
    runtimeSource: null,
    warnings: ['运行环境探测异常，请到设置里手动指定 DSH_HOME 与安装根']
  }
}

async function buildRuntimeInfo(): Promise<RuntimeInfo> {
  const warnings: string[] = []
  const steps: DiscoveryStep[] = []

  const home = resolveDshHome()
  const dshHome = home.home
  const homeLog = new DiscoveryLog(steps)
  homeLog.add('DSH_HOME', dshHome, pathExists(dshHome), `来源：${home.from}${pathExists(dshHome) ? '' : '（目录不存在）'}`)
  homeLog.finish()
  if (!pathExists(dshHome)) warnings.push(`DSH_HOME 目录不存在：${dshHome}`)

  const resolved = resolveInstallRoot(warnings, steps)

  // 异步路由（注册表 / 运行中的进程）可能已经找到一个；别让同步路由把它盖成 null
  const cached = installRootCache
  const installRoot = resolved.root ?? cached?.value ?? null
  const installRootFrom = resolved.root ? resolved.from : installRoot ? (cached?.from ?? null) : null
  installRootCache = { value: installRoot, from: installRootFrom }

  const appDir = installRoot ? join(installRoot, 'resources', 'app') : null
  const desktopVersion = appDir ? readJsonVersion(join(appDir, 'package.json')) : null
  const runtimeVersion = appDir ? readJsonVersion(join(appDir, 'dsh', 'package.json')) : null

  let dshCliPath: string | null = null
  if (appDir) {
    const cli = join(appDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (pathExists(cli)) dshCliPath = cli
    else warnings.push('安装目录里没找到 dsh CLI 入口（resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js），「重启 DSH」可能不可用')
  }
  if (installRoot && !desktopVersion) {
    warnings.push('桌面端 package.json 读取失败，无法确定桌面端版本')
  }
  if (installRoot && !runtimeVersion) {
    warnings.push('随包 runtime package.json 读取失败，无法确定 runtime 版本')
  }

  const nodePath = resolveNodePath(steps)
  const pnpmPath = resolvePnpmPath(nodePath, steps)

  /* ★ 这里是「补全前置」的关键：DSH 随包那一份缺了不算完，插件台自带的那一份永远在。
     所以对外报的 nodePath / pnpmPath 一律是「真能跑起来的那一对」，
     界面上就不会再出现「缺 pnpm」这种用户无从下手的拦人话。
     同时把来源（dsh / bundled）带出去，让用户知道现在用的是谁。 */
  const runnable = getRunnableRuntime()
  const effectiveNode = runnable.nodePath || null
  const effectivePnpm = runnable.pnpmPath || null
  const runtimeSource: 'dsh' | 'bundled' | null =
    !effectiveNode || !effectivePnpm ? null : runnable.source === 'dsh' ? 'dsh' : 'bundled'

  if (!nodePath || !pnpmPath) {
    if (runnable.source === 'bundled' && effectiveNode && effectivePnpm) {
      /* 不是错误，是一条说明：用的是自带那份，功能完全可用 */
      warnings.push(
        '没用上 DSH 随包的 node / pnpm，已自动改用插件台自带的运行时（pnpm ' +
          `${runnable.version ?? '自带'}）—— 装插件、卸载、更新都照常可用`
      )
    } else if (!effectiveNode) {
      warnings.push('连插件台自带的运行时也没找到 —— 安装包可能被删过文件，重新安装一次插件台即可')
    }
  }

  const [nodeVersion, pnpmVersion] = await Promise.all([
    effectiveNode ? runVersion(effectiveNode, ['-v'], runnable.source === 'bundled') : Promise.resolve<string | null>(null),
    effectiveNode && effectivePnpm
      ? runVersion(effectiveNode, [effectivePnpm, '-v'], runnable.source === 'bundled')
      : Promise.resolve<string | null>(null)
  ])

  if (effectiveNode && !nodeVersion) warnings.push('Node 版本探测失败（执行 node -v 出错或超时）')
  if (effectivePnpm && !pnpmVersion) warnings.push('pnpm 版本探测失败（执行 pnpm -v 出错或超时）')

  return {
    dshHome,
    dshHomeFrom: home.from,
    installRoot,
    installRootFrom,
    discovery: clampDiscoverySteps(steps),
    desktopVersion,
    runtimeVersion,
    dshCliPath,
    nodePath: effectiveNode,
    nodeVersion,
    pnpmPath: effectivePnpm,
    pnpmVersion,
    runtimeSource,
    warnings
  }
}

/**
 * 带缓存的完整环境探测；invalidate() 后重算。
 * deep=true 时先跑一遍异步富化（注册表 / 进程 / WScript），再把两段轨迹拼起来 ——
 * 只有用户点「重新检测」这类显式动作才该走 deep，否则每次启动都要多等半秒。
 */
export async function getRuntimeInfo(opts?: { deep?: boolean }): Promise<RuntimeInfo> {
  if (opts?.deep) {
    infoCache = null
    const enriched = await enrichInstallRoot().catch(() => ({ root: null, from: null, steps: [] as DiscoveryStep[] }))
    const info = await getRuntimeInfo()
    return {
      ...info,
      installRoot: info.installRoot ?? enriched.root,
      installRootFrom: info.installRootFrom ?? (enriched.root ? enriched.from : null),
      discovery: clampDiscoverySteps([...info.discovery, ...enriched.steps])
    }
  }

  if (infoCache) return infoCache
  const p = buildRuntimeInfo()
  infoCache = p
  try {
    return await p
  } catch {
    infoCache = null
    return fallbackRuntimeInfo()
  }
}

/** 只取诊断轨迹（完整跑一遍同步路由 + 异步富化） */
export async function getDiscoverySteps(): Promise<DiscoveryStep[]> {
  const info = await getRuntimeInfo({ deep: true })
  return info.discovery
}

/* ------------------------------------------------------------------ *
 * profiles
 * ------------------------------------------------------------------ */

/** <dshHome>/profiles/<name> —— name 会做路径穿越清洗 */
export function getProfileDir(name: string): string {
  return join(getDshHome(), 'profiles', safeSegment(name))
}

/** 列出 profiles 下的目录名（读不到给空数组） */
export function listProfileNames(): string[] {
  try {
    const root = join(getDshHome(), 'profiles')
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => !!safeSegment(n))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 子进程环境
 * ------------------------------------------------------------------ */

function pathKeyName(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return 'PATH'
  for (const k of ['Path', 'PATH', 'path']) {
    if (typeof env[k] === 'string') return k
  }
  return 'Path'
}

/** 拼给 pnpm / node 子进程用的环境变量 */
export function buildChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const s = safeSettings()

  if (s.proxy) {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) {
      env[k] = s.proxy
    }
    env.NO_PROXY = 'localhost,127.0.0.1'
    env.no_proxy = 'localhost,127.0.0.1'
  }

  if (s.registry) env.npm_config_registry = s.registry

  const nodePath = resolveNodePath()
  const segments: string[] = []
  if (nodePath) segments.push(dirname(nodePath))

  const profileDir = typeof extra?.PROFILE_DIR === 'string' ? extra.PROFILE_DIR : ''
  if (profileDir) segments.push(join(profileDir, 'node_modules', '.bin'))

  const pathKey = pathKeyName(env)
  const existingPath = typeof env[pathKey] === 'string' ? (env[pathKey] as string) : ''
  const merged = [...segments, existingPath].filter((v) => !!v).join(delimiter)
  env[pathKey] = merged

  env.npm_config_yes = 'true'
  env.npm_config_fund = 'false'
  env.npm_config_audit = 'false'
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'

  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') env[k] = v
    }
  }

  return env
}
