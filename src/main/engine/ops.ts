/**
 * ops.ts —— 操作编排层（安装 / 卸载 / 更新 / 停用 / 启用 / 修复）。
 *
 * 设计原则：
 *   一、`runOp` 是唯一出口，任何异常都被吃成 `ok:false` + 中文 message，绝不外抛；
 *   二、「装了什么」(dependencies) 与「加载什么」(dsh.profile.bundles) 分开维护：
 *       pnpm 负责写 dependencies，我们负责把声明了 dsh 字段的包补进 bundles；
 *   三、停用 = 只从 bundles 移出并把原下标记进 console state（不动 cordis.patch.yml）；
 *   四、每个分支都必须给出 changes[]，UI 靠它渲染 diff。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type {
  InstallPreview,
  OpChange,
  OpKind,
  OpLogLine,
  OpRequest,
  OpResult,
  ParsedSpec,
  PluginRecord,
  RegistryPackument
} from '../../shared/types'

import * as env from './env'
import * as settings from './settings'
import * as spec from './spec'
import * as net from './net'
import * as inventory from './inventory'
import * as state from './state'
import * as pnpm from './pnpm'
import * as dshpm from './dshpm'
import * as profileYaml from './profileYaml'
import * as updates from './updates'
import * as manifest from './manifest'
import { compareVersions } from './updates'
import { addBundle, backupProfilePkg, bundleIndexOf, getBundles, readProfilePkg, removeBundle } from './bundles'

/* ------------------------------------------------------------------ *
 * 类型 / 常量
 * ------------------------------------------------------------------ */

export interface OpHooks {
  opId?: string
  onLog?: (line: OpLogLine) => void
}

interface Ctx {
  opId: string
  kind: OpKind
  profileDir: string
  profile: string
  startedAt: number
  changes: OpChange[]
  lines: string[]
  failed: boolean
  cached: PluginRecord[] | null
}

/** 官方内置包前缀：随 runtime 发布，不允许卸载 */
const OFFICIAL_PREFIX = '@deepseek-ai/'

/** 正在跑的操作（供 activeOps / cancelOp） */
const active = new Map<string, OpHooks | undefined>()

let opSeq = 0

/* ------------------------------------------------------------------ *
 * 对外：activeOps / cancelOp
 * ------------------------------------------------------------------ */

export function activeOps(): string[] {
  return Array.from(active.keys())
}

/** 取消一个正在跑的操作：自建通道杀子进程，官方通道中止 AbortSignal。 */
export function cancelOp(opId: string): boolean {
  if (!opId) return false
  const killed = pnpm.killOp(opId)
  const aborted = dshpm.abortOfficial(opId)
  return killed || aborted
}

/* ------------------------------------------------------------------ *
 * 工具：日志 / 结果
 * ------------------------------------------------------------------ */

function newOpId(hooks?: OpHooks): string {
  if (hooks?.opId && typeof hooks.opId === 'string' && hooks.opId.trim() !== '') return hooks.opId
  opSeq += 1
  return `op-${Date.now()}-${opSeq.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

function emit(ctx: Ctx, hooks: OpHooks | undefined, channel: OpLogLine['channel'], text: string): void {
  const clean = text == null ? '' : String(text)
  try {
    hooks?.onLog?.({ opId: ctx.opId, at: Date.now(), channel, text: clean })
  } catch {
    /* 回调异常不影响操作 */
  }
}

function logSystem(ctx: Ctx, hooks: OpHooks | undefined, text: string): void {
  ctx.lines.push(text)
  emit(ctx, hooks, 'system', text)
}

function logStd(ctx: Ctx, hooks: OpHooks | undefined, text: string, channel: 'stdout' | 'stderr'): void {
  ctx.lines.push(text)
  emit(ctx, hooks, channel, text)
}

function addChange(ctx: Ctx, change: OpChange): void {
  /* 同一个包同名同动作只留最后一次，避免 UI 重复 */
  const key = `${change.name}::${change.action}`
  const idx = ctx.changes.findIndex((c) => `${c.name}::${c.action}` === key)
  if (idx >= 0) {
    ctx.changes[idx] = change
    return
  }
  ctx.changes.push(change)
}

function fail(ctx: Ctx, hooks: OpHooks | undefined, message: string, code: number | null = null): OpResult {
  ctx.failed = true
  logSystem(ctx, hooks, message)
  return finish(ctx, hooks, { ok: false, code, message, restartRequired: false })
}

interface FinishOpts {
  ok: boolean
  message: string
  code?: number | null
  restartRequired?: boolean
}

function finish(ctx: Ctx, _hooks: OpHooks | undefined, opts: FinishOpts): OpResult {
  return {
    opId: ctx.opId,
    kind: ctx.kind,
    profile: ctx.profile,
    ok: opts.ok,
    code: typeof opts.code === 'number' || opts.code === null ? opts.code : null,
    startedAt: ctx.startedAt,
    endedAt: Date.now(),
    changes: ctx.changes.slice(),
    message: opts.message,
    restartRequired: opts.restartRequired === true,
    log: ctx.lines.join('\n')
  }
}

/* ------------------------------------------------------------------ *
 * 工具：settings / pnpm 参数
 * ------------------------------------------------------------------ */

function safeSettings(): { forceBundle: boolean; extraPnpmArgs: string } {
  let forceBundle = false
  let extraPnpmArgs = ''
  try {
    const s = settings.get()
    forceBundle = s?.forceBundle === true
    extraPnpmArgs = typeof s?.extraPnpmArgs === 'string' ? s.extraPnpmArgs : ''
  } catch {
    /* settings 还没就绪也不该让操作挂掉 */
  }
  return { forceBundle, extraPnpmArgs }
}

/** settings.extraPnpmArgs（空格分隔）→ 数组，带简单引号处理 */
function splitArgs(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const v = m[1] ?? m[2] ?? m[3]
    if (v) out.push(v)
  }
  return out
}

/** pnpm 子命令 + 用户附加参数（settings.extraPnpmArgs） */
function pnpmArgv(args: string[]): string[] {
  const extra = splitArgs(safeSettings().extraPnpmArgs)
  return extra.length > 0 ? [...args, ...extra] : args
}

interface RunOutcome {
  code: number | null
  log: string
  timedOut: boolean
  /**
   * 是否走了官方通道。官方通道自己会 `reconcile()` 调和
   * `dsh.profile.bundles`，调用方**不要再手写** bundles，否则会和宿主打架。
   */
  official: boolean
  /** 官方通道的 pnpm.log 路径，出问题时让用户能直接翻。 */
  logPath: string | null
  /** 官方兼容性门禁拦下的版本。 */
  incompatible: dshpm.OfficialIncompatible[]
}

/** 官方通道给的输出是 chunk，这里聚成行再往上抛。 */
function chunkToLines(onLine: (line: string, channel: 'stdout' | 'stderr') => void): (text: string, channel: 'stdout' | 'stderr') => void {
  const tails: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  return (text, channel) => {
    const buf = (tails[channel] ?? '') + text
    const parts = buf.split(/\r?\n/)
    tails[channel] = parts.pop() ?? ''
    for (const line of parts) onLine(line, channel)
  }
}

/**
 * 跑一次 profile 改动。
 *
 * 优先走 DSH 官方通道（`@deepseek-ai/dsh-plugin-manager/operations`）——它一次
 * 性给了 bundles 调和、兼容性门禁、快照回滚、诊断日志和跨进程写锁。官方模块
 * 不在（换了安装路径 / 版本对不上）时退化到自建 pnpm，行为等价但少了那四样。
 */
async function runPnpmOp(ctx: Ctx, hooks: OpHooks | undefined, args: string[], timeoutMs?: number): Promise<RunOutcome> {
  const argv = pnpmArgv(args)
  const installRoot = (() => {
    try {
      return env.getInstallRoot()
    } catch {
      return null
    }
  })()

  if (dshpm.officialAvailable(installRoot)) {
    try {
      return await runViaOfficial(ctx, hooks, argv, installRoot, timeoutMs)
    } catch (error) {
      if (!(error instanceof dshpm.OfficialUnavailableError)) throw error
      logSystem(ctx, hooks, `官方通道不可用（${error.message}），改用自带 pnpm`)
    }
  }

  const handle = pnpm.runPnpm(argv, {
    cwd: ctx.profileDir,
    opId: ctx.opId,
    ...(timeoutMs ? { timeoutMs } : {}),
    onSpawn: (cmdline) => logSystem(ctx, hooks, `$ ${cmdline}`),
    onLine: (line, channel) => logStd(ctx, hooks, line, channel)
  })
  const res = await handle.done
  const timedOut = /\[超时，已终止\]/.test(res.log)
  return { code: res.code, log: res.log, timedOut, official: false, logPath: null, incompatible: [] }
}

/**
 * runPnpmAddish —— 给「会触发安装的 pnpm 子命令」加一层自愈重试。
 *
 * 只处理两种「环境政策性」失败，都是 pnpm 11 默认替用户把关导致的，
 * 不是用户输入错了：
 *   1. ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
 *      → 往 <profile>/pnpm-workspace.yaml 的 allowBuilds 写精确 key 后重试。
 *      GitHub 装的插件大多有 prepare/build 脚本，不放行就等于装不上，
 *      而那条 key 带完整 tarball URL，用户没法自己猜。
 *   2. ERR_PNPM_MINIMUM_RELEASE_AGE
 *      → 往 minimumReleaseAgeExclude 写 name@version 后重试。
 *
 * 每种最多修一次、整体最多重试两轮，避免和 pnpm 来回打乒乓。
 */
async function runPnpmAddish(
  ctx: Ctx,
  hooks: OpHooks | undefined,
  args: string[],
  timeoutMs?: number
): Promise<RunOutcome> {
  let run = await runPnpmOp(ctx, hooks, args, timeoutMs)
  const tried = new Set<string>()

  for (let round = 0; round < 2 && run.code !== 0; round += 1) {
    const gitKeys = profileYaml.parseGitPrepareKeys(run.log)
    if (gitKeys.length > 0 && !tried.has('allowBuilds')) {
      tried.add('allowBuilds')
      const fix = profileYaml.ensureAllowBuilds(ctx.profileDir, gitKeys)
      if (fix.ok && fix.added.length > 0) {
        logSystem(
          ctx,
          hooks,
          `pnpm 拦下了 git 包的构建脚本，已写入 ${fix.path} 的 allowBuilds：${fix.added.join('、')}${fix.backup ? `（原文件已备份 → ${fix.backup}）` : ''}，重试一次`
        )
        run = await runPnpmOp(ctx, hooks, args, timeoutMs)
        continue
      }
      logSystem(ctx, hooks, fix.ok ? 'allowBuilds 里已经有这条 key 了，重试没有意义' : `写 allowBuilds 失败：${fix.error ?? '未知原因'}`)
    }

    const ageKeys = profileYaml.parseMinimumReleaseAgeKeys(run.log)
    if (ageKeys.length > 0 && !tried.has('minimumReleaseAgeExclude')) {
      tried.add('minimumReleaseAgeExclude')
      const fix = profileYaml.ensureReleaseAgeExclude(ctx.profileDir, ageKeys)
      if (fix.ok && fix.added.length > 0) {
        logSystem(
          ctx,
          hooks,
          `pnpm 的新版本冷却策略拦下了 ${fix.added.join('、')}，已写入 minimumReleaseAgeExclude，重试一次`
        )
        run = await runPnpmOp(ctx, hooks, args, timeoutMs)
        continue
      }
    }

    break
  }

  return run
}

async function runViaOfficial(
  ctx: Ctx,
  hooks: OpHooks | undefined,
  argv: string[],
  installRoot: string | null,
  timeoutMs?: number
): Promise<RunOutcome> {
  const nodePath = env.getNodePath()
  const pnpmPath = env.getPnpmPath()
  if (!nodePath || !pnpmPath) {
    throw new dshpm.OfficialUnavailableError('没探测到自带的 node / pnpm')
  }

  const settingsSnapshot = (() => {
    try {
      return settings.get()
    } catch {
      return null
    }
  })()

  logSystem(ctx, hooks, `$ pnpm --profile ${ctx.profile} ${argv.join(' ')}  （官方通道）`)

  const push = chunkToLines((line, channel) => logStd(ctx, hooks, line, channel))
  const work = async (): Promise<dshpm.OfficialRunResult> =>
    dshpm.runOfficialChange(
      {
        profile: ctx.profile,
        profileDir: ctx.profileDir,
        args: argv,
        nodePath,
        pnpmPath,
        opId: ctx.opId,
        env: childEnvFor(settingsSnapshot),
        onOutput: push,
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(settingsSnapshot?.registry ? { registry: settingsSnapshot.registry } : {})
      },
      installRoot
    )

  let result: dshpm.OfficialRunResult
  try {
    // 官方在 desktop profile 上也会自己套 withFileLock，但那是 CLI 的行为；
    // 库调用这一层没有，所以由我们补上，避免和正在跑的 DSH Desktop 抢写。
    result = await dshpm.withOfficialLock(
      installRoot,
      path.join(ctx.profileDir, 'package.json'),
      work,
      { waitMs: 120_000 }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = /abort|cancel|取消/i.test(message)
    if (aborted) {
      logStd(ctx, hooks, message, 'stderr')
      return { code: null, log: message, timedOut: false, official: true, logPath: null, incompatible: [] }
    }
    throw error
  }

  if (result.incompatible.length > 0) {
    for (const item of result.incompatible) {
      logStd(
        ctx,
        hooks,
        `与当前 dsh 运行时不兼容：${item.name}@${item.version}（需要 ${item.runtimeVersion}）—— 官方已拒绝安装，profile 未被改动`,
        'stderr'
      )
    }
  }
  if (result.logPath) logSystem(ctx, hooks, `诊断日志：${result.logPath}`)
  if (result.truncated) logSystem(ctx, hooks, '输出过长已截断，完整内容见上面的诊断日志')

  const idleStalled = /printed nothing for \d+ms and was terminated/.test(result.output)
  const timedOut = idleStalled || /操作超过 \d+ 秒未结束/.test(result.output)
  return {
    code: result.code,
    log: result.output,
    timedOut,
    official: true,
    logPath: result.logPath,
    incompatible: result.incompatible
  }
}

/**
 * 官方通道跑在 `execution:'service'` 下，官方会先 `scrubbedParentEnv()` 再合
 * 我们的 env —— 所以 PATH 这类必须由我们显式给，否则 git 依赖和生命周期脚本
 * 找不到可执行文件。
 */
function childEnvFor(snapshot: ReturnType<typeof settings.get> | null): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const child = env.buildChildEnv()
    for (const [key, value] of Object.entries(child)) {
      if (typeof value === 'string') out[key] = value
    }
  } catch {
    /* 探测失败就只给代理 */
  }
  const proxy = snapshot?.proxy
  if (typeof proxy === 'string' && proxy.trim() !== '') {
    const url = proxy.trim()
    out.HTTP_PROXY = url
    out.HTTPS_PROXY = url
    out.http_proxy = url
    out.https_proxy = url
    out.NO_PROXY = 'localhost,127.0.0.1,::1'
    out.no_proxy = 'localhost,127.0.0.1,::1'
  }
  if (snapshot?.registry) out.npm_config_registry = snapshot.registry
  out.CI = '1'
  out.NO_COLOR = '1'
  return out
}

/** 读一份 bundles 快照；读不到就当空数组。 */
function bundlesSnapshot(profileDir: string): string[] {
  try {
    return getBundles(profileDir)
  } catch {
    return []
  }
}

/** 官方调和完 bundles 之后，把差异讲清楚（UI 靠 changes[] 渲染）。 */
function reportBundleDiff(
  ctx: Ctx,
  hooks: OpHooks | undefined,
  beforeList: string[],
  afterList: string[]
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(beforeList)
  const afterSet = new Set(afterList)
  const added = afterList.filter((n) => !beforeSet.has(n))
  const removed = beforeList.filter((n) => !afterSet.has(n))

  for (const name of added) {
    addChange(ctx, { name, from: null, to: null, action: 'bundled' })
    logSystem(ctx, hooks, `${name} 已由 DSH 加入加载列表（重启后加载）`)
  }
  for (const name of removed) {
    addChange(ctx, { name, from: null, to: null, action: 'unbundled' })
    logSystem(ctx, hooks, `${name} 已从加载列表移除`)
  }
  if (added.length === 0 && removed.length === 0) {
    logSystem(ctx, hooks, '加载列表（bundles）没有变化')
  }
  return { added, removed }
}

/* ------------------------------------------------------------------ *
 * 工具：错误摘要 / 快照 diff
 * ------------------------------------------------------------------ */

function tailLog(log: string, n: number): string {
  const lines = String(log ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
  return lines.slice(Math.max(0, lines.length - n)).join(' / ')
}

function isErrorLine(line: string): boolean {
  return (
    /ERR_|ERR\b|ELIFECYCLE|ENOENT|EACCES|EPERM|EEXIST|404 Not Found|ETARGET/.test(line) ||
    /\berror\b/i.test(line) ||
    /版本不存在|不存在该|无效的包名/.test(line)
  )
}

/**
 * 把 pnpm 的常见错误码翻译成一句人话。
 *
 * 为什么需要：pnpm 的报错是给会用命令行的人看的，它会把同一段错误印两遍
 * （发生时报一次、退出时汇总再报一次），再带上 `This error happened while
 * installing a direct dependency of C:\Users\...\profiles\desktop` 这种路径。
 * 用户在界面上看到的就是一整屏英文里夹着一个 404，唯一能读出来的信息是
 * 「好像失败了」。这里把「到底哪儿不对」提到最前面，原文仍留在日志里。
 */
function explainPnpmError(log: string): string | null {
  const s = String(log ?? '')
  if (/ERR_PNPM_FETCH_404/.test(s)) {
    const m = s.match(/GET\s+(\S+?):\s*Not Found/)
    const url = m ? m[1] : null
    const pkg = url ? url.split('/').pop() : null
    return pkg
      ? `registry 上没有「${pkg}」这个包（或这个版本）—— 检查一下名字有没有打错；如果它是 GitHub 上的项目，用仓库地址装，不要用包名。`
      : 'registry 上找不到这个包（或这个版本）—— 检查一下名字有没有打错。'
  }
  if (/ERR_PNPM_NO_MATCHING_VERSION|No matching version found/.test(s)) {
    return '这个版本不存在（可能已被撤销，或者名字对但版本号写错了）。'
  }
  if (/ERR_PNPM_MINIMUM_RELEASE_AGE/.test(s)) {
    return 'pnpm 的供应链冷却策略拦下了这个刚发布的版本，稍后再试或改用稍旧的版本。'
  }
  if (/ERR_PNPM_PEER_DEP_ISSUES/.test(s)) {
    return '依赖版本冲突（peer dependency 不匹配），这个插件要求的版本和当前 profile 里的其它包打架。'
  }
  if (/ERR_PNPM_FETCH_401|ERR_PNPM_FETCH_403|ENEEDAUTH/.test(s)) {
    return 'registry 拒绝了这次请求（401/403）—— 私有包需要配 token，或者代理把请求拦了。'
  }
  if (/ERR_PNPM_FETCH_5\d\d/.test(s)) {
    return 'registry 那边出错了（5xx），不是你这边的问题，过一会儿再试。'
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ERR_SOCKET_TIMEOUT/.test(s)) {
    return '连不上 registry —— 网络或代理的问题。到设置里测一下代理延迟。'
  }
  if (/ERR_PNPM_GIT|fatal: (repository|could not read)/i.test(s)) {
    return '拉 GitHub 仓库失败 —— 仓库地址不对、分支/tag 不存在，或者代理没通。'
  }
  if (/ERR_PNPM_UNSUPPORTED_ENGINE/.test(s)) {
    return '这个包要求的 Node 版本和 DSH 自带的对不上。'
  }
  if (/ERR_PNPM_UNKNOWN/.test(s) || /UNKNOWN: unknown error, open/i.test(s)) {
    // 实机确认（Master 的新电脑）：git 包解压到 pnpm 临时目录时，某个文件名敏感
    // （如 unauth-exploit.md）被 Defender 实时防护锁住写入 → UNKNOWN: unknown error, open。
    // tarball 本身是干净的（逐文件核对过：无 symlink、无非法文件名）。
    return (
      '安装到一半被 Windows 安全中心（Defender）挡住了 —— 包里有文件名敏感的文件，' +
      '写入时被实时防护锁住。两个解法：① 暂时关掉实时防护（Windows 安全中心 → 病毒和威胁防护 → ' +
      '实时防护），装完再开；② 把 pnpm 的存储目录加进排除项（通常在 C:\\Users\\<你>\\AppData\\Local\\pnpm）。' +
      '改完再点一次安装。'
    )
  }
  if (/ENOSPC/.test(s)) {
    return '磁盘满了。'
  }
  if (/EACCES|EPERM/.test(s)) {
    return '没有权限写 profile 目录 —— 检查一下 .dsh 是不是被别的程序占用或者设了只读。'
  }
  return null
}

/** 去重 + 掐掉 pnpm 的「This error happened while…」这种纯上下文行 */
function cleanErrorLines(log: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of String(log ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (/^This error happened while installing/i.test(line)) continue
    if (/^Progress: resolved/i.test(line)) continue
    if (/^at\s/.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

function errorSummary(log: string): string {
  const explained = explainPnpmError(log)
  const lines = cleanErrorLines(log)
  const hits = lines.filter(isErrorLine)
  const detail = hits.length > 0 ? hits.slice(0, 3).join('\n') : lines.slice(-4).join('\n')
  /* 有中文解释时，解释放前面、原文压缩成最多 3 行附在后面 ——
   * 用户先看懂发生了什么，需要细究时再往下看原文。 */
  if (explained) return detail ? `${explained}\n\n原始报错：${detail}` : explained
  return detail
}

function toSnapshot(records: PluginRecord[]): Map<string, string | null> {
  const map = new Map<string, string | null>()
  for (const r of records) {
    if (r && typeof r.name === 'string' && r.name !== '') map.set(r.name, r.version ?? null)
  }
  return map
}

async function safeList(profile: string, ctx: Ctx, hooks?: OpHooks): Promise<PluginRecord[]> {
  if (ctx.cached) return ctx.cached
  try {
    const list = await inventory.listPlugins(profile)
    ctx.cached = Array.isArray(list) ? list : []
  } catch (err) {
    ctx.cached = []
    logSystem(ctx, hooks, `读取插件清单失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return ctx.cached
}

function findRecord(list: PluginRecord[], name: string): PluginRecord | null {
  return list.find((r) => r.name === name) ?? null
}

/* ------------------------------------------------------------------ *
 * 安装预检
 * ------------------------------------------------------------------ */

function emptyPreview(profile: string, parsed: ParsedSpec, error: string | null): InstallPreview {
  return {
    parsed,
    resolvedName: null,
    resolvedVersion: null,
    resolvedDescription: null,
    isDshPlugin: false,
    alreadyInstalled: null,
    warnings: [],
    profile,
    error
  }
}

/** 安装前预检：解析来源 + 尽量联网确认包/仓库存在。网络失败只当告警，不阻断 */
export async function installPreview(profile: string, input: string): Promise<InstallPreview> {
  const warnings: string[] = []

  let parsed: ParsedSpec
  try {
    parsed = spec.parseSpec(input)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return emptyPreview(profile, {
      ok: false,
      raw: input,
      kind: 'invalid',
      normalized: null,
      owner: null,
      repo: null,
      ref: null,
      subdir: null,
      packageName: null,
      reason: '解析失败',
      error: message
    }, message)
  }

  if (!parsed || parsed.ok !== true) {
    return emptyPreview(profile, parsed, parsed?.error ?? '无法解析这个来源')
  }

  let profileDir = ''
  try {
    profileDir = env.getProfileDir(profile)
  } catch {
    profileDir = ''
  }

  if (profileDir && !existsSync(profileDir)) {
    return emptyPreview(profile, parsed, `profile 目录不存在：${profileDir}`)
  }

  let resolvedName: string | null = parsed.packageName ?? null
  let resolvedVersion: string | null = null
  let resolvedDescription: string | null = null
  let repoFullName: string | null = null
  let isDshPlugin = false

  /* npm：问 registry */
  if (parsed.kind === 'npm' && parsed.packageName) {
    try {
      const info = (await net.registryPackument(parsed.packageName)) as RegistryPackument
      if (info && info.notFound) {
        warnings.push(`registry 上找不到这个包：${parsed.packageName}`)
      } else if (info && info.error) {
        warnings.push(`查询 registry 失败：${info.error}`)
      } else if (info) {
        resolvedName = info.name || parsed.packageName
        resolvedVersion = info.latest ?? null
        resolvedDescription = info.description ?? null
        if (info.deprecated) warnings.push(`这个包已被标记为废弃：${info.deprecated}`)
        if (resolvedName && resolvedName !== parsed.packageName) {
          warnings.push(`注意：包名被 registry 归一化为 ${resolvedName}`)
        }
        const bundleFlag = net.packumentBundleFlag(parsed.packageName)
        if (bundleFlag === true) {
          isDshPlugin = true
        } else if (bundleFlag === false) {
          warnings.push('这个包的最新版本没有声明 dsh.bundle.patch —— 装了是普通依赖，不会进加载列表')
        }
      } else {
        warnings.push('registry 没有返回可用元数据，安装时会以 pnpm 的结果为准')
      }
    } catch (err) {
      warnings.push(`查询 registry 失败（不影响安装）：${err instanceof Error ? err.message : String(err)}`)
    }
    resolvedDescription = resolvedDescription ?? null
  }

/* git：先读仓库里的 package.json —— raw 域名基本不限流，而且能直接
     拿到包名 / 版本 / 有没有 dsh.bundle.patch，这三样正好是预检要展示的。
     api.github.com 只用来补仓库元信息，403 限流时不再是致命伤。 */
  if (parsed.kind === 'git') {
    if (parsed.owner && parsed.repo) {
      let manifest: Awaited<ReturnType<typeof net.repoManifest>> | null = null
      try {
        manifest = await net.repoManifest(parsed.owner, parsed.repo, parsed.ref)
      } catch (err) {
        warnings.push(`读取仓库 package.json 失败：${err instanceof Error ? err.message : String(err)}`)
      }

      if (manifest && manifest.ok) {
        if (manifest.name) resolvedName = manifest.name
        if (manifest.version) resolvedVersion = manifest.version
        if (manifest.description) resolvedDescription = manifest.description
        isDshPlugin = manifest.isBundle
        if (!manifest.isBundle) {
          warnings.push('这个仓库的 package.json 里没有 dsh.bundle.patch —— 装完是普通依赖，不会进加载列表')
        }
        if (manifest.ref && parsed.ref === null && manifest.ref !== 'HEAD') {
          warnings.push(`默认分支：${manifest.ref}`)
        }
      } else if (manifest) {
        warnings.push(manifest.error ?? '远端没读到 package.json')
        warnings.push('包名和「会不会进加载列表」要等装完才知道')
      }

      try {
        const info = await net.githubRepo(parsed.owner, parsed.repo)
        if (info && info.ok) {
          resolvedDescription = resolvedDescription ?? info.description ?? null
          if (info.fullName) repoFullName = info.fullName
          if (info.defaultBranch && !(manifest && manifest.ok)) {
            warnings.push(`默认分支：${info.defaultBranch}（安装后以 pnpm 解析到的 commit 为准）`)
          }
          if (info.stars !== null && info.stars >= 0) {
            warnings.push(`GitHub 星标：${info.stars}`)
          }
          if (info.archived) warnings.push('这个仓库已归档，后续不会有新版本')
        }
      } catch {
        /* api 挂了不影响预检 —— raw 那条路已经把关键信息拿到了 */
      }
    } else {
      warnings.push('没解析出 owner/repo，安装时以 pnpm 的结果为准')
    }
    if (parsed.ref && /^[0-9a-f]{7,40}$/i.test(parsed.ref)) {
      warnings.push('已锁定 commit，后续不会自动更新')
    }
    if (parsed.subdir) {
      warnings.push(`monorepo 子目录：${parsed.subdir}`)
    }
    if (!resolvedName) {
      warnings.push('仓库里没读到包名，安装后由系统读取 package.json 识别')
    }
    if (repoFullName) {
      warnings.push(`仓库：${repoFullName}`)
    }
  }

  /* tarball / file：本地或远端压缩包，名字从文件名猜 */
  if (parsed.kind === 'tarball' || parsed.kind === 'file') {
    try {
      const norm = parsed.normalized ?? parsed.raw
      const base = path.basename(norm.replace(/^file:/, '').replace(/[?#].*$/, ''))
      if (base) {
        resolvedName = base.replace(/\.(tgz|tar\.gz)$/i, '')
        warnings.push('预检不联网，压缩包内容（包名 / 版本 / dsh 字段）要等安装后才能确认')
      }
    } catch {
      /* 忽略 */
    }
  }

  /* link：本地开发目录 */
  if (parsed.kind === 'link') {
    try {
      const target = (parsed.normalized ?? parsed.raw).replace(/^link:/, '')
      if (target && existsSync(target)) {
        const pkg = readLinkPkg(target)
        const name = typeof pkg?.name === 'string' ? pkg.name : null
        resolvedName = name ?? resolvedName
        resolvedVersion = typeof pkg?.version === 'string' ? pkg.version : null
        resolvedDescription = typeof pkg?.description === 'string' ? pkg.description : null
        isDshPlugin = declaresBundle(pkg)
        if (name) warnings.push(`本地开发目录已存在，将软链 ${name} 到 profile`)
        else warnings.push('这个目录没有可读的 package.json（缺 name），安装后可能无法加载')
      } else if (target) {
        warnings.push(`本地目录不存在：${target}`)
      }
    } catch {
      /* 忽略 */
    }
  }

  /* 已装过？ */
  let alreadyInstalled: string | null = null
  if (profileDir) {
    const probeName = resolvedName ?? parsed.packageName
    try {
      let installed = false
      try {
        installed = inventory.isInstalledPkg(profileDir, probeName ?? '')
      } catch {
        installed = false
      }
      if (!installed) {
        try {
          const list = await inventory.listPlugins(profile)
          const hit = probeName ? list.find((r) => r.name === probeName) : undefined
          if (hit) alreadyInstalled = `${hit.name}@${hit.version ?? '?'}`
        } catch {
          /* 清单读不到就不提示 */
        }
      } else if (probeName) {
        try {
          const list = await inventory.listPlugins(profile)
          const hit = list.find((r) => r.name === probeName)
          alreadyInstalled = hit ? `${hit.name}@${hit.version ?? '?'}` : `${probeName}@已安装`
        } catch {
          alreadyInstalled = `${probeName}@已安装`
        }
        warnings.push('这个包已经装过了，继续安装会按新 spec 覆盖版本')
      }
    } catch {
      /* 忽略 */
    }

    /* 没 node_modules 说明 profile 还没初始化，第一次会很慢 */
    try {
      if (!existsSync(path.join(profileDir, 'node_modules'))) {
        warnings.push('目标 profile 尚未安装依赖（没有 node_modules），首次安装会比较慢')
      }
      if (!existsSync(path.join(profileDir, 'package.json'))) {
        warnings.push('目标 profile 没有 package.json，安装时会新建一个')
      }
    } catch {
      /* 忽略 */
    }
  }

  /* 只有远端明确告诉我们它是不是 DSH 插件时才给 true；判断不了就是 false（不当报错） */
  if (!isDshPlugin && parsed.kind === 'npm') {
    warnings.push('这个仓库/包的元数据里看不到 dsh.bundle.patch，装完读本地 package.json 才能确认是不是加载层')
  }
  if (!isDshPlugin) {
    warnings.push('只有 package.json 里声明了 dsh.bundle.patch 的包才会进加载列表；否则装了也只是普通依赖，不会加载')
  }

  /* 去重，保持顺序 */
  const dedup: string[] = []
  for (const w of warnings) {
    if (!dedup.includes(w)) dedup.push(w)
  }

  return {
    parsed,
    resolvedName,
    resolvedVersion,
    resolvedDescription,
    isDshPlugin,
    alreadyInstalled,
    warnings: dedup,
    profile,
    error: null
  }
}

function readLinkPkg(dir: string): any | null {
  try {
    const file = path.join(dir, 'package.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/**
 * 这个包是不是「profile 层」（要不要进 `dsh.profile.bundles`）。
 *
 * 判据必须与官方 `bundleManifest()` 完全一致：包内 `package.json` 有
 * `dsh.bundle.patch` 才算——**不是**有没有 `dsh` 字段、**不是**包名像不像插件。
 * 拿 `dsh` 字段当判据会把纯依赖塞进加载列表，DSH 一装就报 "declares no
 * dsh.bundle"，或者干脆加载一个没有 patch 的包把 profile 弄坏。
 */
function declaresBundle(pkg: any): boolean {
  try {
    const bundle = pkg?.dsh?.bundle
    if (!bundle) return false
    if (typeof bundle === 'string') return bundle.trim() !== ''
    if (typeof bundle === 'object') {
      const patch = (bundle as Record<string, unknown>)['patch']
      if (typeof patch === 'string') return patch.trim() !== ''
      if (Array.isArray(patch)) return patch.length > 0
      return false
    }
    return false
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * runOp
 * ------------------------------------------------------------------ */

export async function runOp(req: OpRequest, hooks?: OpHooks): Promise<OpResult> {
  const opId = newOpId(hooks)
  const kind: OpKind = (req?.kind ?? 'repair') as OpKind
  const profile = typeof req?.profile === 'string' ? req.profile : ''
  const startedAt = Date.now()

  const ctx: Ctx = {
    opId,
    kind,
    profileDir: '',
    profile,
    startedAt,
    changes: [],
    lines: [],
    failed: false,
    cached: null
  }

  const post = (result: OpResult): OpResult => ({ ...result, opId, kind, profile, startedAt })

  active.set(opId, hooks)
  try {
    /* ---------- 公共前置：profile 目录 ---------- */
    let profileDir = ''
    try {
      profileDir = env.getProfileDir(profile)
    } catch (err) {
      return post(fail(ctx, hooks, `无法解析 profile 目录：${err instanceof Error ? err.message : String(err)}`))
    }
    ctx.profileDir = profileDir
    if (!profileDir || !existsSync(profileDir)) {
      return post(fail(ctx, hooks, `profile 目录不存在：${profileDir || profile}`))
    }

    logSystem(ctx, hooks, `profile：${profile} → ${profileDir}`)

    /* ---------- 公共前置：运行环境预检 ----------
     *
     * 只对「真的会调 pnpm、真的需要安装根」的操作设门禁：
     *   install / uninstall / update / update-all / repair / install-manifest
     *
     * **enable / disable 故意不在门禁里** —— 它们只动我们自己的 state 与 profile 的
     * bundles，不碰 node/pnpm。环境不完整时用户仍然该能「先把碍事的插件停掉」，
     * 把这条也拦住只会让人彻底没法自救。
     *
     * 为什么要有这道门：以前缺 node/pnpm 时是**每个包各自跑一遍、各自失败一次**，
     * 清单里 12 个包就刷 12 行一模一样的话（真实用户反馈的原图就是这样）。
     * 预检把同一个根因在动手之前拦下来，只报一次，并且带上可操作的建议。
     */
    const NEEDS_RUNTIME: OpKind[] = [
      'install',
      'uninstall',
      'update',
      'update-all',
      'repair',
      'install-manifest'
    ]
    if (NEEDS_RUNTIME.includes(kind)) {
      /* ★ 先补探一次，再判。
       *
       * 时序问题：用户在新电脑上打开插件台，界面刚出来就点「安装」—— 那一刻异步路由
       * （注册表 / 进程 / 快捷方式 / 磁盘扫描）还在跑，同步路由又一条都没中，于是
       * checkRuntime() 报「没找到安装目录」，安装直接被打回，而**两秒后环境其实已经齐了**。
       * 用户看到的是「装不了」，重试一次还是同一句 —— 因为他每次都在同一时间窗口里点。
       *
       * 补探有成本（可能起 PowerShell 扫盘），所以只在预检真的不过时才跑，
       * 而且跑完再判一次：还是不过就按原样报错，不会把失败藏起来。
       */
      let check = env.checkRuntime()
      if (!check.ok) {
        logSystem(ctx, hooks, `运行环境预检未通过（缺 ${check.missing ?? '未知'}），先自动补探一次…`)
        try {
          const { root } = await env.enrichInstallRoot()
          env.invalidate()
          if (root) logSystem(ctx, hooks, `补探命中安装根：${root}`)
        } catch (err) {
          logSystem(ctx, hooks, `补探异常：${err instanceof Error ? err.message : String(err)}`)
        }
        check = env.checkRuntime()
      }
      if (!check.ok) {
        logSystem(ctx, hooks, `运行环境预检未通过（缺 ${check.missing ?? '未知'}）：${check.message}`)
        if (check.fix) logSystem(ctx, hooks, check.fix)
        return post(fail(ctx, hooks, `${check.message}。${check.fix}`))
      }
    }

    /* ---------- 分派 ---------- */
    switch (kind) {
      case 'install':
        return post(await opInstall(ctx, hooks, req))
      case 'uninstall':
        return post(await opUninstall(ctx, hooks, req))
      case 'update':
        return post(await opUpdate(ctx, hooks, req, false))
      case 'update-all':
        return post(await opUpdate(ctx, hooks, req, true))
      case 'enable':
        return post(await opToggle(ctx, hooks, req, true))
      case 'disable':
        return post(await opToggle(ctx, hooks, req, false))
      case 'repair':
        return post(await opRepair(ctx, hooks))
      case 'install-manifest':
        return post(await opInstallManifest(ctx, hooks, req))
      default:
        return post(fail(ctx, hooks, `不认识的操作类型：${String(kind)}`))
    }
  } catch (err) {
    /* 兜底：任何漏网异常都在这里变成 ok:false */
    const message = err instanceof Error ? err.message : String(err)
    ctx.failed = true
    logSystem(ctx, hooks, `操作异常终止：${message}`)
    return post(finish(ctx, hooks, { ok: false, code: -1, message, restartRequired: false }))
  } finally {
    active.delete(opId)
  }
}

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

async function opInstall(ctx: Ctx, hooks: OpHooks | undefined, req: OpRequest): Promise<OpResult> {
  /* 1. 解析 spec */
  let parsed: ParsedSpec
  try {
    parsed = spec.parseSpec(req.spec ?? '')
  } catch (err) {
    return fail(ctx, hooks, `无法解析来源：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || parsed.ok !== true || !parsed.normalized) {
    return fail(ctx, hooks, parsed?.error ? `无法解析来源：${parsed.error}` : '无法解析来源，检查一下包名 / 仓库地址')
  }

  /* 2. 备份 package.json */
  const backup = backupProfilePkg(ctx.profileDir)
  logSystem(ctx, hooks, backup ? `已备份 package.json → ${backup}` : 'package.json 不存在，跳过备份')

  /* 3. before 快照 */
  const before = toSnapshot(await safeList(ctx.profile, ctx, hooks))
  const bundlesBefore = bundlesSnapshot(ctx.profileDir)

  /* 4. 跑 pnpm add（pnpm 自己会写 package.json） */
  /* 版本是**拼在 spec 里**传下来的，不单独占一个字段。
   * 上游 `installSpec` 收到的是 VersionPicker 的 `option.spec`，
   * 它已经是 `dsh-context@1.2.3` / `github:owner/repo#v1.0.0` 这种完整形态，
   * 所以这里原样交给 pnpm 就对。别再引入一个 version 字段 ——
   * 两处都能表达版本时，迟早出现「界面选 0.3.8、实际装 latest」这种哑火。 */
  logSystem(ctx, hooks, `开始安装：${parsed.normalized}`)
  const run = await runPnpmAddish(ctx, hooks, ['add', parsed.normalized])

  /* 5. 失败 → 中文摘要 */
  if (run.code !== 0) {
    const detail = run.timedOut
      ? '安装超时，已终止'
      : run.incompatible.length > 0
        ? `与当前 dsh 运行时不兼容，官方已拒绝安装（profile 未被改动）`
        : errorSummary(run.log)
    return fail(ctx, hooks, `安装失败（exit ${String(run.code)}）：${detail}`, run.code)
  }

  /* 6. after 快照 + diff */
  ctx.cached = null
  const after = toSnapshot(await safeList(ctx.profile, ctx, hooks))
  const added: string[] = []
  /** 本来就在、但这回换了版本的（降级 / 换版本都落这里）——摘要文案要能说出「换成了什么」 */
  const swapped: { name: string; from: string | null; to: string | null }[] = []
  for (const [name, version] of after) {
    if (!before.has(name)) {
      added.push(name)
      addChange(ctx, { name, from: null, to: version, action: 'added' })
      continue
    }
    const prev = before.get(name) ?? null
    if (prev !== version) {
      addChange(ctx, { name, from: prev, to: version, action: 'updated' })
      swapped.push({ name, from: prev, to: version })
    }
  }

  /* 7. 加载列表（bundles） */
  let bundled = 0
  if (run.official) {
    /*
     * 官方通道已经在 reconcile() 里按「有没有 dsh.bundle.patch」调和过 bundles，
     * 这里只报差异，不再手写——手写会和宿主的判断打架（判据不同）。
     */
    const diff = reportBundleDiff(ctx, hooks, bundlesBefore, bundlesSnapshot(ctx.profileDir))
    bundled = diff.added.length
  } else {
    const { forceBundle } = safeSettings()
    const records = await safeList(ctx.profile, ctx, hooks)
    for (const name of added) {
      const pkg = safeInstalledPkgJson(ctx.profileDir, name)
      const shouldBundle = declaresBundle(pkg) || forceBundle
      if (!shouldBundle) {
        logSystem(
          ctx,
          hooks,
          `${name} 装了但没进加载列表：它的 package.json 没有声明 dsh.bundle.patch，只会作为普通依赖存在`
        )
        continue
      }
      const okAdd = addBundle(ctx.profileDir, name)
      if (okAdd) {
        bundled += 1
        const rec = findRecord(records, name)
        addChange(ctx, {
          name,
          from: null,
          to: rec?.version ?? after.get(name) ?? null,
          action: 'bundled'
        })
        logSystem(ctx, hooks, `${name} 已加入加载列表，重启后加载`)
      } else {
        logSystem(ctx, hooks, `${name} 写入加载列表失败，请检查 profile 权限`)
      }
    }
  }

  /* 8. 之前在停用名单里的 → 重新装上就算启用 */
  try {
    const st = state.readConsoleState(ctx.profileDir)
    const disabled = { ...(st?.disabled ?? {}) }
    let dirty = false
    for (const name of added) {
      if (Object.prototype.hasOwnProperty.call(disabled, name)) {
        delete disabled[name]
        dirty = true
      }
    }
    if (dirty) {
      state.writeConsoleState(ctx.profileDir, { disabled, updatedAt: Date.now() })
      logSystem(ctx, hooks, '已从停用名单移除这些包')
    }
  } catch (err) {
    logSystem(ctx, hooks, `更新停用名单失败（不影响安装）：${err instanceof Error ? err.message : String(err)}`)
  }

  const loadedCount = bundled
  const message =
    added.length > 0
      ? loadedCount > 0
        ? `已安装 ${added.join('、')}，其中 ${loadedCount} 个进了加载列表`
        : `已安装 ${added.join('、')}，但没有包进加载列表（未声明 dsh.bundle.patch）`
      : swapped.length > 0
        ? `版本已替换：${swapped.map((s) => `${s.name} ${s.from ?? '?'} → ${s.to ?? '?'}`).join('、')}`
        : '安装命令跑完了，但这个包当前就已经是这个版本，没有变化'

  return finish(ctx, hooks, { ok: true, code: run.code, message, restartRequired: true })
}

function safeInstalledPkgJson(profileDir: string, name: string): any | null {
  try {
    return inventory.readInstalledPkgJson(profileDir, name)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * uninstall
 * ------------------------------------------------------------------ */

async function opUninstall(ctx: Ctx, hooks: OpHooks | undefined, req: OpRequest): Promise<OpResult> {
  const targets = Array.isArray(req.targets) ? req.targets.filter((t) => typeof t === 'string' && t !== '') : []
  if (targets.length === 0) return fail(ctx, hooks, '没有指定要卸载的包')

  const backup = backupProfilePkg(ctx.profileDir)
  logSystem(ctx, hooks, backup ? `已备份 package.json → ${backup}` : 'package.json 不存在，跳过备份')

  const before = toSnapshot(await safeList(ctx.profile, ctx, hooks))
  const bundlesBefore = bundlesSnapshot(ctx.profileDir)
  let failedCount = 0
  let removedCount = 0
  let sawOfficial = false

  /* 串行跑：任何一个失败都继续跑其余的 */
  for (const name of targets) {
    if (name.startsWith(OFFICIAL_PREFIX)) {
      logSystem(ctx, hooks, `官方内置包不允许卸载，已跳过：${name}`)
      continue
    }

    logSystem(ctx, hooks, `开始卸载：${name}`)
    const run = await runPnpmOp(ctx, hooks, ['remove', name])
    if (run.official) sawOfficial = true
    if (run.code !== 0) {
      failedCount += 1
      const detail = run.timedOut ? '卸载超时，已终止' : errorSummary(run.log)
      logSystem(ctx, hooks, `卸载失败：${name} —— ${detail}`)
      continue
    }

    removedCount += 1
    addChange(ctx, { name, from: before.get(name) ?? null, to: null, action: 'removed' })

    /* 官方通道的 reconcile() 已经把它从加载列表摘掉了，不要再动一次 */
    if (!run.official) {
      const okRemove = removeBundle(ctx.profileDir, name)
      if (!okRemove) logSystem(ctx, hooks, `${name} 已从 dependencies 移除，但加载列表清理失败`)
      else addChange(ctx, { name, from: null, to: null, action: 'unbundled' })
    }

    try {
      const st = state.readConsoleState(ctx.profileDir)
      const disabled = { ...(st?.disabled ?? {}) }
      if (Object.prototype.hasOwnProperty.call(disabled, name)) {
        delete disabled[name]
        state.writeConsoleState(ctx.profileDir, { disabled, updatedAt: Date.now() })
      }
    } catch (err) {
      logSystem(ctx, hooks, `清理停用名单失败（不影响卸载）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (sawOfficial) reportBundleDiff(ctx, hooks, bundlesBefore, bundlesSnapshot(ctx.profileDir))

  ctx.cached = null

  const ok = failedCount === 0
  const message =
    removedCount === 0 && failedCount === 0
      ? '没有可卸载的包（官方内置包已跳过）'
      : ok
        ? `已卸载 ${removedCount} 个包并同步加载列表`
        : `卸载完成：成功 ${removedCount} 个，失败 ${failedCount} 个`

  return finish(ctx, hooks, { ok, code: ok ? 0 : 1, message, restartRequired: true })
}

/* ------------------------------------------------------------------ *
 * update / update-all
 * ------------------------------------------------------------------ */

/**
 * 渲染层传来的「包名 → 版本」，只收看起来像版本号 / dist-tag 的值。
 *
 * 为什么要在主进程再校验一次：这个字符串会被拼成 `name@version` 当参数交给 pnpm，
 * 带空格或其它怪字符的东西进来了只会变成一个装不上的 spec（报一个和真实原因无关的错），
 * 还不如当作没给、退回「用清单里的 latestVersion 或者 @latest」那条路。
 */
function readPinnedVersions(raw: OpRequest['versions']): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw || typeof raw !== 'object') return out
  for (const [name, version] of Object.entries(raw)) {
    if (typeof name !== 'string' || name.trim() === '') continue
    if (typeof version !== 'string') continue
    const value = version.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value)) continue
    out.set(name, value)
  }
  return out
}

async function opUpdate(
  ctx: Ctx,
  hooks: OpHooks | undefined,
  req: OpRequest,
  all: boolean
): Promise<OpResult> {
  const records = await safeList(ctx.profile, ctx, hooks)
  const before = toSnapshot(records)

  /** 界面「最新版本」那一列写的是什么，就钉什么 */
  const pinned = readPinnedVersions(req.versions)

  const explicit = (Array.isArray(req.targets) ? req.targets : []).filter(
    (t) => typeof t === 'string' && t !== ''
  )

  /*
   * 记录池：磁盘清单打底，现场查到的结论覆盖。
   * 为什么不像以前那样直接拿 records 来判断「谁可更新」：磁盘清单里的 updateAvailable
   * 是 inventory 写死的 false（那要联网才知道），只会在还没检查过更新时恒为空集，
   * 于是「更新全部」永远报「没有可更新的插件」——这就是线上那次投诉。
   */
  const pool = new Map<string, PluginRecord>()
  for (const r of records) {
    if (r && typeof r.name === 'string' && r.name !== '') pool.set(r.name, r)
  }

  let targets: string[] = []
  if (explicit.length > 0) {
    /*
     * 前端给了名单就永远以它为准，哪怕 all 为真。
     * 「用户确认了什么就执行什么」是这里唯一的约定：确认弹窗里列了 6 个包、执行 6 个包，
     * 两个数字必须是同一批名字（以前前端一个目标都不传，主进程自己重算，两边可以完全不同）。
     */
    targets = Array.from(new Set(explicit))
  } else if (all) {
    /* 没有前端名单时的回退路径：现查一次才拿得到真实的可更新集合。
     * 这一步要联网、要几秒，先把话说出来，否则日志里会是一段无声的空白。 */
    logSystem(ctx, hooks, '界面没有指定要更新哪些包，先联网查一次可更新集合…')
    const checked = await updates.checkUpdates(ctx.profile, undefined)
    for (const [name, rec] of Object.entries(checked)) {
      if (rec && typeof rec.name === 'string') pool.set(rec.name, rec)
    }
    targets = Array.from(pool.values())
      .filter(
        (r) =>
          r.updateAvailable === true &&
          r.sourceKind !== 'link' &&
          r.sourceKind !== 'workspace' &&
          !r.builtin
      )
      .map((r) => r.name)
      .sort()
  }

  if (targets.length === 0) {
    if (all) {
      /*
       * 这里只有两种可能：确实没有可更新的，或者界面上的结论已经过期了。
       * 以前报 ok:true，用户看到「没有可更新的插件」一句绿字，会以为「更新跑过了」；
       * 那正是这次投诉里最误导人的一点 —— 判不了就别报成功，直接把下一步告进去。
       */
      return fail(
        ctx,
        hooks,
        '没有可更新的插件 —— 界面上的可更新列表可能已经过期，重新点一次「检查更新」再试'
      )
    }
    return finish(ctx, hooks, { ok: true, code: 0, message: '没有指定要更新的包', restartRequired: false })
  }

  const backup = backupProfilePkg(ctx.profileDir)
  logSystem(ctx, hooks, backup ? `已备份 package.json → ${backup}` : 'package.json 不存在，跳过备份')

  const installArgs: string[] = []
  const touched: string[] = []
  /** 界面上写着的「最新版本」，用来钉版本 + 事后核对 */
  const wanted = new Map<string, string>()
  const links: string[] = []

  for (const name of targets) {
    const rec = pool.get(name) ?? null
    if (!rec) {
      logSystem(ctx, hooks, `跳过 ${name}：清单里找不到这个包`)
      continue
    }
    if (rec.builtin) {
      logSystem(ctx, hooks, `跳过 ${name}：官方内置包随 DSH 发布，不能单独更新`)
      continue
    }
    if (rec.sourceKind === 'link' || rec.sourceKind === 'workspace') {
      links.push(name)
      continue
    }
    /*
     * npm → 钉到「界面上告诉用户的那个版本」，而不是 `@latest`。
     *
     * 三档优先：前端 pin 的版本（用户确认时看到的那一个，最确定）
     *          > 清单里的 latestVersion
     *          > 交给 pnpm 自己取 @latest（下面 unknownLatest 那段还会再补一次远端查询来升级它）。
     *
     * 原因：pnpm 11 的供应链策略会主动把「刚发布没多久」的版本压回旧版，
     * 于是 `@latest` 装出来的东西比那一行写的「可更新到 0.79.0」旧一档，
     * 用户点完更新发现按钮还亮着，体验直接崩。钉到具体版本既确定，
     * 又能在真被策略拦住时报错命中 ERR_PNPM_MINIMUM_RELEASE_AGE，
     * 走 runPnpmAddish 里的豁免重试那条路。
     * git / tarball → 重新解析同一个 spec。
     */
    const pin = pinned.get(name) ?? rec.latestVersion ?? null
    installArgs.push(rec.sourceKind === 'npm' ? `${name}@${pin ?? 'latest'}` : rec.spec)
    touched.push(name)
    if (rec.sourceKind === 'npm' && pin) wanted.set(name, pin)
  }

  /*
   * 清单是刚从磁盘读的，latestVersion 一律是 null（那要联网才知道）。
   * 更新要「钉版本」就得先补一次远端查询，否则 pin 永远是空的。
   * 走到这里的只剩「前端没给版本、清单里也没有」的 npm 包 —— 上面两档都插空了才轮到它。
   */
  const unknownLatest = touched.filter((n) => !wanted.has(n) && pool.get(n)?.sourceKind === 'npm')
  if (unknownLatest.length > 0) {
    try {
      const checked = await updates.checkUpdates(ctx.profile, unknownLatest)
      for (const [name, rec] of Object.entries(checked)) {
        if (rec.latestVersion) wanted.set(name, rec.latestVersion)
      }
      for (let i = 0; i < installArgs.length; i += 1) {
        const name = touched[i]
        const pin = name ? wanted.get(name) : undefined
        if (name && pin && installArgs[i] === `${name}@latest`) installArgs[i] = `${name}@${pin}`
      }
    } catch (err) {
      logSystem(ctx, hooks, `查远端版本失败（继续按 latest 更新）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /* 所有需要重装的包合并成一次 pnpm add */
  if (installArgs.length > 0) {
    const bundlesBefore = bundlesSnapshot(ctx.profileDir)
    logSystem(ctx, hooks, `开始更新 ${touched.length} 个包：${touched.join('、')}`)
    let run = await runPnpmAddish(ctx, hooks, ['add', ...installArgs])
    if (run.code !== 0) {
      const detail = run.timedOut
        ? '更新超时，已终止'
        : run.incompatible.length > 0
          ? '新版本与当前 dsh 运行时不兼容，官方已拒绝更新（版本保持不变）'
          : errorSummary(run.log)
      return fail(ctx, hooks, `更新失败（exit ${String(run.code)}）：${detail}`, run.code)
    }

    /*
     * 钉了版本也可能被 pnpm 的供应链冷却悄悄压回旧版（不报错，直接降级）。
     * 这是「点了更新但版本没到位」的唯一成因，替它加一次精确豁免再补一遍，
     * 并把发生了什么写进日志 —— 用户明确点过更新，这一下是他要的。
     */
    ctx.cached = null
    let afterRecords = await safeList(ctx.profile, ctx, hooks)
    const stuck = touched.filter((name) => {
      const want = wanted.get(name)
      const got = findRecord(afterRecords, name)?.version ?? null
      return Boolean(want && got && compareVersions(got, want) < 0)
    })
    if (stuck.length > 0) {
      const keys = stuck.map((name) => `${name}@${wanted.get(name)}`)
      const fix = profileYaml.ensureReleaseAgeExclude(ctx.profileDir, keys)
      if (fix.ok && fix.added.length > 0) {
        logSystem(
          ctx,
          hooks,
          `pnpm 的供应链冷却策略把 ${keys.join('、')} 压回了旧版本，已写入 minimumReleaseAgeExclude，再补一次`
        )
        const retry = await runPnpmAddish(
          ctx,
          hooks,
          ['add', ...stuck.map((name) => `${name}@${wanted.get(name)}`)]
        )
        if (retry.code === 0) {
          run = retry
          ctx.cached = null
          afterRecords = await safeList(ctx.profile, ctx, hooks)
        } else {
          logSystem(ctx, hooks, `补装失败，版本停在当前值：${errorSummary(retry.log)}`)
        }
      } else if (!fix.ok) {
        logSystem(ctx, hooks, `写 minimumReleaseAgeExclude 失败：${fix.error ?? '未知原因'}`)
      }
    }

    for (const name of touched) {
      const from = before.get(name) ?? null
      const to = findRecord(afterRecords, name)?.version ?? from
      const changed = from !== to
      addChange(ctx, { name, from, to, action: changed ? 'updated' : 'unchanged' })
      const want = wanted.get(name)
      const short = want && to && compareVersions(to, want) < 0 ? `（远端最新 ${want}，pnpm 供应链策略只给到 ${to}）` : ''
      logSystem(ctx, hooks, changed ? `${name}：${from ?? '(未知)'} → ${to ?? '(未知)'}${short}` : `${name}：已是最新（${from ?? '未知'}）`)
    }
    if (run.official) reportBundleDiff(ctx, hooks, bundlesBefore, bundlesSnapshot(ctx.profileDir))
  }

  /* link 类型走 pnpm install 重新对齐软链 */
  if (links.length > 0) {
    logSystem(ctx, hooks, `本地链接包走重连（pnpm install）：${links.join('、')}`)
    const run = await runPnpmAddish(ctx, hooks, ['install'])
    if (run.code !== 0) {
      logSystem(ctx, hooks, `链接包重连失败：${errorSummary(run.log)}`)
    } else {
      for (const name of links) {
        addChange(ctx, { name, from: before.get(name) ?? null, to: before.get(name) ?? null, action: 'unchanged' })
      }
    }
  }

  const updated = ctx.changes.filter((c) => c.action === 'updated')
  const message =
    updated.length > 0
      ? `已更新 ${updated.length} 个包：${updated.map((c) => c.name).join('、')}`
      : '更新命令执行完成，版本没有变化（可能已经是最新）'

  return finish(ctx, hooks, { ok: true, code: 0, message, restartRequired: true })
}

/* ------------------------------------------------------------------ *
 * enable / disable
 * ------------------------------------------------------------------ */

async function opToggle(
  ctx: Ctx,
  hooks: OpHooks | undefined,
  req: OpRequest,
  enable: boolean
): Promise<OpResult> {
  const targets = Array.isArray(req.targets) ? req.targets.filter((t) => typeof t === 'string' && t !== '') : []
  if (targets.length === 0) return fail(ctx, hooks, enable ? '没有指定要启用的包' : '没有指定要停用的包')

  const backup = backupProfilePkg(ctx.profileDir)
  logSystem(ctx, hooks, backup ? `已备份 package.json → ${backup}` : 'package.json 不存在，跳过备份')

  /* 读一次 state，全程在内存里改，最后一次写盘 */
  let disabledMap: Record<string, number | null> = {}
  try {
    const st = state.readConsoleState(ctx.profileDir)
    disabledMap = st && st.disabled && typeof st.disabled === 'object' ? { ...st.disabled } : {}
  } catch (err) {
    logSystem(ctx, hooks, `读取停用名单失败（按空处理）：${err instanceof Error ? err.message : String(err)}`)
    disabledMap = {}
  }

  let okCount = 0
  let failCount = 0

  for (const name of targets) {
    if (enable) {
      /* 取回移出时的原下标 */
      const rawIdx = Object.prototype.hasOwnProperty.call(disabledMap, name) ? disabledMap[name] : undefined
      const at = typeof rawIdx === 'number' && rawIdx >= 0 ? rawIdx : undefined
      const okAdd = addBundle(ctx.profileDir, name, at)
      if (!okAdd) {
        failCount += 1
        logSystem(ctx, hooks, `启用失败（写 bundles 失败）：${name}`)
        continue
      }
      delete disabledMap[name]
      okCount += 1
      addChange(ctx, { name, from: null, to: null, action: 'bundled' })
      logSystem(
        ctx,
        hooks,
        at === undefined ? `${name} 已加入加载列表（末尾）` : `${name} 已加入加载列表（恢复原位置 ${at}）`
      )
    } else {
      const index = bundleIndexOf(ctx.profileDir, name)
      const okRemove = removeBundle(ctx.profileDir, name)
      if (!okRemove) {
        failCount += 1
        logSystem(ctx, hooks, `停用失败（写 bundles 失败）：${name}`)
        continue
      }
      disabledMap[name] = index >= 0 ? index : null
      okCount += 1
      addChange(ctx, { name, from: null, to: null, action: 'unbundled' })
      logSystem(ctx, hooks, `${name} 已移出加载列表（原位置 ${index >= 0 ? index : '未知'}）`)
    }
  }

  try {
    state.writeConsoleState(ctx.profileDir, { disabled: disabledMap, updatedAt: Date.now() })
  } catch (err) {
    logSystem(ctx, hooks, `写入停用名单失败（不影响本次改动）：${err instanceof Error ? err.message : String(err)}`)
  }

  const verb = enable ? '启用' : '停用'
  const ok = failCount === 0 && okCount > 0
  const message =
    okCount === 0 ? `${verb}失败：没有生效的包` : failCount === 0 ? `已${verb} ${okCount} 个包` : `${verb}完成：成功 ${okCount} 个，失败 ${failCount} 个`

  return finish(ctx, hooks, { ok, code: ok ? 0 : 1, message, restartRequired: true })
}

/* ------------------------------------------------------------------ *
 * repair
 * ------------------------------------------------------------------ */

async function opRepair(ctx: Ctx, hooks: OpHooks | undefined): Promise<OpResult> {
  backupProfilePkg(ctx.profileDir)

  if (!existsSync(path.join(ctx.profileDir, 'package.json'))) {
    return fail(ctx, hooks, 'profile 没有 package.json，无法对齐依赖（先用 pnpm add 装一个插件）')
  }

  logSystem(ctx, hooks, '按 package.json 重新对齐依赖（pnpm install）')
  const run = await runPnpmAddish(ctx, hooks, ['install'], 15 * 60 * 1000)
  ctx.cached = null

  if (run.code !== 0) {
    const detail = run.timedOut ? '对齐超时，已终止' : errorSummary(run.log)
    return fail(ctx, hooks, `依赖对齐失败（exit ${String(run.code)}）：${detail}`, run.code)
  }

  return finish(ctx, hooks, {
    ok: true,
    code: run.code,
    message: '依赖已按 package.json 重新对齐',
    restartRequired: true
  })
}

/* ------------------------------------------------------------------ *
 * install-manifest：按插件清单批量安装
 * ------------------------------------------------------------------ */

/**
 * 把一份导出的插件清单装回来。
 *
 * 和单个 install 的差别：
 *   - 一次 `pnpm add` 带上所有缺的包（15 分钟超时，批量装本来就慢），
 *     失败再降级成逐个装，尽量把能装的都装上；
 *   - 装完按清单里缺的那些包逐个记 change，present 的直接跳过不报错。
 */
async function opInstallManifest(
  ctx: Ctx,
  hooks: OpHooks | undefined,
  req: OpRequest
): Promise<OpResult> {
  /* 1. 清单文本 */
  const text = typeof req.spec === 'string' ? req.spec : ''
  if (!text.trim()) {
    return fail(ctx, hooks, '没有提供清单内容')
  }

  /* 2. 预览：算出缺哪些、要交给 pnpm 什么 spec */
  const pv = await manifest.preview(ctx.profile, text)
  if (!pv.ok) {
    return fail(ctx, hooks, pv.error ?? '清单解析失败')
  }

  /* 3. 全都装过了 */
  if (pv.missing.length === 0) {
    if (pv.total === 0) {
      logSystem(ctx, hooks, '清单里没有任何插件条目，无需安装')
      return finish(ctx, hooks, {
        ok: true,
        code: 0,
        message: '清单里没有插件，无需安装',
        restartRequired: false
      })
    }
    logSystem(ctx, hooks, `清单里共 ${pv.total} 个包，当前 profile 都已经装了，无需改动`)
    return finish(ctx, hooks, {
      ok: true,
      code: 0,
      message: `清单里的 ${pv.total} 个包都已经装过了，没有需要安装的`,
      restartRequired: false
    })
  }

  /* 4. 把预览里的提醒都写进日志，别让用户对着界面猜 */
  for (const w of pv.warnings) logSystem(ctx, hooks, `提醒：${w}`)

  logSystem(
    ctx,
    hooks,
    `清单里共 ${pv.total} 个包，跳过 ${pv.present.length} 个已装的，本次安装 ${pv.missing.length} 个`
  )
  for (const s of pv.specs) logSystem(ctx, hooks, `  待安装：${s}`)

  /* 5. 备份 package.json */
  const backup = backupProfilePkg(ctx.profileDir)
  logSystem(ctx, hooks, backup ? `已备份 package.json → ${backup}` : 'package.json 不存在，跳过备份')

  const bundlesBefore = bundlesSnapshot(ctx.profileDir)

  /* 6. 一次性批量安装 */
  logSystem(ctx, hooks, `开始批量安装 ${pv.missing.length} 个插件`)
  const run = await runPnpmAddish(ctx, hooks, ['add', ...pv.specs], 15 * 60 * 1000)
  let official = run.official

  /** 逐个安装阶段收集到的失败明细 */
  const failed: Array<{ name: string; detail: string }> = []

  if (run.code !== 0) {
    /* 批量失败 → 降级逐个装，尽量救回能装的 */
    if (pv.specs.length > 1) {
      logSystem(
        ctx,
        hooks,
        `批量安装失败（exit ${String(run.code)}）：${run.timedOut ? '安装超时，已终止' : errorSummary(run.log)}`
      )
      logSystem(ctx, hooks, '降级为逐个安装，能装的先装上')

      for (let i = 0; i < pv.missing.length; i++) {
        const entry = pv.missing[i]
        if (!entry) continue
        const specOne = manifest.specsOf([entry])[0] ?? entry.name
        logSystem(ctx, hooks, `逐个安装：${specOne}`)
        const one = await runPnpmAddish(ctx, hooks, ['add', specOne], 15 * 60 * 1000)
        official = official || one.official
        if (one.code === 0) continue
        const detail = one.timedOut
          ? '安装超时，已终止'
          : one.incompatible.length > 0
            ? '与当前 dsh 运行时不兼容，官方已拒绝安装（profile 未被改动）'
            : errorSummary(one.log)
        failed.push({ name: entry.name, detail })
        logSystem(ctx, hooks, `${entry.name} 安装失败：${detail}`)
      }
    } else {
      /* 只有一个包，按 install 分支的方式直接报错 */
      const detail = run.timedOut
        ? '安装超时，已终止'
        : run.incompatible.length > 0
          ? '与当前 dsh 运行时不兼容，官方已拒绝安装（profile 未被改动）'
          : errorSummary(run.log)
      return fail(ctx, hooks, `清单导入失败（exit ${String(run.code)}）：${detail}`, run.code)
    }
  }

  /* 7. 刷新记录 + 记 change（只记清单里缺的那些） */
  ctx.cached = null
  const after = toSnapshot(await safeList(ctx.profile, ctx, hooks))

  const installedNames: string[] = []
  for (const entry of pv.missing) {
    if (failed.some((f) => f.name === entry.name)) continue
    if (!after.has(entry.name)) {
      /* 装是装了，但没在 node_modules 里看到它 —— 也算失败，别谎报成功 */
      failed.push({ name: entry.name, detail: '安装命令跑完了，但 node_modules 里没找到它' })
      continue
    }
    const version = after.get(entry.name) ?? null
    installedNames.push(entry.name)
    addChange(ctx, { name: entry.name, from: null, to: version, action: 'added' })
  }

  /* 8. 加载列表（bundles） */
  let bundled = 0
  if (official) {
    /* 官方通道已经在 reconcile() 里调和过 bundles，这里只报差异 */
    const diff = reportBundleDiff(ctx, hooks, bundlesBefore, bundlesSnapshot(ctx.profileDir))
    bundled = diff.added.length
  } else {
    const { forceBundle } = safeSettings()
    const records = await safeList(ctx.profile, ctx, hooks)
    for (const name of installedNames) {
      const pkg = safeInstalledPkgJson(ctx.profileDir, name)
      const shouldBundle = declaresBundle(pkg) || forceBundle
      if (!shouldBundle) {
        logSystem(
          ctx,
          hooks,
          `${name} 装了但没进加载列表：它的 package.json 没有声明 dsh.bundle.patch，只会作为普通依赖存在`
        )
        continue
      }
      const okAdd = addBundle(ctx.profileDir, name)
      if (okAdd) {
        bundled += 1
        const rec = findRecord(records, name)
        addChange(ctx, {
          name,
          from: null,
          to: rec?.version ?? after.get(name) ?? null,
          action: 'bundled'
        })
        logSystem(ctx, hooks, `${name} 已加入加载列表，重启后加载`)
      } else {
        logSystem(ctx, hooks, `${name} 写入加载列表失败，请检查 profile 权限`)
      }
    }
  }

  /* 9. 之前被停用的 → 重新装上就算启用 */
  try {
    const st = state.readConsoleState(ctx.profileDir)
    const disabled = { ...(st?.disabled ?? {}) }
    let dirty = false
    for (const name of installedNames) {
      if (Object.prototype.hasOwnProperty.call(disabled, name)) {
        delete disabled[name]
        dirty = true
      }
    }
    if (dirty) {
      state.writeConsoleState(ctx.profileDir, { disabled, updatedAt: Date.now() })
      logSystem(ctx, hooks, '已从停用名单移除这些包')
    }
  } catch (err) {
    logSystem(
      ctx,
      hooks,
      `更新停用名单失败（不影响安装）：${err instanceof Error ? err.message : String(err)}`
    )
  }

  /* 10. 结果 */
  if (failed.length > 0) {
    ctx.failed = true

    /*
     * 失败原因要按「原因」聚合，不能按「包」平铺。
     *
     * 真实事故：一台没探测到 DSH 安装根的电脑上，清单里 12 个包**每一个**都失败在
     * 同一句「找不到 DSH 自带的 node/pnpm」上，弹窗于是刷了 12 行一模一样的话 ——
     * 用户能拿到的信息量等于 1 行，却得读 12 行才能确认「原来它们都一样」。
     *
     * 所以这里做两件事：
     *   ① 界面文案按原因归并，同一个原因只出现一次，后面跟受影响的包名（太多就截断）；
     *   ② 每条明细仍然逐条进操作日志 —— 「界面折叠」和「信息丢失」是两回事。
     */
    const byDetail = new Map<string, string[]>()
    for (const f of failed) {
      const key = f.detail.trim() || '未知原因'
      const list = byDetail.get(key)
      if (list) list.push(f.name)
      else byDetail.set(key, [f.name])
    }

    const MAX_REASONS = 3
    const MAX_NAMES = 6
    const nameList = (names: string[]): string =>
      names.length <= MAX_NAMES
        ? names.join('、')
        : `${names.slice(0, MAX_NAMES).join('、')} 等 ${names.length} 个`

    const reasons = [...byDetail.entries()].map(([detail, names]) => `${detail}（${nameList(names)}）`)
    const shown = reasons.slice(0, MAX_REASONS).join('；')
    const rest =
      reasons.length > MAX_REASONS ? `；另有 ${reasons.length - MAX_REASONS} 类不同原因，见操作日志` : ''

    for (const f of failed) logSystem(ctx, hooks, `✗ ${f.name}：${f.detail}`)

    const message =
      `清单导入：${installedNames.length} 个装好，${failed.length} 个失败（${shown}${rest}）`
    return finish(ctx, hooks, { ok: false, code: run.code ?? 1, message, restartRequired: true })
  }

  const loadedText =
    bundled > 0
      ? `，其中 ${bundled} 个进了加载列表`
      : '，但没有包进加载列表（未声明 dsh.bundle.patch）'
  const message =
    installedNames.length > 0
      ? `已从清单安装 ${installedNames.length} 个插件：${installedNames.join('、')}${loadedText}`
      : '清单导入完成，但没有检测到新的包'

  return finish(ctx, hooks, { ok: true, code: run.code, message, restartRequired: true })
}

/* ------------------------------------------------------------------ *
 * 小导出：给 UI / 别的模块用
 * ------------------------------------------------------------------ */

/** 当前 profile 的 bundles 快照（只读） */
export function currentBundles(profileDir: string): string[] {
  try {
    return getBundles(profileDir)
  } catch {
    return []
  }
}

/** 当前 profile 的 package.json（只读） */
export function currentProfilePkg(profileDir: string): any | null {
  try {
    return readProfilePkg(profileDir)
  } catch {
    return null
  }
}
