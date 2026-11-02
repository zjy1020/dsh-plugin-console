/**
 * engine/provision.ts —— 把 DSH 随包的运行时补进 <DSH_HOME>。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────────────
 * 插件台装包只需要两样东西：一个 node.exe 和一个 pnpm 入口，它们都在
 * `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies` 里。
 * 这两样不是我们装的，是 DSH 桌面端第一次启动时自己展开的。
 *
 * 于是新电脑上就有一个死结：用户装好了 DSH 桌面端、也可能打开过，
 * 但只要 `dsh-runtimes` 还没展开（第一次启动没跑完 / DSH_HOME 指到了别处 /
 * 用户把 .dsh 删了重来），插件台就只会说「装不了插件：缺 pnpm」，
 * 然后把用户扔回「你自己去开一下 DSH」—— 而用户很可能正是**为了装插件**才打开插件台的。
 *
 * 我们手边其实一直有那份载荷：`<安装根>/resources/runtime/primary-runtime`。
 * DSH 桌面端启动时干的就是「把它拷到 DSH_HOME 下」，逻辑在
 * `@deepseek-ai/dsh-tool-workspace-dependencies` 的 `installPrimaryRuntime()` 里。
 * 这里做同一件事，只是把过程摊开给用户看（多大、拷到哪、到哪一步了）。
 *
 * ── 为什么自己写而不 import 官方那个模块 ─────────────────────────────────
 * 它在 `resources/app/dsh/node_modules` 里 —— 那是 DSH 自己的包树，随版本变路径、
 * 打包后还压在 asar 里。而这件事的全部逻辑就是「比对 runtime.json → 拷到临时目录
 * → 校验 → 换名替换」，不到一百行，自己写反而能保证跨版本可用。
 *
 * ── 几条不肯让步的规矩 ──────────────────────────────────────────────────
 * 1. **先 staging 再换名**。直接往目标目录里拷，拷到一半失败就留下一个半坏的运行时，
 *    比没有更糟：下次探测会认为「有 dsh-runtimes」而去找里面的 node，然后找不到。
 * 2. **目标目录不能是符号链接**（官方 `exists()` 里也是这么挡的）。顺着链接写会写到
 *    用户的别的地方去，而且我们事后无法判断到底写了哪。
 * 3. **幂等**。runtime.json 与源一致就直接返回，一个字节都不拷 —— 用户点第二次
 *    「补全」不该再等十几秒。
 * 4. **进度必须是真的**。257 MB / 六千多个文件，实测十几秒；没有进度的按钮和卡死
 *    没有区别。所以这里不用 `fs.cp`（它不给回调），改成先走一遍算出总量、再逐个拷。
 */

import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  ProvisionProgress,
  ProvisionResult,
  RuntimePartSize,
  RuntimePayloadPart,
  RuntimeSourceInfo
} from '../../shared/types'
import { diag } from '../diagnostics'
import * as env from './env'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 目标目录名（与 DSH 桌面端写死的那个一致，别改） */
const RUNTIME_DIR = 'dsh-primary-runtime'
const RUNTIME_JSON = 'runtime.json'
/** 只拷了部分载荷时留的记号：告诉下一次「这份是我们拷的、拷了哪几块」 */
const MARKER = '.dsh-console-provision.json'

const ALL_PARTS: RuntimePayloadPart[] = ['node', 'pnpm', 'python']

/** 每块载荷在 dependencies 下的目录名 */
const PART_DIR: Record<RuntimePayloadPart, string> = {
  node: 'dependencies/node',
  pnpm: 'dependencies/pnpm',
  python: 'dependencies/python'
}

/** 每块载荷「拷完怎么算成功」的那个文件 */
function partProbe(part: RuntimePayloadPart): string {
  const win = process.platform === 'win32'
  if (part === 'node') return win ? 'dependencies/node/bin/node.exe' : 'dependencies/node/bin/node'
  if (part === 'pnpm') return 'dependencies/pnpm/bin/pnpm.cjs'
  return win ? 'dependencies/python/python.exe' : 'dependencies/python/bin/python3'
}

/* ------------------------------------------------------------------ *
 * runtime.json
 * ------------------------------------------------------------------ */

/**
 * 官方 runtime.json 的形状（`parsePrimaryRuntime` 归一化之后的）。
 *
 * 这里只做我们真正用得到的校验，不照抄官方那套严格规则：
 * 官方要校验 `payloadDigest` 的 64 位 hex、pythonPackages 的去重归一化等等，
 * 那些是「防止有人拿坏载荷骗过安装器」的。我们的用途是「判断这份和那份是不是同一版」，
 * 比 platform / arch / desktopVersion / 三个版本号就够 —— 比对得越宽，越不会因为
 * 官方加了个字段就误判成「不是同一份」而重拷 257 MB。
 */
interface RuntimeManifest {
  desktopVersion: string
  platform: string
  arch: string
  python: string
  node?: string
  pnpm?: string
  pythonPackages?: Record<string, string>
}

function asVersion(v: unknown): string | null {
  return typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v) ? v : null
}

async function readManifest(dir: string): Promise<{ manifest: RuntimeManifest | null; problem: string | null }> {
  let raw: string
  try {
    raw = await readFile(join(dir, RUNTIME_JSON), 'utf8')
  } catch {
    return { manifest: null, problem: `这个目录里没有 ${RUNTIME_JSON}` }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { manifest: null, problem: `${RUNTIME_JSON} 不是合法 JSON` }
  }
  const platform = typeof parsed.platform === 'string' ? parsed.platform : ''
  const arch = typeof parsed.arch === 'string' ? parsed.arch : ''
  const desktopVersion = typeof parsed.desktopVersion === 'string' ? parsed.desktopVersion : ''
  const python = asVersion(parsed.python)
  if (!desktopVersion) return { manifest: null, problem: `${RUNTIME_JSON} 缺 desktopVersion` }
  if (!python) return { manifest: null, problem: `${RUNTIME_JSON} 里的 python 版本不合法` }
  const manifest: RuntimeManifest = {
    desktopVersion,
    platform,
    arch,
    python,
    node: asVersion(parsed.node) ?? undefined,
    pnpm: asVersion(parsed.pnpm) ?? undefined,
    pythonPackages:
      parsed.pythonPackages && typeof parsed.pythonPackages === 'object'
        ? (parsed.pythonPackages as Record<string, string>)
        : undefined
  }
  return { manifest, problem: null }
}

/**
 * 「是不是同一份」的判据。
 *
 * 刻意**不**比 payloadDigest：那个是官方用来校验完整性的，我们拷的是同一台机器上
 * 同一个安装目录里的文件，digest 一样是常态、不一样说明源被动过（那时确实该重拷）。
 * 但更常见的情况是「DSH 升级了、desktopVersion 变了、载荷内容其实没变」——
 * 那种时候重拷 257 MB 是纯粹的浪费。所以只比版本号三元组。
 */
function sameManifest(a: RuntimeManifest | null, b: RuntimeManifest | null): boolean {
  if (!a || !b) return false
  return (
    a.desktopVersion === b.desktopVersion &&
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.python === b.python &&
    (a.node ?? '') === (b.node ?? '') &&
    (a.pnpm ?? '') === (b.pnpm ?? '')
  )
}

/* ------------------------------------------------------------------ *
 * 走一遍源目录：算总量 + 分块体积 + 逐条拷贝计划
 * ------------------------------------------------------------------ */

interface PlannedEntry {
  rel: string
  kind: 'file' | 'dir'
  size: number
}

interface Plan {
  entries: PlannedEntry[]
  totalBytes: number
  totalFiles: number
  parts: Record<RuntimePayloadPart, RuntimePartSize>
}

function emptyPart(): RuntimePartSize {
  return { bytes: 0, files: 0 }
}

/**
 * 有界遍历。
 *
 * 为什么不用 `readdir({recursive:true})`：我们需要每条的大小（算进度总量）和
 * 每块载荷的分项体积（告诉用户 python 占了 146 MB），一次遍历同时拿到三样最省。
 *
 * 符号链接：Windows 的载荷里实测 0 条，但 POSIX 上有（python 的 python / python3
 * 两个别名）。这里**按链接指向的实际内容算**（dereference），并用 realpath 集合
 * 防环 —— 拷完之后目标目录里是实体文件，不依赖源还在不在。
 */
async function planCopy(sourceDir: string, parts: RuntimePayloadPart[]): Promise<Plan> {
  const entries: PlannedEntry[] = []
  const parts_ = { node: emptyPart(), pnpm: emptyPart(), python: emptyPart() }
  const seen = new Set<string>()
  let totalBytes = 0
  let totalFiles = 0

  const stack: Array<{ abs: string; rel: string }> = []
  for (const part of parts) {
    const dir = join(sourceDir, PART_DIR[part])
    stack.push({ abs: dir, rel: PART_DIR[part] })
    entries.push({ rel: PART_DIR[part], kind: 'dir', size: 0 })
  }

  while (stack.length) {
    const cur = stack.pop()
    if (!cur) continue
    let real: string
    try {
      real = await realpath(cur.abs)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)

    let kids: string[]
    try {
      kids = await readFileDir(cur.abs)
    } catch {
      continue
    }
    for (const name of kids) {
      const abs = join(cur.abs, name)
      const rel = `${cur.rel}/${name}`
      let info
      try {
        info = await lstat(abs)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) {
        /* 顺着链接取真实条目：目标目录里要的是实体文件，不能留一条指向源目录的链接
         * （源目录在 D 盘的安装根下，用户哪天卸了 DSH 就断了）。 */
        try {
          info = await stat(abs)
        } catch {
          continue
        }
      }
      if (info.isDirectory()) {
        entries.push({ rel, kind: 'dir', size: 0 })
        stack.push({ abs, rel })
      } else if (info.isFile()) {
        entries.push({ rel, kind: 'file', size: info.size })
        totalBytes += info.size
        totalFiles += 1
        for (const part of parts) {
          if (rel.startsWith(`${PART_DIR[part]}/`)) {
            parts_[part].bytes += info.size
            parts_[part].files += 1
            break
          }
        }
      }
    }
  }

  return { entries, totalBytes, totalFiles, parts: parts_ }
}

/** readdir 的薄封装（单独抽出来是为了在 planCopy 里集中处理异常） */
async function readFileDir(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return readdir(dir)
}

/* ------------------------------------------------------------------ *
 * 找源
 * ------------------------------------------------------------------ */

/**
 * 源目录的候选。
 *
 * 1. `<安装根>/resources/runtime/primary-runtime` —— 官方用的就是这条
 * 2. `<安装根>/resources/app/runtime/primary-runtime` —— 本机实测 `resources/app/runtime`
 *    是指向 `resources/runtime` 的链接，某些打包姿势下两者位置会反过来
 *
 * 没有第三条。**不去猜别的安装位置**：安装根本身就是探测出来的（设置 / 注册表 /
 * 快捷方式 / 进程 / 磁盘扫描），猜错了会把一份来路不明的载荷拷进用户的 .dsh，
 * 那种错误比「找不到源」难查一百倍。
 */
async function sourceCandidates(): Promise<Array<{ dir: string; from: string }>> {
  const root = env.getInstallRoot()
  if (!root) return []
  return [
    { dir: join(root, 'resources', 'runtime', 'primary-runtime'), from: `安装根：${root}` },
    { dir: join(root, 'resources', 'app', 'runtime', 'primary-runtime'), from: `安装根（app 侧）：${root}` }
  ]
}

/** 目标：<DSH_HOME>/dsh-runtimes/dsh-primary-runtime */
export function runtimeTarget(): string {
  return join(env.getDshHome(), 'dsh-runtimes', RUNTIME_DIR)
}

async function readMarker(dir: string): Promise<{ manifest: RuntimeManifest | null; parts: RuntimePayloadPart[] } | null> {
  try {
    const text = await readFile(join(dir, MARKER), 'utf8')
    const parsed = JSON.parse(text) as { manifest?: RuntimeManifest; parts?: RuntimePayloadPart[] }
    const parts = Array.isArray(parsed.parts) ? parsed.parts.filter((p) => ALL_PARTS.includes(p)) : []
    return { manifest: parsed.manifest ?? null, parts }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 对外：这份载荷能不能用、要拷多少
 * ------------------------------------------------------------------ */

/**
 * 「能不能补」的短缓存。
 *
 * 为什么要缓存：`inspectRuntimeSource` 里要跑一次 `planCopy` —— 那是对 6135 个文件
 * 逐个 realpath + lstat。实测冷跑要将近一秒。而引导卡和安装页空态**各挂一个**
 * RuntimeProvision，两边一前一后都问一次，于是第二个会白等一秒、期间什么都不画
 * （组件在 loading 且没有 info 时返回 null）。用户看到的是「这块区域先是空的、
 * 过一会儿才冒出来」，很像卡了一下。
 *
 * 4 秒足够覆盖「同一屏里两处同时问」，又短到不会让用户改完目录还看到旧结论 ——
 * 真改完目录时走的是 `env.invalidate()` + 重新探测，那条路会在 provision 结束时清缓存。
 */
const INSPECT_TTL_MS = 4_000
let inspectCache: { at: number; key: string; value: RuntimeSourceInfo } | null = null

/** 清掉缓存（补全成功、或环境变了之后必须调，否则界面还拿着旧结论） */
export function invalidateInspect(): void {
  inspectCache = null
}

export async function inspectRuntimeSource(opts?: { deep?: boolean }): Promise<RuntimeSourceInfo> {
  const target = runtimeTarget()
  const key = `${env.getInstallRoot() ?? ''}|${env.getDshHome()}|${target}|${opts?.deep ? 'd' : 's'}`
  if (inspectCache && inspectCache.key === key && Date.now() - inspectCache.at < INSPECT_TTL_MS) {
    return inspectCache.value
  }
  const value = await inspectRuntimeSourceUncached(opts)
  inspectCache = { at: Date.now(), key, value }
  return value
}

async function inspectRuntimeSourceUncached(opts?: { deep?: boolean }): Promise<RuntimeSourceInfo> {
  const target = runtimeTarget()
  const empty: RuntimeSourceInfo = {
    ok: false,
    dir: null,
    from: null,
    target,
    desktopVersion: null,
    platform: null,
    arch: null,
    node: null,
    pnpm: null,
    python: null,
    total: emptyPart(),
    parts: { node: emptyPart(), pnpm: emptyPart(), python: emptyPart() },
    upToDate: false,
    problem: null
  }

  if (opts?.deep && !env.getInstallRoot()) {
    try {
      await env.enrichInstallRoot()
      env.invalidate()
    } catch {
      /* 富化失败不影响下面的判断：没有安装根就是没有源 */
    }
  }

  const candidates = await sourceCandidates()
  if (candidates.length === 0) {
    return {
      ...empty,
      problem:
        '没找到 DSH 桌面端的安装目录，所以拿不到随包的运行时载荷。先在上面「手动指定 .dsh 目录…」或者到设置里把安装根指对，再回来点这个。'
    }
  }

  let firstProblem: string | null = null
  for (const cand of candidates) {
    let exists = false
    try {
      exists = (await stat(cand.dir)).isDirectory()
    } catch {
      exists = false
    }
    if (!exists) {
      firstProblem ??= `这个安装目录下没有随包运行时：${cand.dir}`
      continue
    }

    const { manifest, problem } = await readManifest(cand.dir)
    if (!manifest) {
      firstProblem ??= problem ?? `${cand.dir} 里的 ${RUNTIME_JSON} 读不出来`
      continue
    }
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
      firstProblem ??= `这份载荷是 ${manifest.platform}/${manifest.arch} 的，跟本机 ${process.platform}/${process.arch} 不匹配`
      continue
    }

    const plan = await planCopy(cand.dir, ALL_PARTS)
    if (plan.totalFiles === 0) {
      firstProblem ??= `${cand.dir} 里没找到可拷的文件`
      continue
    }

    /* 目标已经是同一份了？两种判据：
     *   a) 有完整 runtime.json 且与源一致 —— 整份都拷过（官方或我们自己拷的）
     *   b) 只有我们留的记号、但版本一致 —— 我们上次只拷了部分载荷 */
    let upToDate = false
    const targetManifest = await readManifest(target)
    if (sameManifest(targetManifest.manifest, manifest)) {
      upToDate = true
    } else {
      const marker = await readMarker(target)
      if (marker && sameManifest(marker.manifest, manifest) && ALL_PARTS.every((p) => marker.parts.includes(p))) {
        upToDate = true
      }
    }

    return {
      ok: true,
      dir: cand.dir,
      from: cand.from,
      target,
      desktopVersion: manifest.desktopVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      node: manifest.node ?? null,
      pnpm: manifest.pnpm ?? null,
      python: manifest.python,
      total: { bytes: plan.totalBytes, files: plan.totalFiles },
      parts: plan.parts,
      upToDate,
      problem: null
    }
  }

  return { ...empty, problem: firstProblem ?? '没找到可用的随包运行时载荷' }
}

/* ------------------------------------------------------------------ *
 * 对外：真的拷
 * ------------------------------------------------------------------ */

/** 并发闸门：同一时刻只允许一次补全（用户连点两下不该拷两份） */
let inflight: Promise<ProvisionResult> | null = null

export function provisionInFlight(): boolean {
  return inflight !== null
}

/**
 * 把载荷拷进 <DSH_HOME>/dsh-runtimes/dsh-primary-runtime。
 *
 * 步骤（与官方 installPrimaryRuntime 同构，但每一步都往 diag 里留一行）：
 *   1. 检查源与目标（含幂等判断）
 *   2. 在**同一个父目录**下建临时目录（跨盘 rename 会失败，所以必须同父）
 *   3. 逐个拷（带进度）
 *   4. 校验每块载荷的关键文件
 *   5. `rm 旧的 .previous` → `rename 目标 → .previous` → `rename 临时 → 目标`
 *      （第二步失败就把 .previous 换回来）→ `rm .previous`
 */
export async function provisionRuntime(opts?: {
  parts?: RuntimePayloadPart[]
  onProgress?: (p: ProvisionProgress) => void
}): Promise<ProvisionResult> {
  if (inflight) {
    diag('provision', '已有一次补全在跑，直接返回同一个 promise')
    return inflight
  }
  inflight = runProvision(opts).finally(() => {
    inflight = null
  })
  return inflight
}

async function runProvision(opts?: {
  parts?: RuntimePayloadPart[]
  onProgress?: (p: ProvisionProgress) => void
}): Promise<ProvisionResult> {
  const started = Date.now()
  const parts = opts?.parts && opts.parts.length > 0 ? opts.parts : ALL_PARTS
  const emit = (p: ProvisionProgress): void => {
    try {
      opts?.onProgress?.(p)
    } catch {
      /* 界面那边炸了不该让拷贝停下 */
    }
  }

  const info = await inspectRuntimeSource({ deep: true })
  if (!info.ok || !info.dir) {
    const message = info.problem ?? '没找到可用的随包运行时载荷'
    diag('provision', `放弃：${message}`)
    emit({ phase: 'fail', copiedBytes: 0, totalBytes: 0, copiedFiles: 0, totalFiles: 0, current: null, message })
    return { ok: false, message, root: null, copied: false, bytes: 0, files: 0, ms: Date.now() - started, error: message }
  }

  const target = info.target ?? runtimeTarget()

  /* 幂等：目标已经是同一份。注意这里**不**看 parts —— 如果目标里有完整 runtime.json，
   * 那它一定是整份的，不管这次请求要哪几块都不需要再动。 */
  if (info.upToDate) {
    const message = `运行时已经是最新的了（${info.desktopVersion}），不用再拷`
    diag('provision', message)
    emit({
      phase: 'done',
      copiedBytes: 0,
      totalBytes: info.total.bytes,
      copiedFiles: 0,
      totalFiles: info.total.files,
      current: null,
      message
    })
    return { ok: true, message, root: target, copied: false, bytes: 0, files: 0, ms: Date.now() - started, error: null }
  }

  emit({
    phase: 'scan',
    copiedBytes: 0,
    totalBytes: info.total.bytes,
    copiedFiles: 0,
    totalFiles: info.total.files,
    current: null,
    message: `正在清点要拷的文件…（约 ${mb(info.total.bytes)}）`
  })

  const plan = await planCopy(info.dir, parts)
  if (plan.totalFiles === 0) {
    const message = '源目录里没找到可拷的文件'
    diag('provision', message)
    emit({ phase: 'fail', copiedBytes: 0, totalBytes: 0, copiedFiles: 0, totalFiles: 0, current: null, message })
    return { ok: false, message, root: null, copied: false, bytes: 0, files: 0, ms: Date.now() - started, error: message }
  }

  /* 临时目录必须建在目标的**同一个父目录**下：rename 不能跨卷，
   * 而 <DSH_HOME> 常在 C 盘、载荷源常在别的盘。 */
  let staging: string | null = null
  try {
    await mkdir(dirname(target), { recursive: true })
    staging = await mkdtemp(join(dirname(target), '.primary-runtime-'))
  } catch (err) {
    const message = `建不了临时目录（${dirname(target)}）：${errText(err)}`
    diag('provision', message)
    emit({ phase: 'fail', copiedBytes: 0, totalBytes: plan.totalBytes, copiedFiles: 0, totalFiles: plan.totalFiles, current: null, message })
    return { ok: false, message, root: null, copied: false, bytes: 0, files: 0, ms: Date.now() - started, error: message }
  }

  let copiedBytes = 0
  let copiedFiles = 0
  let lastEmit = 0

  try {
    /* 先建目录再拷文件：逐条按 plan 的顺序走，plan 里目录一定排在它的子项之前
     * （深度优先压栈时父目录先入 entries）。 */
    for (const entry of plan.entries) {
      if (entry.kind === 'dir') {
        await mkdir(join(staging, entry.rel), { recursive: true })
      }
    }

    for (const entry of plan.entries) {
      if (entry.kind !== 'file') continue
      const src = join(info.dir, entry.rel)
      const dst = join(staging, entry.rel)
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(src, dst)
      copiedBytes += entry.size
      copiedFiles += 1

      /* 节流：六千多个文件，每个都发一次 IPC 会把渲染层打满。
       * 120ms 一次（约 8 帧/秒）已经足够顺，再密人眼看不出区别。 */
      const now = Date.now()
      if (now - lastEmit >= 120 || copiedFiles === plan.totalFiles) {
        lastEmit = now
        emit({
          phase: 'copy',
          copiedBytes,
          totalBytes: plan.totalBytes,
          copiedFiles,
          totalFiles: plan.totalFiles,
          current: entry.rel,
          message: `正在拷运行时：${copiedFiles}/${plan.totalFiles} 个文件（${mb(copiedBytes)} / ${mb(plan.totalBytes)}）`
        })
      }
    }

    /* runtime.json 与记号文件最后写：拷到一半失败时，目标目录里没有 runtime.json，
     * 下次探测不会误以为「已经有一份完整的」。 */
    const allParts = ALL_PARTS.every((p) => parts.includes(p))
    if (allParts) {
      await copyFile(join(info.dir, RUNTIME_JSON), join(staging, RUNTIME_JSON))
    } else {
      /* 只拷了部分载荷 → 刻意**不写 runtime.json**。
       * 为什么：DSH 桌面端用「runtime.json 与源一致」判断要不要重装运行时，
       * 如果我们在只拷了 node+pnpm 的情况下写了完整的 runtime.json，
       * DSH 下次启动会认为运行时齐了，于是 python 永远缺 —— 而 Office 技能会莫名其妙报错。
       * 不写它，DSH 就会自己再补一份完整的，代价是多拷一次，但状态是自洽的。 */
      const marker = {
        manifest: (await readManifest(info.dir)).manifest,
        parts,
        at: Date.now(),
        note: '这份运行时是 DSH 插件台补的，只含指定载荷；DSH 桌面端下次启动会补齐其余部分'
      }
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(staging, MARKER), JSON.stringify(marker, null, 2), 'utf8')
    }

    emit({
      phase: 'verify',
      copiedBytes,
      totalBytes: plan.totalBytes,
      copiedFiles,
      totalFiles: plan.totalFiles,
      current: null,
      message: '正在校验拷完的文件…'
    })

    for (const part of parts) {
      const probe = join(staging, partProbe(part))
      let ok = false
      try {
        ok = (await stat(probe)).isFile()
      } catch {
        ok = false
      }
      if (!ok) throw new Error(`校验没过：缺 ${partProbe(part)}`)
    }

    emit({
      phase: 'swap',
      copiedBytes,
      totalBytes: plan.totalBytes,
      copiedFiles,
      totalFiles: plan.totalFiles,
      current: null,
      message: '正在替换旧的运行时目录…'
    })

    await swapInto(staging, target)
    staging = null // 已经被 rename 走了，finally 里不要再删

    env.invalidate()
    /* 缓存必须一起清：不清的话，界面上另一个还没挂载的 RuntimeProvision
     * 会在这 4 秒内读到「还不能补 / 还要拷 111 MB」的旧结论，于是按钮又出现一次。 */
    invalidateInspect()
    const message = `运行时补好了：${target}（${mb(copiedBytes)}，${copiedFiles} 个文件）`
    diag('provision', message)
    emit({
      phase: 'done',
      copiedBytes,
      totalBytes: plan.totalBytes,
      copiedFiles,
      totalFiles: plan.totalFiles,
      current: null,
      message
    })
    return {
      ok: true,
      message,
      root: target,
      copied: true,
      bytes: copiedBytes,
      files: copiedFiles,
      ms: Date.now() - started,
      error: null
    }
  } catch (err) {
    const message = `补全运行时失败：${errText(err)}`
    diag('provision', message)
    emit({
      phase: 'fail',
      copiedBytes,
      totalBytes: plan.totalBytes,
      copiedFiles,
      totalFiles: plan.totalFiles,
      current: null,
      message
    })
    return {
      ok: false,
      message,
      root: null,
      copied: false,
      bytes: copiedBytes,
      files: copiedFiles,
      ms: Date.now() - started,
      error: errText(err)
    }
  } finally {
    if (staging) {
      try {
        await rm(staging, { recursive: true, force: true })
      } catch {
        /* 清不掉临时目录不算失败：它带 .primary-runtime- 前缀，人一眼能认出是残留 */
      }
    }
  }
}

/**
 * 把 staging 换成目标目录，失败则回滚。
 *
 * 顺序是官方那一套，一个都不能省：
 *   rm 旧 .previous → 目标存在则 rename 目标→.previous → rename staging→目标
 *   → 失败则 rename .previous→目标（把用户原来的那份换回来）→ 成功后 rm .previous
 *
 * 为什么不直接 `rm 目标 && rename staging 目标`：中间那一步如果崩了/断电了，
 * 用户就既没有新运行时也没有旧的。留一份 .previous 至少能手工救。
 */
async function swapInto(staging: string, target: string): Promise<void> {
  const previous = `${target}.previous`
  await rm(previous, { recursive: true, force: true })

  /* 目标不能是符号链接：顺着链接 rename 会把用户的别处目录换掉，
   * 而且我们事后无法判断到底动了哪（官方 exists() 里也是这么挡的）。 */
  let replacing = false
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error(`目标是个符号链接，不敢动它：${target}`)
    replacing = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  if (replacing) await rename(target, previous)
  try {
    await rename(staging, target)
  } catch (err) {
    if (replacing) {
      try {
        await rename(previous, target)
      } catch {
        /* 回滚也失败：至少 .previous 还在，日志里能指路 */
      }
    }
    throw err
  }
  await rm(previous, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function mb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    /* EPERM / EACCES 是最常见的两种：用户把 .dsh 放到了需要管理员权限的位置，
     * 或者有进程正占着 node.exe（DSH 正在跑）。原样带上 code 才好判断。 */
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${err.message}（${code}）` : err.message
  }
  return String(err)
}
