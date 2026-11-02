/**
 * SettingsDialog —— 设置弹窗（左侧分类导航 + 右侧当前类内容）。
 *
 * 两个模型，分界线是「改完要不要重启」：
 *  - 外观整组（AppearanceSettings）改一下就写盘并 dispatch，不需要点保存；
 *  - 环境 / 行为里影响安装与运行参数的字段（DSH_HOME、安装根、registry、代理、并发数）
 *    仍然走草稿 + 保存。
 *
 * 2026-11 分类导航（用户原话：「设置页做一下分类，比如说 主题等等」）：
 * 原来 AppearanceSettings + 环境 + 行为 + 清单 + 危险区整条平铺，滚到行为那段
 * 要跨过整个外观区。现在左侧竖排四类：
 *   外观    —— AppearanceSettings + 深浅模式（原「行为」组里的 theme select）
 *   环境    —— DSH_HOME / 安装根 / 重新检测 / 诊断（envFocus 信号也指到这类）
 *   安装与网络 —— registry / 代理 / 并发数 / 额外 pnpm 参数 / forceBundle
 *   常规    —— 默认 profile / 托盘开关 / 清单导出
 * 右侧只渲染当前类的内容，dialog__body 不再整条滚动（settings__pane 自己滚）。
 *
 * 数据：settingsGet() → state.settings；probeDir(dir) 做路径检测；proxyTest(input) 测代理
 * 保存：settingsSet(patch) → actions.saveSettings（成功后 refreshEnv 重拉 env 相关数据）
 * 导出：exportManifest() → main 侧弹保存对话框，成功后在按钮下面显示路径
 */

import { useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  DiscoveryStep,
  ManifestExportResult,
  ProxyTestResult,
  RuntimeInfo
} from '../../../shared/types'
import { api, toMessage } from '../api'
import { useConsole } from '../lib/store'
import { AppearanceSettings } from './AppearanceSettings'
import {
  DIAGNOSTICS_HINT,
  EnvDiagnostics,
  envDiagnoseFn,
  envRedetectFn,
  onEnvFocus,
  pickDirectoryFn,
  pickDshExeFn
} from './EnvDiagnostics'

/** 设置分类键。顺序就是左侧导航的显示顺序。 */
type SettingsSection = 'appearance' | 'env' | 'install' | 'general'

const SECTIONS: ReadonlyArray<{ key: SettingsSection; label: string }> = [
  { key: 'appearance', label: '外观' },
  { key: 'env', label: '环境' },
  { key: 'install', label: '安装与网络' },
  { key: 'general', label: '常规' }
]

interface ProbeState {
  loading: boolean
  exists?: boolean
  isDir?: boolean
  note?: string
  error?: string
}

/**
 * 只认「一眼就是端口 / host:port」的形状补 http://，其它一律原样返回。
 * 判断不了就原样存，不替用户猜（比如写了一半的 URL、带认证信息的地址）。
 */
function normalizeProxyInput(raw: string | null | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  if (/^\d{1,5}$/.test(v)) return `http://127.0.0.1:${v}`
  if (/^[a-z0-9.-]+:\d{1,5}$/i.test(v)) return `http://${v}`
  return v
}

/**
 * 耗时显示：不到 1 秒报毫秒，超过 1 秒报秒（一位小数）。
 * 代理 hop 常常是个位数毫秒、全链路可能 1800ms —— 同一个单位下这两个数没法并列读。
 */
function formatMs(ms: number | null): string {
  if (typeof ms !== 'number') return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

export function SettingsDialog() {
  const { state, actions, settings } = useConsole()
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [concurrency, setConcurrency] = useState(String(settings.concurrency))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  /** 「选程序文件」选中过的 exe —— 一行回显，让用户确认指的就是那个程序 */
  const [pickedExe, setPickedExe] = useState<string | null>(null)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<ManifestExportResult | null>(null)
  /** 当前分类。打开时默认落在外观（这一页最常改的就是它）。 */
  const [section, setSection] = useState<SettingsSection>('appearance')

  /* ── 环境：重新检测 + 诊断。两个都是「点了才动」的东西 ── */

  /** 重新检测的结论。只进界面与草稿，**不写盘** —— 这一页是草稿 + 保存的模型 */
  const [redetected, setRedetected] = useState<RuntimeInfo | null>(null)
  const [redetecting, setRedetecting] = useState(false)
  const [redetectError, setRedetectError] = useState<string | null>(null)
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagSteps, setDiagSteps] = useState<DiscoveryStep[] | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)
  /** 「去设置里指定安装目录」送来时，给环境分组一个短暂的落点高亮 */
  const [envFocusFlash, setEnvFocusFlash] = useState(false)

  const envGroupRef = useRef<HTMLDivElement | null>(null)
  /** 收到聚焦信号但面板还没打开时先记下，等打开的 effect 再滚（见下面的 effect） */
  const pendingEnvFocus = useRef(false)

  /** 这一次「打开」是否已经起过稿。见下面的 useEffect：起稿只能一次 */
  const seededRef = useRef(false)

  /**
   * 每次打开都从当前生效设置重新起稿 —— 但只在「打开」这一下，不能跟着 settings 的
   * 每一次变化重新起稿。
   *
   * 为什么：外观现在是「改一下就写盘」，每次写盘都会 reloadAll → dispatch 新
   * settings（拖滑杆也会）。如果这里还按 [settings] 重起稿，用户在这页里正打着的
   * registry / 代理 / 并发数（草稿里、还没点保存）会被悄无声息地抹掉，
   * 看上去像「输入框自己清空了」。外观那几条生效路径自己负责把草稿对齐主进程
   * （AppearanceSettings 的 syncDraft）。
   */
  useEffect(() => {
    if (!state.settingsOpen) {
      seededRef.current = false
      return
    }
    if (seededRef.current) return
    seededRef.current = true
    setDraft(settings)
    setConcurrency(String(settings.concurrency))
    setErr(null)
    setProbes({})
    setProxyTesting(false)
    setProxyResult(null)
    setExporting(false)
    setExported(null)
    setRedetected(null)
    setRedetecting(false)
    setRedetectError(null)
    setDiagOpen(false)
    setDiagSteps(null)
    setDiagLoading(false)
    setDiagError(null)
    // 每次打开回到第一类：上次停在哪个分类不该影响这次想改什么
    setSection('appearance')
  }, [state.settingsOpen, settings])

  /**
   * 「去设置里指定安装目录」的信号（store 里发，见 EnvDiagnostics 的说明）。
   * 这里只记意图、不在这里滚：信号和 openSettings 的 dispatch 在同一个批次里，
   * 此刻 settingsOpen 还是 false —— 对话框还没渲染出来，滚的是一个不存在的节点。
   */
  useEffect(
    () =>
      onEnvFocus(() => {
        pendingEnvFocus.current = true
      }),
    []
  )

  useEffect(() => {
    if (!state.settingsOpen || !pendingEnvFocus.current) return
    pendingEnvFocus.current = false
    /* 环境组在「环境」分类里：先把导航切过去，那一帧的落点高亮才有地方出现。
     * 等一帧再滚：对话框刚挂上时内部高度还在算，这一帧滚过去落点会偏。 */
    setSection('env')
    const raf = window.requestAnimationFrame(() => {
      envGroupRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      setEnvFocusFlash(true)
    })
    const timer = window.setTimeout(() => setEnvFocusFlash(false), 1800)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [state.settingsOpen])

  if (!state.settingsOpen) return null

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const probe = async (key: 'dshHome' | 'installRoot') => {
    const dir = (draft[key] ?? '').trim()
    if (!dir) return
    setProbes((p) => ({ ...p, [key]: { loading: true } }))
    try {
      const res = await api().probeDir(dir)
      setProbes((p) => ({
        ...p,
        [key]: { loading: false, exists: res.exists, isDir: res.isDir, note: res.note }
      }))
    } catch (e: unknown) {
      setProbes((p) => ({ ...p, [key]: { loading: false, error: toMessage(e) } }))
    }
  }

  /** 测代理：结果只对「当前输入的这串」负责，输入一变就清掉 */
  const testProxy = async () => {
    setProxyTesting(true)
    setProxyResult(null)
    try {
      const res = await api().proxyTest(draft.proxy ?? '')
      setProxyResult(res)
    } catch (e: unknown) {
      setProxyResult({
        ok: false,
        target: draft.proxy ?? '',
        latencyMs: null,
        totalMs: null,
        status: null,
        error: toMessage(e)
      })
    } finally {
      setProxyTesting(false)
    }
  }

  const onExport = async () => {
    setExporting(true)
    const res = await actions.exportManifest()
    setExporting(false)
    // 用户自己取消的（error === '已取消'）不动这里的状态
    if (res && !res.ok && res.error === '已取消') return
    setExported(res)
  }

  const onSave = async () => {
    setSaving(true)
    setErr(null)
    const n = Number(concurrency)
    const normalizedProxy = normalizeProxyInput(draft.proxy)
    const patch: Partial<AppSettings> = {
      ...draft,
      proxy: normalizedProxy || null,
      concurrency: Number.isFinite(n) && n > 0 ? Math.floor(n) : settings.concurrency
    }
    /*
     * 壁纸已经改成「点了立即生效」，所以这里通常不能再把它塞进 patch。
     *
     * 副作用是真会发生的：主进程的 settingsSet 看到 patch.wallpaper !== undefined，
     * 又会在「跟随壁纸自动调整」开着时补一次 applyAutoFit —— 而 applyAutoFit 会把
     * accent / ambient / sidebarOpacity / sidebarBlur / maskDark / maskLight 整套
     * 覆盖回它算出来的值。后果是：用户刚拖好的遮罩滑杆被算回去，材质被算第二遍，
     * 还会多一次落盘。所以只在「草稿里的壁纸和主进程当前的不一致」时才随保存提交
     * （正常流程走不到这一步，走到了说明壁纸在别处被换过，那时得让草稿赢一次）。
     */
    /*
     * 外观字段现在都是「改一下就写盘」，草稿里这批值等于主进程里的真值，
     * 所以整份 draft 照旧提交也不会把新值写回旧值 —— 主进程是先合并再归一化，
     * 同一份值再写一遍结果不变，只是多一次落盘。
     * 真正要防的是壁纸那一项，理由见下。
     */
    if ((draft.wallpaper?.id ?? null) === (settings.wallpaper?.id ?? null)) delete patch.wallpaper

    const ok = await actions.saveSettings(patch)
    setSaving(false)
    if (ok) {
      // 归一化后的值就是真正生效的值，写回草稿免得下次打开看着还是旧的
      setDraft((d) => ({ ...d, proxy: normalizedProxy || null }))
      actions.closeSettings()
    } else setErr('保存失败，主进程拒绝了这次写入。看日志抽屉与 Toast 里的具体原因。')
  }

  const probeText = (key: 'dshHome' | 'installRoot') => {
    const p = probes[key]
    if (!p) return null
    if (p.loading) return <span className="muted">检测中…</span>
    if (p.error) return <span className="field__hint field__hint--danger">{p.error}</span>
    if (p.exists === false) return <span className="field__hint field__hint--warn">路径不存在</span>
    if (p.isDir === false) return <span className="field__hint field__hint--warn">存在但不是目录</span>
    return (
      <span className="field__hint field__hint--ok">
        目录存在{p.note ? ` · ${p.note}` : ''}
      </span>
    )
  }

  /*
   * 三道环境通道（选文件夹 / 重新探测 / 诊断）的**主进程实现在另一条线上**，
   * preload 可能还没把它们挂出来。所以每次渲染取一遍，拿不到就是 null，
   * 对应按钮直接禁用 —— 新电脑上「找不到安装目录」时最忌讳的就是点了没反应。
   */
  const pickDir = pickDirectoryFn()
  const pickExe = pickDshExeFn()
  const redetect = envRedetectFn()
  const diagnose = envDiagnoseFn()

  /**
   * 「浏览…」：弹系统选择框，把结果写进**草稿**。
   *
   * 为什么不顺手 settingsSet：这一页的模型就是「草稿 + 保存」。用户点开浏览、
   * 选了一个目录、又点「取消」退出，这次选择本就不该落盘 —— 直接写主进程就等于
   * 替他保存了一次，而界面上那两个输入框还显示着旧值，看上去像「改了没生效」。
   */
  const browse = async (key: 'dshHome' | 'installRoot', title: string) => {
    if (!pickDir) return
    const current = (draft[key] ?? '').trim()
    try {
      const picked = await pickDir(title, current || undefined)
      if (!picked) return
      set(key, picked)
      // 选完清掉上一次的「检测」结论：它对应的是旧路径，留着就是一句假话
      setProbes((p) => {
        const next = { ...p }
        delete next[key]
        return next
      })
    } catch (e: unknown) {
      setErr(`打开选择框失败：${toMessage(e)}`)
    }
  }

  /**
   * 「选程序文件…」：直接指到 DeepSeek Harness.exe，把它的所在目录写进草稿。
   *
   * 这是安装根这条路的终极防呆形态 —— 比 browse() 更进一步：browse 还要求用户
   * 「选中那个正确的目录」，而这里用户只需要认识程序图标。选中的那一刻
   * dirname 就是安装根，没有「选错一层」的空间。
   */
  const pickExeAction = async () => {
    if (!pickExe) return
    try {
      const r = await pickExe()
      if (!r) return
      set('installRoot', r.dir)
      setPickedExe(r.exe)
      // 换了路径就把旧「检测」结论清掉 —— 它对应的是上一个路径，留着就是假话
      setProbes((p) => {
        const next = { ...p }
        delete next.installRoot
        return next
      })
    } catch (e: unknown) {
      setErr(`打开选择框失败：${toMessage(e)}`)
    }
  }

  /** 「重新检测」：清缓存重跑完整探测，结果进草稿 + 就地摘要（保存才落盘） */
  const onRedetect = async () => {
    if (!redetect) return
    setRedetecting(true)
    setRedetectError(null)
    try {
      const info = await redetect()
      setRedetected(info)
      if (info.installRoot || info.dshHome) {
        /* 先说再改：输入框自己变了却没人解释，用户会以为是被谁改掉的 */
        actions.toast('info', '已把检测到的路径填进上面的输入框', '点「保存」才真正生效。')
        if (info.installRoot) set('installRoot', info.installRoot)
        if (info.dshHome) set('dshHome', info.dshHome)
      }
      /* 探测到了 DSH_HOME 却找不到安装根，是**最常见也最无害**的一种：
       * 装插件只用 .dsh，安装根只喂「启动 / 退出 DSH」。这句要说清，
       * 否则用户会以为环境还没配好，接着去折腾一个根本不影响装包的字段。 */
      if (info.dshHome && !info.installRoot) {
        actions.toast(
          'info',
          '装插件不受影响',
          '没找到 DSH 桌面端的安装目录 —— 那只影响「启动 / 退出 DSH」两个按钮。'
        )
      }
    } catch (e: unknown) {
      setRedetectError(toMessage(e))
    } finally {
      setRedetecting(false)
    }
  }

  /**
   * 「环境诊断」：点开才去取。
   * 不在打开设置面板时就拉 —— 那会白跑一次完整的探测回溯（注册表 / 快捷方式 /
   * 磁盘扫描都算一遍），而多数人是来改代理和主题的。
   */
  const toggleDiagnose = async () => {
    if (diagOpen) {
      setDiagOpen(false)
      return
    }
    setDiagOpen(true)
    if (!diagnose) {
      setDiagError('主进程还没接上「环境诊断」通道，暂时拿不到探测过程。')
      return
    }
    if (diagSteps || diagLoading) return
    setDiagLoading(true)
    setDiagError(null)
    try {
      setDiagSteps(await diagnose())
    } catch (e: unknown) {
      setDiagError(toMessage(e))
    } finally {
      setDiagLoading(false)
    }
  }

  /** node 版本显示成统一的 vX.Y.Z（主进程给的是带不带 v 都可能） */
  const nodeLabel = (info: RuntimeInfo): string | null => {
    if (!info.nodeVersion) return null
    return info.nodeVersion.startsWith('v') ? info.nodeVersion : `v${info.nodeVersion}`
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && actions.closeSettings()}>
      <div className="dialog dialog--settings" role="dialog" aria-modal="true" aria-label="设置">
        <div className="dialog__head">
          <span className="dialog__title">设置</span>
          <button
            type="button"
            className="icon-btn"
            onClick={actions.closeSettings}
            aria-label="关闭设置"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="dialog__body">
          {/* 分类导航（用户原话：「设置页做一下分类，比如说 主题等等」）：
              左侧竖排四类，右侧只渲染当前类 —— 原来五个分组整条平铺，
              滚到「行为」要先跨过整个外观区。 */}
          <div className="settings__layout">
            <nav className="settings__nav" aria-label="设置分类">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`settings__nav-item${section === s.key ? ' is-active' : ''}`}
                  onClick={() => setSection(s.key)}
                  aria-current={section === s.key ? 'true' : undefined}
                >
                  {s.label}
                </button>
              ))}
              <span className="settings__nav-meta">
                外观改完即生效；环境 / 安装与网络要点「保存」。
              </span>
            </nav>

            <div className="settings__pane">
              {section === 'appearance' ? (
                <>
                  {/* 深浅模式从「行为」组挪过来：它就是外观的一部分 */}
                  <AppearanceSettings draft={draft} set={set} replaceDraft={setDraft} />
                </>
              ) : null}

              {section === 'env' ? (
                <div
                  className={`settings__group${envFocusFlash ? ' is-env-focus' : ''}`}
                  ref={envGroupRef}
                >
                  <div className="section-title">环境</div>

            <label className="field">
              <span className="field__label">DSH_HOME</span>
              <div className="field__row">
                <input
                  className="input input--mono"
                  value={draft.dshHome ?? ""}
                  onChange={(e) => set('dshHome', e.target.value)}
                  spellCheck={false}
                  placeholder={state.runtime?.dshHome ?? "留空 = 自动探测"}
                />
                <button
                  type="button"
                  className="btn btn--sm envbrowse"
                  onClick={() => void browse('dshHome', '选择 DSH_HOME（.dsh 目录）')}
                  disabled={!pickDir}
                  title={
                    pickDir
                      ? '弹系统「选择文件夹」，选中的目录只填进这个输入框，点「保存」才生效'
                      : '主进程还没接上「选择文件夹」通道，现在只能手打路径'
                  }
                >
                  浏览…
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void probe('dshHome')}
                  disabled={!(draft.dshHome ?? "").trim()}
                >
                  检测
                </button>
              </div>
              <span className="field__hint">
                profile 目录、cordis.patch.yml 都在这下面；插件装进
                <span className="mono">profiles\&lt;名字&gt;</span>，跑的是
                <span className="mono">dsh-runtimes</span> 里的 node / pnpm ——
                <strong>这一栏对了就能装插件</strong>。
              </span>
              {probeText('dshHome')}
            </label>

            <label className="field">
              <span className="field__label">安装根（只用于启动 / 退出 DSH）</span>
              <div className="field__row">
                <input
                  className="input input--mono"
                  value={draft.installRoot ?? ""}
                  onChange={(e) => set('installRoot', e.target.value)}
                  spellCheck={false}
                  placeholder={state.runtime?.installRoot ?? "留空 = 自动探测"}
                />
                <button
                  type="button"
                  className="btn btn--sm envbrowse"
                  onClick={() =>
                    void browse(
                      'installRoot',
                      '选择 DeepSeek Harness 的安装目录（里面应该有 resources 文件夹和 DeepSeek Harness.exe）'
                    )
                  }
                  disabled={!pickDir}
                  title={
                    pickDir
                      ? '弹系统「选择文件夹」，选中的目录只填进这个输入框，点「保存」才生效'
                      : '主进程还没接上「选择文件夹」通道，现在只能手打路径'
                  }
                >
                  浏览…
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void pickExeAction()}
                  disabled={!pickExe}
                  title={
                    pickExe
                      ? '直接选 DeepSeek Harness.exe：它所在的文件夹自动填进这一栏 —— 不用管目录结构长什么样'
                      : '主进程还没接上「选程序文件」通道'
                  }
                >
                  选程序文件…
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void probe('installRoot')}
                  disabled={!(draft.installRoot ?? "").trim()}
                >
                  检测
                </button>
              </div>
              <span className="field__hint">
                留空就自动探测（当前 {state.runtime?.installRoot ?? "未探测到"}）。
                这一栏<strong>不影响装插件</strong>，只决定「启动 / 退出 DSH」两个按钮能不能用。
                不确定目录结构就直接点「选程序文件…」—— 认得 DeepSeek Harness.exe 就够了。
              </span>
              {pickedExe ? (
                <span className="field__hint field__hint--ok">
                  按选中的程序记下安装根：{pickedExe}
                </span>
              ) : null}
              {probeText('installRoot')}
            </label>

            {/*
              手打路径正是用户抱怨的那一步，所以「重新检测」摆在两个字段正下方：
              它能自己把安装根找出来并填进草稿，比让用户去对着一堆路由猜快得多。
            */}
            <div className="envset__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void onRedetect()}
                disabled={!redetect || redetecting}
                title={
                  redetect
                    ? '清掉探测缓存，把注册表 / 快捷方式 / 父目录 / 磁盘扫描整套重跑一遍'
                    : '主进程还没接上「重新检测」通道'
                }
              >
                {redetecting ? <span className="spinner spinner--sm" /> : null}
                {redetecting ? '检测中…' : '重新检测'}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void toggleDiagnose()}
                aria-expanded={diagOpen}
                title="看看我们按顺序试过哪些地方、每一条为什么没成"
              >
                环境诊断 {diagOpen ? '▾' : '▸'}
              </button>
            </div>

            {redetectError ? (
              <span className="field__hint field__hint--danger">{redetectError}</span>
            ) : null}

            {/* 检测结论就地读：四行就是用户真正要判断的东西，别塞进 toast 里一闪而过 */}
            {redetected ? (
              <div className="envset__summary">
                <p className="envset__line">
                  <span className="envset__line-key">安装根</span>
                  <span
                    className={`envset__line-val mono selectable${
                      redetected.installRoot ? '' : ' envset__line-val--miss'
                    }`}
                  >
                    {redetected.installRoot ?? '未找到'}
                  </span>
                  {redetected.installRootFrom ? (
                    <span className="envset__line-from">（来自：{redetected.installRootFrom}）</span>
                  ) : null}
                </p>
                <p className="envset__line">
                  <span className="envset__line-key">DSH_HOME</span>
                  <span className="envset__line-val mono selectable">{redetected.dshHome}</span>
                  {redetected.dshHomeFrom ? (
                    <span className="envset__line-from">（来自：{redetected.dshHomeFrom}）</span>
                  ) : null}
                </p>
                <p className="envset__line">
                  <span className="envset__line-key">Node</span>
                  <span
                    className={`envset__line-val mono${nodeLabel(redetected) ? '' : ' envset__line-val--miss'}`}
                  >
                    {nodeLabel(redetected) ?? '未找到'}
                  </span>
                </p>
                <p className="envset__line">
                  <span className="envset__line-key">pnpm</span>
                  <span
                    className={`envset__line-val mono${
                      redetected.pnpmVersion ? '' : ' envset__line-val--miss'
                    }`}
                  >
                    {redetected.pnpmVersion ?? '未找到'}
                  </span>
                </p>
              </div>
            ) : null}

            {/* 缺 node / pnpm = 真的装不了：把告警和「没命中的那几条」摊开，用户截图就能说清。
                判据不能再用 installRoot —— 那只是「启动 / 退出 DSH」用的，缺它照样能装插件。 */}
            {redetected && !(redetected.nodePath && redetected.pnpmPath) ? (
              <EnvDiagnostics
                steps={(redetected.discovery ?? []).filter((s) => !s.ok)}
                warnings={redetected.warnings}
                hint="下面是这次没命中的每一条。知道 .dsh 在哪就直接点上面 DSH_HOME 的「浏览…」选它，比对着这个列表猜快。"
                emptyText="这次探测没有留下任何记录。"
              />
            ) : null}

            {/* 诊断区：默认收起，点开才去取（懒加载，见 toggleDiagnose） */}
            {diagOpen ? (
              <EnvDiagnostics
                steps={diagSteps ?? []}
                loading={diagLoading}
                error={diagError}
                hint={DIAGNOSTICS_HINT}
                emptyText="主进程这次一条路由都没记录 —— 通常意味着探测本身没跑起来。"
              />
            ) : null}
            </div>
          ) : null}

          {section === 'install' ? (
            <div className="settings__group">
              <div className="section-title">安装与网络</div>

            <label className="field">
              <span className="field__label">registry</span>
              <input
                className="input input--mono"
                value={draft.registry}
                onChange={(e) => set('registry', e.target.value)}
                spellCheck={false}
                placeholder="https://registry.npmjs.org"
              />
              <span className="field__hint">pnpm 的 --registry。换淘宝源可填 https://registry.npmmirror.com。</span>
            </label>

            <label className="field">
              <span className="field__label">proxy</span>
              <div className="field__row">
                <input
                  className="input input--mono"
                  value={draft.proxy ?? ""}
                  onChange={(e) => {
                    // 输入一变，上一次的测试结果就不再对应现在的输入了，直接清掉
                    setProxyResult(null)
                    set('proxy', e.target.value)
                  }}
                  spellCheck={false}
                  placeholder="http://127.0.0.1:7890"
                  aria-label="proxy"
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void testProxy()}
                  disabled={proxyTesting}
                  title="用这个地址试一次，看能不能通、延迟多少毫秒"
                >
                  {proxyTesting ? <span className="spinner spinner--sm" /> : null}
                  {proxyTesting ? '测试中…' : '测试'}
                </button>
              </div>
              <span className="field__hint">
                填端口（如 7890）或 127.0.0.1:7890 都行，会自动补成 http://。留空 = 直连。
              </span>

              {/* 测试结果就地显示在输入框下面，不走 toast */}
              {proxyTesting ? (
                <span className="pxtest pxtest--busy" role="status">
                  <span className="spinner spinner--sm" />
                  <span className="pxtest__text">
                    正在连 {(draft.proxy ?? "").trim() || '直连'}…
                  </span>
                </span>
              ) : null}

              {!proxyTesting && proxyResult ? (
                proxyResult.ok ? (
                  <span className="pxtest pxtest--ok" role="status">
                    <span className="pxtest__tag">
                      ✓ 通了
                      {typeof proxyResult.latencyMs === 'number'
                        ? ` · 代理 ${formatMs(proxyResult.latencyMs)}`
                        : ''}
                      {typeof proxyResult.totalMs === 'number'
                        ? ` · 全链路 ${formatMs(proxyResult.totalMs)}`
                        : ''}
                    </span>
                    {/*
                      两个数差得多的时候必须说一句人话，否则「代理 3 ms」会被读成
                      「装插件也是 3 ms」—— 那 1.8 秒其实是出境。
                    */}
                    {typeof proxyResult.latencyMs === 'number' &&
                    typeof proxyResult.totalMs === 'number' &&
                    proxyResult.totalMs - proxyResult.latencyMs > 400 ? (
                      <span className="pxtest__note">
                        代理本身很快，慢的是出境那一段 —— 装 GitHub / npm 上的包时按「全链路」看
                      </span>
                    ) : null}
                    <span className="pxtest__target mono selectable">{proxyResult.target}</span>
                    {(draft.proxy ?? "").trim() !== proxyResult.target ? (
                      <span className="pxtest__note">（已归一化）</span>
                    ) : null}
                    {typeof proxyResult.status === 'number' && proxyResult.status > 0 ? (
                      <span className="pxtest__note">HTTP {proxyResult.status}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="pxtest pxtest--fail" role="alert">
                    <span className="pxtest__tag">✗ {proxyResult.error || '连不上这个代理'}</span>
                    {proxyResult.target ? (
                      <span className="pxtest__target mono">{proxyResult.target}</span>
                    ) : null}
                  </span>
                )
              ) : null}
            </label>

            <label className="field">
              <span className="field__label">并发数</span>
              <input
                className="input input--mono"
                type="number"
                min={1}
                max={32}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
              />
              <span className="field__hint">「检查更新」同时查几个包。默认 6，机器慢就调小。</span>
            </label>

            <label className="field">
              <span className="field__label">额外 pnpm 参数</span>
              <input
                className="input input--mono"
                value={draft.extraPnpmArgs}
                onChange={(e) => set("extraPnpmArgs", e.target.value)}
                spellCheck={false}
                placeholder="--no-frozen-lockfile"
              />
              <span className="field__hint">按空格拆开，原样追加到每次 pnpm 调用后面。</span>
            </label>

            <div className="settings__subgroup">
              <div className="section-title">危险区</div>

              <label className="checkbox settings__check">
                <input
                  type="checkbox"
                  checked={draft.forceBundle}
                  onChange={(e) => set('forceBundle', e.target.checked)}
                />
                <span>
                  <span className="settings__check-label">强制写 bundles（forceBundle）</span>
                  <span className="field__hint field__hint--warn">
                    装包时不检查 dsh 插件字段也强行写进 dsh.profile.bundles。写错会让 DSH 启动时加载失败，
                    只有确定自己在装什么时才开。
                  </span>
                </span>
              </label>
            </div>
            </div>
          ) : null}

          {section === 'general' ? (
            <div className="settings__group">
              <div className="section-title">常规</div>

              <label className="field">
                <span className="field__label">默认 profile</span>
                <select
                  className="select"
                  value={draft.defaultProfile ?? ''}
                  onChange={(e) => set('defaultProfile', e.target.value)}
                >
                  <option value="">（自动：第一个）</option>
                  {state.profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} · {p.depCount} 插件 · {p.bundleCount} 层
                    </option>
                  ))}
                </select>
                <span className="field__hint">启动时默认选中的 profile，也会写回这里。</span>
              </label>

              <div className="settings__switch-row">
                <label className="switch settings__switch">
                  <input
                    type="checkbox"
                    checked={draft.minimizeToTray}
                    onChange={(e) => set('minimizeToTray', e.target.checked)}
                    disabled={saving}
                  />
                  关闭窗口时收进系统托盘
                </label>
                <span className="field__hint">
                  {saving ? '正在保存，保存完才能改这个开关。' : '关掉这个开关，点右上角 ✕ 就是直接退出程序。'}
                </span>
              </div>

              <div className="field">
                <span className="field__label">已装清单</span>
                <div className="field__row">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void onExport()}
                    disabled={exporting}
                    title="把当前 profile 的插件清单导出成 JSON"
                  >
                    {exporting ? <span className="spinner spinner--sm" /> : null}
                    {exporting ? '导出中…' : '导出已装清单'}
                  </button>
                </div>
                <span className="field__hint">
                  导出 profile「{state.activeProfile ?? settings.defaultProfile ?? '（未选择）'}
                  」的插件清单，之后可以在「安装插件 → 导入清单」里批量装回来。
                </span>

                {exported && exported.ok && exported.path ? (
                  <span className="settings__path" role="status">
                    <span className="settings__path-text mono selectable" title={exported.path}>
                      {exported.path}
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => void actions.revealPath(exported.path)}
                    >
                      打开所在文件夹
                    </button>
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
            </div>
          </div>

          {err ? (
            <div className="banner banner--danger" role="alert">
              {err}
            </div>
          ) : null}
        </div>

        <div className="dialog__foot">
          <span className="dialog__foot-note muted">
            外观（模式、材质、颜色、壁纸、侧边栏、动效、主题）改完就已经生效。这里只负责
            DSH_HOME / 安装根 / registry / 代理地址 / 并发数这些要重启或改安装行为的字段，并把环境信息重拉一遍。
          </span>
          <div className="dialog__foot-actions">
            <button type="button" className="btn btn--ghost" onClick={actions.closeSettings} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void onSave()} disabled={saving}>
              {saving ? <span className="spinner spinner--sm" /> : null}
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}