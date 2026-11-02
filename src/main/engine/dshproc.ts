/**
 * engine/dshproc.ts —— DSH 桌面端的进程状态探测与启停。
 *
 * 为什么不用 Electron 的 app.relaunch：插件装完要重启的是**被管理的那个 DSH**，
 * 也就是装在 `env.getInstallRoot()`（用户机器上 D:\Dowloads\DeepSeekHarness）里的
 * 那个桌面端，跟当前跑这个插件台的进程没有父子关系，只能靠 exe 路径找、靠 taskkill 关。
 *
 * 三个坑：
 *   1. exe 名带空格（`DeepSeek Harness.exe`），比路径字符串更稳；
 *   2. 环境里可能残留 `ELECTRON_RUN_AS_NODE`，会让 Electron 退化成纯 Node 启动，
 *      必须从子进程 env 里显式删掉；
 *   3. 所有对外函数都不许抛 —— 界面层拿不到结果比拿到「失败」更糟。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import * as env from './env'
import { diag } from '../diagnostics'

import type { DshActionResult, DshStatus } from '../../shared/types'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const TASKLIST = 'tasklist.exe'
const TASKKILL = 'taskkill.exe'
const POWERSHELL = 'powershell.exe'

/** 启动后确认进程真的起来的轮询参数 */
const START_POLL_INTERVAL_MS = 500
const START_POLL_TIMEOUT_MS = 15000
/** 强杀后等待进程消失 */
const FORCE_WAIT_MS = 1500
/** 子进程输出上限，防止 tasklist 输出撑爆内存 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** exe 探测结果缓存：同一个 installRoot 只扫一次目录 */
const exeCache = new Map<string, string | null>()

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function textOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ *
 * exe 定位
 * ------------------------------------------------------------------ */

/** 明显不是主程序的：卸载器 / 辅助工具 / 非 exe */
function isUninstallerLike(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.startsWith('unins') ||
    lower.includes('uninstall') ||
    lower.includes('卸载') ||
    lower.includes('setup') ||
    lower.includes('installer')
  )
}

/**
 * 在 installRoot 根目录里挑主可执行文件。
 * 规则：只看根目录（不递归进 resources\，那里是 electron.exe 之类），
 * 排除卸载器，优先名字里带 Harness / DeepSeek / DSH 的，最后退到体积最大的那个。
 */
function pickExeFile(files: string[]): string | null {
  const exes = files.filter(
    (f) => f.toLowerCase().endsWith('.exe') && !isUninstallerLike(f)
  )
  if (exes.length === 0) return null

  const preferred = exes.filter((f) => /harness|deepseek|dsh/i.test(f))
  const pool = preferred.length > 0 ? preferred : exes
  // 名字短的更可能是主程序，多候选时优先短名
  pool.sort((a, b) => a.length - b.length)
  return pool[0] ?? null
}

/** 拿 exe 绝对路径；找不到返回 null。永不抛。 */
function locateExePath(): string | null {
  let installRoot: string | null = null
  try {
    installRoot = env.getInstallRoot()
  } catch {
    installRoot = null
  }
  if (!installRoot) return null

  const cached = exeCache.get(installRoot)
  if (cached !== undefined) {
    // 找到过且文件还在 → 直接复用；没找到过 → 也复用（别每次 status 都扫目录）
    if (cached === null || existsSync(cached)) return cached
    // 文件被删了，丢缓存重扫
    exeCache.delete(installRoot)
  }

  let picked: string | null = null
  try {
    if (existsSync(installRoot)) {
      const entries = readdirSync(installRoot, { withFileTypes: true })
      const files = entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name)
      picked = pickExeFile(files)

      // 目录里没有？那就认「和安装目录同名」的那个 exe 兜底
      if (!picked) {
        const dirBase = basename(installRoot).toLowerCase()
        const same = files.find(
          (f) => f.toLowerCase() === `${dirBase}.exe` && !isUninstallerLike(f)
        )
        picked = same ?? null
      }
    }
  } catch {
    picked = null
  }

  const full = picked ? join(installRoot, picked) : null
  exeCache.set(installRoot, full)
  return full
}

/** 带缓存地对外暴露（供下方 status 使用） */
export function exePath(): string | null {
  return locateExePath()
}

/** env.getInstallRoot() 的永不抛版本 —— 探测代码出错不该把进程控制一起带崩 */
function safeInstallRoot(): string | null {
  try {
    return env.getInstallRoot()
  } catch {
    return null
  }
}

/* 这里原来有个 safeCheckRuntime()：env.checkRuntime() 的永不抛包装。
 * 「启动 DSH」这条路上唯一的失败原因其实是「找不到桌面端 exe」，
 * 它由 start() 里直接读 before.installRoot / before.exePath 说清，
 * 不需要再借运行时的口径 —— 借过来反而会说成「缺 Node 运行时」。
 * 留着这个没人调的函数只会让下一个人以为启动还要过运行时预检，所以删掉。 */

/* ------------------------------------------------------------------ *
 * 进程枚举
 * ------------------------------------------------------------------ */

interface ProcList {
  pids: number[]
  /** 从列表里看到的、匹配到目标 exe 的可执行文件名 */
  imageName: string | null
}

/** 跑一个命令并把 stdout 收全；失败/超时返回 null，永不抛 */
function runCapture(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | null = null
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (value: { code: number | null; stdout: string } | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      resolve(value)
    }

    try {
      child = spawn(file, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      finish(null)
      return
    }

    let out = ''
    let oversized = false

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (oversized) return
      out += chunk
      if (out.length > MAX_OUTPUT_BYTES) {
        oversized = true
        out = ''
      }
    })

    timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        /* 忽略 */
      }
      finish(null)
    }, timeoutMs)

    child.once('error', () => finish(null))
    child.once('close', (code) => finish({ code, stdout: out }))
  })
}

/** 用 tasklist 解析 CSV，找 Image Name 等于 target 的 PID */
async function pidsViaTasklist(target: string): Promise<ProcList> {
  const res = await runCapture(TASKLIST, ['/FO', 'CSV', '/NH'], 10000)
  if (!res || !res.stdout) return { pids: [], imageName: null }

  const want = target.toLowerCase()
  const pids: number[] = []
  const seen = new Set<number>()
  let matchedName: string | null = null

  for (const line of res.stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    // "DeepSeek Harness.exe","35524","Console","1","234,136 K"
    const cols = t.split('","')
    if (cols.length < 2) continue
    const name = cols[0]!.replace(/^"/, '').replace(/"$/, '')
    if (name.toLowerCase() !== want) continue
    const pidStr = cols[1]!.replace(/"/g, '').replace(/,/g, '').trim()
    const pid = Number(pidStr)
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue
    seen.add(pid)
    pids.push(pid)
    matchedName = name
  }

  return { pids, imageName: matchedName }
}

/** PowerShell 兜底：Get-Process -Name '<basename（去 .exe）>' */
async function pidsViaPowerShell(target: string): Promise<ProcList> {
  const procName = target.replace(/\.exe$/i, '').replace(/'/g, "''")
  const script = `Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
  const res = await runCapture(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    10000
  )
  if (!res || !res.stdout) return { pids: [], imageName: null }

  const pids: number[] = []
  const seen = new Set<number>()
  for (const line of res.stdout.split(/\r?\n/)) {
    const pid = Number(line.trim())
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue
    seen.add(pid)
    pids.push(pid)
  }
  return { pids, imageName: pids.length > 0 ? target : null }
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

/** 读一次状态。**绝不抛**。 */
export async function status(): Promise<DshStatus> {
  let installRoot: string | null = null
  try {
    installRoot = env.getInstallRoot()
  } catch {
    installRoot = null
  }

  const target = locateExePath()
  const base: DshStatus = {
    running: false,
    pids: [],
    exePath: target,
    installRoot,
    checkedAt: Date.now()
  }

  if (!target) return base

  const imageName = basename(target)

  let list: ProcList = { pids: [], imageName: null }
  try {
    list = await pidsViaTasklist(imageName)
  } catch {
    list = { pids: [], imageName: null }
  }

  if (list.pids.length === 0) {
    try {
      const alt = await pidsViaPowerShell(imageName)
      if (alt.pids.length > 0) list = alt
    } catch {
      /* 兜底也失败就维持空列表 */
    }
  }

  const pids = list.pids.slice().sort((a, b) => a - b)
  return {
    running: pids.length > 0,
    pids,
    exePath: target,
    installRoot,
    checkedAt: Date.now()
  }
}

/* ------------------------------------------------------------------ *
 * 子进程 env
 * ------------------------------------------------------------------ */

/**
 * 构造给 DSH 用的环境变量副本。
 * 关键：删掉 ELECTRON_RUN_AS_NODE —— 有它在，Electron 会被当成纯 Node 跑，
 * 界面永远出不来（我们踩过这个坑）。再顺手清掉几个会干扰的 Electron 变量。
 */
export function childEnvForDsh(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  delete out['ELECTRON_RUN_AS_NODE']
  delete out['ELECTRON_NO_ATTACH_CONSOLE']
  delete out['ELECTRON_FORCE_IS_PACKAGED']
  delete out['ELECTRON_ENABLE_LOGGING']
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out[k] = v
  }
  return out
}

/* ------------------------------------------------------------------ *
 * start / stop
 * ------------------------------------------------------------------ */

function resultOf(ok: boolean, message: string, st: DshStatus): DshActionResult {
  return { ok, message, status: st }
}

/** 轮询等到进程出现，或超时 */
async function waitUntilRunning(timeoutMs: number): Promise<DshStatus | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const st = await status()
    if (st.running) return st
    if (Date.now() >= deadline) return null
    await sleep(START_POLL_INTERVAL_MS)
  }
}

/** 轮询等到进程消失，或超时 */
async function waitUntilStopped(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const st = await status()
    if (!st.running) return true
    if (Date.now() >= deadline) return false
    await sleep(START_POLL_INTERVAL_MS)
  }
}

export async function start(): Promise<DshActionResult> {
  /*
   * 先补一刀异步探测。
   *
   * 为什么：同步路由（env.ts 的 installRootCandidates）只能靠命名约定猜 —— 设置、环境变量、
   * 提示文件、几个常见目录名。全新电脑上这些全落空，而**注册表与运行中的进程是当场就有的**
   * （安装器写进去的 DisplayName/InstallLocation/UninstallString）。它们是异步的（要起进程），
   * 所以放在这里：start() 本来就是 async，用户点「启动」也不在乎多花几百毫秒。
   * 只在「自己没拿到根」时才跑 —— 手上有就没必要再拉 PowerShell。
   */
  if (!safeInstallRoot()) {
    try {
      await env.enrichInstallRoot()
      env.invalidate()
      exeCache.clear()
    } catch {
      /* 探测失败不改变行为：下面照样报「找不到」并给出设置入口 */
    }
  }

  const before = await status()
  if (before.running) {
    return resultOf(true, `DSH 已经在运行（PID ${before.pids.join('、')}）`, before)
  }

  const target = before.exePath
  if (!target || !existsSync(target)) {
    const shown = target ?? (before.installRoot ? join(before.installRoot, '<未找到 .exe>') : '<安装目录未知>')
    /* ★ 这里是**唯一**真正需要安装根的地方，所以文案必须只谈安装根。
     *   以前这里借了 checkRuntime() 的 message/fix —— 那条现在只谈 node/pnpm
     *   （因为装插件只需要 .dsh），借过来就会说成「缺 Node 运行时」，
     *   而用户真正缺的是桌面端装在哪。两件事分开说，别互相借文案。
     * 三种情形三种出路，别用一句话糊弄：
     *   ① 填了目录、目录里没扫到 exe → 「选程序文件」一步到位（防呆极限形态）
     *   ② 连目录都没有 → 同上，直接选程序文件比理解「安装根」快得多
     *   ③ 目录都没有且用户不想指 → 手动打开 DSH 永远是保底 */
    const fix = before.installRoot
      ? '那个目录里没找到 DeepSeek Harness 的程序文件（exe）。最稳的办法：设置里点「选程序文件…」，直接指到 DeepSeek Harness.exe —— 不用管目录结构长什么样。'
      : '到设置里点「选程序文件…」直接指到 DeepSeek Harness.exe（或者把「安装根」指到它的安装目录），也可以先手动打开 DSH。'
    return resultOf(false, `找不到 DSH 可执行文件：${shown}。${fix}`, before)
  }

  const cwd = before.installRoot ?? undefined

  try {
    const child = spawn(target, [], {
      detached: true,
      stdio: 'ignore',
      cwd,
      windowsHide: false,
      env: childEnvForDsh()
    })
    child.unref()
  } catch (err) {
    const after = await status()
    return resultOf(false, `启动 DSH 失败：${textOf(err)}`, after)
  }

  const st = await waitUntilRunning(START_POLL_TIMEOUT_MS)
  if (st) {
    return resultOf(true, 'DSH 已启动', st)
  }
  const after = await status()
  return resultOf(false, '进程已拉起，但 15 秒内没检测到它在运行', after)
}

/**
 * taskkill 一批 PID；单个失败不影响其它，永不抛。
 *
 * ⚠ 三条硬约束，每条都是事故换来的：
 *
 * 1. **绝不加 `/T`**。`/T` 会连目标的整棵子进程树一起砍，而插件台在开发期是从 DSH
 *    的 shell 里被拉起来的 —— **插件台自己就是 DSH 的后代**，于是「退出 DSH」会顺手
 *    把插件台一起砍了（现场：点完退出，插件台窗口消失，日志里退出轨迹中途断掉）。
 *    去掉 `/T` 也能杀干净：DSH 的主进程、renderer、gpu、utility 全都跑在同一个镜像名
 *    `DeepSeek Harness.exe` 下，重新枚举镜像名补刀即可。
 *
 * 2. **一律带 `/F`**。不带 `/F` 时 taskkill 只是给有窗口的进程投一个 WM_CLOSE，实测对
 *    Electron 完全无效 —— 五个 PID「已执行」之后 `tasklist` 里一个都没少（2026-11-02
 *    17:10 现场），而它发出的控制台控制事件却是 `0xC000013A`（STATUS_CONTROL_C_EXIT）
 *    的来源，会把共享同一个控制台的进程一起带走。`/F` 走 TerminateProcess，没有这种
 *    连带副作用。
 *
 * 3. **先杀子进程，最后杀主进程**。PID 由小到大基本就是启动顺序（主进程最小），所以
 *    这里倒序打。让 DSH 的子进程先没，主进程最后走，它的退出逻辑就没机会再去做别的事。
 */
async function killPids(pids: number[]): Promise<void> {
  const order = pids.slice().sort((a, b) => b - a) /* 子进程（PID 大）先，主进程最后 */
  for (const pid of order) {
    // 双保险：任何情况下都不对自己、也不对直接父进程下手
    if (pid === process.pid || pid === process.ppid) {
      diag('stop', `跳过自身/父进程 PID ${pid}`)
      continue
    }
    const args = ['/PID', String(pid), '/F']
    try {
      const res = await runCapture(TASKKILL, args, 10000)
      diag('stop', `taskkill ${args.join(' ')} 已执行（exit=${String(res?.code ?? '?')}）`)
    } catch (err) {
      diag('stop', `taskkill ${args.join(' ')} 失败：${textOf(err)}`)
    }
  }
}

export async function stop(): Promise<DshActionResult> {
  const before = await status()
  if (!before.running) {
    return resultOf(true, 'DSH 本来就没在运行', before)
  }

  const pids = before.pids.slice()
  const listed = pids.join('、')
  diag('stop', `开始退出 DSH；exe ${before.exePath ?? '?'}；PID ${listed}`)

  /*
   * 直接强杀，不再有「优雅」那一刀。
   *
   * 原来是 `taskkill /PID <pid>`（不带 /F）先试一次优雅关闭，实测有两个问题：
   *   1. 对 Electron 根本无效 —— 五个 PID 全部「已执行」，`tasklist` 里一个都没少；
   *   2. 它会发出控制台控制事件，把共享控制台的进程一起带走（`0xC000013A`）。
   * 于是那一刀既没用又有副作用，删掉。DSH 没有提供「请优雅退出」的 IPC，能做的只有
   * 让它尽快死透，然后告诉用户「未保存的会话可能丢失」。
   */
  for (let round = 1; round <= 3; round += 1) {
    const left = (await status()).pids
    if (left.length === 0) break
    diag('stop', `第 ${round} 轮强杀：PID ${left.join('、')}`)
    await killPids(left)
    const gone = await waitUntilStopped(FORCE_WAIT_MS)
    diag('stop', `第 ${round} 轮结束：${gone ? '已全部退出' : '仍有残留，继续'}`)
    if (gone) break
  }

  const after = await status()
  if (!after.running) {
    diag('stop', '已强制结束，无残留')
    return resultOf(true, `DSH 已退出（PID ${listed}）；未保存的会话可能丢失`, after)
  }
  diag('stop', `退出失败，残留 PID ${after.pids.join('、')}`)
  return resultOf(
    false,
    `没能结束 DSH 进程（还活着：PID ${after.pids.join('、')}），可能需要管理员权限`,
    after
  )
}

/* ------------------------------------------------------------------ *
 * watch
 * ------------------------------------------------------------------ */

/** 模块级单例：热重载时重复调用 watch 只能有一个 interval */
let watchTimer: NodeJS.Timeout | null = null
let lastRunning: boolean | null = null
let lastPidsKey = ''

/**
 * 轮询状态。只有 `running` 或 `pids` 真的变了才回调 —— 否则界面每 4 秒重渲染一次。
 * 返回一个取消函数。重复调用会先把旧的清掉。
 */
export function watch(cb: (s: DshStatus) => void, intervalMs = 4000): () => void {
  if (watchTimer !== null) {
    clearInterval(watchTimer)
    watchTimer = null
  }

  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : 4000

  const tick = async (): Promise<void> => {
    let st: DshStatus
    try {
      st = await status()
    } catch {
      /* status 自己不该抛；真抛了也保持 interval 存活，等下一轮 */
      return
    }
    const key = st.pids.join(',')
    if (lastRunning === st.running && lastPidsKey === key) return
    lastRunning = st.running
    lastPidsKey = key
    try {
      cb(st)
    } catch {
      /* 回调自己炸了不该拖垮轮询 */
    }
  }

  /* 先立刻推一次，界面不用等一个周期 */
  lastRunning = null
  lastPidsKey = ''
  void tick()

  watchTimer = setInterval(() => {
    /* 用 promise 包一层：哪怕 status() 抛错，interval 也不受影响 */
    void (async () => {
      try {
        await tick()
      } catch {
        /* 忽略 */
      }
    })()
  }, period)

  /* interval 不该拖住进程退出 */
  if (typeof watchTimer.unref === 'function') watchTimer.unref()

  return (): void => {
    if (watchTimer !== null) {
      clearInterval(watchTimer)
      watchTimer = null
    }
  }
}
