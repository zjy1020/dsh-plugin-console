/**
 * 官方通道桥接层。
 *
 * 背景：DSH 安装目录里带着 `@deepseek-ai/dsh-plugin-manager`，它的 `./operations`
 * 子路径导出的 `runProfilePnpm` / `withFileLock` 就是「DSH 官方插件管理器」和
 * `dsh plugin` CLI 真正用的那一份实现。自己拼 pnpm 会丢掉四样关键东西：
 *
 *   1. `reconcile()` —— 装完之后维护 `package.json` 的 `dsh.profile.bundles`
 *      数组（唯一判据是包内 `dsh.bundle.patch` 是否存在，不是 `dsh` 字段、不是包名）；
 *   2. 兼容性前置门禁 —— 不兼容当前 dsh 运行时的插件会被直接拒绝，避免把整个
 *      profile 装上就起不来；拒绝时会回滚 `package.json` / `pnpm-lock.yaml`；
 *   3. 快照回滚 —— 失败时恢复这两个文件；
 *   4. `<profile>/.plugin-manager/logs/` 下的 pnpm.log 诊断日志 + 跨进程写锁
 *      （`withFileLock(<profile>/package.json)`，120s 等待），和正在运行的
 *      DSH Desktop 抢同一份 package.json 时不会互相覆盖。
 *
 * 所以写操作一律优先走这里。官方模块不在（用户装了别的版本 / 换了安装路径）时
 * 返回 null，由 `ops.ts` 退化到自建 pnpm 路径。
 *
 * 注意几个必须踩准的点（都是读官方源码得到的，不是猜的）：
 *   - `execution: 'service'` 才捕获输出；`'cli'` 是 `inherit`，`onOutput` 永远不触发。
 *   - `options.env` 会覆盖 `scrubbedParentEnv()`，所以想让它看见的东西得自己塞进去。
 *   - `idleTimeoutMs` 是「静默超时」：不传就永不超时，传了就按「多久没打印」算。
 *   - 真正的取消走 `options.signal`（官方内部会和它自己的 AbortController 合并）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type LineChannel = 'stdout' | 'stderr'

/** 官方运行时里我们用到的几个绝对路径。 */
export interface OfficialPaths {
  /** `<安装根>/resources/app/dsh` */
  runtimeDir: string
  /** 官方 `INSTALL_ANCHOR`：`<runtimeDir>/node_modules/@deepseek-ai/dsh/package.json` */
  installAnchor: string
  /** `@deepseek-ai/dsh-plugin-manager/operations` 入口（ESM） */
  opsEntry: string
  /** `@deepseek-ai/dsh-atomic-write` 入口（ESM，提供 withFileLock） */
  atomicEntry: string
}

export interface OfficialIncompatible {
  name: string
  version: string
  runtimeVersion: string
  message: string
}

export interface OfficialRunOptions {
  profile: string
  profileDir: string
  /** 透传给 pnpm 的参数，例如 `['add', 'foo@1.2.3']`。 */
  args: string[]
  /** 官方模块要用哪个 node 去跑 pnpm（绝对路径）。 */
  nodePath: string
  /** 要跑哪个 pnpm 入口（pnpm.cjs / pnpm.mjs 绝对路径）。 */
  pnpmPath: string
  opId?: string
  /** 取消信号。 */
  signal?: AbortSignal
  /** 追加到官方 env 之上的环境变量（代理、registry 等）。 */
  env?: Record<string, string>
  /** 逐块回调（不是逐行，官方给的是 chunk）。 */
  onOutput?: (text: string, channel: LineChannel) => void
  /** 整轮上限（毫秒）。超时走 signal 中止，进程树一起收。 */
  timeoutMs?: number
  /** 静默超时（毫秒）。默认 5 分钟没一点输出就判定卡死。 */
  idleTimeoutMs?: number
  /** 单次 registry 查询上限（毫秒）。 */
  lookupTimeoutMs?: number
  /** 是否让官方在安装成功后调和 bundles。默认允许（这正是我们要的）。 */
  activateNewBundles?: boolean
  /** registry 覆盖；不传则用 pnpm 自己的配置。 */
  registry?: string | null
}

export interface OfficialRunResult {
  code: number
  output: string
  truncated: boolean
  logPath: string | null
  incompatible: OfficialIncompatible[]
}

/** 官方模块的最小形状（没有随包发 .d.ts，只能自己声明用到的部分）。 */
interface OfficialOperations {
  runProfilePnpm(context: unknown, args: string[], options: unknown): Promise<{
    exitCode: number
    output: string
    truncated: boolean
    logPath: string
    incompatible: OfficialIncompatible[]
  }>
  reconcile?: (before: unknown, dir: string, anchor: string, options: unknown) => Promise<void>
}

interface OfficialAtomicWrite {
  withFileLock<T>(filename: string, operation: () => Promise<T> | T, options?: { waitMs?: number; signal?: AbortSignal }): Promise<T>
  writeFileAtomic(filename: string, content: string, options: { mode?: number }): Promise<void>
}

/** 安装根下的候选位置，第一个存在的赢。 */
function candidates(installRoot: string): OfficialPaths[] {
  const dshDir = join(installRoot, 'resources', 'app', 'dsh')
  const scope = join(dshDir, 'node_modules', '@deepseek-ai')
  const manager = join(scope, 'dsh-plugin-manager')
  return [
    {
      runtimeDir: dshDir,
      installAnchor: join(scope, 'dsh', 'package.json'),
      opsEntry: join(manager, 'lib', 'types', 'operations.js'),
      atomicEntry: join(scope, 'dsh-atomic-write', 'lib', 'index.js'),
    },
  ]
}

/*
 * 缓存必须按 installRoot 键控。
 *
 * 原来这里是「算一次就记死，连算不出来的 null 也记死」（判据 cachedPaths !== undefined）。
 * 后果正好踩在这次要修的那条路上：新电脑上启动时安装根还没探测出来 → 算出 null 并记死 →
 * 用户在引导卡里手动选对了目录、界面也显示好了 → 但本进程内官方通道仍然是 null，
 * 装任何插件都还走退化路径，必须重启插件台才生效。界面说好了、实际没好，是最难查的一类。
 * 键控之后：调用方传进来的 installRoot 一变就重算，null → 真目录 这一步自然生效。
 */
let cachedFor: string | null | undefined
let cachedPaths: OfficialPaths | null = null

/** 定位官方模块。全机只有一份 dsh 运行时，用安装根算即可；算不出来就返回 null。 */
export function resolveOfficialPaths(installRoot: string | null): OfficialPaths | null {
  if (cachedFor !== undefined && cachedFor === installRoot) return cachedPaths
  cachedFor = installRoot
  cachedPaths = null
  if (installRoot) {
    for (const candidate of candidates(installRoot)) {
      if (existsSync(candidate.opsEntry) && existsSync(candidate.installAnchor)) {
        cachedPaths = candidate
        break
      }
    }
  }
  return cachedPaths
}

/**
 * 强行丢弃缓存。
 * 安装根变了会被上面的键控自动处理；这个留给「安装根没变、但官方包本身可能被动过」的场合
 * （设置保存、以及以后可能的「修复官方通道」动作）。
 */
export function invalidateOfficialPaths(): void {
  cachedFor = undefined
  cachedPaths = null
}

export function officialAvailable(installRoot: string | null): boolean {
  return resolveOfficialPaths(installRoot) !== null
}

const modules = new Map<string, Promise<unknown>>()

function loadEsm<T>(entry: string): Promise<T> {
  const hit = modules.get(entry)
  if (hit) return hit as Promise<T>
  const promise = import(pathToFileURL(entry).href).catch((error: unknown) => {
    // 失败的 import 不能留在缓存里，否则这台机器此后再也不会重试。
    modules.delete(entry)
    throw error
  })
  modules.set(entry, promise)
  return promise as Promise<T>
}

/** 打补丁：官方 reconcile 会自己读 `dsh.bundle.patch`，这里只负责把它接出来给外部判断用。 */
export interface BundleProbe {
  /** 该包是不是一个「profile 层」（决定要不要留在 bundles 里）。 */
  isBundle: boolean
  /** 该包声明的 dsh 要求（用于界面上标「与当前运行时可能不兼容」）。 */
  manifests: string[]
}

/** 读某个已装包是否声明了 `dsh.bundle.patch`——与官方 `bundleManifest()` 同一判据。 */
export async function probeBundle(
  installRoot: string | null,
  profileDir: string,
  name: string,
): Promise<BundleProbe | null> {
  const paths = resolveOfficialPaths(installRoot)
  if (!paths) return null
  try {
    const ops = await loadEsm<Record<string, unknown>>(paths.opsEntry)
    const manifest = ops['bundleManifest']
    if (typeof manifest !== 'function') return null
    const result = (manifest as (n: string, d: string, a: string) => Record<string, unknown> | undefined)(
      name,
      profileDir,
      paths.installAnchor,
    )
    if (!result) return { isBundle: false, manifests: [] }
    const bundle = (result['dsh'] as Record<string, unknown> | undefined)?.['bundle'] as
      | Record<string, unknown>
      | undefined
    const patches = Array.isArray(bundle?.['patch']) ? (bundle!['patch'] as unknown[]) : [bundle?.['patch']]
    return {
      isBundle: true,
      manifests: patches.filter((p): p is string => typeof p === 'string'),
    }
  } catch {
    return null
  }
}

export class OfficialUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfficialUnavailableError'
  }
}

/** 官方 withFileLock 的窄包装；拿不到官方模块时直接执行，由调用方决定要不要退化。 */
export async function withOfficialLock<T>(
  installRoot: string | null,
  file: string,
  operation: () => Promise<T>,
  options?: { waitMs?: number; signal?: AbortSignal },
): Promise<T> {
  const paths = resolveOfficialPaths(installRoot)
  if (!paths) return operation()
  try {
    const atomic = await loadEsm<OfficialAtomicWrite>(paths.atomicEntry)
    if (typeof atomic.withFileLock === 'function') {
      return await atomic.withFileLock(file, operation, options)
    }
  } catch {
    // 锁拿不到不能把操作一起废掉：退化成直接执行（自建路径自己还有一层备份）。
  }
  return operation()
}

/** 运行中的官方调用，按 opId 归组——官方路径没有我们自己的子进程句柄，取消只能走 AbortSignal。 */
const activeSignals = new Map<string, Set<AbortController>>()

/** 取消某个操作正在跑的官方调用；命中才算 true。 */
export function abortOfficial(opId: string): boolean {
  const group = activeSignals.get(opId)
  if (!group || group.size === 0) return false
  let hit = false
  for (const controller of group) {
    if (controller.signal.aborted) continue
    hit = true
    controller.abort(new Error('用户取消了操作'))
  }
  return hit
}

/** 有没有官方调用在跑（给「取消」按钮判断用）。 */
export function officialRunning(opId: string): boolean {
  const group = activeSignals.get(opId)
  return group !== undefined && group.size > 0
}

/**
 * 跑一轮官方 profile 改动。
 *
 * @throws OfficialUnavailableError 官方模块不在或加载失败——调用方应退化到自建 pnpm。
 */
export async function runOfficialChange(opts: OfficialRunOptions, installRoot: string | null): Promise<OfficialRunResult> {
  const paths = resolveOfficialPaths(installRoot)
  if (!paths) {
    throw new OfficialUnavailableError('未找到 DSH 官方的 dsh-plugin-manager/operations 模块')
  }

  let ops: OfficialOperations
  try {
    ops = await loadEsm<OfficialOperations>(paths.opsEntry)
  } catch (error) {
    throw new OfficialUnavailableError(
      `加载官方 operations 模块失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof ops.runProfilePnpm !== 'function') {
    throw new OfficialUnavailableError('官方 operations 模块没有导出 runProfilePnpm')
  }

  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000

  // 官方只认 options.signal，超时得我们自己做成中止信号。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`操作超过 ${Math.round(timeoutMs / 1000)} 秒未结束`)), timeoutMs)
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal

  if (opts.opId) {
    let group = activeSignals.get(opts.opId)
    if (!group) {
      group = new Set()
      activeSignals.set(opts.opId, group)
    }
    group.add(controller)
  }

  const context = {
    profile: opts.profile,
    dir: opts.profileDir,
    installAnchor: paths.installAnchor,
    cwd: opts.profileDir,
  }

  const options = {
    command: opts.nodePath,
    args: [opts.pnpmPath, '--reporter=append-only'],
    execution: 'service' as const,
    outputBytes: 4 << 20,
    lookupTimeoutMs: opts.lookupTimeoutMs ?? 30_000,
    idleTimeoutMs,
    signal,
    env: opts.env ?? {},
    onOutput: opts.onOutput,
    ...(opts.activateNewBundles === undefined ? {} : { activateNewBundles: opts.activateNewBundles }),
    ...(opts.registry === undefined || opts.registry === null ? {} : { registry: opts.registry }),
  }

  try {
    const result = await ops.runProfilePnpm(context, opts.args, options)
    return {
      code: typeof result.exitCode === 'number' ? result.exitCode : 1,
      output: typeof result.output === 'string' ? result.output : '',
      truncated: result.truncated === true,
      logPath: typeof result.logPath === 'string' ? result.logPath : null,
      incompatible: Array.isArray(result.incompatible) ? result.incompatible : [],
    }
  } finally {
    clearTimeout(timer)
    if (opts.opId) {
      const group = activeSignals.get(opts.opId)
      if (group) {
        group.delete(controller)
        if (group.size === 0) activeSignals.delete(opts.opId)
      }
    }
  }
}
