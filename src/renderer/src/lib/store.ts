/**
 * store.ts —— 全局状态：React context + useReducer，外面包一层 async actions。
 *
 * 分层：
 *   state   —— 纯数据，reducer 只做同步迁移
 *   actions —— 异步 thunk：调 api()、失败转 toast、成功后 dispatch
 *
 * 约定：组件永远不直接调 window.dsh，一律 action 出入，保证错误一定被 UI 接住。
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode
} from 'react'

import { api, toMessage } from '../api'
import { DEFAULT_SETTINGS } from '../../../shared/ipc'
/**
 * 环境类失败要给的出口（「去设置里指定安装目录」）得先把设置面板叫起来、
 * 再让面板滚到环境分组 —— 这条信号的定义在展示层那一侧（见 EnvDiagnostics 的说明）。
 */
import { requestEnvFocus } from '../components/EnvDiagnostics'
import type {
  AppSettings,
  DshActionResult,
  ManifestExportResult,
  ManifestPreview,
  OpKind,
  OpLogLine,
  OpRequest,
  OpResult,
  PluginRecord,
  ProfileSummary,
  RuntimeInfo,
  UpdateCheckProgress,
  UpdateKind
} from '../../../shared/types'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 日志行上限：超过就从头砍，避免 pnpm 刷屏把内存吃光 */
const MAX_LOGS = 4000

/**
 * settings 还没取回来时的兜底。
 * 直接派生自 shared 的 DEFAULT_SETTINGS —— 以前这里手抄了一份，结果是每加一个字段
 * 都要改两处（漏了就编译不过），而且一旦漏改成功就会静默发一份过期的默认值出去。
 * 现在只有一个真相源；克隆嵌套是为了不让 UI 改到 DEFAULT_SETTINGS 的同一个对象。
 */
export const FALLBACK_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  wallpaper: null,
  wallpaperAdjust: { ...DEFAULT_SETTINGS.wallpaperAdjust },
  customThemes: []
}

/** 确认弹窗里明细列表最多列几条，多出来的折成「…等 N 个」 */
const CONFIRM_LIST_MAX = 12

export type FilterKey = 'all' | 'updatable' | 'disabled' | 'thirdparty' | 'builtin'

export interface FilterMeta {
  key: FilterKey
  label: string
  hint: string
}

export const FILTERS: FilterMeta[] = [
  { key: 'all', label: '全部', hint: '当前 profile 的全部依赖' },
  { key: 'updatable', label: '可更新', hint: '远端有新版本 / 新提交' },
  { key: 'disabled', label: '已停用', hint: '在依赖里，但被移出了 bundles' },
  { key: 'thirdparty', label: '第三方', hint: '非 @deepseek-ai 官方包' },
  { key: 'builtin', label: '官方内置', hint: '随 runtime 发布的官方层' }
]

/* 日志也是 view：用户原话「日志为什么点开之后还是在已安装，而不是显示日志呢」——
 * 底部抽屉永远盖不住主区，侧栏点「运行日志」就必须把主区换成日志。
 * 与抽屉的另一个区别：view 是互斥的目的地，抽屉是「叠在别人身上的一块」。 */
export type ViewKey = 'plugins' | 'install' | 'logs'

export type ToastLevel = 'info' | 'success' | 'warn' | 'error'

/* ------------------------------------------------------------------ *
 * 状态类型
 * ------------------------------------------------------------------ */

export interface LogLine {
  id: number
  opId: string
  at: number
  channel: OpLogLine['channel']
  text: string
  /** 由 \r 产生的进度行：同一 op 的连续进度行会就地替换 */
  progress: boolean
}

export interface ToastItem {
  id: number
  level: ToastLevel
  title: string
  detail?: string
}

/** 确认弹窗里的一行键值（「来源 → github:owner/repo」这种能让人判断的明细） */
export interface ConfirmKV {
  key: string
  value: string
  mono?: boolean
}

/** 确认弹窗里的一条横幅（warn = 会出现意外结果，info = 只是提醒） */
export interface ConfirmBanner {
  level: 'info' | 'warn' | 'danger'
  text: string
}

export interface ConfirmRequest {
  title: string
  message: string
  bullets?: string[]
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  /** 非空时要求用户输入这段文字才能确认（卸载的两步确认、更新全部） */
  requireText?: string | null
  /** 键值明细：会改哪些文件、装到哪个 profile、来源被归一化成什么 */
  kv?: ConfirmKV[]
  /** 附注：点下去之后会发生什么、要不要重启 DSH */
  notes?: string[]
  /** 单条警示/提示横幅 */
  banner?: ConfirmBanner | null
  /**
   * 确认之后要干的事。给了它就走「requestConfirm + onConfirm」这条路：
   * 不需要把用户的选择回传给调用方时用（更新单个 / 更新全部）。
   * 需要拿到 boolean 的调用方继续用 askConfirm。
   */
  onConfirm?: () => void | Promise<void>
}

/** 安装前确认要用到的预检信息（来自 installPreview，没有就只报 spec） */
export interface InstallConfirmHint {
  /** 归一化后真正交给 pnpm 的 spec */
  normalized?: string | null
  name?: string | null
  version?: string | null
  /** false = 这个版本没有声明 dsh.bundle.patch，装完不会进加载列表 */
  isDshPlugin?: boolean | null
  alreadyInstalled?: string | null
}

export interface UpdateProgressView {
  profile: string
  done: number
  total: number
  name: string
  ok: number
  error: number
  skipped: number
  finished: boolean
}

export interface OpRunState {
  /** 主进程真正分配 opId 前为 null，收到第一行日志后补上 */
  opId: string | null
  kind: OpKind | null
  label: string
  startedAt: number
}

export interface CheckState {
  running: boolean
  done: number
  total: number
}

/**
 * 一次更新检查的结论快照（五个字段就是 PluginRecord 上那五个）。
 *
 * 为什么渲染层要自己留一份：主进程每次 plugins() 都从 package.json 重新组记录，
 * update* 五个字段一律硬写成 null / false（见 src/main/engine/inventory.ts:308-312）。
 * 也就是说「刷新」这个动作本身就会把刚查到的结论抹平 —— 用户点一次 ⟳ 就得再等
 * 半分钟重查一遍。结论得有人保管，渲染层是唯一能管的地方（本文件也是唯一允许改的
 * 那一侧），所以这里存快照、刷新时缝回新清单上。
 */
export interface UpdateSnapshot {
  /**
   * 结下这条结论时该包的已装版本。
   * 为什么必须有它：结论是「已装版本 vs registry latest」比出来的，
   * 版本一变（重装 / 升级 / 换了 tag）结论就不再成立，光看包名还在不在会漏。
   */
  atVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  updateKind: UpdateKind
  updateError: string | null
  checkedAt: number
}

export interface ConsoleState {
  /** 首次数据装载完成 */
  ready: boolean
  /** 启动阶段挂掉（preload 缺失 / 主进程 handler 报错） */
  fatal: string | null

  settings: AppSettings | null
  runtime: RuntimeInfo | null
  profiles: ProfileSummary[]
  activeProfile: string | null

  plugins: PluginRecord[]
  pluginsLoading: boolean
  pluginsError: string | null
  /** 正在计算大小的包名 */
  deepBusy: string | null

  search: string
  filter: FilterKey
  /** 是否在列表里展示官方内置层（默认关，否则一堆 @deepseek-ai/* 淹没列表） */
  showBuiltinLayer: boolean
  view: ViewKey
  selectedId: string | null
  /**
   * 批量更新时勾选的包名（不是 PluginRecord.id：id 带 `profile::` 前缀，换 profile 就整套失效）。
   *
   * 为什么放在 store 而不是组件里的 useState：列表会因为切筛选 / 改搜索词而重挂载，
   * 放组件里勾选会被清空，用户勾了 5 个再切个 tab 回来就得重勾。
   * 语义：跨「搜索 / 筛选 / 官方内置层开关」保留；切 profile 与重新拉列表（'plugins' 动作，
   * 含更新完成后那次刷新）时清空 —— 那时清单本身可能整套换过，
   * 留着旧包名就会变成「勾了 3 个却更新了别的包」。
   */
  picks: string[]

  check: CheckState | null
  progress: UpdateProgressView | null
  /**
   * 已查到的更新结论，按 PluginRecord.id 索引，与 plugins 分开放。
   * 分开的原因：plugins 是「主进程每次重读的清单」（会被整体替换），
   * updates 是「用户花时间换来的结论」（刷新不丢）—— 两者的生命周期不一样。
   */
  updates: Record<string, UpdateSnapshot>

  logs: LogLine[]
  op: OpRunState | null
  lastResult: OpResult | null

  confirm: ConfirmRequest | null
  /** 确认按钮已经点下、onConfirm 正在执行中（弹窗里两个按钮都禁用并转圈） */
  confirmBusy: boolean
  settingsOpen: boolean
  warningsDismissed: boolean

  toasts: ToastItem[]
}

const INITIAL_STATE: ConsoleState = {
  ready: false,
  fatal: null,
  settings: null,
  runtime: null,
  profiles: [],
  activeProfile: null,
  plugins: [],
  pluginsLoading: false,
  pluginsError: null,
  deepBusy: null,
  search: '',
  filter: 'all',
  showBuiltinLayer: false,
  view: 'plugins',
  selectedId: null,
  picks: [],
  check: null,
  progress: null,
  updates: {},
  logs: [],
  op: null,
  lastResult: null,
  confirm: null,
  confirmBusy: false,
  settingsOpen: false,
  warningsDismissed: false,
  toasts: []
}

/* ------------------------------------------------------------------ *
 * Action
 * ------------------------------------------------------------------ */

type Action =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'settings'; value: AppSettings }
  | { type: 'runtime'; value: RuntimeInfo }
  | { type: 'profiles'; value: ProfileSummary[] }
  | { type: 'activeProfile'; name: string | null }
  | { type: 'pluginsStart' }
  | { type: 'plugins'; value: PluginRecord[] }
  | { type: 'pluginsPatch'; value: PluginRecord[] }
  | { type: 'pluginsError'; message: string | null }
  | { type: 'deepBusy'; name: string | null }
  | { type: 'search'; value: string }
  | { type: 'filter'; value: FilterKey }
  | { type: 'showBuiltin'; value: boolean }
  | { type: 'view'; value: ViewKey }
  | { type: 'select'; id: string | null }
  | { type: 'picks'; value: string[] }
  | { type: 'checkStart'; total: number }
  | { type: 'checkProgress'; value: UpdateCheckProgress }
  | { type: 'checkDone' }
  | { type: 'log'; lines: LogLine[] }
  | { type: 'logsClear' }
  | { type: 'opStart'; value: OpRunState }
  | { type: 'opEnd'; value: OpResult | null }
  | { type: 'confirm'; value: ConfirmRequest | null }
  | { type: 'confirmBusy'; value: boolean }
  | { type: 'settingsOpen'; value: boolean }
  | { type: 'warnDismiss' }
  | { type: 'toast'; value: ToastItem }
  | { type: 'toastDismiss'; id: number }

let logSeq = 0

/** OpLogLine → LogLine[]，处理多行与 \r 进度 */
function toLogLines(raw: OpLogLine): LogLine[] {
  const text = typeof raw.text === 'string' ? raw.text : String(raw.text ?? '')
  const segments = text.split('\n')
  const out: LogLine[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i] ?? ''
    if (seg === '') continue
    const hasCR = seg.includes('\r')
    const cleaned = hasCR ? seg.slice(seg.lastIndexOf('\r') + 1) : seg
    if (cleaned === '' && !hasCR) continue
    out.push({
      id: 0,
      opId: raw.opId,
      at: raw.at,
      channel: raw.channel,
      text: cleaned.replace(/\r/g, ''),
      progress: hasCR
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 更新结论的保管与缝合（见 UpdateSnapshot 上的说明）
 * ------------------------------------------------------------------ */

/** 记录 → 结论快照；从未查过（checkedAt 为 null）就没有结论 */
function snapshotOf(rec: PluginRecord): UpdateSnapshot | null {
  if (rec.checkedAt === null) return null
  return {
    atVersion: rec.version,
    latestVersion: rec.latestVersion,
    updateAvailable: rec.updateAvailable,
    updateKind: rec.updateKind,
    updateError: rec.updateError,
    checkedAt: rec.checkedAt
  }
}

/** 结论 → 记录上那五个字段（为什么不用 patchRecord：那个在主进程，渲染层只有记录） */
function withSnapshot(rec: PluginRecord, snap: UpdateSnapshot): PluginRecord {
  return {
    ...rec,
    latestVersion: snap.latestVersion,
    updateAvailable: snap.updateAvailable,
    updateKind: snap.updateKind,
    updateError: snap.updateError,
    checkedAt: snap.checkedAt
  }
}

/**
 * 把保管的结论缝回一份「刚从主进程重读的清单」。
 *
 * 四条规则，每条都对应一件真的会让结论失效或误报的事：
 *   1) 不是当前 profile 的结论原样留着 —— 切 profile 不该把另一边的检查成果冲掉；
 *   2) 这次主进程自己带了结论（checkedAt 非空，例如刚点完检查更新那次刷新）
 *      → 以主进程为准，顺手更新快照；
 *   3) 结论对应的已装版本和现在的 version 对不上（重装 / 升级 / 换 tag / 换 spec）
 *      → 结论作废，宁可让它显示「未检查」，也不要摆一个可能错的答案；
 *   4) 当前 profile 里已经不存在的包 → 结论一起丢，否则「可更新」计数会指向
 *      一个已卸载的幽灵包，用户点更新还会失败。
 * 规则 4 是这套写法的天然结果：当前 profile 的条目只从 list 里重新长出。
 */
function weaveUpdates(
  list: PluginRecord[],
  updates: Record<string, UpdateSnapshot>,
  profile: string | null
): { plugins: PluginRecord[]; updates: Record<string, UpdateSnapshot> } {
  /* 空清单不是「全都卸载了」，而是「还没拿到清单」（切 profile 时 selectProfile 会先
   * 派一个空数组清屏）。这时候什么都不能剪，否则来回切一次 profile 就把那边的结论丢光。 */
  if (list.length === 0) return { plugins: list, updates }

  const next: Record<string, UpdateSnapshot> = {}
  const belongsToMe = profile !== null ? (id: string): boolean => id.startsWith(`${profile}::`) : () => false

  /* 先把别人的留下：属于当前 profile 的条目这一轮全部由下面的循环重建 */
  for (const [id, snap] of Object.entries(updates)) {
    if (!belongsToMe(id)) next[id] = snap
  }

  const plugins = list.map((rec) => {
    const fresh = snapshotOf(rec)
    if (fresh) {
      next[rec.id] = fresh
      return rec
    }
    const snap = updates[rec.id]
    if (!snap) return rec
    if (snap.atVersion !== rec.version) return rec
    next[rec.id] = snap
    return withSnapshot(rec, snap)
  })

  return { plugins, updates: next }
}

/**
 * op 结束后作废受影响的结论。
 * 为什么信主进程的 changes 而不是比对版本：git 来源的包换 commit 时 version 字段
 * 可以不变，只比版本会漏掉「刚拉过的最新代码」。bundled / unbundled / unchanged
 * 不算 —— 它们只动加载层名单，包本身没换。
 */
function dropChangedUpdates(
  updates: Record<string, UpdateSnapshot>,
  changes: OpResult['changes']
): Record<string, UpdateSnapshot> {
  const changed = changes.filter(
    (c) => c.action === 'added' || c.action === 'removed' || c.action === 'updated'
  )
  if (changed.length === 0) return updates
  const next = { ...updates }
  for (const c of changed) {
    /* id 是 `${profile}::${name}`，包名在末尾；带 :: 前缀比对以免误伤同名前缀的包 */
    const suffix = `::${c.name}`
    for (const id of Object.keys(next)) {
      if (id.endsWith(suffix)) delete next[id]
    }
  }
  return next
}

/* ------------------------------------------------------------------ *
 * 环境类失败：怎么认、怎么折叠、给什么出口
 * ------------------------------------------------------------------ */

/**
 * 「这不是插件的问题，是 DSH 环境没定下来」的识别词。
 *
 * 为什么集中成一个常量 + 一个判定函数：这句话是主进程在启动不了 pnpm 时抛的，
 * 渲染层有三处要认它（失败提示、清单批量安装的汇总、给不给「去设置里指定 DSH_HOME」的出路）。
 * 撒三份字符串比较，早晚有一处漏改 —— 而漏掉的那处恰好是给出口的那一处，
 * 用户就又会回到「点完就没了，没有任何按钮」。
 *
 * 只认「运行时找不到」这一类。「安装根」「安装目录」这两个词故意**不进列表**：
 * 安装目录只喂「启动 / 退出 DSH」，缺它不影响装包，不该被当成环境失败去弹出口。
 */
const ENV_FAILURE_HINTS = ['找不到 node', '找不到 pnpm', '没找到 Node', '没找到 pnpm', '未找到 DSH']

/** 只看前 4000 字符：log 可能是几万行 pnpm 输出，扫全文既慢又容易误伤 */
const ENV_SCAN_LIMIT = 4000

/** 明细行少于这个数就不值得折叠 —— 两行的话原样展示还更好读 */
const MANIFEST_FOLD_MIN = 3
/** 折叠后保留几条明细（剩下的折成「另有 N 条同类」） */
const MANIFEST_KEEP = 3

/** 失败结果是不是「环境没定下来」这一类 */
export function isEnvFailure(result: OpResult | null | undefined): boolean {
  if (!result || result.ok) return false
  const text = `${result.message}\n${(result.log ?? '').slice(0, ENV_SCAN_LIMIT)}`
  return ENV_FAILURE_HINTS.some((hint) => text.includes(hint))
}

/** 从「（@scope/pkg：<原因>；」这种明细行里刮出包名后面的原因 */
function detailReason(line: string): string | null {
  const matched = line.match(/^[（(]\s*[^：:]+[：:]\s*(.+?)\s*[；;)）]*$/)
  return matched?.[1]?.trim() || null
}

interface ManifestFailure {
  /** 同一类环境错误的条数，也就是失败的包数 */
  count: number
  /** 刮出来的共同原因 */
  reason: string
  /** 明细行（已剥掉外层括号与尾部分号） */
  lines: string[]
}

/**
 * 清单批量安装的失败明细解析。
 *
 * 为什么要有这一步：环境坏了的时候，主进程会给出一模一样的 N 行
 * 「（<包名>：找不到 DSH 自带的 node/pnpm，请到设置里指定安装根；」——
 * 12 行同一条错误既盖住了「其实是同一个原因」，也没人会读完。
 */
function parseManifestFailure(result: OpResult): ManifestFailure | null {
  if (result.ok || result.kind !== 'install-manifest') return null
  const lines = result.message
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < MANIFEST_FOLD_MIN) return null

  const envLines = lines.filter((l) => ENV_FAILURE_HINTS.some((hint) => l.includes(hint)))
  /* 只在这一批失败**基本上都是同一个环境问题**时才折叠：
   * 半路混着别的失败（包不存在、网络不通）时，原样列出来才是有用的。 */
  if (envLines.length < 2 || envLines.length < lines.length - 1) return null

  return {
    count: envLines.length,
    reason: detailReason(envLines[0]) ?? 'DSH 环境没定下来',
    lines: envLines.map((l) => l.replace(/^[（(]\s*/, '').replace(/\s*[；;]$/, ''))
  }
}

/** 折叠后的一句话（toast 用：它只有一行的高度，塞不下明细） */
function manifestFailureHeadline(result: OpResult): string | null {
  const folded = parseManifestFailure(result)
  return folded ? `${folded.count} 个包全部失败：${folded.reason}` : null
}

/** 折叠后的完整明细（确认弹窗用：message 是 pre-wrap，换行能留住） */
function manifestFailureDetail(result: OpResult): string | null {
  const folded = parseManifestFailure(result)
  if (!folded) return null
  const kept = folded.lines.slice(0, MANIFEST_KEEP)
  const rest = folded.lines.length - kept.length
  return [
    `${folded.count} 个包全部失败：${folded.reason}`,
    ...kept.map((l) => `· ${l}`),
    rest > 0 ? `另有 ${rest} 条同类（原因一样，不再重复列）` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case 'ready':
      return { ...state, ready: true }

    case 'fatal':
      return { ...state, fatal: action.message, ready: true }

    case 'settings':
      return { ...state, settings: action.value }

    case 'runtime':
      return { ...state, runtime: action.value, warningsDismissed: false }

    case 'profiles':
      return { ...state, profiles: action.value }

    case 'activeProfile':
      /* 换 profile 顺手清勾选：勾选是按包名记的，另一个 profile 里的同名包完全是另一个东西 */
      return { ...state, activeProfile: action.name, picks: [] }

    case 'pluginsStart':
      return { ...state, pluginsLoading: true, pluginsError: null }

    case 'plugins': {
      /* 刷新只换「清单本身」：环境、包、版本、大小全是主进程重读的，这部分必须更新。
       * 但更新检查的结论主进程不负责保管（inventory.ts 每次都把它写成 null），
       * 所以在这里缝回来 —— 否则点一次 ⟳刷新 就等于把半分钟的检查成果扔掉，
       * 用户还得再查一遍才知道哪些能更新。 */
      const woven = weaveUpdates(action.value, state.updates, state.activeProfile)
      return {
        ...state,
        plugins: woven.plugins,
        updates: woven.updates,
        pluginsLoading: false,
        pluginsError: null,
        /* 清单重新长过一遍了（刷新 / 更新完成 / 换 profile），勾选跟着作废：
         * 留着旧包名就会出现「勾选的 N 和实际能更新的东西对不上」 */
        picks: []
      }
    }

    case 'pluginsPatch': {
      const byId = new Map(state.plugins.map((p) => [p.id, p] as const))
      /* 主进程刚给的记录里带着结论（checkUpdates 的返回）→ 顺便存进快照，
       * 这样后续任何一次刷新都还能把它缝回来 */
      let updates = state.updates
      for (const rec of action.value) {
        byId.set(rec.id, rec)
        const snap = snapshotOf(rec)
        if (snap) {
          if (updates === state.updates) updates = { ...state.updates }
          updates[rec.id] = snap
        }
      }
      return { ...state, plugins: Array.from(byId.values()), updates }
    }

    case 'pluginsError':
      return { ...state, pluginsError: action.message, pluginsLoading: false }

    case 'deepBusy':
      return { ...state, deepBusy: action.name }

    case 'search':
      return { ...state, search: action.value }

    case 'filter':
      /* 日志从抽屉改成 view 之后，抽屉不再挡筛选的高亮 —— 这里只剩纯筛选语义。 */
      return { ...state, filter: action.value }

    case 'showBuiltin':
      return { ...state, showBuiltinLayer: action.value }

    case 'view':
      return { ...state, view: action.value }

    case 'select':
      return { ...state, selectedId: action.id }

    case 'picks': {
      /* 唯一的写入口，顺手去重去空：调用方（全选 / 单行勾选）本来已经过滤过，
       * 但脏值一旦进来，「更新选中 (N)」的 N 就会和真正发下去的目标对不上。 */
      const seen = new Set<string>()
      const value: string[] = []
      for (const name of action.value) {
        if (typeof name !== 'string' || name === '' || seen.has(name)) continue
        seen.add(name)
        value.push(name)
      }
      return { ...state, picks: value }
    }

    case 'checkStart':
      return {
        ...state,
        check: { running: true, done: 0, total: action.total },
        progress: {
          profile: state.activeProfile ?? '',
          done: 0,
          total: action.total,
          name: '',
          ok: 0,
          error: 0,
          skipped: 0,
          finished: false
        }
      }

    case 'checkProgress': {
      const p = action.value
      const prev = state.progress
      const sameRun = prev && !prev.finished && prev.profile === p.profile
      const ok = (sameRun ? prev.ok : 0) + (p.result === 'ok' ? 1 : 0)
      const error = (sameRun ? prev.error : 0) + (p.result === 'error' ? 1 : 0)
      const skipped = (sameRun ? prev.skipped : 0) + (p.result === 'skipped' ? 1 : 0)
      return {
        ...state,
        check: state.check ? { ...state.check, done: p.done, total: p.total } : { running: true, done: p.done, total: p.total },
        progress: {
          profile: p.profile,
          done: p.done,
          total: p.total,
          name: p.name,
          ok,
          error,
          skipped,
          finished: p.total > 0 && p.done >= p.total
        }
      }
    }

    case 'checkDone':
      return {
        ...state,
        check: state.check ? { ...state.check, running: false } : null,
        progress: state.progress ? { ...state.progress, finished: true } : null
      }

    case 'log': {
      if (action.lines.length === 0) return state
      let logs = state.logs
      for (const line of action.lines) {
        const last = logs.length > 0 ? logs[logs.length - 1] : undefined
        const item: LogLine = { ...line, id: (logSeq += 1) }
        if (line.progress && last && last.progress && last.opId === line.opId) {
          logs = logs.slice(0, -1)
        }
        logs = logs.concat(item)
      }
      if (logs.length > MAX_LOGS) logs = logs.slice(logs.length - MAX_LOGS)
      const firstOpId = action.lines[0]?.opId ?? null
      const op =
        state.op && state.op.opId === null && firstOpId ? { ...state.op, opId: firstOpId } : state.op
      return { ...state, logs, op }
    }

    case 'logsClear':
      return { ...state, logs: [] }

    case 'opStart':
      /* 不再强制弹日志。用户原话：「每次点击更新之后就自动跳转到日志面板 很麻烦
       * 我还要更新别的呢」—— 连续更新多个包时，每点一次就被拽到日志页一次，
       * 还得切回列表再勾下一个。运行状态由 Toast 与列表行内状态自己汇报；
       * 想看输出的人自己点侧栏「运行日志」。 */
      return { ...state, op: action.value, lastResult: null }

    case 'opEnd': {
      const result = action.value
      /* 装 / 卸 / 升级之后，针对那个包的结论确实过时了：以主进程的 changes 为准作废，
       * 这是唯一权威的「清单变了」信号（渲染层没有单独的事件通道）。 */
      const updates = result ? dropChangedUpdates(state.updates, result.changes) : state.updates
      return { ...state, op: null, lastResult: result ?? state.lastResult, updates }
    }

    case 'confirm':
      return { ...state, confirm: action.value, confirmBusy: false }

    case 'confirmBusy':
      return { ...state, confirmBusy: action.value }

    case 'settingsOpen':
      /* 设置是模态弹窗，与日志 view 不互斥（它盖在最上层）。 */
      return { ...state, settingsOpen: action.value }

    case 'warnDismiss':
      return { ...state, warningsDismissed: true }

    case 'toast': {
      const toasts = state.toasts.concat(action.value)
      return { ...state, toasts: toasts.length > 4 ? toasts.slice(toasts.length - 4) : toasts }
    }

    case 'toastDismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }

    default:
      return state
  }
}

/* ------------------------------------------------------------------ *
 * 选择器 / 过滤器
 * ------------------------------------------------------------------ */

export type FilterCounts = Record<FilterKey, number>

/** 列表是否因为是「官方内置层」而被隐藏 */
export function isLayerHidden(rec: PluginRecord, showBuiltinLayer: boolean): boolean {
  return rec.builtin && !showBuiltinLayer
}

export function countFilters(plugins: PluginRecord[], showBuiltinLayer: boolean): FilterCounts {
  const listed = plugins.filter((p) => !isLayerHidden(p, showBuiltinLayer))
  return {
    all: listed.length,
    updatable: listed.filter((p) => p.updateAvailable).length,
    disabled: listed.filter((p) => p.disabled).length,
    thirdparty: plugins.filter((p) => !p.builtin).length,
    builtin: plugins.filter((p) => p.builtin).length
  }
}

function matchSearch(rec: PluginRecord, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (rec.name.toLowerCase().includes(needle)) return true
  if (rec.description && rec.description.toLowerCase().includes(needle)) return true
  return rec.keywords.some((k) => k.toLowerCase().includes(needle))
}

function matchFilter(rec: PluginRecord, filter: FilterKey): boolean {
  switch (filter) {
    case 'updatable':
      return rec.updateAvailable
    case 'disabled':
      return rec.disabled
    case 'thirdparty':
      return !rec.builtin
    case 'builtin':
      return rec.builtin
    case 'all':
    default:
      return true
  }
}

/** 列表排序：可更新优先 → 正常在前 → 名字升序 */
export function sortPlugins(list: PluginRecord[]): PluginRecord[] {
  return [...list].sort((a, b) => {
    if (a.updateAvailable !== b.updateAvailable) return a.updateAvailable ? -1 : 1
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

export function filterPlugins(
  plugins: PluginRecord[],
  opts: { search: string; filter: FilterKey; showBuiltinLayer: boolean }
): PluginRecord[] {
  const base =
    opts.filter === 'builtin'
      ? plugins.filter((p) => p.builtin)
      : plugins.filter((p) => !isLayerHidden(p, opts.showBuiltinLayer))
  const q = opts.search.trim()
  return sortPlugins(base.filter((p) => matchFilter(p, opts.filter) && matchSearch(p, q)))
}

/** 「更新失败」徽章用：检查过但失败了 */
export function hasUpdateError(rec: PluginRecord): boolean {
  return rec.checkedAt !== null && !!rec.updateError
}

/**
 * 能不能走「批量更新」（列表复选框、表头三态全选、更新选中都只认它）。
 *
 * 为什么和 PluginRow 里那个 `updateAvailable && installed` 不合并成一个函数：
 * 那一处只管「这一行要不要显示更新按钮」，而这里还要额外排掉主进程会跳过的三类
 * （builtin = 随 DSH 发布不能单独更新、link / workspace = 本地开发来源走 git）。
 * 合并了就会出现「界面上勾上了、日志里写跳过」这种对不上，
 * 而这次的整个修复就是「界面上看到的必须就是执行的」。
 */
export function isUpdateTarget(rec: PluginRecord): boolean {
  return (
    rec.updateAvailable === true &&
    rec.installed &&
    !rec.builtin &&
    rec.sourceKind !== 'link' &&
    rec.sourceKind !== 'workspace'
  )
}

/** 更新确认弹窗的明细行：列出「当前版本 → 要去的版本」，超过上限折成「…等 N 个」 */
function updateConfirmBullets(list: PluginRecord[]): string[] {
  const shown = list.slice(0, CONFIRM_LIST_MAX)
  const bullets = shown.map(
    (p) => `${p.name}  ${p.version ?? '（当前版本未知）'} → ${p.latestVersion ?? '（远端版本未知）'}`
  )
  if (list.length > shown.length) bullets.push(`…等 ${list.length} 个`)
  return bullets
}

/**
 * 目标 → 要钉住的版本（一起发给主进程的 `versions`）。
 *
 * 为什么非带不可：主进程重新联网查一次可能查到和界面不同的答案（缓存抖动、期间又发了新版），
 * 装完那一行还亮着「可更新」，用户看到的就是「点了没反应」；
 * 钉到确认弹窗里写的那个版本，结果才和用户看到的完全一致，
 * 而且被 pnpm 11 的供应链冷却拦下来时会命中 ERR_PNPM_MINIMUM_RELEASE_AGE，
 * 走主进程 runPnpmAddish 的豁免重试那条路。
 */
function updateVersions(list: PluginRecord[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of list) {
    if (typeof p.latestVersion === 'string' && p.latestVersion !== '') out[p.name] = p.latestVersion
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export interface ConsoleActions {
  refreshEnv: () => Promise<void>
  /** silent：调用方自己已经给过反馈时用（外观类操作各有一句更具体的提示） */
  reloadAll: (opts?: { silent?: boolean }) => Promise<void>
  /**
   * 只把设置灌进 state，**不重拉环境**。
   *
   * 为什么需要它：外观是「边拖边生效」的，一次拖动会落盘十来次。每次走 reloadAll
   * 都要顺带 `runtimeInfo` + `profiles` + `loadPlugins` 三次 IPC —— 为了改个滑杆
   * 去重扫一遍插件列表，纯粹是拿主进程的 IO 换一次重渲染，拖起来就发涩。
   * 而外观字段**改不了环境**（装了什么插件、DSH 装在哪，跟玻璃多糊没有任何关系）。
   *
   * 所以：外观写盘成功后拿主进程回读的那份设置调这里就够了。
   */
  applySettings: (next: AppSettings) => void
  selectProfile: (name: string) => Promise<void>
  loadPlugins: (profile?: string, opts?: { deep?: boolean }) => Promise<void>
  checkUpdates: (names?: string[]) => Promise<void>
  updateOne: (rec: PluginRecord) => Promise<void>
  updateAll: () => Promise<void>
  /** 批量更新「勾选的那批」（目标来自 state.picks，与确认弹窗里列出的完全一致） */
  updateSelected: () => Promise<void>
  /**
   * 批量停用 / 启用 / 卸载勾选的那批（2026-11-03：用户原话「还要支持多选删除，停用等」）。
   *
   * 勾选池放宽到「已装 + 可卸载」之后，勾选不再只服务于更新 —— 这三个走
   * 渲染层串行循环（每个包一次单件 op），不新造主进程批量 kind：
   * 停用 / 启用本来就不走 pnpm（只摘 bundles + 记自己的 state），循环零成本；
   * 卸载每条一条 pnpm remove，官方通道的备份 / 快照 / 回滚护栏一条不缺。
   */
  disableSelected: () => Promise<void>
  enableSelected: () => Promise<void>
  uninstallSelected: () => Promise<void>
  /** 勾选 / 取消勾选一个包（只对 isUpdateTarget 的行有意义） */
  togglePick: (name: string) => void
  /** 整体替换勾选集合：表头三态（全选 / 清空）用 */
  setPicks: (names: string[]) => void
  toggleOne: (rec: PluginRecord) => Promise<void>
  uninstall: (rec: PluginRecord) => Promise<void>
  reinstall: (rec: PluginRecord) => Promise<void>
  installSpec: (
    spec: string,
    profile?: string,
    hint?: InstallConfirmHint
  ) => Promise<OpResult | null>
  /** 按导出的清单 JSON 批量安装（先弹确认，再 runOp({kind:'install-manifest'})） */
  installManifest: (
    profile: string,
    text: string,
    preview: ManifestPreview
  ) => Promise<OpResult | null>
  /** 导出当前 profile 的已装清单，main 侧弹保存对话框 */
  exportManifest: () => Promise<ManifestExportResult | null>
  /** 拉起 DSH 桌面端（走一次轻确认） */
  startDsh: () => Promise<DshActionResult | null>
  /** 退出正在运行的 DSH（走二次确认） */
  stopDsh: () => Promise<DshActionResult | null>
  computeSize: (rec: PluginRecord) => Promise<void>
  cancelOp: () => Promise<void>
  restartDsh: () => Promise<void>
  revealPath: (target: string | null) => Promise<void>
  openExternal: (url: string | null) => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<boolean>
  applyRuntime: (info: RuntimeInfo) => void
  setSearch: (value: string) => void
  setFilter: (value: FilterKey) => void
  setShowBuiltinLayer: (value: boolean) => void
  setView: (value: ViewKey) => void
  select: (id: string | null) => void
  openSettings: () => void
  closeSettings: () => void
  clearLogs: () => void
  dismissWarnings: () => void
  toast: (level: ToastLevel, title: string, detail?: string) => void
  dismissToast: (id: number) => void
  askConfirm: (req: ConfirmRequest) => Promise<boolean>
  /** 挂一个待确认请求（不带 Promise，确认后跑 req.onConfirm） */
  requestConfirm: (req: ConfirmRequest) => void
  /** 用户点了确认：没有 onConfirm 的请求只回传 true，有 onConfirm 的先转 busy 再执行 */
  resolveConfirm: (ok: boolean) => void
  /** 用户点了取消 / Esc / 点遮罩：清空待确认请求，什么都不执行 */
  cancelConfirm: () => void
}

export interface ConsoleContextValue {
  state: ConsoleState
  actions: ConsoleActions
  /** 过滤后的可见列表（PluginList 与空态判断共用） */
  visible: PluginRecord[]
  counts: FilterCounts
  settings: AppSettings
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null)

export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext)
  if (!ctx) throw new Error('useConsole 必须在 <ConsoleProvider> 内使用')
  return ctx
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)

  const stateRef = useRef(state)
  stateRef.current = state

  const confirmResolver = useRef<((ok: boolean) => void) | null>(null)
  /** 每弹一次确认框自增：异步的 onConfirm 回来时用它判断弹窗还是不是自己那一枪 */
  const confirmSeq = useRef(0)
  const toastSeq = useRef(0)

  /* ----------------------------- 基础 ----------------------------- */

  const toast = useCallback((level: ToastLevel, title: string, detail?: string) => {
    toastSeq.current += 1
    dispatch({ type: 'toast', value: { id: toastSeq.current, level, title, detail } })
  }, [])

  const dismissToast = useCallback((id: number) => {
    dispatch({ type: 'toastDismiss', id })
  }, [])

  const askConfirm = useCallback(
    (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        confirmResolver.current?.(false)
        confirmResolver.current = resolve
        confirmSeq.current += 1
        dispatch({ type: 'confirm', value: req })
      }),
    []
  )

  /**
   * 挂一个「待确认请求」：用户点确认后由 req.onConfirm 自己干活，
   * 调用方不需要等结果（更新单个 / 更新全部走这条）。
   */
  const requestConfirm = useCallback((req: ConfirmRequest) => {
    confirmResolver.current?.(false)
    confirmResolver.current = null
    confirmSeq.current += 1
    dispatch({ type: 'confirm', value: req })
  }, [])

  /** 用户点了取消 / 按了 Esc / 点了遮罩：什么都不执行，直接清空 */
  const cancelConfirm = useCallback(() => {
    if (stateRef.current.confirmBusy) return
    confirmResolver.current?.(false)
    confirmResolver.current = null
    confirmSeq.current += 1
    dispatch({ type: 'confirm', value: null })
  }, [])

  /**
   * 用户点了确认。
   * - 带 onConfirm 的请求：弹窗先进入 busy（按钮转圈 + 禁用），等 onConfirm 起了头再自动关掉；
   *   真正要跑几分钟的是 runOp 那套操作 UI（日志抽屉 / 行内按钮），弹窗不压在界面上。
   * - 不带 onConfirm 的请求（askConfirm）：只把 true 回传给调用方，弹窗立即关。
   */
  const resolveConfirm = useCallback(
    (ok: boolean) => {
      if (stateRef.current.confirmBusy) return
      const req = stateRef.current.confirm
      const resolve = confirmResolver.current
      confirmResolver.current = null

      if (!ok || !req || !req.onConfirm) {
        confirmSeq.current += 1
        dispatch({ type: 'confirm', value: null })
        resolve?.(ok)
        return
      }

      const seq = (confirmSeq.current += 1)
      dispatch({ type: 'confirmBusy', value: true })
      resolve?.(true)
      const run = req.onConfirm
      void (async () => {
        try {
          await run()
        } catch (err) {
          toast('error', '确认后的操作失败', toMessage(err))
        } finally {
          // seq 变了说明期间又弹了新的确认框，这一枪就别关别人的窗
          if (confirmSeq.current === seq) dispatch({ type: 'confirm', value: null })
        }
      })()
    },
    [toast]
  )

  /* ----------------------------- 数据装载 ----------------------------- */

  const loadPlugins = useCallback(
    async (profile?: string, opts?: { deep?: boolean }) => {
      const target = profile ?? stateRef.current.activeProfile
      if (!target) {
        dispatch({ type: 'plugins', value: [] })
        return
      }
      dispatch({ type: 'pluginsStart' })
      try {
        const list = await api().plugins(target, { deep: opts?.deep ?? false })
        dispatch({ type: 'plugins', value: list })
      } catch (err) {
        const message = toMessage(err)
        dispatch({ type: 'pluginsError', message })
        toast('error', '读取插件列表失败', message)
      }
    },
    [toast]
  )

  const refreshEnv = useCallback(async () => {
    try {
      const [runtime, profiles] = await Promise.all([api().runtimeInfo(), api().profiles()])
      dispatch({ type: 'runtime', value: runtime })
      dispatch({ type: 'profiles', value: profiles })

      const current = stateRef.current.activeProfile
      const preferred = stateRef.current.settings?.defaultProfile ?? null
      const pick =
        (current && profiles.some((p) => p.name === current) ? current : null) ??
        (preferred && profiles.some((p) => p.name === preferred) ? preferred : null) ??
        profiles[0]?.name ??
        null

      if (pick) {
        dispatch({ type: 'activeProfile', name: pick })
        await loadPlugins(pick)
      } else {
        dispatch({ type: 'activeProfile', name: null })
        dispatch({ type: 'plugins', value: [] })
      }
    } catch (err) {
      const message = toMessage(err)
      // 环境探测整体失败 = 找不到 DSH，属于 fatal 级
      dispatch({ type: 'fatal', message })
      toast('error', '环境探测失败', message)
    }
  }, [loadPlugins, toast])

  const reloadAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      /* 这里以前只 refreshEnv（环境 + 插件列表），于是外观类操作全成了哑炮：
       * wallpaperSet / wallpaperAutoFit / themeApply 都是「写进主进程的设置、
       * 再由渲染层读 state.settings 渲染」，settings 不重读，界面就一动不动 ——
       * 用户点了壁纸缩略图，只看到一句「已刷新 · 环境与插件列表已重新拉取」，
       * 而背景根本没换。设置必须跟着一起重读。 */
      try {
        const settings = await api().settingsGet()
        dispatch({ type: 'settings', value: settings })
      } catch {
        /* 设置拉不到不该让整次刷新失败：env 那一半仍然有价值 */
      }
      await refreshEnv()
      if (!opts?.silent) toast('info', '已刷新', '设置、环境与插件列表已重新拉取')
    },
    [refreshEnv, toast]
  )

  /**
   * 只 dispatch 设置。外观写盘的快路径（见 ConsoleActions.applySettings 的注释）。
   * 用 useCallback 包一层是为了能进 actions 的 memo 依赖而不会每次渲染换身份。
   */
  const applySettings = useCallback((next: AppSettings) => {
    dispatch({ type: 'settings', value: next })
  }, [])

  /* ----------------------------- 启动 + 事件订阅 ----------------------------- */

  useEffect(() => {
    let alive = true
    const boot = async (): Promise<void> => {
      try {
        const settings = await api().settingsGet()
        if (!alive) return
        dispatch({ type: 'settings', value: settings })
        await refreshEnv()
        if (alive) dispatch({ type: 'ready' })
      } catch (err) {
        if (alive) dispatch({ type: 'fatal', message: toMessage(err) })
      }
    }
    void boot()
    return () => {
      alive = false
    }
  }, [refreshEnv])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.dsh) return undefined
    const d = window.dsh

    const offLog = d.onOpLog((raw) => {
      dispatch({ type: 'log', lines: toLogLines(raw) })
    })

    const offDone = d.onOpDone((result) => {
      dispatch({ type: 'opEnd', value: result })

      /* 清单批量安装失败时走折叠文案：toast 的 detail 只有 68px 高、又不保留换行
       * （components.css 的 .toast__detail），所以这里要的是那一句话，明细留给弹窗。 */
      const headline = result.ok ? result.message : manifestFailureHeadline(result) ?? result.message
      toast(result.ok ? 'success' : 'error', result.ok ? '操作完成' : '操作失败', headline)

      /* 失败如果压根不是插件的问题、而是 DSH 环境没定下来，只说原因没用 ——
       * 用户要的是一个能点的地方。toast 是纯展示、没有动作位（而 Toasts 组件不在
       * 本次允许改动的清单里），所以这里补一个确认框：确认键就是那条出路。 */
      if (isEnvFailure(result)) {
        requestConfirm({
          title: '这次操作没跑起来：DSH 运行时没找到',
          message: manifestFailureDetail(result) ?? result.message,
          bullets: [
            '插件台要靠 .dsh 里那套 node / pnpm 去装包，这两个没定位到，pnpm 根本没启动。',
            '要指给它的是 DSH_HOME（通常是 C:\\Users\\<你的用户名>\\.dsh），不是 DSH 桌面端装在哪。',
            '所以这次什么都没改：依赖、bundles、node_modules 都还是原样，可以放心重试。'
          ],
          confirmLabel: '去设置里指定 DSH_HOME',
          cancelLabel: '知道了',
          onConfirm: () => {
            /* 先开面板再发聚焦信号：信号是同步派发的，设置面板此刻已经挂载
             * （它只是 return null），会先把意图记下，等面板真的打开再滚过去。 */
            dispatch({ type: 'settingsOpen', value: true })
            requestEnvFocus()
          }
        })
      }

      const profile = stateRef.current.activeProfile
      if (profile) void loadPlugins(profile)
    })

    const offProgress = d.onUpdateProgress((p) => {
      dispatch({ type: 'checkProgress', value: p })
    })

    const offToast = d.onToast((t) => {
      const level: ToastLevel = t.level === 'info' ? 'info' : t.level
      toast(level, t.title, t.detail)
    })

    /* 环境在后台被认出来了（异步路由命中 / 用户改完路径设置 / 补探终于等到 DSH 启动）。
     * 为什么必须订阅：新电脑上同步路由一条都不中，首屏就是「装不了」的引导卡；
     * 主进程随后跑注册表 / 进程 / 快捷方式 / 磁盘扫描，两秒后其实已经知道在哪了，
     * 但界面没有收到任何通知 —— 引导卡一直挂在那儿，用户以为这软件没救。
     * 收到就把环境灌进去、整轮重拉，界面自己好起来，不需要用户点任何按钮。
     *
     * 提示语要说清**这次好了什么**：事件可能在「只补到 node/pnpm」时也发，
     * 那时安装根还是空的 —— 一律说「已自动找到 DSH」会让用户以为启动按钮也能用了。 */
    const offEnv = d.onEnvChanged((info) => {
      dispatch({ type: 'runtime', value: info })
      const runOk = Boolean(info.nodePath && info.pnpmPath)
      if (runOk && info.installRoot) {
        toast('success', '已自动找到 DSH', `${info.installRoot}（来源：${info.installRootFrom ?? '探测'}）`)
      } else if (runOk) {
        toast(
          'success',
          '装插件的环境已就绪',
          `运行时在 ${info.dshHome ?? '.dsh'}（还没找到桌面端安装目录，那只影响「启动 / 退出 DSH」）`
        )
      } else {
        /* node/pnpm 还没齐 —— 别报喜。只把状态换掉，等下一轮。 */
        toast('info', '环境有变化', '还在找 .dsh 里的 Node / pnpm 运行时。')
      }
      void reloadAll({ silent: true })
    })

    return () => {
      offLog()
      offDone()
      offProgress()
      offToast()
      offEnv()
    }
  }, [loadPlugins, reloadAll, toast])

  /* ----------------------------- profile / 更新检查 ----------------------------- */

  const selectProfile = useCallback(
    async (name: string) => {
      dispatch({ type: 'activeProfile', name })
      dispatch({ type: 'select', id: null })
      dispatch({ type: 'plugins', value: [] })
      try {
        const next = await api().settingsSet({ defaultProfile: name })
        dispatch({ type: 'settings', value: next })
      } catch (err) {
        toast('warn', '默认 profile 没存住', toMessage(err))
      }
      await loadPlugins(name)
    },
    [loadPlugins, toast]
  )

  const checkUpdates = useCallback(
    async (names?: string[]) => {
      const profile = stateRef.current.activeProfile
      if (!profile) {
        toast('warn', '没有可检查的 profile')
        return
      }
      const total = names?.length ?? stateRef.current.plugins.length
      dispatch({ type: 'checkStart', total })
      try {
        const map = await api().checkUpdates(profile, names)
        const patched = Object.values(map)
        if (patched.length > 0) dispatch({ type: 'pluginsPatch', value: patched })
        const failed = patched.filter((p) => !!p.updateError).length
        const updatable = patched.filter((p) => p.updateAvailable).length
        if (failed > 0) {
          toast('warn', `更新检查完成，${failed} 个包查询失败`, '失败原因见每行的「更新失败」标记')
        } else {
          toast('success', `更新检查完成`, `${updatable} 个可更新 / 共 ${patched.length} 个`)
        }
      } catch (err) {
        toast('error', '检查更新失败', toMessage(err))
      } finally {
        dispatch({ type: 'checkDone' })
      }
    },
    [toast]
  )

  /* ----------------------------- 操作 ----------------------------- */

  const runOp = useCallback(
    async (req: OpRequest, label: string): Promise<OpResult | null> => {
      dispatch({
        type: 'opStart',
        value: { opId: null, kind: req.kind, label, startedAt: Date.now() }
      })
      try {
        const result = await api().runOp(req)
        dispatch({ type: 'opEnd', value: result })
        return result
      } catch (err) {
        const message = toMessage(err)
        dispatch({ type: 'opEnd', value: null })
        toast('error', `${label} 失败`, message)
        return null
      }
    },
    [toast]
  )

  const updateOne = useCallback(
    async (rec: PluginRecord) => {
      requestConfirm({
        title: `更新 ${rec.name}？`,
        message: `${rec.version ?? '（当前版本未知）'} → ${rec.latestVersion ?? '（远端版本未知）'}`,
        notes: ['会修改 profile 的 package.json，装完需要重启 DSH 才会加载新版本。'],
        kv: [
          { key: '装到', value: rec.profile, mono: true },
          { key: '会修改', value: `${rec.profile}/package.json 与 pnpm-lock.yaml`, mono: true }
        ],
        confirmLabel: '更新',
        onConfirm: () =>
          void runOp(
            {
              kind: 'update',
              profile: rec.profile,
              targets: [rec.name],
              /* 同上：钉到这一行「→ x.y.z」写着的那个版本，别让主进程再猜一次 */
              versions: rec.latestVersion ? { [rec.name]: rec.latestVersion } : undefined
            },
            `更新 ${rec.name}`
          )
      })
    },
    [requestConfirm, runOp]
  )

  const updateAll = useCallback(async () => {
    const profile = stateRef.current.activeProfile
    if (!profile) return
    const list = stateRef.current.plugins.filter((p) => p.updateAvailable)
    const count = list.length
    if (count === 0) {
      toast('info', '没有可更新的插件')
      return
    }
    /* 这一批名字和版本要一起发下去：主进程直接拿它当执行名单，
     * 确认弹窗里列了几个、执行的就是几个，两边不再各算一套。
     * （以前只发 kind + profile，主进程自己去磁盘清单里找「可更新的」，
     *  而磁盘清单的 updateAvailable 恒为 false → 永远回一句「没有可更新的插件」。） */
    const targets = list.map((p) => p.name)
    requestConfirm({
      title: `更新 ${count} 个包？`,
      message: `会把 profile「${profile}」里这 ${count} 个可更新的包升到最新版，逐个跑 pnpm。`,
      bullets: updateConfirmBullets(list),
      notes: [
        '会修改 profile 的 package.json，装完需要重启 DSH 才会加载新版本。',
        '任何一个包的新版本如果与当前 dsh 运行时不兼容，官方通道会拒绝安装并回滚，profile 不会被改坏。'
      ],
      confirmLabel: '更新全部',
      requireText: '更新',
      onConfirm: () =>
        void runOp(
          { kind: 'update-all', profile, targets, versions: updateVersions(list) },
          `更新全部（${count} 个）`
        )
    })
  }, [requestConfirm, runOp, toast])

  /**
   * 批量更新「勾选的那几个」。
   *
   * 和 updateAll 同构，唯一区别是目标来自 state.picks（用户一个一个勾出来的那些），
   * 而不是「所有可更新的」—— 用户挑着更新的需求就落在这里。
   */
  const updateSelected = useCallback(async () => {
    const profile = stateRef.current.activeProfile
    if (!profile) return
    const picks = stateRef.current.picks
    /* 按 picks 从当前清单里取记录：勾选可能横跨多个筛选（勾完再切到别的筛选），
     * 所以不能只用 visible —— 否则「界面上勾了 3 个」会被筛掉一部分变成更新 1 个。
     * 清单里已经不存在的包同时从「弹窗」和「目标」两边消失，两边依然一致。 */
    const list = stateRef.current.plugins.filter((p) => picks.includes(p.name))
    if (list.length === 0) {
      toast('info', '先在列表里勾选要更新的插件')
      return
    }
    const count = list.length
    const targets = list.map((p) => p.name)
    requestConfirm({
      title: `更新选中的 ${count} 个包？`,
      message: `会把 profile「${profile}」里勾选的这 ${count} 个包升到「最新版本」那一列显示的版本。`,
      bullets: updateConfirmBullets(list),
      notes: [
        '会修改 profile 的 package.json，装完需要重启 DSH 才会加载新版本。',
        '任何一个包的新版本如果与当前 dsh 运行时不兼容，官方通道会拒绝安装并回滚，profile 不会被改坏。'
      ],
      confirmLabel: '更新选中',
      requireText: '更新',
      onConfirm: () =>
        void runOp(
          { kind: 'update-all', profile, targets, versions: updateVersions(list) },
          `更新选中（${count} 个）`
        )
    })
  }, [requestConfirm, runOp, toast])

  /**
   * 勾选池按 picks 取记录（三个批量操作共用）。
   *
   * 和 updateSelected 同一条纪律：名单以「确认弹窗里列出的」为准 —— 弹窗列了几个，
   * 执行的就是几个。清单里已经不存在的包两边同时消失。
   */
  const pickedRecords = () => {
    const profile = stateRef.current.activeProfile
    if (!profile) return null
    const picks = stateRef.current.picks
    const list = stateRef.current.plugins.filter((p) => picks.includes(p.name))
    return { profile, list }
  }

  /** 批量操作确认弹窗的名单（列全量，弹窗自己滚动） */
  const batchBullets = (list: PluginRecord[]): string[] =>
    list.map((p) => {
      const state = p.disabled ? '已停用' : p.inBundles ? '加载中' : '未加载'
      return `${p.name}${p.version ? ` ${p.version}` : ''}（${state}${p.builtin ? '，官方内置' : ''}）`
    })

  /**
   * 串行跑完一批单件操作。逐条 await：上一条的 pnpm 没落地，下一条不该起跑
   * （pnpm 的 store 锁虽然会排队，但「并行 N 个进程互相等锁」在日志里是一片乱麻）。
   * 每条跑完 runOp 内部自己刷新清单 / 弹结果条；这里最后补一句汇总。
   *
   * 单条失败不停批（最后汇总 x / N）；用户点「取消」停的是当前那一条 ——
   * 这里顺着主进程带回的取消信号把整批停掉，不然「取消」只拦一条，剩下的
   * 又自己跑起来，跟没取消一样。
   */
  const runBatch = async (
    profile: string,
    list: PluginRecord[],
    kind: 'disable' | 'enable' | 'uninstall'
  ) => {
    const verb = kind === 'disable' ? '停用' : kind === 'enable' ? '启用' : '卸载'
    let okCount = 0
    for (const rec of list) {
      const res = await runOp({ kind, profile, targets: [rec.name] }, `${verb} ${rec.name}`)
      if (res?.ok) {
        okCount += 1
        continue
      }
      if (res && /取消|abort|cancel/i.test(res.message ?? '')) {
        toast('warn', `已停止${verb}：完成 ${okCount} / ${list.length}`, '取消后剩余的条目没有执行。')
        return
      }
    }
    toast(
      okCount === list.length ? 'success' : 'warn',
      `${verb}完成：${okCount} / ${list.length}`,
      okCount === list.length ? undefined : '失败的条目在操作日志里有完整输出。'
    )
  }

  const disableSelected = useCallback(async () => {
    const picked = pickedRecords()
    if (!picked) return
    const { profile, list } = picked
    /* 只对「正在加载层里」的有意义：已经停用的再停一次是空操作 */
    const targets = list.filter((p) => !p.disabled)
    if (targets.length === 0) {
      toast('info', '勾选的插件都已经是停用状态')
      return
    }
    requestConfirm({
      title: `停用选中的 ${targets.length} 个包？`,
      message: `把下面这些包从 profile「${profile}」的加载层（dsh.profile.bundles）里摘掉，已安装的文件不动。`,
      bullets: batchBullets(targets),
      notes: ['重启 DSH 后生效（这批包不再被加载）。随时可以勾回来「启用」。'],
      confirmLabel: '停用选中',
      onConfirm: () => void runBatch(profile, targets, 'disable')
    })
  }, [requestConfirm, toast])

  const enableSelected = useCallback(async () => {
    const picked = pickedRecords()
    if (!picked) return
    const { profile, list } = picked
    const targets = list.filter((p) => p.disabled)
    if (targets.length === 0) {
      toast('info', '勾选的插件没有处于停用状态')
      return
    }
    requestConfirm({
      title: `启用选中的 ${targets.length} 个包？`,
      message: `把下面这些包放回 profile「${profile}」的加载层（按原来的位置顺序插回去）。`,
      bullets: batchBullets(targets),
      notes: ['重启 DSH 后生效。'],
      confirmLabel: '启用选中',
      onConfirm: () => void runBatch(profile, targets, 'enable')
    })
  }, [requestConfirm, toast])

  const uninstallSelected = useCallback(async () => {
    const picked = pickedRecords()
    if (!picked) return
    const { profile, list } = picked
    /* 勾选池本身已经按「已装 + 可卸载」过滤，这里只挡漏网的不可卸载条目 */
    const targets = list.filter((p) => p.removable)
    if (targets.length === 0) {
      toast('info', '勾选的插件都不可卸载（官方内置或被依赖）')
      return
    }
    requestConfirm({
      title: `卸载选中的 ${targets.length} 个包？`,
      message: `把下面这些包从 profile「${profile}」的依赖里真正移除（逐个跑 pnpm remove），文件会从 node_modules 删除。`,
      bullets: batchBullets(targets),
      notes: [
        '此操作不可撤销；profile 的 package.json 每一步都有备份，但卸掉的包要装回来得重新下载。',
        'link / workspace 来源的包只解链，本地源码目录不受影响。'
      ],
      confirmLabel: '卸载选中',
      danger: true,
      requireText: '卸载',
      onConfirm: () => void runBatch(profile, targets, 'uninstall')
    })
  }, [requestConfirm, toast])
  const togglePick = useCallback((name: string) => {
    const cur = stateRef.current.picks
    dispatch({
      type: 'picks',
      value: cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]
    })
  }, [])

  const setPicks = useCallback((names: string[]) => {
    dispatch({ type: 'picks', value: names })
  }, [])

  const toggleOne = useCallback(
    async (rec: PluginRecord) => {
      const next = rec.disabled ? 'enable' : 'disable'
      await runOp({ kind: next, profile: rec.profile, targets: [rec.name] }, `${next === 'enable' ? '启用' : '停用'} ${rec.name}`)
    },
    [runOp]
  )

  const uninstall = useCallback(
    async (rec: PluginRecord) => {
      const bullets = [
        `当前版本：${rec.version ?? '（本地 link，无版本号）'}`,
        rec.inBundles
          ? `会从 dsh.profile.bundles 的下标 [${rec.bundleIndex}] 中摘掉`
          : '不在 bundles 名单里，不会影响加载层',
        rec.hasServer ? '该包声明了服务端插件，卸载后它的能力立即消失' : '该包只做前端注入',
        'node_modules 里的目录会被 pnpm 移除，本地源码目录不受影响'
      ]
      if (!rec.removable) {
        bullets.push('注意：主进程判定该包不可卸载（官方内置或被其他包依赖），执行大概率失败')
      }
      const ok = await askConfirm({
        title: `卸载 ${rec.name}`,
        message: `把 ${rec.name} 从 profile「${rec.profile}」的依赖里移除。此操作会真的调用 pnpm remove。`,
        bullets,
        confirmLabel: '确认卸载',
        danger: true,
        requireText: rec.name
      })
      if (!ok) return
      await runOp(
        { kind: 'uninstall', profile: rec.profile, targets: [rec.name] },
        `卸载 ${rec.name}`
      )
    },
    [askConfirm, runOp]
  )

  const reinstall = useCallback(
    async (rec: PluginRecord) => {
      const ok = await askConfirm({
        title: `重新安装 ${rec.name}`,
        message: `用原始 spec 重新装一遍：${rec.spec}`,
        bullets: ['适用于 node_modules 被删掉 / 安装损坏的情况', '会覆盖当前已安装的同名包'],
        confirmLabel: '重新安装'
      })
      if (!ok) return
      await runOp({ kind: 'install', profile: rec.profile, spec: rec.spec }, `重新安装 ${rec.name}`)
    },
    [askConfirm, runOp]
  )

  const installSpec = useCallback(
    async (spec: string, profile?: string, hint?: InstallConfirmHint): Promise<OpResult | null> => {
      const target = profile ?? stateRef.current.activeProfile
      const trimmed = spec.trim()
      if (!trimmed) {
        toast('warn', '先填一个 spec 再装')
        return null
      }
      if (!target) {
        toast('error', '没有选中的 profile')
        return null
      }

      const name = (hint?.name ?? '').trim() || trimmed
      const version = (hint?.version ?? '').trim() || null
      const normalized = (hint?.normalized ?? '').trim() || trimmed
      const notes: string[] = ['命令行等效：pnpm add ' + normalized]
      if (hint?.alreadyInstalled) notes.push(`已经装了 ${hint.alreadyInstalled}，这次会覆盖。`)
      const banner: ConfirmBanner | null =
        hint?.isDshPlugin === false
          ? {
              level: 'warn',
              text: '这个版本没有声明 dsh.bundle.patch，装完是普通依赖，不会进加载列表。'
            }
          : null

      const ok = await askConfirm({
        title: `安装 ${name}${version ? ` ${version}` : ''}？`,
        message: `会把 ${name} 装进 profile「${target}」的依赖，装完自动重拉插件列表。`,
        kv: [
          { key: '来源', value: normalized, mono: true },
          { key: '装到', value: target, mono: true },
          { key: '会修改', value: `${target}/package.json 与 pnpm-lock.yaml`, mono: true }
        ],
        notes,
        banner,
        confirmLabel: '安装'
      })
      if (!ok) return null
      return runOp({ kind: 'install', profile: target, spec: trimmed }, `安装 ${trimmed}`)
    },
    [askConfirm, runOp, toast]
  )

  /**
   * 按清单批量安装：确认框里列出要装的包名，装完重拉列表。
   * text 是清单原文，原样交给主进程（runOp 的 spec 字段）。
   */
  const installManifest = useCallback(
    async (
      profile: string,
      text: string,
      preview: ManifestPreview
    ): Promise<OpResult | null> => {
      const raw = text.trim()
      if (!raw) {
        toast('warn', '先选一份清单再装')
        return null
      }
      const target = profile || stateRef.current.activeProfile || ''
      if (!target) {
        toast('error', '没有选中的 profile')
        return null
      }

      const missing = preview.missing ?? []
      const count = missing.length
      const shown = missing.slice(0, CONFIRM_LIST_MAX)
      const bullets = shown.map((e) => (e.version ? `${e.name}  ${e.version}` : e.name))
      if (count > shown.length) bullets.push(`…等 ${count} 个`)
      const notes: string[] = []
      if (preview.present.length > 0) {
        notes.push(`${preview.present.length} 个已经在当前 profile 里，会跳过。`)
      }

      const ok = await askConfirm({
        title: `安装清单里的 ${count} 个包？`,
        message: `会把清单里缺的 ${count} 个包装进 profile「${target}」，装完自动重拉插件列表。`,
        bullets,
        notes,
        kv: [{ key: '会修改', value: `${target}/package.json 与 pnpm-lock.yaml`, mono: true }],
        confirmLabel: '安装'
      })
      if (!ok) return null
      return runOp(
        { kind: 'install-manifest', profile: target, spec: raw },
        `安装清单（${count} 个）`
      )
    },
    [askConfirm, runOp, toast]
  )

  const computeSize = useCallback(
    async (rec: PluginRecord) => {
      dispatch({ type: 'deepBusy', name: rec.name })
      try {
        const list = await api().plugins(rec.profile, { deep: true })
        dispatch({ type: 'pluginsPatch', value: list })
      } catch (err) {
        toast('error', '计算占用大小失败', toMessage(err))
      } finally {
        dispatch({ type: 'deepBusy', name: null })
      }
    },
    [toast]
  )

  const cancelOp = useCallback(async () => {
    const opId = stateRef.current.op?.opId ?? null
    if (!opId) {
      toast('warn', '当前没有可取消的操作')
      return
    }
    try {
      const ok = await api().cancelOp(opId)
      if (ok) toast('info', '已发送取消信号', `opId ${opId}`)
      else toast('warn', '取消没有被接受', '操作可能已经结束了')
    } catch (err) {
      toast('error', '取消失败', toMessage(err))
    }
  }, [toast])

  const restartDsh = useCallback(async () => {
    const ok = await askConfirm({
      title: '重启 DSH',
      message: '会让 DSH 主进程退出并重新拉起，新的 plugins/bundles 配置才会生效。',
      bullets: ['正在进行的会话会被中断', '插件台本身不受影响，重启完可以继续操作'],
      confirmLabel: '重启 DSH',
      danger: true
    })
    if (!ok) return
    try {
      const res = await api().restartDsh()
      toast(res.ok ? 'success' : 'error', res.ok ? '已请求重启 DSH' : '重启失败', res.message)
    } catch (err) {
      toast('error', '重启请求失败', toMessage(err))
    }
  }, [askConfirm, toast])

  /* ----------------------------- DSH 进程 ----------------------------- */

  const startDsh = useCallback(async (): Promise<DshActionResult | null> => {
    const installRoot = stateRef.current.runtime?.installRoot ?? null
    const ok = await askConfirm({
      title: '启动 DSH？',
      message: `会用 ${installRoot ?? '安装目录'} 下的可执行文件拉起 DSH 桌面端。`,
      notes: ['启动后插件台会继续显示进程状态；装完插件要重启 DSH 才会加载。'],
      confirmLabel: '启动 DSH'
    })
    if (!ok) return null
    try {
      const res = await api().dshStart()
      toast(res.ok ? 'success' : 'error', res.ok ? 'DSH 已启动' : '启动 DSH 失败', res.message)
      return res
    } catch (err) {
      toast('error', '启动 DSH 失败', toMessage(err))
      return null
    }
  }, [askConfirm, toast])

  const stopDsh = useCallback(async (): Promise<DshActionResult | null> => {
    const ok = await askConfirm({
      title: '退出 DSH？',
      message: '正在运行的 DSH 会关闭，未保存的会话可能丢失。',
      bullets: ['插件台自己不受影响，之后可以再点「启动 DSH」把它拉起来'],
      confirmLabel: '退出 DSH',
      danger: true
    })
    if (!ok) return null
    try {
      const res = await api().dshStop()
      toast(res.ok ? 'success' : 'error', res.ok ? 'DSH 已退出' : '退出 DSH 失败', res.message)
      return res
    } catch (err) {
      toast('error', '退出 DSH 失败', toMessage(err))
      return null
    }
  }, [askConfirm, toast])

  /* ----------------------------- 清单导出 ----------------------------- */

  const exportManifest = useCallback(async (): Promise<ManifestExportResult | null> => {
    const profile =
      stateRef.current.activeProfile ?? stateRef.current.settings?.defaultProfile ?? null
    if (!profile) {
      toast('warn', '没有可导出的 profile', '先在左侧选一个 profile')
      return null
    }
    try {
      const res = await api().exportManifest(profile)
      if (!res.ok) {
        // 用户在保存对话框里点了取消：这是正常路径，不要弹错误提示
        if (res.error === '已取消') return res
        toast('error', '导出清单失败', res.error ?? '主进程没有给出原因')
        return res
      }
      toast(
        'success',
        `已导出 ${res.count} 个插件`,
        (res.skipped ?? []).length > 0
          ? `${res.path ?? ''}\n\n跳过了 ${(res.skipped ?? []).length} 个本地开发来源的插件（${(res.skipped ?? []).join('、')}）—— 它们指向这台机器上的目录，清单拿去别的机器装不上。`
          : res.path ?? undefined
      )
      return res
    } catch (err) {
      toast('error', '导出清单失败', toMessage(err))
      return null
    }
  }, [toast])

  /* ----------------------------- 杂项 ----------------------------- */

  const revealPath = useCallback(
    async (target: string | null) => {
      if (!target) {
        toast('warn', '这个包没有安装路径（未安装 / link 目标不存在）')
        return
      }
      try {
        const ok = await api().revealPath(target)
        if (!ok) toast('warn', '打不开这个路径', target)
      } catch (err) {
        toast('error', '打开目录失败', toMessage(err))
      }
    },
    [toast]
  )

  const openExternal = useCallback(
    async (url: string | null) => {
      if (!url) return
      try {
        const ok = await api().openExternal(url)
        if (!ok) toast('warn', '链接没法打开', url)
      } catch (err) {
        toast('error', '打开链接失败', toMessage(err))
      }
    },
    [toast]
  )

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const next = await api().settingsSet(patch)
        dispatch({ type: 'settings', value: next })
        toast('success', '设置已保存')
        await refreshEnv()
        return true
      } catch (err) {
        toast('error', '保存设置失败', toMessage(err))
        return false
      }
    },
    [refreshEnv, toast]
  )

  const actions = useMemo<ConsoleActions>(
    () => ({
      refreshEnv,
      reloadAll,
      applySettings,
      selectProfile,
      loadPlugins,
      checkUpdates,
      updateOne,
      updateAll,
      updateSelected,
      disableSelected,
      enableSelected,
      uninstallSelected,
      togglePick,
      setPicks,
      toggleOne,
      uninstall,
      reinstall,
      installSpec,
      installManifest,
      exportManifest,
      startDsh,
      stopDsh,
      computeSize,
      cancelOp,
      restartDsh,
      revealPath,
      openExternal,
      saveSettings,
      applyRuntime: (info: RuntimeInfo) => dispatch({ type: 'runtime', value: info }),
      setSearch: (value: string) => dispatch({ type: 'search', value }),
      setFilter: (value: FilterKey) => dispatch({ type: 'filter', value }),
      setShowBuiltinLayer: (value: boolean) => dispatch({ type: 'showBuiltin', value }),
      setView: (value: ViewKey) => dispatch({ type: 'view', value }),
      select: (id: string | null) => dispatch({ type: 'select', id }),
      openSettings: () => dispatch({ type: 'settingsOpen', value: true }),
      closeSettings: () => dispatch({ type: 'settingsOpen', value: false }),
      clearLogs: () => dispatch({ type: 'logsClear' }),
      dismissWarnings: () => dispatch({ type: 'warnDismiss' }),
      toast,
      dismissToast,
      askConfirm,
      requestConfirm,
      resolveConfirm,
      cancelConfirm
    }),
    [
      refreshEnv,
      reloadAll,
      applySettings,
      selectProfile,
      loadPlugins,
      checkUpdates,
      updateOne,
      updateAll,
      updateSelected,
      disableSelected,
      enableSelected,
      uninstallSelected,
      togglePick,
      setPicks,
      toggleOne,
      uninstall,
      reinstall,
      installSpec,
      installManifest,
      exportManifest,
      startDsh,
      stopDsh,
      computeSize,
      cancelOp,
      restartDsh,
      revealPath,
      openExternal,
      saveSettings,
      toast,
      dismissToast,
      askConfirm,
      requestConfirm,
      resolveConfirm,
      cancelConfirm
    ]
  )

  const visible = useMemo(
    () =>
      filterPlugins(state.plugins, {
        search: state.search,
        filter: state.filter,
        showBuiltinLayer: state.showBuiltinLayer
      }),
    [state.plugins, state.search, state.filter, state.showBuiltinLayer]
  )

  const counts = useMemo(
    () => countFilters(state.plugins, state.showBuiltinLayer),
    [state.plugins, state.showBuiltinLayer]
  )

  const value = useMemo<ConsoleContextValue>(
    () => ({
      state,
      actions,
      visible,
      counts,
      settings: state.settings ?? FALLBACK_SETTINGS
    }),
    [state, actions, visible, counts]
  )

  // 本文件是 .ts（不能写 JSX），所以 Provider 用 createElement 挂
  return createElement(ConsoleContext.Provider, { value }, children)
}