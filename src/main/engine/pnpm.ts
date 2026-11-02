/**
 * pnpm.ts —— 子进程执行层。
 *
 * 只负责「把一条命令跑起来、把输出变成行、把句柄交出去」这一件事：
 *   - node / pnpm 一律用 DSH 自带 runtime（env.getNodePath / getPnpmPath），不走系统 PATH；
 *   - 逐块 utf8 解码后按 /\r?\n/ 切行，pnpm 的 \r 进度条也会被切开；
 *   - 每个运行中的句柄登记到 opId，供 ops.cancelOp 取消；
 *   - 超时（默认 10 分钟）Windows 下先 taskkill /T /F 再 child.kill()。
 *
 * 任何异常都不外抛：spawn 失败 / ENOENT / 找不到 runtime → done 以 code -1 收尾。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

import * as env from './env'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface RunHandle {
  opId: string
  cmdline: string
  kill(): void
  done: Promise<{ code: number | null; log: string }>
}

export interface RunOpts {
  cwd: string
  /** 归属的操作 id；传了就以此登记句柄，ops.cancelOp 靠它找到运行中的进程 */
  opId?: string
  onLine?: (line: string, channel: 'stdout' | 'stderr') => void
  onSpawn?: (cmdline: string) => void
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

interface HandleEntry {
  handle: RunHandle
  proc: ChildProcess | null
  killed: boolean
  close(): void
}

/* ------------------------------------------------------------------ *
 * 常量 / 模块级状态
 * ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_LOG_CHARS = 2_000_000
const MAX_LINE_CHARS = 32_000

/** 运行中的句柄表：key = `${opId}##${seq}`（同一 op 串行跑多次也不互相覆盖） */
const handles = new Map<string, HandleEntry>()

let seq = 0

function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function quoteIfNeeded(s: string): string {
  if (s === '') return '""'
  return /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

function makeCmdline(file: string, args: string[]): string {
  return [file, ...args].map(quoteIfNeeded).join(' ')
}

/* ------------------------------------------------------------------ *
 * 分级 / 切行
 * ------------------------------------------------------------------ */

class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private buf = ''

  constructor(private readonly sink: (line: string) => void) {}

  push(chunk: Buffer): string {
    this.buf += this.decoder.write(chunk)
    return this.drain()
  }

  /** 流结束时把残留缓冲吐干净（decoder.end() 会补齐被截断的多字节字符） */
  flush(): string {
    this.buf += this.decoder.end()
    return this.drain()
  }

  private drain(): string {
    let emitted = ''
    let idx = this.buf.search(/\r\n|\r|\n/)
    while (idx >= 0) {
      const raw = this.buf.slice(0, idx)
      const nlLen = this.buf.startsWith('\r\n', idx) ? 2 : 1
      this.buf = this.buf.slice(idx + nlLen)
      const text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…[行过长，已截断]` : raw
      emitted += `${text}\n`
      this.sink(text)
      idx = this.buf.search(/\r\n|\r|\n/)
    }
    return emitted
  }

  /** 进程结束但流没收到尾换行时，把最后一段当成一行 */
  tail(): string {
    const rest = this.buf
    this.buf = ''
    if (!rest) return ''
    this.sink(rest)
    return `${rest}\n`
  }
}

/* ------------------------------------------------------------------ *
 * 核心：spawn
 * ------------------------------------------------------------------ */

function spawnProcess(cmd: string, args: string[], opts: RunOpts): RunHandle {
  /* 句柄键 = `<opId>##<seq>`；同一个操作的多次串行命令不会互相覆盖 */
  const opId = opts.opId && opts.opId.trim() !== '' ? opts.opId : nextId('run')
  seq += 1
  const entryKey = `${opId}##${seq}`
  const cmdline = makeCmdline(cmd, args)

  /* runtime 缺失 → 不 spawn，直接以 -1 收尾 */
  if (!cmd || !existsSync(cmd)) {
    /* cmd 是 node（pnpm 是它的参数），所以这里缺的一般是 node；名字里带 pnpm 的才按 pnpm 报 */
    const what: 'node' | 'pnpm' = /pnpm/i.test(cmd ?? '') ? 'pnpm' : 'node'
    const lines = runtimeMissingLines(what, cmd)
    const short = lines[0] ?? '运行环境不可用'
    try {
      for (const line of lines) opts.onLine?.(line, 'stderr')
    } catch {
      /* 日志回调自身的异常不向外扩散 */
    }
    const handle: RunHandle = {
      opId,
      cmdline,
      kill(): void {},
      done: Promise.resolve({ code: -1, log: short })
    }
    return handle
  }

  try {
    opts.onSpawn?.(cmdline)
  } catch {
    /* 忽略回调异常 */
  }

  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS

  let child: ChildProcess | null = null
  let chunks: string[] = []
  let logLen = 0
  let timedOut = false
  let finished = false
  let exitCode: number | null = null
  let errorText: string | null = null
  let timer: NodeJS.Timeout | null = null

  const pushLog = (text: string): void => {
    if (!text) return
    if (logLen < MAX_LOG_CHARS) {
      chunks.push(text)
      logLen += text.length
    }
  }

  const logText = (): string => chunks.join('\n')

  let settle: (v: { code: number | null; log: string }) => void = () => {}
  const done = new Promise<{ code: number | null; log: string }>((resolve) => {
    settle = resolve
  })

  const finish = (code: number | null): void => {
    if (finished) return
    finished = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    handles.delete(entryKey)
    const text = logText()
    chunks = []
    logLen = 0
    settle({ code, log: text })
  }

  const kill = (): void => {
    const proc = child
    if (!proc || finished) return
    /* Windows：连子孙进程一起干掉，避免 pnpm 留下孤儿 node 进程占着 node_modules */
    if (process.platform === 'win32' && typeof proc.pid === 'number' && proc.pid > 0) {
      try {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          shell: false
        })
        killer.on('error', () => {})
      } catch {
        /* 落回 child.kill() */
      }
    }
    try {
      proc.kill()
    } catch {
      /* 已经死了 */
    }
  }

  try {
    child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err)
    pushLog(errorText)
    finish(-1)
    return { opId, cmdline, kill, done }
  }

  const emit = (line: string, channel: 'stdout' | 'stderr'): void => {
    try {
      opts.onLine?.(line, channel)
    } catch {
      /* 忽略 */
    }
  }

  const outSplitter = new LineSplitter((line) => {
    pushLog(line)
    emit(line, 'stdout')
  })
  const errSplitter = new LineSplitter((line) => {
    pushLog(line)
    emit(line, 'stderr')
  })

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer | string) => {
      pushLog(outSplitter.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    })
    child.stdout.on('error', () => {})
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      pushLog(errSplitter.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    })
    child.stderr.on('error', () => {})
  }

  child.on('error', (err: Error) => {
    errorText = err instanceof Error ? err.message : String(err)
    pushLog(`\n[进程启动失败] ${errorText}`)
    emit(`[进程启动失败] ${errorText}`, 'stderr')
    finish(-1)
  })

  child.on('close', (code) => {
    exitCode = typeof code === 'number' ? code : exitCode
    pushLog(outSplitter.flush())
    pushLog(outSplitter.tail())
    pushLog(errSplitter.flush())
    pushLog(errSplitter.tail())
    if (errorText) {
      finish(-1)
      return
    }
    finish(timedOut ? -1 : exitCode)
  })

  timer = setTimeout(() => {
    timedOut = true
    pushLog('')
    pushLog('[超时，已终止]')
    emit('[超时，已终止]', 'stderr')
    kill()
    /* 进程被打死后 close 事件会兜底 finish；taskkill 卡住时 3 秒强收 */
    setTimeout(() => finish(-1), 3000)
  }, timeoutMs)
  if (timer.unref) timer.unref()

  const entry: HandleEntry = {
    handle: { opId, cmdline, kill, done },
    proc: child,
    killed: false,
    close(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
  entry.handle.kill = (): void => {
    entry.killed = true
    kill()
  }
  handles.set(entryKey, entry)

  return entry.handle
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/** 用 DSH 自带 node 跑一个脚本（入口文件必须是绝对路径） */
export function runNode(args: string[], opts: RunOpts): RunHandle {
  const nodePath = safeNodePath()
  if (!nodePath) {
    return missingRuntime(runtimeMissingLines('node'), opts)
  }
  return spawnProcess(nodePath, args, opts)
}

/** 找 pnpm 入口：优先 DSH 随包，其次插件台自带。没有就返回 null */
export function getPnpmEntry(): string | null {
  try {
    const rt = env.getRunnableRuntime()
    return rt.pnpmPath || null
  } catch {
    return null
  }
}

/**
 * 用可用的 node 跑 pnpm.cjs；默认带 --reporter=append-only（调用方已有 --reporter 时不重复加）。
 *
 * ★ 运行时不再只认 DSH 随包那一份。`env.getRunnableRuntime()` 会先给 DSH 的，
 *   没有就退回**插件台自带的**：electron.exe（在 ELECTRON_RUN_AS_NODE=1 下就是 node）
 *   + resources/pnpm。后者在安装包里，永远不会缺 —— 这才叫「补全前置」。
 *   走自带那条时必须把 ELECTRON_RUN_AS_NODE=1 塞进子进程环境，否则 electron.exe
 *   会去开一个窗口而不是跑脚本（表现为「什么也没发生，也没有输出」）。
 */
export function runPnpm(args: string[], opts: RunOpts): RunHandle {
  const rt = safeRunnable()
  const nodePath = rt?.nodePath || ''
  const pnpmPath = rt?.pnpmPath || ''
  if (!nodePath || !pnpmPath) {
    /* 先说清缺的是 node 还是 pnpm —— 这两件事的修法不一样 */
    return missingRuntime(runtimeMissingLines(nodePath ? 'pnpm' : 'node'), opts)
  }
  /* ★ 顺序是 `node <pnpm.cjs> --reporter=... <args>`，flag 必须落在脚本**之后**。
   *   以前写成 withReporter([pnpmPath, ...args]) —— pnpmPath 是个非选项参数，
   *   withReporter 于是把 flag 插到它前面，变成 `node --reporter=append-only pnpm.cjs`，
   *   而 --reporter 是 node 自己的选项（值只有 TAP/spec/dot 之类），
   *   node 直接报 `bad option: --reporter=append-only` 并以 exit 9 退出。
   *   现象是**所有安装都失败、耗时 71ms**，看起来像环境没配好，其实是参数位置错了。 */
  const finalArgs = [pnpmPath, ...withReporter(args)]
  const baseEnv = childEnv(opts)
  const env2 = rt?.source === 'bundled' ? { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' } : baseEnv
  return spawnProcess(nodePath, finalArgs, { ...opts, env: env2 })
}

/** getRunnableRuntime 的安全版（探测异常时返 null，不把异常抛给 UI） */
function safeRunnable(): ReturnType<typeof env.getRunnableRuntime> | null {
  try {
    return env.getRunnableRuntime()
  } catch {
    return null
  }
}

/** 任意命令（dsh.ts 的 taskkill 等） */
export function runCommand(cmd: string, args: string[], opts: RunOpts): RunHandle {
  return spawnProcess(cmd, args, { ...opts, env: opts.env ?? process.env })
}

/** 按 opId 找运行中的句柄（可能不止一个）—— ops.cancelOp 用 */
export function getHandles(opId: string): RunHandle[] {
  if (!opId) return []
  const out: RunHandle[] = []
  for (const [key, entry] of handles) {
    if (key === opId || key.startsWith(`${opId}##`)) out.push(entry.handle)
  }
  return out
}

/** 按 opId 取第一个运行中的句柄（兼容单命令场景） */
export function getHandle(opId: string): RunHandle | null {
  const all = getHandles(opId)
  return all.length > 0 ? all[0] : null
}

/** 直接按 opId 取消（该操作下所有在跑的进程），返回是否真的命中了 */
export function killOp(opId: string): boolean {
  const list = getHandles(opId)
  if (list.length === 0) return false
  let hit = false
  for (const handle of list) {
    try {
      handle.kill()
      hit = true
    } catch {
      /* 这个句柄没杀成，继续下一个 */
    }
  }
  return hit
}

/** 当前在跑的操作 id（去重） */
export function runningOpIds(): string[] {
  const seen = new Set<string>()
  for (const key of handles.keys()) {
    const idx = key.lastIndexOf('##')
    seen.add(idx > 0 ? key.slice(0, idx) : key)
  }
  return Array.from(seen)
}

/** 进程被外部强杀（Electron 退出）时统一清场 */
export function killAll(): void {
  for (const entry of Array.from(handles.values())) {
    try {
      entry.handle.kill()
    } catch {
      /* 忽略 */
    }
    try {
      entry.close()
    } catch {
      /* 忽略 */
    }
  }
  handles.clear()
}

/* ------------------------------------------------------------------ *
 * 内部小工具
 * ------------------------------------------------------------------ */

function safeNodePath(): string | null {
  try {
    return env.getNodePath() || null
  } catch {
    return null
  }
}

/** runPnpm 的默认 env：buildChildEnv() + PROFILE_DIR */
function childEnv(opts: RunOpts): NodeJS.ProcessEnv {
  if (opts.env) return opts.env
  try {
    return env.buildChildEnv({ PROFILE_DIR: opts.cwd })
  } catch {
    return { ...process.env, PROFILE_DIR: opts.cwd }
  }
}

/**
 * runtime 缺失时的两条日志。
 *
 * 为什么要分两句：面板里只该出现一句能行动的短句（缺的是哪一环），
 * 日志里则必须能直接看出「期望的 node / pnpm 路径、安装根、cmd」——
 * 排障时不用再回头问用户「你那边到底装了没」。
 * 旧文案「找不到 DSH 自带的 node/pnpm，请到设置里指定安装根」把两件事混成一句话，
 * 用户照着「指定安装根」做也没用（node/pnpm 是从 DSH_HOME\dsh-runtimes 找的，与安装根无关）。
 */
function runtimeMissingLines(what: 'node' | 'pnpm', cmd?: string): string[] {
  let check: env.RuntimeCheck | null = null
  let nodePath: string | null = null
  let pnpmPath: string | null = null
  let installRoot: string | null = null
  try {
    check = env.checkRuntime()
  } catch {
    check = null
  }
  try {
    nodePath = env.getNodePath() || null
  } catch {
    nodePath = null
  }
  try {
    pnpmPath = env.getPnpmPath() || null
  } catch {
    pnpmPath = null
  }
  try {
    installRoot = env.getInstallRoot()
  } catch {
    installRoot = null
  }

  const known = what === 'node' ? !!nodePath : !!pnpmPath
  let short: string
  if (!known && check && check.missing === what) {
    short = check.message
  } else if (!known) {
    short = what === 'node' ? '没找到随包的 Node 运行时' : '没找到 pnpm 入口'
  } else if (cmd) {
    short = `${what} 的可执行文件不见了：${cmd}`
  } else {
    short = `拿不到 ${what} 的可执行路径`
  }

  const detail =
    `[runtime] 缺的是 ${what}；期望 node=${nodePath ?? '(未找到)'}；期望 pnpm=${pnpmPath ?? '(未找到)'}` +
    `；安装根=${installRoot ?? '(未找到)'}；预检=${check ? check.missing ?? 'ok' : '异常'}` +
    (cmd ? `；cmd=${cmd}` : '') +
    (check?.fix ? `；建议=${check.fix}` : '')

  return [short, detail]
}

/** runtime 缺失时合成一个「已经失败」的句柄，绝不 spawn */
function missingRuntime(lines: string[], opts: RunOpts): RunHandle {
  const opId = opts.opId && opts.opId.trim() !== '' ? opts.opId : nextId('run')
  const short = lines[0] ?? '运行环境不可用'
  try {
    opts.onSpawn?.(short)
  } catch {
    /* 忽略 */
  }
  for (const line of lines) {
    try {
      opts.onLine?.(line, 'stderr')
    } catch {
      /* 忽略 */
    }
  }
  const handle: RunHandle = {
    opId,
    cmdline: short,
    kill(): void {},
    done: Promise.resolve({ code: -1, log: short })
  }
  return handle
}

/**
 * 默认追加 --reporter=append-only。
 * 插到第一个非选项参数之前（= 子命令之前），这样 `pnpm add x` / `pnpm install` 都合法；
 * 调用方自己带了 --reporter（或 --reporter=xxx）就完全不碰。
 */
function withReporter(args: string[]): string[] {
  const hasReporter = args.some((a) => a === '--reporter' || a.startsWith('--reporter='))
  if (hasReporter) return args
  const flag = '--reporter=append-only'
  let insertAt = args.length
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) {
      insertAt = i
      break
    }
  }
  const out = args.slice()
  out.splice(insertAt, 0, flag)
  /* 只有 flag 一个元素（args 为空）时也得合法 */
  return out.length > 0 ? out : [flag]
}
