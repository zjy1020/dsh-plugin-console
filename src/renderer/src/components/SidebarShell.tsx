/**
 * SidebarShell —— 悬浮亚克力侧边栏（L1 外壳）。
 *
 * 它不是传统的「贴左边缘的固定菜单」，而是一块和屏幕边缘留出间距的圆角玻璃面板：
 * 五区从上到下 = 品牌 / 快捷操作 / 分组导航 / 动态状态 / 用户。
 * 收起态不是「把文字藏起来」——行高、图标尺寸、选中形状全部重配平，
 * 并且缝隙刻度竖过来，仍然一眼能看出「哪个装了没加载」。
 *
 * 关于内容的一句实话：导航只放**真的能到达**的地方（已安装 / 安装插件 / 筛选 / 日志 / 设置）。
 * 设计纲领里那套「工作区 / 插件 / 管理 / 部署」的菜单树是示意，本项目没有那些页面，
 * 造几个点不动的项出来就变成装饰性装置了 —— 所以是按真实目的地分组的。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PluginRecord } from '../../../shared/types'
import { api } from '../api'
import { FILTERS, useConsole, type FilterKey } from '../lib/store'
import { useDshStatus } from '../lib/useDshStatus'
import { DshControl } from './DshControl'
import { GapStrip } from './GapStrip'

/* ----------------------------- 线性图标 ----------------------------- */
/* 统一 16×16、stroke 1.5、圆角端点、无填充 —— 混用填充/彩色图标是最容易露怯的地方 */

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

const IconPlus = () => (
  <svg {...ICON_PROPS}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </svg>
)
const IconSearch = () => (
  <svg {...ICON_PROPS}>
    <circle cx="7.2" cy="7.2" r="4.2" />
    <path d="M10.4 10.4 14 14" />
  </svg>
)
const IconRefresh = () => (
  <svg {...ICON_PROPS}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8" />
  </svg>
)
const IconLog = () => (
  <svg {...ICON_PROPS}>
    <path d="M3 2.6h7.4L13 5.2v8.2H3z" />
    <path d="M5.4 8h5.2M5.4 10.6h3.4" />
  </svg>
)
const IconGear = () => (
  <svg {...ICON_PROPS}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.8v1.6M8 12.6v1.6M2.8 8h1.6M11.6 8h1.6M4.3 4.3l1.1 1.1M10.6 10.6l1.1 1.1M11.7 4.3l-1.1 1.1M5.4 10.6l-1.1 1.1" />
  </svg>
)
const IconUser = () => (
  <svg {...ICON_PROPS}>
    <circle cx="8" cy="5.6" r="2.6" />
    <path d="M3.4 13.2a4.9 4.9 0 0 1 9.2 0" />
  </svg>
)
const IconChevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg {...ICON_PROPS}>
    <path d={dir === 'left' ? 'M9.8 3.6 5.4 8l4.4 4.4' : 'M6.2 3.6 10.6 8l-4.4 4.4'} />
  </svg>
)

/* ----------------------------- 组件 ----------------------------- */

interface NavItem {
  id: string
  label: string
  icon: React.ReactNode
  /** 右侧数字（徽章） */
  num?: number
  /** 数字是不是「需要注意」的那种（用 ember 而不是灰） */
  alert?: boolean
  hint: string
  go: () => void
  active: boolean
}

/* ----------------------------- 读数格式化 ----------------------------- */

/**
 * 毫秒 → 可读字符串：不到 1 秒给毫秒，到了 1 秒就换单位。
 *
 * 为什么必须换单位：hop 与全链路是两个量级的数（hop 个位数 ms、全链路可能 1800ms）。
 * 同一个单位里「1820 ms」和「3 ms」并排，量级差 600 倍，眼睛只会觉得两个数都很小；
 * 换成「1.8 s」与「3 ms」才读得出「钱花在隧道上、不在代理上」。
 */
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/**
 * hop 与全链路的差超过这个门槛，才在读数后面补一段弱化的「全链路」。
 * 400ms 是人的时间感阈值：差得比这少，说明隧道本来就是直的，
 * 多挂一个数只会让这张卡多一行噪音（而且两个数挨得近时反而更容易被误读成一个数）。
 */
const FULL_CHAIN_DIFF_MS = 400

export function SidebarShell() {
  const { state, actions, counts, settings } = useConsole()
  const dsh = useDshStatus()

  const collapsed = !settings.sidebarExpanded
  const profile = state.profiles.find((p) => p.name === state.activeProfile) ?? null

  /* 收起态是由设置驱动的（持久化），但展开时的即时反馈要在本地先动，避免 IPC 往返卡一下 */
  const [localCollapsed, setLocalCollapsed] = useState<boolean | null>(null)
  const isCollapsed = localCollapsed ?? collapsed
  useEffect(() => {
    if (localCollapsed !== null && localCollapsed === collapsed) setLocalCollapsed(null)
  }, [collapsed, localCollapsed])

  const toggleCollapse = useCallback(() => {
    const next = !isCollapsed
    setLocalCollapsed(next)
    void actions.saveSettings({ sidebarExpanded: !next })
  }, [actions, isCollapsed])

  /* ------------------------- 玻璃滑块定位 ------------------------- */

  const navRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [slider, setSlider] = useState<{ top: number; height: number; id: string } | null>(null)
  /** 首次定位不做过渡：否则一进页面滑块会从面板顶部滑下来 */
  const firstPaint = useRef(true)

  const registerItem = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) itemRefs.current.set(id, el)
    else itemRefs.current.delete(id)
  }, [])

  /* ------------------------- 导航定义 ------------------------- */

  const navGroups = useMemo(() => {
    const items: { title: string; items: NavItem[] }[] = []

    /* 这里原本还有个「工作区」组（已安装 / 安装插件），后来删了：
     * 上面那排大按钮已经写了「+ 安装插件 / 检查更新」，主区顶部又有一组
     * 「已安装 | 安装插件」页签 —— 同一个目的地挂三遍不算导航，算噪音。
     * 而且侧栏高度是有限的：多这一组 40×2 + 组头，正好把「管理」整组挤到
     * 可视区外（要滚动才看得见），代价远大于收益。 */

    /* 筛选是真的分组语义：它就是同一份数据的不同切面，所以单独成组而不是塞进「工作区」 */
    const filterItems: NavItem[] = FILTERS.map((f) => ({
      id: `filter-${f.key}`,
      label: f.label,
      icon: <FilterGlyph k={f.key} />,
      num: counts[f.key],
      alert: f.key === 'updatable' && counts.updatable > 0,
      hint: f.hint,
      go: () => {
        actions.setView('plugins')
        actions.setFilter(f.key as FilterKey)
      },
      active: state.view === 'plugins' && state.filter === f.key
    }))
    items.push({ title: '筛选', items: filterItems })

    items.push({
      title: '管理',
      items: [
        {
          id: 'logs',
          label: '运行日志',
          icon: <IconLog />,
          hint: '看 pnpm 到底跑了什么',
          /* 日志 view 化：点它主区整个换成日志（以前是弹底部抽屉，主区不动，
           * 用户以为点了没反应）。active 也按 view 判断 —— 滑块跟着走。 */
          go: () => actions.setView('logs'),
          active: state.view === 'logs'
        },
        {
          id: 'settings',
          label: '环境与设置',
          icon: <IconGear />,
          hint: 'DSH 路径、代理、外观与主题',
          go: () => actions.openSettings(),
          active: state.settingsOpen
        }
      ]
    })

    return items
  }, [actions, counts, state.filter, state.plugins, state.settingsOpen, state.view])

  const activeId = useMemo(() => {
    /* 「刚打开的面板」优先于「当前筛选」：筛选项在你看设置的时候依然是生效的
     * （列表还在那儿，只是被挡住了），所以按组顺序找第一个 active 会永远命中筛选，
     * 滑块就不会跟着你点的那一项走 —— 看起来像没反应。 */
    if (state.settingsOpen) return 'settings'
    for (const g of navGroups) {
      const hit = g.items.find((i) => i.active)
      if (hit) return hit.id
    }
    return null
  }, [navGroups, state.settingsOpen])

  /* 量出当前项的位置 → 把滑块移过去。dependent on 尺寸变化，所以也监听 resize */
  const measure = useCallback(() => {
    const container = navRef.current
    if (!container || !activeId) {
      setSlider(null)
      return
    }
    const el = itemRefs.current.get(activeId)
    if (!el) {
      setSlider(null)
      return
    }
    setSlider({ top: el.offsetTop, height: el.offsetHeight, id: activeId })
  }, [activeId])

  useLayoutEffect(() => {
    measure()
    const t = window.setTimeout(() => {
      firstPaint.current = false
    }, 60)
    return () => window.clearTimeout(t)
  }, [measure, isCollapsed, state.plugins.length])

  useEffect(() => {
    const onResize = () => measure()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [measure])

  /* ------------------------- 代理延迟 ------------------------- */

  /**
   * 一次测代理会得到两个数（见 src/shared/types.ts 的 ProxyTestResult）：
   *   hopMs   —— 代理自身那一跳（TCP + CONNECT），本地代理通常个位数 ms
   *   totalMs —— 全链路（含出境、隧道里的 TLS 握手与 HTTPS 往返），可能到 1.8s
   * 分开存是必须的：合成一个数的话「延迟 3 ms」会被读成「装插件也只要 3 ms」，
   * 而真正决定装插件快不快的是 totalMs。error 与它们互斥（出错时两个数都是 null）。
   */
  const [latency, setLatency] = useState<{
    hopMs: number | null
    totalMs: number | null
    error: string | null
  } | null>(null)
  const [testing, setTesting] = useState(false)

  const testProxy = useCallback(async () => {
    if (!settings.proxy) {
      setLatency({ hopMs: null, totalMs: null, error: '还没设代理' })
      return
    }
    setTesting(true)
    try {
      const r = await api().proxyTest(settings.proxy)
      setLatency(
        r.ok
          ? { hopMs: r.latencyMs, totalMs: r.totalMs, error: null }
          : { hopMs: null, totalMs: null, error: r.error ?? '不通' }
      )
    } catch (e: unknown) {
      setLatency({ hopMs: null, totalMs: null, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }, [settings.proxy])

  /**
   * 侧栏上唯一的「刷新」入口：重读 DSH 状态 + 重测代理延迟，一次点完。
   *
   * 为什么把两件事并进一个按钮，而不是像以前那样各留一个：
   *   这张卡上「DSH 运行中 · N 进程」和「延迟 10 ms」都是会过期的读数，用户点 ↻
   *   想的是「把卡上的数都刷一遍」。以前 ↻ 只刷新 DSH 状态、延迟纹丝不动，
   *   旁边那枚「测」才是唯一能重测的东西 —— 点 ↻ 的人看到的就是「点了没反应」。
   * 为什么不 await 串起来：测一次真代理要 1~2 秒（含出境、隧道里的 TLS 握手），
   *   串行会把「刷新 DSH 状态」这个几十毫秒的动作硬拖成 2 秒。两个请求并行发，
   *   各自回来各自更新，按钮转圈直到测速结束。
   * 也刻意不做定时轮询：测速会占着代理出口跑真实流量，只在用户按下时跑一次。
   */
  const reloadDsh = dsh.reload
  const refreshAll = useCallback(() => {
    void reloadDsh()
    void testProxy()
  }, [reloadDsh, testProxy])

  /* ------------------------- 延迟读数 ------------------------- */

  /* 重音位只给 hop：它是「代理本身有多快」，也是这张卡上唯一的实时测量值。
     全链路是补充口径，只在明显慢于 hop 时才出现，且一律走弱化样式。 */
  const hopMs = latency?.hopMs ?? null
  const totalMs = latency?.totalMs ?? null
  const totalText =
    hopMs !== null && totalMs !== null && totalMs - hopMs > FULL_CHAIN_DIFF_MS
      ? `全链路 ${fmtMs(totalMs)}`
      : null
  /* 悬停提示与收起态共用这一句：两个数都必须能查到 —— 收起态放不下第二个数，
     只能靠 title；展开态也留它，方便对着数校。 */
  const latencyTitle =
    hopMs !== null
      ? `代理 ${settings.proxy ?? ''} · hop ${fmtMs(hopMs)}` +
        (totalMs !== null ? ` · 全链路 ${fmtMs(totalMs)}` : '')
      : testing
        ? '正在测试代理连通性…'
        : (latency?.error ?? '还没测过代理延迟')

  /* ------------------------- 派生读数 ------------------------- */

  const installed = state.plugins.filter((p) => p.installed && !p.builtin).length
  const loaded = state.plugins.filter((p) => p.installed && p.inBundles && !p.disabled).length
  const gaps = state.plugins.filter((p) => p.installed && !p.inBundles).length

  const dshRunning = dsh.phase === 'ready' && (dsh.status?.running ?? false)
  const dotClass =
    dsh.phase === 'loading'
      ? 'dot dot--loading'
      : dsh.phase === 'error'
        ? 'dot dot--fail'
        : dshRunning
          ? 'dot dot--running'
          : 'dot dot--offline'

  const accountName = profile ? `本机 · ${profile.name}` : '未选择 profile'
  const accountSub = state.runtime ? `dsh ${state.runtime.desktopVersion ?? '—'}` : '正在探测环境'
  const monogram = (profile?.name ?? 'DSH').slice(0, 1).toUpperCase()

  const onPickGap = useCallback(
    (rec: PluginRecord) => {
      actions.setView('plugins')
      actions.select(rec.id)
    },
    [actions]
  )

  return (
    <aside
      className={`sb${isCollapsed ? ' sb--collapsed' : ''}`}
      aria-label="主导航"
      data-collapsed={isCollapsed ? 'true' : 'false'}
    >
      <span className="sb__edge" aria-hidden="true" />

      {/* ------------------------- 品牌区 ------------------------- */}
      <div className="sb__brand">
        <span className="sb__logo" aria-hidden="true">
          <img src="./logo-64.png" alt="" width={20} height={20} draggable={false} />
        </span>
        <span className="sb__brand-text">
          <span className="sb__title">插件台</span>
          <span className="sb__ctx mono truncate" title={profile?.dir ?? '未选择 profile'}>
            {profile ? profile.name : '未选择'}
            <span className="sb__ctx-page">已安装</span>
          </span>
        </span>
        <button
          type="button"
          className="sb__icon-btn sb__collapse"
          onClick={toggleCollapse}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={isCollapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <IconChevron dir={isCollapsed ? 'right' : 'left'} />
        </button>
      </div>

      {/* ------------------------- 快捷操作区 ------------------------- */}
      {!isCollapsed ? (
        <div className="sb__quick">
          <button
            type="button"
            className="sb__quick-btn sb__quick-btn--main"
            onClick={() => {
              actions.setView('install')
              window.setTimeout(() => {
                document.querySelector<HTMLInputElement>('[data-install-input="true"]')?.focus()
              }, 0)
            }}
            title="装一个新插件：粘贴 GitHub 链接或 npm 包名"
          >
            <IconPlus />
            <span>安装插件</span>
          </button>

          <button
            type="button"
            className="sb__search"
            onClick={() => {
              actions.setView('plugins')
              window.setTimeout(() => {
                const el = document.querySelector<HTMLInputElement>('[data-search-input="true"]')
                el?.focus()
                el?.select()
              }, 0)
            }}
            title="搜索已装插件（Ctrl+K）"
          >
            <IconSearch />
            <span className="sb__search-text">搜索插件</span>
            <kbd className="sb__kbd mono">Ctrl K</kbd>
          </button>

          <div className="sb__quick-row">
            <button
              type="button"
              className="sb__quick-btn"
              onClick={() => void actions.checkUpdates()}
              disabled={state.check?.running ?? false}
              title="逐包打 npm registry，看有没有新版本"
            >
              {state.check?.running ? (
                <span className="spinner spinner--sm" />
              ) : (
                <IconRefresh />
              )}
              <span>检查更新</span>
              {counts.updatable > 0 ? (
                <span className="sb__quick-num mono">{counts.updatable}</span>
              ) : null}
            </button>
          </div>
        </div>
      ) : (
        <div className="sb__quick-mini">
          <button
            type="button"
            className="sb__quick-btn sb__quick-btn--main"
            onClick={() => actions.setView('install')}
            title="安装插件"
            aria-label="安装插件"
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="sb__quick-btn"
            onClick={() => void actions.checkUpdates()}
            disabled={state.check?.running ?? false}
            title={counts.updatable > 0 ? `${counts.updatable} 个可更新` : '检查更新'}
            aria-label="检查更新"
          >
            <IconRefresh />
            {counts.updatable > 0 ? <span className="sb__mini-badge mono">{counts.updatable}</span> : null}
          </button>
        </div>
      )}

      {/* ------------------------- 导航区 ------------------------- */}
      <div className="sb__nav" ref={navRef}>
        {/*
          * 滑块在收起态里也要在 —— 纲领 §2 要求收起态「仍要知道当前在哪一页」，
          * 展开态靠滑块 + 文字，收起态就只剩这块玻璃了。它在这里缩成 32×32 的方形，
          * 左侧另有一条 2px 品牌色指示条（见 glass.css 的 .sb--collapsed .gl-slider::after）。
          *
          * 垂直位置要自己补一个居中偏移：收起态行高 40、滑块 32，直接 translateY(offsetTop)
          * 会顶到行上沿，看起来偏上 4px。高度交给 CSS（inline height 会盖掉 32px）。
          */}
        {slider ? (
          <span
            className={`gl-slider${isCollapsed ? ' gl-slider--collapsed' : ''}${
              firstPaint.current ? ' gl-slider--instant' : ''
            }${!slider.id ? ' gl-slider--first' : ''}`}
            style={{
              transform: `translateY(${
                isCollapsed ? slider.top + Math.max(0, (slider.height - 32) / 2) : slider.top
              }px)`,
              ...(isCollapsed ? null : { height: `${slider.height}px` }),
            }}
            aria-hidden="true"
          />
        ) : null}

        {navGroups.map((g) => (
          <div className="sb__group" key={g.title}>
            <div className="sb__group-head">{g.title}</div>
            {g.items.map((it) => (
              <button
                key={it.id}
                type="button"
                ref={(el) => registerItem(it.id, el)}
                className={`sb__item${it.active ? ' is-active' : ''}`}
                aria-current={it.active ? 'page' : undefined}
                onClick={it.go}
                title={isCollapsed ? `${it.label} — ${it.hint}` : it.hint}
              >
                <span className="sb__item-icon">{it.icon}</span>
                <span className="sb__item-label">{it.label}</span>
                {typeof it.num === 'number' && it.num > 0 ? (
                  <span className={`sb__item-num mono${it.alert ? ' sb__item-num--alert' : ''}`}>
                    {it.num}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* ------------------------- 状态区 ------------------------- */}
      <div className={`sb__status${dsh.phase === 'error' ? ' sb__status--error' : ''}`}>
        {!isCollapsed ? (
          <>
            <div className="sb__status-row">
              <span className={dotClass} aria-hidden="true" />
              <span className="sb__status-text" role="status">
                {dsh.phase === 'loading'
                  ? '正在读 DSH 状态…'
                  : dsh.phase === 'error'
                    ? 'DSH 状态未知'
                    : dshRunning
                      ? `DSH 运行中 · ${dsh.status?.pids.length ?? 0} 进程`
                      : 'DSH 未运行'}
              </span>
            </div>

            <div className="sb__readouts">
              <span className="sb__readout">
                <span className="sb__readout-key">插件</span>
                <span className="sb__readout-val mono">{installed}</span>
              </span>
              <span className="sb__readout">
                <span className="sb__readout-key">加载层</span>
                <span className="sb__readout-val mono">{loaded}</span>
              </span>
              <span className="sb__readout">
                <span className="sb__readout-key">缺口</span>
                <span className={`sb__readout-val mono${gaps > 0 ? ' sb__readout-val--alert' : ''}`}>
                  {gaps}
                </span>
              </span>
            </div>

            <GapStrip
              plugins={state.plugins}
              error={state.pluginsError}
              onPick={onPickGap}
            />

            <div className="sb__status-row sb__status-row--sub">
              {/*
                * 读数与状态合成一个元素：这一行里只剩右边那枚 ↻ 可点（见下面的 refreshAll）。
                * 以前是「延迟 未测」+ 一枚写着「测」的小按钮并排 —— 读起来就是
                * 「延迟 未测测」（主控实测到的原话），而且两个按钮各管一半，
                * 点 ↻ 不重测、点「测」不刷状态，用户根本分不清该按哪个。
                *
                * 测试中为什么跟在老读数后面而不是把老读数换掉：
                *   换掉会让数字在 1~2 秒里凭空消失；而用户点刷新正是为了核对
                *   「变快还是变慢」，老数得在场才有对照。没测过时没有老数，就直接
                *   写「延迟 测试中」（这一支只在 hopMs 为 null 时走到）。
                */}
              <span
                className={`sb__latency${hopMs === null ? ' sb__latency--untested' : ''} mono`}
                title={latencyTitle}
              >
                {hopMs !== null ? (
                  <>
                    {hopMs}
                    <span className="sb__latency-unit"> ms</span>
                  </>
                ) : testing ? (
                  '延迟 测试中'
                ) : latency?.error ? (
                  '延迟 —'
                ) : (
                  '延迟 未测'
                )}
                {testing && hopMs !== null ? (
                  <span className="sb__latency-flag">测试中</span>
                ) : null}
              </span>
              <span className="sb__spacer" />
              {/* 全链路读数走到 spacer 之后：hop 是重音（左、亮、大），它是补充（右、灰、小一号）。
                  同一行两个数靠位置和字重分主次，而不是靠「谁先写」——
                  否则「3 ms 全链路 1.8 s」会读成一串。
                  totalText 为 null（差得不够多 / 没测过 / 出错）时整段不渲染，行宽立刻还回去。 */}
              {totalText ? (
                <span className="sb__latency-total mono" title={latencyTitle}>
                  {totalText}
                </span>
              ) : null}
              {/* 侧栏里唯一的刷新入口：一次点下 = 重读 DSH 状态 + 重测代理延迟。
                  测试中（或首次加载）换成 spinner 并 disabled，避免连点叠出多次测速；
                  disabled 不等于「停了」—— 光标也被改成 progress（见 components.css 第 5 节）。 */}
              <button
                type="button"
                className="sb__icon-btn sb__refresh"
                onClick={refreshAll}
                disabled={testing || dsh.phase === 'loading'}
                title={
                  settings.proxy
                    ? `刷新状态并重测代理延迟（${settings.proxy}）`
                    : '刷新 DSH 状态（还没设代理，先去设置里填）'
                }
                aria-label="刷新状态并重测代理延迟"
              >
                {testing || dsh.phase === 'loading' ? (
                  <span className="spinner spinner--sm" />
                ) : (
                  <IconRefresh />
                )}
              </button>
            </div>

            <DshControl headless view={dsh} />
          </>
        ) : (
          <>
            <span className={dotClass} aria-hidden="true" title={dshRunning ? 'DSH 运行中' : 'DSH 未运行'} />
            <GapStrip plugins={state.plugins} vertical error={state.pluginsError} />
            {/* 收起态（64px）横向只有半个手掌宽，放不下第二个数：
                这里只留 hop 进重音位，全链路靠 title（latencyTitle 里两个数都在）。 */}
            <span className="sb__mini-latency mono" title={latencyTitle}>
              {hopMs !== null ? hopMs : '—'}
            </span>
            <button
              type="button"
              className="sb__icon-btn"
              onClick={toggleCollapse}
              title="展开侧边栏"
              aria-label="展开侧边栏"
            >
              <IconChevron dir="right" />
            </button>
          </>
        )}
      </div>

      {/* ------------------------- 用户区 ------------------------- */}
      <div className="sb__spacer" />
      <div className="sb__user">
        <span className="sb__avatar mono" aria-hidden="true">
          {monogram}
        </span>
        {!isCollapsed ? (
          <span className="sb__user-text">
            <span className="sb__user-name truncate" title={accountName}>
              {accountName}
            </span>
            <span className="sb__user-sub mono truncate">{accountSub}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="sb__icon-btn"
          onClick={() => actions.openSettings()}
          title="设置"
          aria-label="设置"
        >
          <IconUser />
        </button>
      </div>
    </aside>
  )
}

/** 筛选项的小标记：不用图标库，用几何形状区分五个切面 */
function FilterGlyph({ k }: { k: string }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  switch (k) {
    case 'all':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <path d="M2.4 4h11.2M2.4 8h11.2M2.4 12h11.2" />
        </svg>
      )
    case 'updatable':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 12.4V3.6M4.6 7 8 3.6 11.4 7" />
        </svg>
      )
    case 'disabled':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <circle cx="8" cy="8" r="5" />
          <path d="M4.6 11.4 11.4 4.6" />
        </svg>
      )
    case 'thirdparty':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
          <path d="M8 2.6 13.4 8 8 13.4 2.6 8z" />
        </svg>
      )
    case 'builtin':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
          <path d="M8 2.8 13 5.4v5.2L8 13.2 3 10.6V5.4z" />
          <path d="M3 5.4 8 8l5-2.6M8 8v5.2" />
        </svg>
      )
    default:
      return null
  }
}
