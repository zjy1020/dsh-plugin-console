/**
 * dsh.ts —— 桌面端进程控制。
 *
 * 改完 profile 的 package.json / bundles 必须重启 DSH 才生效，这里就是那一刀：
 *   杀掉正在跑的桌面端（taskkill /IM <exe> /F，**不带 /T**）→ 等 1.5 秒 → detached 重新拉起。
 *
 * 为什么不带 /T：/IM 已经能命中全部同镜像名进程，而 /T 会额外把目标的子进程树一起杀 ——
 * 开发期插件台往往就是从 DSH 所在的 shell 里拉起来的，那样等于把自己的进程树一起砍了
 * （详见 dshproc.ts 的 killPids 与 docs/_log.md 第十节）。
 *
 * 失败一律降级成「让用户手动重启」，不抛异常。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import * as env from './env'

export interface RestartResult {
  ok: boolean
  message: string
}

/**
 * 安装根下的桌面端可执行文件名。
 *
 * 真实文件名**带空格**（`DeepSeek Harness.exe`，实测于 D:\Dowloads\DeepSeekHarness）。
 * 历史上这里只写了无空格的那一种，于是「先试精确名」这一步从来命中不了，一直靠下面的
 * 目录扫描兜底 —— 能跑，但等于把唯一的定位手段压在「目录里只有一个非 unins 的 exe」上。
 * 两种都留着：扫描只作为最后保险，不是主路径。
 */
const EXE_CANDIDATES = ['DeepSeek Harness.exe', 'DeepSeekHarness.exe'] as const
const RELAUNCH_DELAY_MS = 1500

/**
 * 明显不是主程序的：卸载器 / 辅助工具。
 *
 * 为什么单独写一条：真实卸载器叫 `Uninstall DeepSeek Harness.exe`（实测于
 * D:\Dowloads\DeepSeekHarness），旧代码只排除了 `unins` 前缀，
 * 一旦目录扫描兜底先撞上它，就会把卸载器当成主程序去 taskkill / 拉起 —— 后果是把用户装的东西卸掉。
 * 所以这里按 dshproc.ts 的口径把 uninstall / 卸载 / setup / installer 一并排掉。
 */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从安装根里找出桌面端可执行文件 */
function findExe(): string | null {
  let root: string | null = null
  try {
    root = env.getInstallRoot()
  } catch {
    root = null
  }
  if (!root) return null

  for (const candidate of EXE_CANDIDATES) {
    try {
      const direct = path.join(root, candidate)
      if (existsSync(direct) && isFile(direct)) return direct
    } catch {
      /* 继续试下一个候选名 */
    }
  }

  try {
    const entries = readdirSync(root)
    const exes: string[] = []
    for (const name of entries) {
      const lower = name.toLowerCase()
      if (!lower.endsWith('.exe')) continue
      if (isUninstallerLike(name)) continue /* 卸载器不算 */
      const full = path.join(root, name)
      if (isFile(full)) exes.push(name)
    }
    if (exes.length === 0) return null
    /* 名字里带 harness / deepseek / dsh 的最像主程序；都没有就按名字短的挑（主程序通常最短） */
    const preferred = exes.filter((n) => /harness|deepseek|dsh/i.test(n))
    const pool = preferred.length > 0 ? preferred : exes.slice().sort((a, b) => a.length - b.length)
    return path.join(root, pool[0] as string)
  } catch {
    /* 目录读不到 */
  }
  return null
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function killByName(exeName: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      /*
       * 这里的 `/IM`（按镜像名匹配）已经能一次命中 DSH 的全部进程 ——
       * 主进程、renderer、gpu、utility 跑的都是同一个 `DeepSeek Harness.exe`。
       * 所以**不要**再加 `/T`：`/T` 是「连这些进程的整棵子进程树一起砍」，
       * 而插件台在开发期就是从 DSH 的 shell 里被拉起来的，
       * 加了 `/T` 会把插件台自己也带走（现场：「退出 DSH」之后插件台窗口一起消失）。
       */
      const proc = spawn('taskkill', ['/IM', exeName, '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false
      })
      proc.on('error', () => resolve())
      proc.on('close', () => resolve())
      /* taskkill 卡住也别把上层吊死 */
      setTimeout(resolve, 5000)
    } catch {
      resolve()
    }
  })
}

function relaunch(exe: string): boolean {
  try {
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
      cwd: path.dirname(exe)
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * 重启 DSH 桌面端。
 * - 找不到 exe → ok:false，让用户手动重启；
 * - 杀掉失败不影响拉起（可能本来就没在跑）。
 */
export async function restartDsh(): Promise<RestartResult> {
  const exe = findExe()
  if (!exe) {
    return { ok: false, message: '没找到 DSH 桌面端可执行文件，请手动重启 DSH' }
  }

  const exeName = path.basename(exe)
  await killByName(exeName)
  await sleep(RELAUNCH_DELAY_MS)

  const launched = relaunch(exe)
  if (!launched) {
    return { ok: false, message: `没能拉起 ${exeName}，请手动重启 DSH` }
  }
  return { ok: true, message: '已重启 DSH' }
}

/** 只查不改：桌面端 exe 在哪（UI 的「打开安装目录」用得上） */
export function locateExe(): string | null {
  try {
    return findExe()
  } catch {
    return null
  }
}
