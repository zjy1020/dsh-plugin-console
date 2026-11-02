/**
 * App —— 外壳：壁纸层 / 悬浮侧边栏 / 主区（列表 或 安装）/ 详情 / 日志 / 弹窗 / Toast。
 * 全局键盘：Ctrl+K 聚焦搜索、Ctrl+Shift+R 刷新、Esc 逐层关闭。
 * 主题：settings.appearanceMode → <html data-theme>（system 跟随 prefers-color-scheme）；
 *       材质开关 → <html data-glass>（off 时整块玻璃层回落到实色，作为低性能兜底）。
 */

import { useEffect, useState } from 'react'
import { ConsoleProvider, useConsole } from './lib/store'
import { api, toMessage } from './api'
import type { DiscoveryStep } from '../../shared/types'
import { ConfirmDialog } from './components/ConfirmDialog'
import {
  EnvDiagnostics,
  envRedetectFn,
  missingEnvParts,
  pickDirectoryFn,
  wrongPickMessage
} from './components/EnvDiagnostics'
import { InstallPanel } from './components/InstallPanel'
import { LogDrawer } from './components/LogDrawer'
import { PluginDetail } from './components/PluginDetail'
import { PluginList } from './components/PluginList'
import { RuntimeProvision } from './components/RuntimeProvision'
import { SettingsDialog } from './components/SettingsDialog'
import { SidebarShell } from './components/SidebarShell'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { WallpaperLayer } from './components/WallpaperLayer'
import { WallpaperDrop } from './components/WallpaperDrop'

/*
 * 环境引导卡 / 诊断区的样式。
 *
 * 为什么挂在 App 上而不是 main.tsx：main.tsx 不在本次允许改动的清单里。
 * 代价是加载顺序 —— main.tsx 的 `import { App }` 排在四条 styles 之前，ESM 深度优先，
 * 所以这份 CSS 在产物里排到 base/components/glass 前面，同特异性的规则会输；
 * env-setup.css 里因此凡是覆盖既有规则的地方都带了祖先选择器，而不是用 !important。
 */
import './styles/env-setup.css'

/**
 * 系统级「降低透明度」（Windows 设置 → 辅助功能 → 视觉效果）。
 *
 * 为什么要单独订阅：光靠 CSS 的 `@media (prefers-reduced-transparency: reduce)` 不够 ——
 * 下面那个 effect 会把 sidebarOpacity / sidebarBlur 以内联自定义属性写到 documentElement，
 * 而内联优先级高于样式表，系统的关玻璃请求会被用户的滑杆值整个压掉（这就是审计报告
 * 里「7 个变量死了 2 个」的那一条）。所以把系统偏好也读进来，一起决定要不要摘掉内联值。
 */
function useSystemReducedTransparency(): boolean {
  const query = '(prefers-reduced-transparency: reduce)'
  // 懒初始化：首帧就要正确，否则启动瞬间会闪一下玻璃
  const [reduce, setReduce] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (): void => setReduce(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduce
}

export function App() {
  return (
    <ConsoleProvider>
      <Shell />
    </ConsoleProvider>
  )
}

export default App

function Shell() {
  const { state, actions, counts, settings } = useConsole()
  const systemReduce = useSystemReducedTransparency()

  /* ----------------------------- 主题与材质 ----------------------------- */
  useEffect(() => {
    // appearanceMode 是 v5 的外观主开关；老配置里没有时回退到 theme，保证升级不闪一下
    const mode = settings.appearanceMode ?? settings.theme ?? 'dark'
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const root = document.documentElement
    const apply = () => {
      const resolved = mode === 'system' ? (mq.matches ? 'light' : 'dark') : mode
      root.dataset.theme = resolved
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.appearanceMode, settings.theme])

  /* --------------------- 外观设置 → 根属性 + CSS 变量 ---------------------
   *
   * 这是「设置真的变成像素」的唯一出口。之前侧边栏那四个滑块（宽度 / 圆角 /
   * 透明度 / 模糊强度）和强调色、环境色只写进了 settings.json，样式表一次都没读到
   * —— 拖完界面纹丝不动，看起来像坏了。所以统一在这里把值灌到 documentElement
   * 的自定义属性上，css 只管用 var() 消费。
   *
   * 三条注意：
   * 1) 内联样式优先级高于样式表，所以「关掉透明效果」时**必须主动把
   *    --gl-panel-alpha / --gl-panel-blur 摘掉**，否则用户设的 0.95 会盖过降级块
   *    的 alpha 1 / blur 0，玻璃关不干净。
   * 2) accent / ambient 的空串是合法的「不指定」（跟随主题 / 跟随壁纸），
   *    这时要把变量摘掉让它落回默认，而不是写成空串把继承打断。
   * 3) --p-brand-06/08/10/soft 在 tokens.css 里是从 --p-brand 推导的，
   *    所以只写这一个变量，所有浅色底会自动跟走。
   */
  useEffect(() => {
    const root = document.documentElement
    // 三个来源任一为真就不给玻璃：用户自己的开关、动效关（省 GPU）、系统辅助功能偏好
    const glassOff = settings.reduceTransparency || settings.motionLevel === 'off' || systemReduce

    if (glassOff) root.dataset.glass = 'off'
    else delete root.dataset.glass

    if (settings.enhanceContrast) root.dataset.contrast = 'high'
    else delete root.dataset.contrast

    if (settings.motionLevel) root.dataset.motion = settings.motionLevel
    else delete root.dataset.motion

    const put = (name: string, value: string | null | undefined) => {
      if (value === null || value === undefined || value === '') root.style.removeProperty(name)
      else root.style.setProperty(name, value)
    }

    put('--sb-w-expanded', `${Math.round(settings.sidebarWidth)}px`)
    put('--sb-radius', `${Math.round(settings.sidebarRadius)}px`)

    // 玻璃关掉时不写这两个，让降级块赢
    put('--gl-panel-alpha', glassOff ? null : String(settings.sidebarOpacity))
    put('--gl-panel-blur', glassOff ? null : `${Math.round(settings.sidebarBlur)}px`)

    put('--p-brand', settings.accent)
    put('--p-ambient', settings.ambient)

    /* 内容面板（主区 / 详情）的不透明度与模糊。
     * 0 = 跟随主题：这时把变量摘掉，让 tokens.css 里那条
     * `--panel-alpha: calc(var(--gl-bed-alpha) + 0.14)` 生效 —— 也就是可调化之前的观感。
     * 玻璃关掉时也一并摘掉，否则用户设的 0.95 会盖过降级块的「不透明 / 无模糊」。 */
    put('--panel-alpha', glassOff || settings.panelOpacity <= 0 ? null : String(settings.panelOpacity))
    put('--panel-blur', glassOff || settings.panelBlur <= 0 ? null : `${Math.round(settings.panelBlur)}px`)
  }, [
    settings.reduceTransparency,
    settings.enhanceContrast,
    settings.motionLevel,
    settings.sidebarWidth,
    settings.sidebarRadius,
    settings.sidebarOpacity,
    settings.sidebarBlur,
    settings.accent,
    settings.ambient,
    settings.panelOpacity,
    settings.panelBlur,
    systemReduce
  ])

  /* ----------------------------- 快捷键 ----------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey

      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        actions.setView('plugins')
        window.setTimeout(() => {
          const el = document.querySelector<HTMLInputElement>('[data-search-input="true"]')
          el?.focus()
          el?.select()
        }, 0)
        return
      }

      // Ctrl+R 被主进程绑成 reload，所以刷新走 Ctrl+Shift+R
      if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        void actions.loadPlugins()
        return
      }

      if (e.key === 'Escape') {
        if (state.confirm) {
          // 确认弹窗优先级最高：Esc = 取消（执行中不响应，别把正在跑的确认流程打断）
          e.preventDefault()
          actions.cancelConfirm()
        } else if (state.settingsOpen) {
          e.preventDefault()
          actions.closeSettings()
        } else if (state.view === 'logs') {
          // 日志是 view：Esc = 回到已安装（顶部页签也回得去，这里是键盘路径）
          e.preventDefault()
          actions.setView('plugins')
        } else if (state.selectedId) {
          e.preventDefault()
          actions.select(null)
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, state.confirm, state.settingsOpen, state.view, state.selectedId])

  const profile = state.profiles.find((p) => p.name === state.activeProfile) ?? null
  const warnings = state.warningsDismissed ? [] : state.runtime?.warnings ?? []
  const detailOpen = state.selectedId !== null

  /**
   * 环境是否残缺 —— 直接由 runtime 的字段判定，不看 warnings 的文本（见 missingEnvParts）。
   * 为什么还要 state.ready：启动那一下 runtime 还是 null，那不是「残缺」而是「还没探完」，
   * 否则每次开窗都会先闪一张引导卡再消失。
   */
  const envBroken =
    state.fatal !== null || (state.ready && missingEnvParts(state.runtime).length > 0)

  return (
    <div className={`app${settings.sidebarExpanded === false ? ' app--sb-collapsed' : ''}`}>
      <WallpaperLayer />
      <TitleBar />

      {/* 环境不完整时的引导卡。它自己带「再探一遍 / 手动选目录」两条出路 ——
          新电脑上用户唯一能做的事不该是「去设置里手打路径」。 */}
      {envBroken ? <EnvSetupCard /> : null}

      {/* 引导卡已经把环境告警摊开、还多给了出路，这一条就不再重复说一遍 */}
      {!envBroken && warnings.length > 0 ? (
        <div className="banner banner--warn app__warn" role="status">
          <span aria-hidden="true">▲</span>
          <span className="app__warn-text">
            {warnings.map((w, i) => (
              <span key={i} className="app__warn-line">
                {w}
              </span>
            ))}
          </span>
          <span className="app__fatal-actions">
            {/* 「用自带运行时」是常态、不是毛病 —— 那种情况下不给「设置」按钮，
                因为用户去设置里也没有任何可改的东西（自带那份就在安装目录里）。
                只在真的缺东西（envBroken 之外的其他告警）时才让用户能跳去设置。 */}
            {state.runtime?.runtimeSource !== 'bundled' ? (
              <button type="button" className="btn btn--sm btn--ghost" onClick={actions.openSettings}>
                设置
              </button>
            ) : null}
            <button type="button" className="btn btn--sm btn--ghost" onClick={actions.dismissWarnings}>
              忽略
            </button>
          </span>
        </div>
      ) : null}

      {/* 日志从「底部抽屉」改成主区 view（用户原话：「日志为什么点开之后还是在已安装，
           而不是显示日志呢」）—— 抽屉永远只盖住主区下半截，主区还停在已安装，
           看起来就是「点了没反应」。view 化之后点侧栏「运行日志」主区整个换成日志。 */}
      <div className="app__body">
        <SidebarShell />

        <main
          className={`app__main shell-main${
            settings.sidebarExpanded === false ? ' shell-main--collapsed' : ''
          }`}
        >
          <div className="subbar">
            <div className="subbar__tabs" role="tablist" aria-label="视图">
              <button
                type="button"
                role="tab"
                aria-selected={state.view === 'plugins'}
                className={`subbar__tab${state.view === 'plugins' ? ' is-active' : ''}`}
                onClick={() => actions.setView('plugins')}
              >
                已安装
                <span className="subbar__count mono">{state.plugins.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={state.view === 'install'}
                className={`subbar__tab${state.view === 'install' ? ' is-active' : ''}`}
                onClick={() => actions.setView('install')}
              >
                安装插件
              </button>
            </div>

            <div className="subbar__meta mono">
              {profile ? (
                <>
                  <span className="truncate" title={profile.dir}>
                    {profile.name}
                  </span>
                  <span className="dim">·</span>
                  <span className="dim">{profile.hasNodeModules ? 'node_modules 就绪' : '未初始化'}</span>
                </>
              ) : (
                <span className="dim">未选择 profile</span>
              )}
              {counts.updatable > 0 ? (
                <>
                  <span className="dim">·</span>
                  <span className="badge badge--accent">{counts.updatable} 可更新</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="app__view">
            {state.view === 'logs' ? (
              <LogDrawer />
            ) : state.view === 'plugins' ? (
              <PluginList />
            ) : (
              <InstallPanel />
            )}
          </div>
        </main>

        {detailOpen ? <PluginDetail /> : null}
      </div>

      {/* LogDrawer 不再在底部挂载：它现在是主区 view（上面 app__view 里渲染）。
          SettingsDialog 还是模态弹窗，继续挂最外层。 */}
      <SettingsDialog />

      {/* 拖拽导入壁纸：挂在最外层，因为它要监听整个窗口的 drag 事件 */}
      <WallpaperDrop />
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}

/**
 * 首屏的「装不了插件」引导卡。
 *
 * ★ 这张卡说的是「缺 Node / pnpm」，**不是「缺安装目录」**。
 *
 * 以前把它做成「找不到 DSH 桌面端安装目录」就整屏拦住 —— 这是错的：插件装进的是
 * `<DSH_HOME>/profiles/<name>`（`C:\Users\<你>\.dsh\profiles\desktop`），跑的是
 * `<DSH_HOME>\dsh-runtimes` 里的 node 与 pnpm。整条链路跟 DSH 桌面端装在哪里无关。
 * 安装目录只在「启动 / 退出 DSH」和「走官方通道」时用得上，那两件事各有各的降级，
 * 不该反过来把插件台整个堵死。
 *
 * 所以这里给的出路也是针对 .dsh 的：
 *   1) 自动检测一遍：清缓存重跑探测（含 DSH_HOME 的各候选位置）；
 *   2) 手动指定 .dsh 目录：用户可能就是把它挪到别处了；
 *   3) 打开设置：还不行就手填。
 */
function EnvSetupCard() {
  const { state, actions } = useConsole()
  const runtime = state.runtime
  const gaps = missingEnvParts(runtime)

  /* 这两道通道的实现在主进程那一路，可能还没挂出来 —— 拿不到就禁用按钮并给 title */
  const autoFn = envRedetectFn()
  const pickFn = pickDirectoryFn()

  const [busy, setBusy] = useState<'auto' | 'pick' | null>(null)
  const [found, setFound] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [steps, setSteps] = useState<DiscoveryStep[]>(runtime?.discovery ?? [])
  /* 诊断明细默认收起。
   * 环境全缺时它会渲染几十条（本机实测 74 条 / 1551px 内容高），摊开就把这张卡
   * 撑到 40vh 上限、把主区顶到下半屏 —— 用户第一眼看到的是「界面被挤歪了」，
   * 而不是「有两个按钮能自救」。明细是给「想搞清楚为什么」的人看的，
   * 默认状态该是「按钮在脸上、明细在门后」。 */
  const [diagOpen, setDiagOpen] = useState(false)

  /* runtime 是异步到的：这张卡第一次渲染时它多半还是 null，discovery 得跟着补上 ——
     否则用户看到的是「点上面自动检测一遍」，而其实已经有一批记录在手上了。 */
  useEffect(() => {
    if (runtime?.discovery?.length) setSteps(runtime.discovery)
  }, [runtime])

  const title =
    gaps.length > 0 ? `装不了插件：缺 ${gaps.map((g) => g.short).join('、')}` : '装不了插件'
  const lead =
    gaps.length > 0
      ? `${gaps.map((g) => g.hint).join('')}这些都在 .dsh 目录里，下面随便点一个就能自己解决。`
      : '插件台没找到能用来装包的东西。'

  const onAuto = async () => {
    if (!autoFn) return
    setBusy('auto')
    setErr(null)
    try {
      const info = await autoFn()
      setSteps(info.discovery ?? [])
      /* ★ 判据是 node 与 pnpm 都在 —— 那才是「能装包」。
       *   安装目录不参与这个判断（它只影响「启动 DSH」那个按钮）。 */
      if (info.nodePath && info.pnpmPath) {
        setFound(info.dshHome ?? info.installRoot ?? '')
        /* 让「找到了」在脸上停一下，再整轮重拉。
         * 两个动作同一帧发出去的话，界面一恢复就会把这张卡顶掉，
         * 那句「找到了：<路径>」等于没显示过 —— 用户只看到界面闪了一下。 */
        await new Promise((resolve) => window.setTimeout(resolve, 900))
        // 先把结论灌进 store，界面上的环境摘要立刻就是对的
        actions.applyRuntime(info)
        // 再整轮重拉：profile、插件列表、设置全是按环境算出来的，只改 runtime 救不回来
        await actions.reloadAll()
      } else {
        setErr('还是没找到。看看下面的明细，或者直接手动指定 .dsh 目录。')
      }
    } catch (e: unknown) {
      setErr(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const onPick = async () => {
    if (!pickFn) return
    setErr(null)
    let picked: string | null = null
    try {
      picked = await pickFn(
        '选择 .dsh 目录（里面应该有 profiles 和 dsh-runtimes；默认在 C:\\Users\\<你的用户名>\\.dsh）',
        runtime?.dshHome ?? undefined
      )
    } catch (e: unknown) {
      setErr(toMessage(e))
      return
    }
    // 用户点了取消：这是正常路径，不要弹错误
    if (!picked) return

    setBusy('pick')
    try {
      /* 这一条与设置面板的「浏览…」不同：这里环境是坏的，用户没有任何可保存的草稿，
       * 所以选完直接落盘 —— 少一步「再去点保存」就少一个卡住的地方。 */
      await api().settingsSet({ dshHome: picked })
      const info = autoFn ? await autoFn() : null
      if (info) {
        setSteps(info.discovery ?? [])
        actions.applyRuntime(info)
      }
      /* ★ 只有探测真的认下这个目录，才说「找到了」。
       *   原来这里写的是 `setFound(info?.installRoot ?? picked)` —— 探测没认出来时
       *   退回「用户选的那个」，于是把用户的输入当成结论报了回去。现场表现就是
       *   Master 的「我都选择了还是这样」：界面说找到了，其实什么都没变。
       *   现在的判据是 node 与 pnpm 都在（那才是能装包），不是「目录存在」。 */
      if (info && info.nodePath && info.pnpmPath) {
        setFound(info.dshHome ?? picked)
        // 先让「找到了：<路径>」看得见，再整轮重拉把界面救回来
        await new Promise((resolve) => window.setTimeout(resolve, 900))
        await actions.reloadAll()
      } else {
        setErr(wrongPickMessage(picked, info))
      }
    } catch (e: unknown) {
      setErr(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="banner banner--danger app__fatal envset" role="alert">
      <div className="envset__head">
        <span aria-hidden="true">✕</span>
        <div className="envset__title-wrap">
          <strong className="envset__title">{title}</strong>
          <span className="envset__lead">{lead}</span>
        </div>
      </div>

      <div className="envset__actions">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => void onAuto()}
          disabled={busy !== null || !autoFn}
          title={
            autoFn
              ? '清掉探测缓存，把 .dsh 的各候选位置、运行时目录整套重跑一遍'
              : '主进程还没接上「重新检测」通道'
          }
        >
          {busy === 'auto' ? <span className="spinner spinner--sm" /> : null}
          自动检测一遍
        </button>
        <button
          type="button"
          className="btn btn--sm envbrowse"
          onClick={() => void onPick()}
          disabled={busy !== null || !pickFn}
          title={
            pickFn
              ? '弹系统「选择文件夹」，选中 .dsh 目录后直接写进设置并重新探测'
              : '主进程还没接上「选择文件夹」通道'
          }
        >
          {busy === 'pick' ? <span className="spinner spinner--sm" /> : null}
          手动指定 .dsh 目录…
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={actions.openSettings}>
          打开设置
        </button>
      </div>

      {/* 一键补全：缺 node/pnpm 时最该给的不是说明，是这颗按钮。
          它会去 <安装根>/resources/runtime 把载荷拷进 .dsh —— DSH 桌面端启动时干的
          就是这件事，我们只是把它摊开给用户看（多大、拷到哪、到哪一步）。
          源不可用（没装桌面端）时它自己退化成一句原因，不留一个按不动的按钮。 */}
      <RuntimeProvision
        className="envset__provision"
        onDone={() => {
          /* 补完立刻整轮重拉：环境、profile、插件列表全是按运行时算出来的。
           * 这里不等 900ms 的「找到了」停顿 —— 用户刚刚看着进度条爬到 100%，
           * 结论已经写在进度区里了，再停一下反而像没反应。 */
          void actions.reloadAll()
        }}
      />

      {found ? (
        <p className="envset__found">
          找到了：
          <span className="envset__found-path mono selectable">{found}</span>
        </p>
      ) : null}

      {state.fatal ? <p className="envset__err mono selectable">{state.fatal}</p> : null}
      {err ? <p className="envset__err">{err}</p> : null}

      {/* 安装目录缺失**单独说一句、不拦人** —— 它只影响「启动 / 退出 DSH」两个按钮。
          以前把它并进上面那张红卡，等于让一个用不上的按钮把整个插件台拦住。 */}
      {runtime && !runtime.installRoot ? (
        <p className="envset__note">
          另外没找到 DSH 桌面端的安装目录。那只影响「启动 / 退出 DSH」两个按钮，不影响装插件 ——
          插件装在 {runtime.dshHome ?? '.dsh'} 下。
        </p>
      ) : null}

      {/* 明细默认收起，但把「有多少条」放在按钮上 —— 一个光秃秃的「诊断明细」
          按钮会让人以为里面没什么东西；带上条数才说明「这里真的记了东西，只是没摊开」。 */}
      <button
        type="button"
        className="btn btn--sm btn--ghost envset__diagtoggle"
        onClick={() => setDiagOpen((v) => !v)}
        aria-expanded={diagOpen}
      >
        {diagOpen ? '收起诊断明细 ▴' : `看诊断明细（${steps.filter((s) => !s.ok).length} 条没命中）▾`}
      </button>

      {diagOpen ? (
        <EnvDiagnostics
          className="envset__diag"
          steps={steps.filter((s) => !s.ok)}
          warnings={runtime?.warnings}
          hint="下面是这次没命中的每一条。知道 DSH 装在哪就直接点上面的「手动选择安装目录…」，比对着这个列表猜快。"
          emptyText="点一下上面的「自动检测一遍」，就能看到我们按顺序试过哪些地方。"
        />
      ) : null}
    </div>
  )
}