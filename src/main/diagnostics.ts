/**
 * main/diagnostics.ts —— 进程级诊断日志。
 *
 * 为什么需要它：这个应用被反馈过两次「莫名其妙自己退出了」，而 Electron 出错时
 * 要么什么都不打印（发布版没有控制台），要么只弹一个一闪而过的框。
 * 没有日志就只能靠猜，猜出来的结论不可能对。
 *
 * 落盘位置：<userData>/diag.log，超过 DIAG_MAX_BYTES 就截断重来（不做轮转，
 * 只保留最近一段 —— 排查现场要的是「刚才发生了什么」，不是三个月的历史）。
 *
 * 记什么：
 *   1. 启动时的进程信息与**祖先进程链**（回答「我是不是某个进程的子进程」，
 *      这直接决定了别人 taskkill /T 的时候会不会顺手把我带走）；
 *   2. 未捕获异常 / 未处理的 Promise 拒绝（带 stack）；
 *   3. 渲染进程与子进程消失（Electron 的 render-process-gone / child-process-gone，
 *      带 reason 与 exitCode —— 崩溃和被杀是两种不同的 reason）；
 *   4. 退出路径的每一步（before-quit / will-quit / 窗口 close / window-all-closed），
 *      用来区分「自己退的」和「被人杀的」。自己退的一定会留下整串轨迹，
 *      被人杀的那一串会在中途断掉 —— 断在哪就是死在哪。
 */

import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'

/** 单文件上限：1MB。超了直接重开，不做轮转。 */
const DIAG_MAX_BYTES = 1024 * 1024
/** 祖先链最多往上找几层，防止异常数据绕成环 */
const MAX_ANCESTORS = 8

let logPath: string | null = null
let installed = false

function resolveLogPath(): string | null {
  if (logPath) return logPath
  try {
    // app.getPath('userData') 在 ready 之前也能调，但目录可能还没建出来
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'diag.log')
  } catch {
    logPath = null
  }
  return logPath
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  )
}

/** 写一行诊断日志。**永不抛** —— 日志炸了不能把应用带走。 */
export function diag(tag: string, detail?: unknown): void {
  const path = resolveLogPath()
  if (!path) return
  let line = `${stamp()} [${tag}]`
  if (detail !== undefined) {
    let text: string
    if (detail instanceof Error) text = `${detail.name}: ${detail.message}\n${detail.stack ?? ''}`
    else if (typeof detail === 'string') text = detail
    else {
      try {
        text = JSON.stringify(detail)
      } catch {
        text = String(detail)
      }
    }
    line += ` ${text}`
  }
  line += '\n'
  try {
    try {
      if (statSync(path).size > DIAG_MAX_BYTES) writeFileSync(path, '', 'utf8')
    } catch {
      /* 文件还不存在，正常 */
    }
    appendFileSync(path, line, 'utf8')
  } catch {
    /* 磁盘满了 / 没权限：忽略，不能因为日志挂了就崩 */
  }
}

/**
 * 向上追一条进程链并写进日志。
 * 用 CIM 查 ParentProcessId（wmic 在新系统上已经被移除了，别用）。
 * 全异步、失败静默 —— 只是诊断信息，拿不到也不该影响启动。
 */
function logProcessTree(): void {
  const pid = process.pid
  const script =
    '$ErrorActionPreference="SilentlyContinue";' +
    '$map=@{};' +
    'Get-CimInstance Win32_Process | ForEach-Object { $map[[int]$_.ProcessId]=@($_.ParentProcessId,$_.Name) };' +
    `$cur=${pid}; $out=@();` +
    `for($i=0;$i -lt ${MAX_ANCESTORS};$i++){` +
    '  if(-not $map.ContainsKey($cur)){break};' +
    '  $e=$map[$cur]; $out+="$cur=$($e[1])"; $next=[int]$e[0];' +
    '  if($next -le 0 -or $next -eq $cur){break}; $cur=$next };' +
    '$out -join " <- "'

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      if (err) {
        diag('proc-tree', `查询祖先链失败：${err.message}`)
        return
      }
      diag('proc-tree', `本进程 PID=${pid}；祖先链（本进程 <- 父 <- 祖父 …）：${stdout.trim()}`)
    }
  )
}

/** 装好所有诊断钩子。重复调用只生效一次。 */
export function installDiagnostics(): void {
  if (installed) return
  installed = true

  diag('boot', `pid=${process.pid} ppid=${process.ppid} electron=${process.versions.electron} ` +
    `node=${process.versions.node} packaged=${app.isPackaged} argv=${JSON.stringify(process.argv.slice(1))}`)
  logProcessTree()

  process.on('uncaughtException', (err) => {
    diag('uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    diag('unhandledRejection', reason instanceof Error ? reason : String(reason))
  })

  // 崩溃 vs 被杀：reason 会明确告诉我们是 'crashed' / 'oom' / 'killed' / 'clean-exit'
  app.on('render-process-gone', (_e, _contents, details) => {
    diag('render-process-gone', details)
  })
  app.on('child-process-gone', (_e, details) => {
    diag('child-process-gone', details)
  })

  app.on('before-quit', () => diag('before-quit', '应用开始退出'))
  app.on('will-quit', () => diag('will-quit', '退出前最后一站'))
  app.on('window-all-closed', () => diag('window-all-closed', '所有窗口已关闭'))
  app.on('quit', (_e, code) => diag('quit', `退出完成，code=${code}`))

  diag('boot', '诊断钩子已安装')
}

/** 给其它模块用的便捷入口：窗口的创建/关闭/隐藏也值得记一笔 */
export function diagPath(): string | null {
  return resolveLogPath()
}

/** 日志文件所在目录（设置面板里要能一键打开它） */
export function diagDir(): string | null {
  const p = resolveLogPath()
  return p ? dirname(p) : null
}
