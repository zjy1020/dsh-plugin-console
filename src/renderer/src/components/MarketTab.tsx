/**
 * MarketTab —— 「插件市场」tab。
 *
 * 数据：marketList({ force })（主进程 market.ts 从 dsh-plugin-catalog 这个 npm 包里
 *       解出 plugins.json，8000+ 条，首次要几秒）
 * 呈现：宫格卡片；点卡片开详情（覆盖层）。安装动作全走 actions.installSpec，
 *       确认框由 store 统一弹，这里不绕过。
 * 图标：卡片只看目录的 icon 字段（带 loading="lazy"），加载失败立刻退成 monogram 首字母，
 *       不重试、不走主进程那套三级解析；本机装过的条目在详情里才交给 PluginIcon。
 *       任何情况都不会出现空洞。
 *
 * 目录有 8000+ 条，所以列表是**虚拟滚动（windowing）**：只把视口上下各一屏对应的那几十张卡
 * 挂进 DOM，剩下靠一个撑高的占位容器顶着滚动条。滚动时只换挂进来的那一段，
 * DOM 节点数封顶，不会随着往下滚越长越多。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { MarketEntry, MarketList, VersionOption } from '../../../shared/types'
import { api, toMessage, useDebouncedValue } from '../api'
import { useConsole } from '../lib/store'
import { marketSpecOf } from '../lib/marketSpec'
import { EmptyState } from './EmptyState'
import { PluginIcon, monogramOf } from './PluginIcon'
import PluginGallery from './PluginGallery'
import VersionPicker from './VersionPicker'
import '../styles/market.css'

/** 首屏先按这么多张摆（挂载后马上按视口高度重算） */
const PAGE = 48
/** 卡片列宽下限，跟 market.css 里 `minmax(200px, 1fr)` 保持一致 */
const MIN_COL_W = 200
/** 量不到实际行高时的兜底（卡片 158 + 行间距 12） */
const FALLBACK_ROW_H = 170

type SortKey = 'stars' | 'downloads' | 'added'

const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'stars', label: '星标', hint: '按 GitHub 星标从多到少' },
  { key: 'downloads', label: '下载量', hint: '按 npm 下载量从多到少' },
  { key: 'added', label: '最近加入', hint: '按目录收录时间从新到旧' }
]

/** 能力标签的中文名（目录里的 id 是英文，这里只做显示层翻译） */
const CAP_LABELS: Record<string, string> = {
  shell: '执行命令',
  network: '联网',
  credentials: '读凭据',
  'fs-read': '读文件',
  'fs-write': '写文件',
  env: '读环境变量',
  llm: '调模型',
  'dynamic-code': '动态代码'
}

/** 多语言里挑一句给用户看的描述：中文优先 */
function descOf(entry: MarketEntry): string {
  const d = entry.description
  return (d['zh-CN'] ?? d['zh'] ?? d['en'] ?? Object.values(d)[0] ?? '').trim()
}

/** 目录里其它语言的描述（详情里补一句，方便对照） */
function descAlt(entry: MarketEntry): string {
  const d = entry.description
  const en = (d['en'] ?? '').trim()
  return en && en !== descOf(entry) ? en : ''
}

/** 分类显示名：中文优先，没有就退回 id */
function labelOf(id: string, labels: Record<string, string>): string {
  return (labels['zh-CN'] ?? labels['zh'] ?? labels['en'] ?? Object.values(labels)[0] ?? '').trim() || id
}

/** null 排最后（配合降序排序用：拿 -1 当下界） */
function num(v: number | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : -1
}

/** 89901 → 8.99 万；卡片位置小，用中文数量级更好读 */
function fmtNum(n: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 亿`
  if (n >= 10000) return `${(n / 10000).toFixed(2)} 万`
  return String(n)
}

/** 「3 分钟前」这种相对时间 */
function agoText(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '未知时间'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 只认 http(s) 的图标地址（目录里偶尔会有空串或相对路径） */
function httpUrl(v: string | null | undefined): string | null {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null
}

/* ------------------------------------------------------------------ *
 * 卡片图标
 * ------------------------------------------------------------------ */

/**
 * 详情面板里的图标：走跟卡片同一条地址链（目录声明的 → 排队去仓库里猜），
 * 都没图、而本机真装过这个包，才交给 PluginIcon 去本地包目录里找。
 * 详情一次只开一张，所以不用 lazy。
 */
function MktIcon({
  entry,
  profile,
  size,
  installed
}: {
  entry: MarketEntry
  profile: string
  size: number
  installed: boolean
}) {
  const pkg = entry.npm ?? entry.name
  const { src, kind, onFailed } = useEntryIcon(entry)

  // 本机真装过这个包时，本地包里的图标才是正主。头像只是「插件自己仓库里没图」时的
  // 兜底，不该让它盖掉本机包自带的图标（声明地址和猜出来的地址仍然优先）。
  if (installed && kind === 'avatar') {
    return <PluginIcon profile={profile} name={pkg} size={size} radius={Math.round(size / 4)} className="mkt__icon" />
  }

  if (src) {
    return (
      <img
        key={src}
        className="mkt__icon mkt__icon--img"
        src={src}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        referrerPolicy="no-referrer"
        onError={onFailed}
      />
    )
  }

  if (installed) {
    return <PluginIcon profile={profile} name={pkg} size={size} radius={Math.round(size / 4)} className="mkt__icon" />
  }

  return <Monogram pkg={pkg} size={size} />
}

/**
 * 从条目带的仓库地址里抠出 owner/repo。
 * url 常常是子目录形态（…/tree/main/packages/xxx），所以只取前两段；
 * 不是 GitHub 的地址直接返回 null（那种情况不猜图标）。
 */
function repoOf(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /github\.com\/([^/?#]+)\/([^/?#]+)/.exec(url)
  if (!m) return null
  const repo = m[2].replace(/\.git$/, '')
  if (!m[1] || !repo || repo === 'tree') return null
  return `${m[1]}/${repo}`
}

/**
 * 条目属于哪个 GitHub 账号 —— 插件自己仓库里没图时，拿它的头像当兜底。
 * 优先信仓库地址里的第一段（那一定是账号名），退回目录给的 owner 字段，
 * 但只认像 GitHub 登录名的写法（字母数字加连字符），别的（邮箱、显示名）宁可不猜。
 */
function ownerOf(repo: string | null, owner: string | null | undefined): string | null {
  if (repo) {
    const first = repo.split('/')[0]
    if (first) return first
  }
  const o = typeof owner === 'string' ? owner.trim() : ''
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(o) ? o : null
}

/**
 * 条目名里 # 后面那段，就是它在这台仓库里的子目录（如 archify#integrations/deepseek-harness）。
 * 这类条目（默认星标榜前列一大半都是）图标基本都在自己那个子目录里，不在仓库根，
 * 所以要先按子目录拼地址试一遍。返回的路径里含 .. 的一律不要。
 */
function subdirOf(entry: MarketEntry): string | null {
  const hash = entry.name.indexOf('#')
  const fromName = hash >= 0 ? entry.name.slice(hash + 1) : ''
  if (fromName && !fromName.includes('..')) return fromName.replace(/^\/+|\/+$/g, '')
  const m = /github\.com\/[^/]+\/[^/]+\/(?:tree|blob)\/[^/]+\/(.+)$/.exec(entry.url ?? '')
  if (m && m[1] && !m[1].includes('..')) return m[1].replace(/^\/+|\/+$/g, '')
  return null
}

/** 目录只给 6% 的条目声明了 icon，其余按仓库地址猜这个顺序的常见位置；用 HEAD，不假定默认分支叫 main */
const ICON_CANDIDATES = [
  'assets/icon-180.png',
  'assets/icon.png',
  'icon-180.png',
  'icon.png',
  'assets/logo.png',
  'logo.png',
  'public/icon.png',
  'public/logo.png',
  'assets/icon.svg',
  'icon.svg'
]

/** 子目录形态的条目：图标在它自己的子目录下，实测命中的基本是子目录根上的 icon.svg / assets/icon-* */
const ICON_CANDIDATES_SUB = [
  'icon.svg',
  'assets/icon-180.png',
  'assets/icon.png',
  'icon.png',
  'assets/icon.svg',
  'icon-180.png',
  'assets/logo.png'
]

/** 子目录里都没命中时，只在仓库根再试这么几个，别把队列占太久 */
const ICON_SUB_ROOT_FALLBACK = 4

/* ------------------------------------------------------------------ *
 * 图标探测队列
 *
 * 找图只能靠 <img> 的 load/error 一个个试（renderer 的 connect-src 只有 'self'，fetch 会 Failed
 * to fetch），一屏几十张卡同时开一堆候选会把网络连接和渲染都拖住（实测滚一格要十几秒）。
 * 偏偏这两件事的代价差得很远，所以给它们**两条独立的队列**：
 *
 *   头像队列：一次请求（github.com/<owner>.png → 302 到 CDN 上的 2 KB 小图），快、几乎必中，
 *            是「每张卡都得有图」的底。给它自己的一份额度，绝不被猜路径挤掉 ——
 *            之前共用一条队列时，一屏 48 张卡会把 24 个位置全占满，结果连头像都排不进去，
 *            屏幕上照样整片首字母。
 *   猜图队列：一个仓库最多试 10 个候选（单个 2.5 秒超时），慢、命中率天生就低，
 *            所以并发压到 4、排队上限 24，排不上就算了（头像已经在那儿了）。
 * 两条队列各自按 key 缓存结果，同一个仓库/账号只探一次。
 * ------------------------------------------------------------------ */

const ICON_PROBE_CONCURRENCY = 4
const ICON_PROBE_QUEUE_MAX = 24
const AVATAR_PROBE_CONCURRENCY = 6
const AVATAR_QUEUE_MAX = 240
const ICON_CANDIDATE_TIMEOUT_MS = 2500

/** 一个带并发上限与排队上限的小队列；队列太长返回 null（这次不探） */
function createProbeQueue(concurrency: number, max: number) {
  const jobs: (() => Promise<unknown>)[] = []
  let active = 0
  const pump = (): void => {
    while (active < concurrency && jobs.length > 0) {
      const task = jobs.shift()
      if (!task) break
      active += 1
      void task().finally(() => {
        active -= 1
        pump()
      })
    }
  }
  return <R,>(job: () => Promise<R>): Promise<R> | null => {
    if (jobs.length >= max) return null
    return new Promise<R>((resolve) => {
      jobs.push(async () => resolve(await job()))
      pump()
    })
  }
}

const iconProbeSlot = createProbeQueue(ICON_PROBE_CONCURRENCY, ICON_PROBE_QUEUE_MAX)
const avatarProbeSlot = createProbeQueue(AVATAR_PROBE_CONCURRENCY, AVATAR_QUEUE_MAX)

/** 仓库地址 → 探到的图标 URL（null = 试完所有候选都没有），以及正在探的同一个仓库 */
const iconCache = new Map<string, string | null>()
const iconPending = new Map<string, Promise<string | null>>()

/** 一个候选地址能不能当图加载（超时也算失败） */
function tryIconUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      img.onload = null
      img.onerror = null
      window.clearTimeout(timer)
      resolve(ok)
    }
    const timer = window.setTimeout(() => finish(false), ICON_CANDIDATE_TIMEOUT_MS)
    img.onload = () => finish(true)
    img.onerror = () => finish(false)
    img.src = url
  })
}

/** 探一个仓库（可带子目录）的图标：命中的话回地址，全试完都没有回 null；队列满了回 null（按没图处理） */
function probeIcon(repo: string, sub: string | null): Promise<string | null> | null {
  const key = sub ? `${repo}#${sub}` : repo
  const cached = iconCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = iconPending.get(key)
  if (pending) return pending

  const paths = sub
    ? [
        ...ICON_CANDIDATES_SUB.map((candidate) => `${sub}/${candidate}`),
        ...ICON_CANDIDATES.slice(0, ICON_SUB_ROOT_FALLBACK)
      ]
    : ICON_CANDIDATES

  const task = iconProbeSlot<string | null>(async () => {
    for (const candidate of paths) {
      const url = `https://raw.githubusercontent.com/${repo}/HEAD/${candidate}`
      if (await tryIconUrl(url)) {
        iconCache.set(key, url)
        return url
      }
    }
    iconCache.set(key, null)
    return null
  })
  if (!task) return null

  iconPending.set(key, task)
  void task.finally(() => {
    if (iconPending.get(key) === task) iconPending.delete(key)
  })
  return task
}

/**
 * 探发布者头像：`github.com/<login>.png?size=96` 会 302 到 CDN 上的小图（约 2 KB），
 * 比任何截图都轻。只在「声明地址 + 仓库里猜」都没中时才轮到它，
 * 但它是最后一道有真图的防线 —— 有了它卡片不会整屏都是首字母。
 * 负结果（确实没这个账号 / 拿不到）也缓存，同一个账号只探一次。
 */
const avatarCache = new Map<string, string | null>()
const avatarPending = new Map<string, Promise<string | null>>()

function probeAvatar(login: string): Promise<string | null> | null {
  const cached = avatarCache.get(login)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = avatarPending.get(login)
  if (pending) return pending

  const candidates = [`https://github.com/${login}.png?size=96`, `https://avatars.githubusercontent.com/${login}`]
  const task = avatarProbeSlot<string | null>(async () => {
    for (const url of candidates) {
      if (await tryIconUrl(url)) {
        avatarCache.set(login, url)
        return url
      }
    }
    avatarCache.set(login, null)
    return null
  })
  if (!task) return null

  avatarPending.set(login, task)
  void task.finally(() => {
    if (avatarPending.get(login) === task) avatarPending.delete(login)
  })
  return task
}

function Monogram({ pkg, size }: { pkg: string; size: number }) {
  return (
    <span
      className="mkt__icon mkt__icon--mono"
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) }}
      aria-hidden="true"
    >
      {monogramOf(pkg)}
    </span>
  )
}

/** 声明地址挂了、或者热更新换了条目，都从「没图」重新开始 */
type IconKind = 'declared' | 'probed' | 'avatar'
function useEntryIcon(entry: MarketEntry): { src: string | null; kind: IconKind | null; onFailed: () => void } {
  const declared = httpUrl(entry.icon)
  const repo = repoOf(entry.url)
  const sub = subdirOf(entry)
  const login = ownerOf(repo, entry.owner)
  const [declaredFailed, setDeclaredFailed] = useState(false)
  const [probed, setProbed] = useState<string | null>(null)
  const [avatar, setAvatar] = useState<string | null>(null)

  useEffect(() => {
    setDeclaredFailed(false)
    setProbed(null)
    setAvatar(null)
  }, [entry])

  const showDeclared = Boolean(declared) && !declaredFailed

  /**
   * 三级找图，压进两条队列（详见上面 createProbeQueue 那段）：
   *   1. 目录声明的 icon —— 有就用，不探
   *   2. 发布者头像 —— 一个请求、2 KB、几乎必中，**先把它填进格子**，卡片不许空着
   *   3. 按仓库地址（带子目录就先在子目录里）猜常见位置 —— 慢，命中就升级成插件自己的图标
   * 显示优先级始终是 声明 → 猜到的 → 头像，所以头像只是「先垫上」，真图标一到就换掉它。
   */
  useEffect(() => {
    if (showDeclared) return
    let alive = true
    if (login) {
      void (probeAvatar(login) ?? Promise.resolve(null)).then((face) => {
        if (alive && face) setAvatar(face)
      })
    }
    if (repo) {
      void (probeIcon(repo, sub) ?? Promise.resolve(null)).then((hit) => {
        if (alive && hit) setProbed(hit)
      })
    }
    return () => {
      alive = false
    }
  }, [showDeclared, repo, sub, login])

  if (showDeclared) {
    return { src: declared, kind: 'declared', onFailed: () => setDeclaredFailed(true) }
  }
  if (probed) {
    return { src: probed, kind: 'probed', onFailed: () => setProbed(null) }
  }
  return { src: avatar, kind: avatar ? 'avatar' : null, onFailed: () => setAvatar(null) }
}

function CardIcon({ entry, size }: { entry: MarketEntry; size: number }) {
  const pkg = entry.npm ?? entry.name
  const { src, onFailed } = useEntryIcon(entry)

  if (!src) return <Monogram pkg={pkg} size={size} />

  return (
    <img
      key={src}
      className="mkt__icon mkt__icon--img"
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={onFailed}
    />
  )
}

export interface MarketTabProps {
  /** 装到哪个 profile（安装 / 已装判定都用它） */
  profile: string
  /** 装成功后回调（父级可以顺手刷新插件列表） */
  onInstalled?: (entry: MarketEntry) => void
}

export function MarketTab({ profile, onInstalled }: MarketTabProps) {
  const { state, actions } = useConsole()

  const [list, setList] = useState<MarketList | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query.trim(), 200)
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<SortKey>('stars')

  /**
   * 虚拟滚动（windowing）：8000+ 条不可能全进 DOM。
   *   - metrics：每行几张卡（按容器宽度算）+ 一行多高（卡片固定高 + 行间距），ResizeObserver 跟着容器变
   *   - range：当前要挂进 DOM 的那一段（视口 ±1 屏），滚动时只改这个区间
   *   - offset：这一段第一行距离列表顶部的像素数，用 translateY 摆到正确位置
   */
  const [metrics, setMetrics] = useState({ cols: 4, rowH: FALLBACK_ROW_H, gap: 12 })
  const [range, setRange] = useState({ start: 0, end: PAGE, offset: 0 })
  const gridWrapRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)

  /** 正在装的那一条（按钮转圈用） */
  const [installing, setInstalling] = useState<string | null>(null)

  /** 详情覆盖层：当前打开的那条；picker 是里面的版本选择面板 */
  const [open, setOpen] = useState<MarketEntry | null>(null)
  const [picker, setPicker] = useState(false)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  /** 关闭详情后把焦点还给刚才那张卡 */
  const lastTriggerRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  const busy = state.op !== null

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await api().marketList(force ? { force: true } : undefined)
      setList(res)
      if (!res.ok) setErr(res.error ?? '插件目录拉取失败')
    } catch (e) {
      setList(null)
      setErr(toMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  /** 当前 profile 真实装了的包名 → 版本（store 里的列表比目录自带的 installed 更贴近「现在」） */
  const installedMap = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const p of state.plugins) {
      if (p.profile === profile && p.installed) m.set(p.name.toLowerCase(), p.version ?? null)
    }
    return m
  }, [state.plugins, profile])

  const pkgOf = useCallback((entry: MarketEntry) => entry.npm ?? entry.name, [])

  const isInstalled = useCallback(
    (entry: MarketEntry) => entry.installed || installedMap.has(pkgOf(entry).toLowerCase()),
    [installedMap, pkgOf]
  )

  /** 本机已装的版本；没装过给 undefined（不要给 null —— null 是「确认没有」的意思） */
  const installedVersionOf = useCallback(
    (entry: MarketEntry): string | undefined => {
      const v = installedMap.get(pkgOf(entry).toLowerCase())
      return v ?? (entry.installed ? entry.version ?? undefined : undefined)
    },
    [installedMap, pkgOf]
  )

  const all = list?.plugins ?? []

  const filtered = useMemo(() => {
    const q = debounced.toLowerCase()
    const out = all.filter((e) => {
      if (category !== 'all' && !e.categories.includes(category)) return false
      if (!q) return true
      if (e.name.toLowerCase().includes(q)) return true
      if ((e.npm ?? '').toLowerCase().includes(q)) return true
      if (e.owner.toLowerCase().includes(q)) return true
      return Object.values(e.description).some((v) => v.toLowerCase().includes(q))
    })
    const sorted = out.slice()
    if (sort === 'added') sorted.sort((a, b) => b.added.localeCompare(a.added))
    else if (sort === 'downloads') sorted.sort((a, b) => num(b.downloads) - num(a.downloads))
    else sorted.sort((a, b) => num(b.stars) - num(a.stars))
    return sorted
  }, [all, debounced, category, sort])

  /** 过滤 + 排序后剩下多少条（下面虚拟滚动就按这个数撑高度） */
  const count = filtered.length
  /** 宫格出现在 DOM 里之后才量得到列数/行高（首屏先渲染的是「正在拉目录…」那一段） */
  const hasGrid = count > 0

  /**
   * 量「一行几张卡」和「一行多高」：都从实时布局读，不写死列数 —— 窗口拉宽缩窄、换字号都会重算。
   * 行高 = 卡片高 + 行间距；卡片是固定高度（描述固定 2 行截断），所以行高稳定、滚动位置不会漂。
   */
  useEffect(() => {
    if (!hasGrid) return
    const wrap = gridWrapRef.current
    const grid = wrap?.firstElementChild as HTMLElement | null
    if (!wrap || !grid) return

    const measure = () => {
      const cs = getComputedStyle(grid)
      const colGap = Number.parseFloat(cs.columnGap) || 12
      const rowGap = Number.parseFloat(cs.rowGap) || colGap
      const width = wrap.clientWidth
      const cols = Math.max(1, Math.floor((width + colGap) / (MIN_COL_W + colGap)))
      const card = grid.firstElementChild as HTMLElement | null
      const cardH =
        card?.offsetHeight || Number.parseFloat(cs.getPropertyValue('--mkt-card-h')) || FALLBACK_ROW_H - rowGap
      const rowH = cardH + rowGap
      setMetrics((prev) =>
        prev.cols === cols && prev.rowH === rowH && prev.gap === rowGap ? prev : { cols, rowH, gap: rowGap }
      )
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [hasGrid])

  const rows = Math.max(1, Math.ceil(count / metrics.cols))
  /** 撑开滚动条用的总高度：真实条目数 × 行高，DOM 里并没有那么多卡 */
  const gridHeight = count > 0 ? rows * metrics.rowH - metrics.gap : 0

  /**
   * 按当前滚动位置算出该挂哪一段：视口 + 上下各留一屏，滚动时看不到空白。
   * 过滤/排序/搜索都在前面算完了，这里只决定「渲染哪几十张」——不是先渲染全部再隐藏。
   */
  const computeRange = useCallback(() => {
    const wrap = gridWrapRef.current
    if (!wrap) return
    const { cols, rowH } = metrics
    const rowCount = Math.max(1, Math.ceil(count / cols))
    const scroller = scrollerRef.current
    const wrapTop = wrap.getBoundingClientRect().top
    const viewTopRaw = scroller ? scroller.getBoundingClientRect().top : 0
    const viewBottomRaw = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight
    const viewTop = Math.max(0, viewTopRaw - wrapTop)
    const viewBottom = Math.min(wrap.offsetHeight, Math.max(0, viewBottomRaw - wrapTop))
    const firstRow = Math.max(0, Math.min(rowCount - 1, Math.floor(viewTop / rowH) - 1))
    const lastRow = Math.max(firstRow, Math.min(rowCount - 1, Math.ceil(viewBottom / rowH) + 1))
    const start = firstRow * cols
    const end = Math.min(count, (lastRow + 1) * cols)
    const offset = firstRow * rowH
    setRange((prev) =>
      prev.start === start && prev.end === end && prev.offset === offset ? prev : { start, end, offset }
    )
  }, [metrics, count])

  /**
   * 挂滚动监听。滚动容器就是替整个「安装插件」页滚动的那一层（向上找第一个能滚的祖先，
   * 找不到就用根滚动元素）。
   *
   * 这里直接在 scroll 回调里同步算区间，不套 rAF：算一次只是读两个 rect 再比几个数（不做布局写入），
   * 而窗口被遮挡/最小化时 rAF 根本不回调 —— 实测过，套 rAF 会让窗口慢一拍甚至一两秒才跟上，
   * 快速滚动时就会看到空白。
   */
  useEffect(() => {
    if (!hasGrid) return
    const wrap = gridWrapRef.current
    if (!wrap) return

    let el: HTMLElement | null = wrap.parentElement
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) break
      el = el.parentElement
    }
    scrollerRef.current = el ?? (document.scrollingElement as HTMLElement | null)

    const target: EventTarget = scrollerRef.current ?? window
    const onScroll = () => computeRange()

    computeRange()
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      target.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [hasGrid, computeRange])

  // 换关键词 / 换分类 / 换排序 / 目录换了：把列表滚回顶部，避免「翻到第 500 张卡又改条件」的错位
  useEffect(() => {
    const wrap = gridWrapRef.current
    const scroller = scrollerRef.current
    if (wrap && scroller && scroller !== document.scrollingElement) {
      const delta = wrap.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      if (delta < -4) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 8)
    }
    setRange({ start: 0, end: PAGE, offset: 0 })
  }, [debounced, category, sort, list])

  /** 真正挂进 DOM 的只有这一段 */
  const visible = filtered.slice(range.start, range.end)

  /**
   * 详情打开时把焦点移进面板；关闭后把焦点还给刚才那张卡（键盘用户不会掉到页面开头）。
   * 都放在 effect 里做：effect 跑在 DOM 提交之后，关闭那一帧面板已经卸载完，
   * 不会被「面板卸载导致焦点掉到 body」盖掉（用 rAF 就会踩这个时序）。
   */
  useEffect(() => {
    if (open) {
      sheetRef.current?.focus()
      return
    }
    const back = lastTriggerRef.current
    if (back && document.contains(back)) back.focus()
  }, [open])

  const closeDetail = useCallback(() => {
    setOpen(null)
    setPicker(false)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeDetail()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closeDetail])

  /** Tab 循环留在面板里 */
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab') return
    const panel = sheetRef.current
    if (!panel) return
    const nodes = Array.from(
      panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter((n) => !n.hasAttribute('disabled'))
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const cur = document.activeElement as HTMLElement | null
    if (e.shiftKey && (cur === first || cur === panel)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const onInstall = async (entry: MarketEntry) => {
    if (busy || installing) return
    // 目录给的 `install` 是整条命令行（`dsh plugin --profile web add x`），
    // 交给 marketSpecOf 洗成真 spec；洗不出来就别往下走，免得又报「输入里有空格」
    const spec = marketSpecOf(entry)
    if (!spec) {
      actions.toast('error', `目录这条没给能用的安装地址（${entry.name}），点「打开仓库」自己看一眼`)
      return
    }
    const installedNow = isInstalled(entry)
    setInstalling(entry.name)
    try {
      const res = await actions.installSpec(spec, profile, {
        normalized: spec,
        name: pkgOf(entry),
        // 目录里的 version 是它收录时的快照，不是这次真要装的版本（实际拿的是 registry / 仓库上的最新），
        // 直接写进去会变成「说要装 11.3.0，装出来是 11.4.1」。spec 本身钉死了版本/引用时就不用这句。
        version: /@\d+\.\d+\.\d+|#.+$/.test(spec) ? null : '最新版',
        isDshPlugin: null,
        alreadyInstalled: installedNow ? (entry.version ?? '已装') : null
      })
      if (res?.ok) onInstalled?.(entry)
    } finally {
      setInstalling(null)
    }
  }

  /** 详情里选中一个版本 → 直接交给 store 的安装链路（确认框它自己弹） */
  const onPickVersion = async (entry: MarketEntry, option: VersionOption) => {
    const pkg = pkgOf(entry)
    const res = await actions.installSpec(option.spec, profile, {
      normalized: option.spec,
      name: pkg,
      version: option.value,
      isDshPlugin: null
    })
    if (res?.ok) {
      setPicker(false)
      onInstalled?.(entry)
    }
  }

  const openDetail = (entry: MarketEntry, trigger: HTMLElement) => {
    lastTriggerRef.current = trigger
    setPicker(false)
    setOpen(entry)
  }

  const cached = list?.cached === true
  const categories = list?.categories ?? []
  const total = list?.total ?? 0
  const catLabel = (id: string) => labelOf(id, categories.find((c) => c.id === id)?.labels ?? {})

  /* 详情里用得到的两份派生值：包名、本机已装版本（没装过是 undefined，不给 null） */
  const openPkg = open ? pkgOf(open) : ''
  const openCurrent = open ? installedVersionOf(open) : undefined

  return (
    <div className="install__pane mkt">
      <div className="mkt__bar">
        <div className="mkt__search">
          <span className="mkt__search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            className="input mkt__input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜名字 / 描述 / 作者 / npm 包名"
            spellCheck={false}
            aria-label="在插件目录里搜索"
          />
          {query ? (
            <button type="button" className="btn btn--ghost btn--sm mkt__clear" onClick={() => setQuery('')} title="清空搜索">
              ✕
            </button>
          ) : null}
        </div>

        <label className="mkt__select">
          <span className="mkt__select-label">分类</span>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="按分类筛选">
            <option value="all">全部（{total}）</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {labelOf(c.id, c.labels)}（{c.count}）
              </option>
            ))}
          </select>
        </label>

        <div className="mkt__sorts" role="group" aria-label="排序方式">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`btn btn--sm${sort === s.key ? ' btn--primary' : ' btn--ghost'}`}
              aria-pressed={sort === s.key}
              onClick={() => setSort(s.key)}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn btn--ghost btn--sm mkt__refresh"
          disabled={loading}
          onClick={() => void load(true)}
          title="忽略本地缓存，重新从 npm 拉一份目录（可能要几秒）"
        >
          {loading ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
          重新拉取
        </button>
      </div>

      <p className="mkt__status">
        {list?.ok ? (
          <>
            <span>
              共 <span className="mono">{total}</span> 条，筛出 <span className="mono">{filtered.length}</span> 条
            </span>
            <span className="mkt__dot" aria-hidden="true">
              ·
            </span>
            <span>目录构建于 {list.updated || '未知时间'}</span>
            <span className="mkt__dot" aria-hidden="true">
              ·
            </span>
            <span>{list.source === 'origin' ? '来自官网插件清单' : '来自 npm 包 dsh-plugin-catalog'}</span>
            {cached ? (
              <>
                <span className="mkt__dot" aria-hidden="true">
                  ·
                </span>
                <span className="mkt__cached">用的是本地缓存 · 拉取于 {agoText(list.fetchedAt)}</span>
              </>
            ) : null}
          </>
        ) : (
          <span>插件目录来自 npm 包 dsh-plugin-catalog，首次拉取要解一个好几兆的包，可能要几秒。</span>
        )}
      </p>

      {list && list.warnings.length > 0 ? (
        <div className="banner banner--warn" role="status">
          <span aria-hidden="true">▲</span>
          <span>{list.warnings.join('；')}</span>
        </div>
      ) : null}

      {loading && !list ? (
        <>
          <p className="mkt__loading-line" role="status">
            <span className="spinner spinner--sm" aria-hidden="true" /> 正在拉插件目录…第一次要解一个好几兆的包，可能要几秒。
          </p>
          <ul className="mkt__grid" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <li className="mkt__card" key={i}>
                <div className="mkt__card-face mkt__card-face--skeleton">
                  <span className="skeleton skeleton--line" style={{ width: '34px', height: '34px' }} />
                  <span className="skeleton skeleton--line" style={{ width: `${48 + (i % 3) * 14}%` }} />
                  <span className="skeleton skeleton--line skeleton--sm" style={{ width: '88%' }} />
                  <span className="skeleton skeleton--line skeleton--sm" style={{ width: '64%' }} />
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {!loading && err ? (
        <EmptyState
          icon="⚠"
          tone="danger"
          title="没拿到插件目录"
          hint={
            <>
              拉取时出错了，所以这份列表是空的。点下面的「重试」再拉一次；如果一直失败，去「设置 → 网络代理」确认
              registry 能不能连上。
            </>
          }
          footnote={err}
          action={{ label: '重试', onClick: () => void load(true), primary: true }}
          secondaryAction={{ label: '打开设置', onClick: actions.openSettings }}
        />
      ) : null}

      {!loading && !err && list?.ok && all.length === 0 ? (
        <EmptyState
          icon="◍"
          title="目录里现在一条插件都没有"
          hint="拿到的清单是空的。过一会儿点「重新拉取」，或去设置里换一个 registry 再试。"
          action={{ label: '重新拉取', onClick: () => void load(true), primary: true }}
        />
      ) : null}

      {!loading && !err && all.length > 0 && filtered.length === 0 ? (
        <EmptyState
          compact
          icon="⌕"
          title={debounced ? `没有匹配「${debounced}」的插件` : '这个分类下没有插件'}
          hint={
            debounced
              ? `搜的是插件名、描述（含多语言）、作者和 npm 包名这三处；当前分类是「${
                  category === 'all' ? '全部' : catLabel(category)
                }」。换个词，或把分类切回「全部」。`
              : '目录里这一分类没有条目，把分类切回「全部」再看看。'
          }
        />
      ) : null}

      {count > 0 ? (
        <>
          {/*
            撑开滚动条的是这层固定高度的占位容器（高度 = 真实条目数 × 行高）；
            DOM 里只挂视口上下各一屏的那几十张卡，用 translateY 摆到正确位置。
          */}
          <div className="mkt__vwrap" ref={gridWrapRef} style={{ height: gridHeight }}>
            <ul className="mkt__grid mkt__grid--win" style={{ transform: `translateY(${range.offset}px)` }}>
              {visible.map((entry) => {
                const installedNow = isInstalled(entry)
                const cats = entry.categories.map((c) => catLabel(c))
                return (
                  <li className="mkt__card" key={`${entry.name}@${entry.owner}`}>
                    <button
                      type="button"
                      className="mkt__card-face"
                      aria-haspopup="dialog"
                      title={`打开 ${entry.name} 的详情`}
                      onClick={(e) => openDetail(entry, e.currentTarget)}
                    >
                      <span className="mkt__card-top">
                        <CardIcon entry={entry} size={34} />
                      </span>
                      <span className="mkt__card-name mono truncate">{entry.name}</span>
                      <span className="mkt__card-desc">{descOf(entry) || '目录里没给这条写描述，点开看仓库。'}</span>
                      <span className="mkt__card-meta">
                        <span title="GitHub 星标">★ {fmtNum(entry.stars)}</span>
                        <span title="npm 下载量">↓ {fmtNum(entry.downloads)}</span>
                        {cats.length > 0 ? (
                          <span className="mkt__card-cat truncate" title={cats.join(' / ')}>
                            {cats[0]}
                          </span>
                        ) : null}
                      </span>
                    </button>

                    <div className="mkt__card-act">
                      {installedNow ? (
                        <span
                          className="badge badge--ok"
                          title={`这个 profile 里已经装了${installedVersionOf(entry) ? ` ${installedVersionOf(entry)}` : ''}`}
                        >
                          已安装
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          disabled={busy || installing !== null}
                          onClick={() => void onInstall(entry)}
                          title={`pnpm 安装 ${marketSpecOf(entry)} 到 ${profile}（会先弹确认框）`}
                        >
                          {installing === entry.name ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
                          安装
                        </button>
                      )}
                    </div>

                    {entry.deprecated ? (
                      <span
                        className="badge badge--warn mkt__card-flag"
                        title={entry.replacement ? `目录标记为已弃用，建议换成 ${entry.replacement}` : '目录标记为已弃用'}
                      >
                        已弃用
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="mkt__more">
            <span className="mkt__more-count">
              显示第 {range.start + 1}–{range.end} 个 / 共 {count} 个插件
            </span>
            <span className="mkt__more-done">往下滚就行，卡片会边滚边换</span>
          </div>
        </>
      ) : null}

      {/* ---------------- 详情覆盖层 ---------------- */}
      {open ? (
        <div
          className="mkt__overlay"
          onMouseDown={(e) => {
            // 只有点空白处才关；点面板内部不关
            if (e.target === e.currentTarget) closeDetail()
          }}
        >
          <div
            className="mkt__sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            ref={sheetRef}
            onKeyDown={trapTab}
          >
            <div className="mkt__sheet-head">
              <MktIcon entry={open} profile={profile} size={48} installed={isInstalled(open)} />
              <div className="mkt__sheet-titlewrap">
                <h2 className="mkt__sheet-title mono" id={titleId}>
                  {open.name}
                </h2>
                <p className="mkt__sheet-sub">
                  {open.owner ? <span>作者 {open.owner}</span> : null}
                  {open.owner && open.npm ? <span className="mkt__dot" aria-hidden="true"> · </span> : null}
                  {open.npm ? <span className="mono">npm {open.npm}</span> : <span>这个只从 GitHub 装</span>}
                </p>
                <div className="mkt__badges">
                  <span className={`badge ${open.npm ? 'badge--accent' : 'badge--muted'}`}>{open.npm ? 'NPM' : 'GITHUB'}</span>
                  {isInstalled(open) ? (
                    <span className="badge badge--ok">
                      已安装{installedVersionOf(open) ? ` ${installedVersionOf(open)}` : ''}
                    </span>
                  ) : null}
                  {open.deprecated ? <span className="badge badge--warn">已弃用</span> : null}
                </div>
              </div>
              <button type="button" className="btn btn--ghost btn--sm mkt__sheet-close" onClick={closeDetail} aria-label="关闭详情（Esc）" title="关闭详情（Esc）">
                ✕
              </button>
            </div>

            <div className="mkt__sheet-actions">
              {isInstalled(open) ? (
                <span className="mkt__sheet-note">已经装在 {profile} 里了，要动版本就用右边的「换版本」。</span>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy || installing !== null}
                  onClick={() => void onInstall(open)}
                  title={`pnpm 安装 ${marketSpecOf(open)} 到 ${profile}（会先弹确认框）`}
                >
                  {installing === open.name ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
                  安装到 {profile}
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost"
                aria-expanded={picker}
                onClick={() => setPicker((v) => !v)}
                title={`列出 ${pkgOf(open)} 在 npm 上的所有版本，挑一个装`}
              >
                换版本
              </button>
              {open.url ? (
                <button type="button" className="btn btn--ghost" onClick={() => void actions.openExternal(open.url)} title={`用系统浏览器打开 ${open.url}`}>
                  打开仓库
                </button>
              ) : null}
            </div>

            {picker ? (
              <div className="mkt__picker">
                <p className="mkt__picker-note">
                  下面列出 <span className="mono">{openPkg}</span> 在 npm 上的标签和版本，点一条就装那个版本；这会改{' '}
                  <span className="mono">{profile}/package.json</span>。
                </p>
                <VersionPicker
                  profile={profile}
                  input={openPkg}
                  {...(openCurrent ? { current: openCurrent } : {})}
                  compact
                  onPick={(option) => void onPickVersion(open, option)}
                  onCancel={() => setPicker(false)}
                />
              </div>
            ) : null}

            <p className="mkt__sheet-desc">{descOf(open) || '目录里没给这条写描述。'}</p>
            {descAlt(open) ? <p className="mkt__sheet-desc-alt">{descAlt(open)}</p> : null}

            {open.deprecated ? (
              <div className="banner banner--warn" role="status">
                <span aria-hidden="true">▲</span>
                <span>
                  目录把这条标成已弃用{open.replacement ? `，建议改用 ${open.replacement}` : ''}。
                </span>
              </div>
            ) : null}

            {/* 图片区：只在详情打开时才挂 PluginGallery，不会在 8000 张卡上预加载 */}
            <section className="mkt__slot" aria-label="插件截图">
              <h3 className="mkt__slot-title">截图</h3>
              <PluginGallery profile={profile} name={pkgOf(open)} compact />
            </section>

            <div className="mkt__kv">
              <div className="kv">
                <span className="kv__k">星标</span>
                <span className="kv__v mono">{open.stars ?? '目录没给'}</span>
              </div>
              <div className="kv">
                <span className="kv__k">下载量</span>
                <span className="kv__v mono">{open.downloads ?? '目录没给'}</span>
              </div>
              <div className="kv">
                <span className="kv__k">分类</span>
                <span className="kv__v">{open.categories.map((c) => catLabel(c)).join(' / ') || '未分类'}</span>
              </div>
              <div className="kv">
                <span className="kv__k">目录声明版本</span>
                <span className="kv__v mono">{open.version ?? '没写'}</span>
              </div>
              <div className="kv">
                <span className="kv__k">收录时间</span>
                <span className="kv__v mono">{open.added || '没写'}</span>
              </div>
              <div className="kv">
                <span className="kv__k">安装 spec</span>
                <span className="kv__v mono selectable" title={`目录原始给的是：${open.install || '（空）'}`}>
                  {marketSpecOf(open) || '目录没给可用的安装地址'}
                </span>
              </div>
              <div className="kv">
                <span className="kv__k">仓库</span>
                <span className="kv__v">
                  {open.url ? (
                    <button type="button" className="mkt__link mono" onClick={() => void actions.openExternal(open.url)} title={`用系统浏览器打开 ${open.url}`}>
                      {open.url}
                    </button>
                  ) : (
                    '目录没给'
                  )}
                </span>
              </div>
            </div>

            <div className="mkt__caps mkt__caps--detail">
              {open.capabilities.length > 0 ? (
                <>
                  {open.capabilities.map((c) => (
                    <span className="mkt__cap" key={c} title={`静态扫描声明会用到的能力：${c}`}>
                      {CAP_LABELS[c] ?? c}
                    </span>
                  ))}
                  {open.capabilityCheckedAt ? (
                    <span className="mkt__cap-note">扫描于 {open.capabilityCheckedAt.slice(0, 10)}</span>
                  ) : null}
                </>
              ) : (
                <span className="mkt__cap-note">
                  {open.capabilityCheckedAt
                    ? `扫描过，没检出会碰系统的能力（${open.capabilityCheckedAt.slice(0, 10)}）`
                    : '目录还没扫描过它的能力，装之前可以打开仓库自己看一眼'}
                </span>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
