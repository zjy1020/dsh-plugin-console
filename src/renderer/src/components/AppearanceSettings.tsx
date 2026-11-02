import { useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  AppearanceMode,
  MaterialKind,
  MotionLevel,
  ThemeSpec,
  WallpaperAdjust,
  WallpaperAutoFit,
  WallpaperEntry,
  WallpaperFit
} from '../../../shared/types'
import { api, toMessage } from '../api'
import { useConsole } from '../lib/store'
import '../styles/appearance-settings.css'

interface Props {
  draft: AppSettings
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  /** 立即生效类操作（换壁纸 / 应用主题 / 自动适配）改了主进程设置后，把被改动的
   *  字段搬回草稿 —— 否则高亮和滑杆读数会停在旧值，用户以为没生效。
   *  只搬差异键，不整份覆盖：这页里还有用户没保存的代理/并发数。 */
  replaceDraft: (next: AppSettings) => void
}

/* 三档以上的互斥选择用分段控件，不用下拉 —— 下拉会把当前值藏起来，
   而「我现在是深色还是浅色」是这一页最该一眼看到的事。 */
function Seg<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { v: T; label: string; hint?: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="apseg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          className={`apseg__opt${value === o.v ? ' is-on' : ''}`}
          onClick={() => onChange(o.v)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* 一条带数值回显的滑杆。数值必须显示出来 —— 拖到哪儿了不靠估计。 */
function Range({
  label,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
  onChange: (v: number) => void
  /** 松手 / 键盘抬起 / 失焦时补最后一刀。拖动过程里的 onChange 是节流写盘的，
   *  最后落点那一下不再触发 input 事件，不补这一刀就会永远差着最后一档。 */
  onCommit?: () => void
}) {
  return (
    <label className="aprng">
      <span className="aprng__label">{label}</span>
      <input
        className="aprng__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
      <span className="aprng__val">{format ? format(value) : `${value}${unit ?? ''}`}</span>
    </label>
  )
}

function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={`apsw${disabled ? ' is-disabled' : ''}`}>
      <span className="apsw__text">
        <span className="apsw__label">{label}</span>
        {hint ? <span className="apsw__hint">{hint}</span> : null}
      </span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      </span>
    </label>
  )
}

/* 取色行。
 *
 * `accent` / `ambient` 的空串是**合法值**，含义是「不指定，跟随主题 / 壁纸」。
 * 所以值里没有颜色时不能把 #000000 硬塞给 <input type="color"> —— 一个黑块的
 * 意思是「我选了黑色」，和「没指定」在屏幕上长得一样、语义完全相反。
 * 这里的处理是：色块退回占位色（只是显示），右侧文字写明「跟随主题」，清空按钮就地禁用。
 *
 * 外层用 div 不用 label：label 里的按钮会把点击转给内部 input，点「清空」会顺手
 * 弹出系统取色器，很难用。 */
function Color({
  label,
  value,
  fallback,
  hint,
  onInput,
  onCommit,
  onClear
}: {
  label: string
  value: string
  fallback: string
  hint: string
  onInput: (v: string) => void
  onCommit: () => void
  onClear: () => void
}) {
  return (
    <div className="apcolor">
      <span className="aprow__label">{label}</span>
      <input
        className="apcolor__input"
        type="color"
        value={value || fallback}
        onChange={(e) => onInput(e.target.value)}
        onBlur={onCommit}
        aria-label={label}
        title={hint}
      />
      <span className="apcolor__val">{value || '跟随主题'}</span>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        disabled={!value}
        onClick={onClear}
        title="清空 = 不指定，交回给主题 / 壁纸去决定"
      >
        清空
      </button>
    </div>
  )
}

const FIT_LABEL: Record<WallpaperFit, string> = {
  cover: '填满',
  contain: '完整',
  fill: '拉伸',
  tile: '平铺',
  center: '居中'
}

/** 调参里每个键的中文名。换壁纸时「跟随壁纸自动调整」可能重算其中几项，
 *  note 必须点名是哪几项 —— 只说「参数变了」用户根本不知道滑杆为什么自己动了。 */
const ADJUST_LABEL: Record<keyof WallpaperAdjust, string> = {
  brightness: '亮度',
  saturation: '饱和度',
  contrast: '对比度',
  blur: '模糊',
  scale: '缩放',
  offsetX: '横向偏移',
  offsetY: '纵向偏移',
  maskDark: '深色遮罩',
  maskLight: '浅色遮罩'
}

/** 两次自动适配之间到底动了哪几个滑杆（浮点直接比会误报，留一点容差） */
function changedAdjustKeys(a: WallpaperAdjust, b: WallpaperAdjust): string[] {
  const keys = Object.keys(ADJUST_LABEL) as (keyof WallpaperAdjust)[]
  return keys.filter((k) => Math.abs(a[k] - b[k]) > 1e-9).map((k) => ADJUST_LABEL[k])
}

/** 「主进程到底改了哪几个字段」—— 拿动作前后两次快照逐键比。
 *  换壁纸时 applyAutoFit 动的是 accent / ambient / sidebar* / mask*，不会碰
 *  proxy、并发数这些用户在别处正打着的东西，所以下面 syncDraft 只搬差异键，
 *  不整份覆盖草稿。 */
function diffSettings(base: AppSettings, fresh: AppSettings): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {}
  const keys = Object.keys(fresh) as (keyof AppSettings)[]
  for (const k of keys) {
    // 用 Object.assign 而不是 patch[k] = ...：后者在联合键类型上会被收窄成 never
    if (JSON.stringify(base[k]) !== JSON.stringify(fresh[k])) Object.assign(patch, { [k]: fresh[k] })
  }
  return patch
}

/** 高频控件的写盘节流窗口。
 *  100~140ms 是「眼睛觉得跟手」和「别每 1px 发一次 IPC」的交界：再密，一次拖动能打
 *  出几十个 IPC，每个都要主进程 read-改-写整份 settings.json 再广播回去，反而卡；
 *  再疏，遮罩/宽度这种大幅度变化会明显滞后于滑块。 */
const COMMIT_MS = 120

/** 「还原外观」的上膛有效期。外观是一档一档拖出来的，手停太久说明人已经走了，
 *  自己退回未上膛状态，免得回头误点一下就把整页还原掉。 */
const RESET_ARM_MS = 5000

/** 列表项 → 设置里那份引用。字段形状两边不一样，只搬设置认识的（preset/pinned 不进设置） */
function toRef(w: WallpaperEntry): NonNullable<AppSettings['wallpaper']> {
  return {
    id: w.id,
    name: w.name,
    path: w.path ?? '',
    thumbPath: w.thumbPath,
    palette: w.palette,
    width: w.width,
    height: w.height,
    kind: w.kind,
    addedAt: w.addedAt
  }
}

export function AppearanceSettings({ draft, set, replaceDraft }: Props) {
  const { actions } = useConsole()
  const [themes, setThemes] = useState<ThemeSpec[]>([])
  const [walls, setWalls] = useState<WallpaperEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [fit, setFit] = useState<WallpaperAutoFit | null>(null)
  const [newName, setNewName] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  /** 最新的草稿。syncDraft 是异步的，直接读 props.draft 拿到的是点击那一刻的旧渲染值 */
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  const reload = async () => {
    try {
      const [t, w] = await Promise.all([api().themesList(), api().wallpaperList()])
      setThemes(t)
      setWalls(w)
    } catch {
      /* 设置面板不能用一次读失败把用户堵在门外，静默降级成空列表 */
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const adjust = draft.wallpaperAdjust

  /**
   * 立即生效类动作（换壁纸 / 应用主题 / 自动适配）之后，把主进程改过的字段搬回草稿。
   *
   * 高亮、「现在用着」、滑杆读数全都长在 draft 上，draft 不回流，
   * 用户看到的就是「界面说 A、设置里是 B」。
   *
   * 为什么不是整份 replaceDraft(fresh)：这页里还躺着用户没保存的代理地址、
   * 并发数（那些要重启才生效的字段仍然走草稿）。整份覆盖会把这些悄悄抹掉，
   * 看上去像「输入框自己清空了」（上一轮就是这个坑的另一种形态）。
   * 所以只把 base→fresh 之间主进程真的改过的键搬进草稿：界面与主进程在这些键上
   * 必然一致，用户没保存的东西也留得住。 */
  const syncDraft = async (base: AppSettings): Promise<AppSettings | null> => {
    try {
      const fresh = await api().settingsGet()
      const merged = { ...draftRef.current, ...diffSettings(base, fresh) }
      replaceDraft(merged)
      return merged
    } catch {
      /* 回读失败不改已经落盘的结果，界面保留乐观值 */
      return null
    }
  }

  /** 动作之前的磁盘真相，用来算「主进程改了哪几个键」。
   *  读失败就退化用草稿当基线（本轮退化成「多搬几个键」，而不是把动作卡死）。 */
  const snapshot = async (): Promise<AppSettings> => {
    try {
      return await api().settingsGet()
    } catch {
      return draftRef.current
    }
  }

  /* ==================== 改一下就生效的写盘通道 ====================
   *
   * 这一页除代理 / 并发数 / DSH_HOME 这些「改完要重启或改安装行为」的项之外，
   * 全部改成点了立刻生效。落地方式只有一条：settingsSet → applySettings(next)。
   * 为什么不用 store 的 saveSettings：它每调一次就弹一条「设置已保存」，
   * 拖一次滑杆能糊十几条 toast。
   * 为什么不用 reloadAll：它会连 runtimeInfo / profiles / loadPlugins 一起重拉，
   * 而外观字段改不了环境 —— 拖一次滑杆落盘十来次，等于拿主进程的 IO 换一次重渲染。
   * 真正把 CSS 变量 / data-* 算出来的是「dispatch 设置」这一步，applySettings 就干这个。
   */

  /** 待落盘的增量。合并成同一个包而不是排队：拖动过程里只有最后那个值有意义，
   *  攒着一次发出去既快，也不会因为乱序把滑块写回旧位置。 */
  const pendingRef = useRef<Partial<AppSettings> | null>(null)
  const timerRef = useRef<number | null>(null)
  /** 正在写盘中。拖动和松手几乎同时打到这里，两次 settingsSet 并发跑完的先后
   *  不确定，后到的旧值会把新值盖掉 —— 用它挡重入。 */
  const flushingRef = useRef(false)
  /** 所有会改主进程设置的动作排成一条链。主进程侧是读-改-写，
   *  并发进来时后一次是基于旧快照算的，会丢掉前一次刚写的键。 */
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())

  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chainRef.current.then(fn, fn)
    // 链上只留「跑完了没」，不留值也不留 rejection：一次失败不该卡住后面每一次
    chainRef.current = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 按待写包的键名，从最新草稿里取值。
   *  不能直接用入队那一刻的值：节流窗里用户可能又拖了几档，
   *  用旧值落盘会把最后几像素吃掉（松手后滑块跳一下）。 */
  const freshValues = (keys: Partial<AppSettings>): Partial<AppSettings> => {
    const out: Partial<AppSettings> = {}
    for (const k of Object.keys(keys) as (keyof AppSettings)[]) {
      Object.assign(out, { [k]: draftRef.current[k] })
    }
    return out
  }

  const drain = async (): Promise<void> => {
    if (flushingRef.current) return
    const patch = pendingRef.current
    if (!patch) return
    pendingRef.current = null
    flushingRef.current = true
    try {
      await serial(async () => {
        const next = await api().settingsSet(freshValues(patch))
        /* 只 dispatch 设置，不重拉环境。
         * 外观拖一次会落盘十来次，每次都顺带 runtimeInfo + profiles + loadPlugins
         * 等于拿主进程的 IO 换一次重渲染 —— 拖起来就发涩；而外观字段改不了环境。 */
        actions.applySettings(next)
      })
    } catch (e: unknown) {
      // 写盘失败不能装成功，把真话摆出来；草稿保持用户拖到的那个值
      setNote(toMessage(e))
    } finally {
      flushingRef.current = false
      // 这一趟跑的时候又攒了新值（拖动没停、或者刚点了开关），接着来一版
      if (pendingRef.current && timerRef.current === null) void drain()
    }
  }

  const commit = async (): Promise<void> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await drain()
  }

  const armTimer = (): void => {
    // 已经有定时器就别重置：那样一直拖就一直不发，屏幕会一直是旧的
    if (timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void drain()
    }, COMMIT_MS)
  }

  /** 本地先改。
   *  受控控件的 value 直接来自 draft，不先写草稿的话滑块会当场弹回去；
   *  同时把值同步进 draftRef —— drain 的取值来源是它，而 React 的 effect
   *  要到下一拍才更新 ref，点了就生效这条路上没有下一拍可以等。 */
  const putLocal = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    set(key, value)
    const next = { ...draftRef.current }
    Object.assign(next, { [key]: value })
    draftRef.current = next
  }

  const queue = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    const patch: Partial<AppSettings> = { ...(pendingRef.current ?? {}) }
    Object.assign(patch, { [key]: value })
    pendingRef.current = patch
  }

  /** 高频控件（滑杆 / 取色器）：草稿立刻跟手，写盘走节流。 */
  const setLive = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    putLocal(key, value)
    queue(key, value)
    armTimer()
  }

  /**
   * 低频控件（分段控件 / 开关）：不节流，点完这一下就该看到结果。
   *
   * 和滑杆的区别不只是「不节流」：这一类改动在主进程里可能连带改别的键
   * （切到系统材质会关掉自绘壁纸层、换材质会重算透明度/模糊读数、切深浅模式会动
   * 遮罩），所以写完必须回读一次、把主进程真改过的键搬回草稿 —— 否则界面上的高亮
   * 和读数会停在一个主进程已经不认的值上。回读一律走 snapshot + syncDraft，
   * 不整份覆盖：代理地址/并发数还在草稿里等着点保存。
   */
  const setNow = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    putLocal(key, value)
    void (async () => {
      // 先把手停着的那批滑杆值发出去：它们比这次点击更早发生，
      // 但定时器可能排在这次写盘后面，不先清掉就会把刚切的值盖回去
      await commit()
      const base = await snapshot()
      const patch: Partial<AppSettings> = {}
      Object.assign(patch, { [key]: draftRef.current[key] })
      try {
        await serial(async () => {
          const next = await api().settingsSet(patch)
          // dispatch 才是让 CSS 变量 / data-* / 壁画层重算的那一步
          // （只灌设置，不重拉环境：环境跟「玻璃多糊」没有任何关系）
          actions.applySettings(next)
          await syncDraft(base)
        })
      } catch (e: unknown) {
        setNote(toMessage(e))
      }
    })()
  }

  /** 9 个遮罩/滤镜滑杆共用：整份 wallpaperAdjust 一起发，主进程按子键合并。 */
  const setAdjust = (k: keyof WallpaperAdjust, v: number): void => {
    setLive('wallpaperAdjust', { ...draftRef.current.wallpaperAdjust, [k]: v })
  }

  /** 取色器拖动时每一帧都触发 input，走节流；空串也照发（= 交回主题决定）。 */
  const setColor = (k: 'accent' | 'ambient', v: string): void => {
    setLive(k, v)
  }

  /* ---------------- 还原外观（两步确认） ---------------- */

  const [resetArm, setResetArm] = useState(false)
  const [resetNote, setResetNote] = useState<string | null>(null)
  const resetTimerRef = useRef<number | null>(null)

  // 卸载时把两个定时器收掉：面板关得快的时候不留定时器在后台写盘
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    }
  }, [])

  const disarmReset = (): void => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
    setResetArm(false)
  }

  const armReset = (): void => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    setResetArm(true)
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null
      setResetArm(false)
    }, RESET_ARM_MS)
  }

  /**
   * 还原外观。
   *
   * 顺序不能换：
   *  1) 先把还没落盘的滑杆值扔掉 —— 否则它在还原之后才写进主进程，
   *     刚还原的外观又被那几个旧值推回去；
   *  2) appearanceReset() 只动外观字段，代理 / 并发数 / 安装目录 / 托盘不碰，
   *     壁纸图片文件也不删（只把引用放下），customThemes 保留；
   *  3) replaceDraft(next) 整份替换：这一页所有字段都被还原了，没有哪个键
   *     还能留着旧值，这里不需要再算差异；
   *  4) reloadAll({ silent: true })：根节点的 data-* 属性、CSS 变量、壁纸层、
   *     侧栏宽度都长在 state.settings 上，不 dispatch，还原了屏幕也不变。
   */
  const doResetAppearance = async (): Promise<void> => {
    disarmReset()
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    setBusy('reset')
    setResetNote(null)
    setFit(null)
    try {
      const next = await serial(() => api().appearanceReset())
      draftRef.current = next
      replaceDraft(next)
      /* 只灌设置。还原动的是外观字段，装了什么插件、DSH 装在哪一点没变，
       * 没必要为了一次还原去重扫一遍环境与插件列表。 */
      actions.applySettings(next)
      setResetNote('外观已还原成默认（壁纸文件还在壁纸库里，没有删）。')
    } catch (e: unknown) {
      setResetNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    setBusy('import')
    setNote(null)
    try {
      const res = await api().wallpaperImport()
      if (res.ok && res.ref) {
        setFit(res.autoFit ?? null)
        // 导入不直接替换 —— 纲领 §5 明确要求「先进预览状态」。
        // 这里给的是「已进库、点缩略图才换上」，不偷偷改掉用户当前的背景。
        setNote(`已导入「${res.ref.name}」，先进了壁纸库；点下面那张缩略图才会换成它。`)
        await actions.reloadAll()
        await reload()
      } else if (res.error) {
        setNote(res.error)
      }
    } catch (e: unknown) {
      setNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * 换壁纸 = 立即生效。Master 的原话是「调了之后立即预览，不要点保存才看到效果」。
   *
   * 三步缺一不可：
   *  1) wallpaperSet(id) —— 真的写进主进程（「跟随壁纸自动调整」开着时它顺带重算材质）；
   *  2) reloadAll({ silent: true }) —— 重读设置并 dispatch。WallpaperLayer 读的是
   *     state.settings，不走这一步主进程换了、背景一动不动；
   *     silent 不能省：每点一张弹一条「已刷新」toast，点三张就糊三条。
   *  3) syncDraft() —— 草稿整份对齐。否则缩略图的 is-on、上方「现在用着」、
   *     以及被自动适配改过的滑杆读数全停在上一张。
   *
   * 为什么还要乐观更新：一轮 IPC + 自动适配要几十到几百毫秒，这期间点下去得有反应。
   * 但乐观值只是显示层的临时值 —— 成功以 settingsGet() 为准，失败也回读一次，
   * 保证不会留下「界面显示 A、设置里是 B」的分叉。
   */
  const doSet = async (id: string | null) => {
    setNote(null)
    setFit(null)

    const prevWall = draft.wallpaper
    const beforeAdjust = draft.wallpaperAdjust
    const beforeMode = draft.appearanceMode

    let picked: WallpaperEntry | null = null
    if (id) {
      const w = walls.find((x) => x.id === id)
      if (!w) {
        setNote('这张壁纸不在库里了，刷新一下列表再试。')
        return
      }
      if (!w.path) {
        setNote('这张壁纸的原图已经不在了（可能被删过或移走），换一张吧。')
        return
      }
      picked = w
    }

    setBusy(id ? `wall:${id}` : 'wall:none')
    // 动作前的磁盘快照：下面靠它判断自动适配到底改了哪几个键
    const base = await snapshot()
    // 乐观：先让高亮和「现在用着」当场指向新图，别等 IPC 回来
    set('wallpaper', picked ? toRef(picked) : null)

    try {
      // 和滑杆写盘同一条链：换壁纸会顺带重算材质/遮罩，跟还在飞的滑杆写盘撞上，
      // 后到的旧值会把自动适配算出来的结果盖掉
      const fresh = await serial(async () => {
        const fallback = await api().wallpaperSet(id)
        /* wallpaperSet 直接返回整份设置，用它 dispatch 就够 —— 不必再 settingsGet 一次、
         * 更不必重拉环境（换壁纸不影响环境）。 */
        actions.applySettings(fallback)
        // 回读一次草稿：自动适配可能改了遮罩/强调色，界面读数要跟着走
        return (await syncDraft(base)) ?? fallback
      })

      const moved = changedAdjustKeys(beforeAdjust, fresh.wallpaperAdjust)
      const modeMoved = fresh.appearanceMode !== beforeMode
      if (!picked) {
        setNote('已经拿掉壁纸，背景现在是纯色底。（立即生效，不用保存）')
      } else {
        const extra =
          moved.length > 0 || modeMoved
            ? ` 自动适配按这张图重算了${moved.length > 0 ? `「${moved.join('、')}」` : '深浅模式'}，下面的读数已同步。`
            : ''
        setNote(`已换成「${picked.name}」。（立即生效，不用保存）${extra}`)
      }
    } catch (e: unknown) {
      setNote(toMessage(e))
      // 失败了必须把草稿拉回主进程的真相，否则高亮会赖在没换上的那张上
      if (!(await syncDraft(base))) set('wallpaper', prevWall)
    } finally {
      setBusy(null)
    }
  }

  const doAuto = async () => {
    setBusy('auto')
    setNote(null)
    const base = await snapshot()
    try {
      const res = await serial(async () => {
        // apply=true：按钮的意义就是把算出来的值真的落到设置上，只算不写等于没点
        const fitRes = await api().wallpaperAutoFit(draft.wallpaper?.id ?? null, true)
        // autoFit 返回的是适配结果不是设置，所以要单独取一次设置再灌进去
        actions.applySettings(await api().settingsGet())
        // 适配会改强调色 / 环境色 / 遮罩这些字段，草稿得跟着回流，
        // 否则滑杆还显示旧值、用户以为没生效又去拖一遍
        await syncDraft(base)
        return fitRes
      })
      setFit(res)
      setNote('材质参数已按这张壁纸重算并生效（立即生效，不用保存）。')
    } catch (e: unknown) {
      setNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  /* 主题卡和壁纸卡一样是「点了就生效」（themeApply 直接写设置），所以同样要回流草稿：
     「使用中」那个徽标读的是 draft.activeThemeId，不回流就永远停在上一套。
     不给它写 note —— note 那块 DOM 长在「壁纸」分组里，把主题的消息塞进去会串台，
     而且整套强调色/侧边栏当场就变了，本身就是反馈。 */
  const doApplyTheme = async (id: string) => {
    setBusy(`theme:${id}`)
    const base = await snapshot()
    try {
      await serial(async () => {
        // themeApply 直接返回应用后的整份设置，用不着再 settingsGet 一次
        actions.applySettings(await api().themeApply(id))
        await syncDraft(base)
      })
    } catch (e: unknown) {
      setNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const doSaveTheme = async () => {
    if (!newName.trim()) return
    setBusy('save-theme')
    try {
      const t = await api().themeSave({ name: newName.trim() })
      setNewName('')
      setNote(`已保存主题「${t.name}」。`)
      await reload()
      await actions.reloadAll()
    } catch (e: unknown) {
      setNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const doDeleteTheme = async (t: ThemeSpec) => {
    setBusy(`del:${t.id}`)
    const base = await snapshot()
    try {
      await serial(async () => {
        await api().themeDelete(t.id)
        await reload()
        // 删主题返回的是 bool，设置得自己取一次
        actions.applySettings(await api().settingsGet())
        // 删掉的正好是「使用中」那套时，主进程会把 activeThemeId 落回内置兜底，
        // 草稿不回流的话「使用中」徽标会挂在一个已经不存在的主题上
        await syncDraft(base)
      })
    } catch (e: unknown) {
      setNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const doExportTheme = async (t: ThemeSpec) => {
    setBusy(`exp:${t.id}`)
    try {
      const res = await api().themeExport(t.id)
      if (res.ok) setNote(`主题已导出到 ${res.path}`)
      else if (res.error !== '已取消') setNote(res.error ?? '导出失败')
    } catch (e: unknown) {
      setNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const doImportTheme = async (file: File) => {
    setBusy('import-theme')
    try {
      const text = await file.text()
      const t = await api().themeImport(text)
      setNote(`已导入主题「${t.name}」，它被当成本地自定义主题，不会覆盖内置的那五套。`)
      await reload()
    } catch (e: unknown) {
      setNote(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const builtin = themes.filter((t) => t.builtin)
  const custom = themes.filter((t) => !t.builtin)
  const wallName = draft.wallpaper?.name ?? null

  return (
    <div className="apsec">
      {/* ---------------- 模式与材质 ---------------- */}
      <div className="settings__group">
        <div className="apsec__head">
          <div className="section-title">模式与材质</div>
          {/* 两步确认：第一下只是上膛，旁边冒出「取消」和后果说明，5 秒不动自己退回。
              外观是一档一档拖出来的，一步点掉会把人惹火，所以必须能反悔。 */}
          {resetArm ? (
            <div className="apreset">
              <span className="apreset__ask">还原外观？代理和并发数不动</span>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={busy !== null}
                onClick={() => void doResetAppearance()}
              >
                {busy === 'reset' ? '还原中…' : '确认还原'}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={busy === 'reset'}
                onClick={disarmReset}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn--sm btn--ghost apreset__btn"
              disabled={busy !== null}
              onClick={armReset}
              title="把外观恢复成默认；壁纸文件仍留在壁纸库里"
            >
              还原外观
            </button>
          )}
        </div>
        <div className="apnote">
          这一页改完就生效，不用点保存。下面「环境」「行为」里的 DSH_HOME、安装根、registry、代理地址、并发数
          仍然要点「保存」—— 它们要重启才生效，或者会改变安装行为。
        </div>
        {resetNote ? <div className="apnote apnote--ok">{resetNote}</div> : null}

        <div className="aprow">
          <span className="aprow__label">深浅模式</span>
          <Seg<AppearanceMode>
            label="深浅模式"
            value={draft.appearanceMode}
            onChange={(v) => setNow('appearanceMode', v)}
            options={[
              { v: 'dark', label: '深色' },
              { v: 'light', label: '浅色' },
              { v: 'system', label: '跟随系统', hint: '跟随系统时会听壁纸的明暗建议' }
            ]}
          />
        </div>

        <div className="aprow">
          <span className="aprow__label">窗口材质</span>
          <Seg<MaterialKind>
            label="窗口材质"
            value={draft.material}
            onChange={(v) => setNow('material', v)}
            options={[
              { v: 'css', label: '自绘', hint: '窗口内自绘壁纸层 + CSS 模糊，任何壁纸都能用' },
              { v: 'acrylic', label: '系统亚克力', hint: '模糊的是桌面本身，此时自定义壁纸层会关掉' },
              { v: 'mica', label: '系统云母', hint: '同上，云母比亚克力更不透明' }
            ]}
          />
        </div>
        <span className="field__hint">
          {draft.material === 'css'
            ? '自绘模式：壁纸画在窗口里，面板靠 CSS 模糊做出玻璃。换壁纸立即生效。'
            : '系统材质模式：模糊由 Windows 负责、采的是桌面壁纸，所以「自定义壁纸」这一项不参与显示。'}
        </span>

        {/* 强调色 / 氛围色。
            空串是合法值，意思是「不指定」，交回主题或壁纸的主色去决定 ——
            所以这里必须能清空，而且清空后不能显示成一块黑色（黑色 = 用户选了黑）。 */}
        <Color
          label="强调色"
          value={draft.accent}
          fallback="#6ea8ff"
          hint="按钮、焦点框、选中态用的主色。清空 = 跟随主题。"
          onInput={(v) => setColor('accent', v)}
          onCommit={() => void commit()}
          onClear={() => setNow('accent', '')}
        />
        <Color
          label="氛围色"
          value={draft.ambient}
          fallback="#2a3a5c"
          hint="面板背后那层大面积光晕的颜色。清空 = 跟随主题。"
          onInput={(v) => setColor('ambient', v)}
          onCommit={() => void commit()}
          onClear={() => setNow('ambient', '')}
        />

        <Switch
          label="减少透明效果"
          hint="把所有玻璃层换成实色底，适合远看、投影或眼睛累的时候。"
          checked={draft.reduceTransparency}
          onChange={(v) => setNow('reduceTransparency', v)}
        />
        <Switch
          label="增强对比度"
          hint="文字与边框比默认更重一档。壁纸很花时建议开。"
          checked={draft.enhanceContrast}
          onChange={(v) => setNow('enhanceContrast', v)}
        />
      </div>

      {/* ---------------- 壁纸 ---------------- */}
      <div className="settings__group">
        <div className="section-title">壁纸</div>

        <div className="aprow aprow--wall">
          <div className="apwall__now">
            {draft.wallpaper ? (
              <img className="apwall__thumb" src={`dshwp://thumb/${draft.wallpaper.id}`} alt="" />
            ) : (
              <div className="apwall__thumb apwall__thumb--empty">无</div>
            )}
            <div className="apwall__meta">
              <span className="apwall__name">{wallName ?? '没有导入壁纸'}</span>
              <span className="apwall__sub">
                {draft.wallpaper
                  ? `${draft.wallpaper.width ?? '?'} × ${draft.wallpaper.height ?? '?'}${
                      draft.wallpaper.palette ? ` · 主色 ${draft.wallpaper.palette.dominant}` : ''
                    }`
                  : '导入后原图会复制到应用自己的目录，原位置的文件删了也不影响。'}
              </span>
            </div>
          </div>
          <div className="aprow__side">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={busy !== null}
              onClick={() => void doImport()}
            >
              {busy === 'import' ? '导入中…' : '导入壁纸'}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy !== null}
              onClick={() => void doAuto()}
            >
              {busy === 'auto' ? '正在适配…' : '自动适配'}
            </button>
            {draft.wallpaper ? (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={busy !== null}
                onClick={() => void doSet(null)}
              >
                移除
              </button>
            ) : null}
          </div>
        </div>

        {fit ? (
          <div className="apfit">
            <div className="apfit__head">
              自动适配算出来的结果
              <span className="apfit__mode">{fit.mode === 'dark' ? '深色' : '浅色'}</span>
            </div>
            <ul className="apfit__reasons">
              {fit.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {note ? <div className="apnote">{note}</div> : null}

        {walls.length > 0 ? (
          <>
            <span className="field__label">壁纸库（{walls.length}）</span>
            <div className="apwall__grid">
              {walls.map((w) => {
                const on = draft.wallpaper?.id === w.id
                return (
                  <button
                    key={w.id}
                    type="button"
                    className={`apwall__cell${on ? ' is-on' : ''}`}
                    title={w.path ?? w.name}
                    onClick={() => void doSet(w.id)}
                    disabled={busy !== null}
                  >
                    {w.thumbPath || w.path ? (
                      <img src={`dshwp://thumb/${w.id}`} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <span className="apwall__miss">文件已不在</span>
                    )}
                    <span className="apwall__cellname">{w.name}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : null}

        <div className="aprow">
          <span className="aprow__label">显示方式</span>
          <Seg<WallpaperFit>
            label="显示方式"
            value={draft.wallpaperFit}
            onChange={(v) => setNow('wallpaperFit', v)}
            options={(['cover', 'contain', 'fill', 'tile', 'center'] as WallpaperFit[]).map((v) => ({
              v,
              label: FIT_LABEL[v]
            }))}
          />
        </div>

        {/* 下面这九条都是拖着看的：草稿立刻跟手（受控 value 来自 draft），
            写盘按 COMMIT_MS 节流，松手/键盘抬起/失焦再补最后一刀。
            别改成每条 onChange 直接 settingsSet —— 一次拖动能打出上百个 IPC。 */}
        <Range
          label="亮度"
          value={adjust.brightness}
          min={0.2}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setAdjust('brightness', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="饱和度"
          value={adjust.saturation}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setAdjust('saturation', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="对比度"
          value={adjust.contrast}
          min={0.2}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setAdjust('contrast', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="模糊"
          value={adjust.blur}
          min={0}
          max={64}
          step={1}
          unit="px"
          onChange={(v) => setAdjust('blur', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="缩放"
          value={adjust.scale}
          min={1}
          max={3}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => setAdjust('scale', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="横向偏移"
          value={adjust.offsetX}
          min={-1}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setAdjust('offsetX', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="纵向偏移"
          value={adjust.offsetY}
          min={-1}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setAdjust('offsetY', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="深色遮罩"
          value={adjust.maskDark}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setAdjust('maskDark', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="浅色遮罩"
          value={adjust.maskLight}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setAdjust('maskLight', v)}
          onCommit={() => void commit()}
        />
        <Switch
          label="跟随壁纸自动调整"
          hint="不用每次换壁纸都手动压遮罩。关掉之后自动适配按钮仍然手动可用。"
          checked={draft.wallpaperAuto}
          onChange={(v) => setNow('wallpaperAuto', v)}
        />
      </div>

      {/* ---------------- 侧边栏 ---------------- */}
      <div className="settings__group">
        <div className="section-title">侧边栏</div>
        <Switch
          label="默认展开"
          hint="关掉就一直是收起态的窄条。任何时候都能用左上角的箭头临时展开。"
          checked={draft.sidebarExpanded}
          onChange={(v) => setNow('sidebarExpanded', v)}
        />
        <Range
          label="宽度"
          value={draft.sidebarWidth}
          min={216}
          max={300}
          step={2}
          unit="px"
          onChange={(v) => setLive('sidebarWidth', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="圆角"
          value={draft.sidebarRadius}
          min={0}
          max={28}
          step={1}
          unit="px"
          onChange={(v) => setLive('sidebarRadius', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="透明度"
          value={draft.sidebarOpacity}
          min={0.2}
          max={0.95}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setLive('sidebarOpacity', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="模糊强度"
          value={draft.sidebarBlur}
          min={0}
          max={60}
          step={1}
          unit="px"
          onChange={(v) => setLive('sidebarBlur', v)}
          onCommit={() => void commit()}
        />
        <Switch
          label="显示快捷操作"
          hint="安装插件、搜插件、检查更新这三个按钮。"
          checked={draft.sidebarShowQuickActions}
          onChange={(v) => setNow('sidebarShowQuickActions', v)}
        />
        <Switch
          label="显示运行状态"
          hint="DSH 进程状态、启停按钮、加载层缺口和代理延迟读数。"
          checked={draft.sidebarShowStatus}
          onChange={(v) => setNow('sidebarShowStatus', v)}
        />
        <Switch
          label="自动隐藏"
          hint="鼠标离开一段时间后收起，靠到左边缘再出来。"
          checked={draft.sidebarAutoHide}
          onChange={(v) => setNow('sidebarAutoHide', v)}
        />
      </div>

      {/* ---------------- 内容面板 ----------------
          侧边栏一直是可调的，主区这块一直写死。两处都是「玻璃」，凭什么只有一边能调。
          0 是「跟随主题」的哨兵：不指定时由主题的衬底 alpha / 面板模糊推导
          （深色 86% / 18px，浅色 94% / 15.6px），也就是可调化之前那个观感。 */}
      <div className="settings__group">
        <div className="section-title">内容面板</div>
        <div className="apnote">
          主区与插件详情共用这组参数。<b>0% 与 0px 表示「跟随主题」</b>—— 不指定，交给当前主题去算；拖动任意一格就会接管。
        </div>
        <Range
          label="不透明度"
          value={draft.panelOpacity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => (v <= 0 ? '跟随主题' : `${Math.round(v * 100)}%`)}
          onChange={(v) => setLive('panelOpacity', v)}
          onCommit={() => void commit()}
        />
        <Range
          label="模糊强度"
          value={draft.panelBlur}
          min={0}
          max={60}
          step={1}
          format={(v) => (v <= 0 ? '跟随主题' : `${Math.round(v)}px`)}
          onChange={(v) => setLive('panelBlur', v)}
          onCommit={() => void commit()}
        />
        <div className="apnote">
          越透越好看，也越容易读不清：壁纸颜色一深一浅，同一档不透明度的可读性差很多。插件名字、版本号、状态徽章这些读数一旦发灰，就往回调 10%。
        </div>
      </div>

      {/* ---------------- 动效 ---------------- */}
      <div className="settings__group">
        <div className="section-title">动效</div>
        <div className="aprow">
          <span className="aprow__label">动效等级</span>
          <Seg<MotionLevel>
            label="动效等级"
            value={draft.motionLevel}
            onChange={(v) => setNow('motionLevel', v)}
            options={[
              { v: 'full', label: '完整', hint: '玻璃滑块会滑、状态点会呼吸、面板有进出场' },
              { v: 'reduced', label: '简化', hint: '保留状态反馈，去掉位移与缩放' },
              { v: 'off', label: '关闭装饰性', hint: '只留必要的出现/消失，同时把玻璃层降级为实色' }
            ]}
          />
        </div>
        <span className="field__hint">
          {draft.motionLevel === 'full'
            ? '完整：滑块 420ms 弹簧，状态点 2.4s 呼吸，面板 300ms 滑入 / 150ms 滑出。'
            : draft.motionLevel === 'reduced'
              ? '简化：只保留颜色与透明度的淡入淡出，所有位移、缩放、呼吸都停掉。'
              : '关闭装饰性：除必要的出现/消失外不动，同时把玻璃层换成实色底以省 GPU。'}
        </span>
        <span className="field__hint">
          系统里开了「减少动态效果」时，这里无论选哪一档都会按「简化」执行。
        </span>
      </div>

      {/* ---------------- 主题管理 ----------------
          主题和壁纸一样走「点了立即生效」。主题卡卖的是「整套看起来什么样」
          （强调色 / 玻璃透明度 / 模糊 / 边框亮度），不换上去根本判断不了选得对不对。
          这一页现在的分界是「改完要不要重启」：
          只要当场能看到结果的外观字段（模式、材质、颜色、滑杆、开关、主题）全都
          改完即生效；剩下的「保存」只负责代理地址、并发数、DSH_HOME、registry、
          安装目录这些要重启或会改变安装行为的字段。 */}
      <div className="settings__group">
        <div className="section-title">主题</div>
        <span className="field__hint">
          主题保存的是一整套侧边栏环境：材质透明度、模糊、遮罩、边框亮度、阴影、动效等级、宽度与展开状态。
          壁纸本身不随主题包走。「应用」点下去当场生效，不用保存。
        </span>

        <div className="aptheme__grid">
          {builtin.map((t) => {
            const on = draft.activeThemeId === t.id
            return (
              <div key={t.id} className={`aptheme__card${on ? ' is-on' : ''}`}>
                <div className="aptheme__swatch">
                  <span style={{ background: t.accent }} />
                  <span style={{ background: t.accent2 }} />
                  <span style={{ background: t.ambient }} />
                </div>
                <div className="aptheme__name">{t.name}</div>
                <div className="aptheme__desc">{t.description}</div>
                <div className="aptheme__acts">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy !== null || on}
                    onClick={() => void doApplyTheme(t.id)}
                  >
                    {on ? '使用中' : '应用'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={busy !== null}
                    onClick={() => void doExportTheme(t)}
                  >
                    导出
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {custom.length > 0 ? (
          <>
            <span className="field__label">我保存的主题（{custom.length}）</span>
            <div className="aptheme__grid">
              {custom.map((t) => {
                const on = draft.activeThemeId === t.id
                return (
                  <div key={t.id} className={`aptheme__card${on ? ' is-on' : ''}`}>
                    <div className="aptheme__swatch">
                      <span style={{ background: t.accent }} />
                      <span style={{ background: t.accent2 }} />
                      <span style={{ background: t.ambient }} />
                    </div>
                    <div className="aptheme__name">{t.name}</div>
                    <div className="aptheme__acts">
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={busy !== null || on}
                        onClick={() => void doApplyTheme(t.id)}
                      >
                        {on ? '使用中' : '应用'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        disabled={busy !== null}
                        onClick={() => void doExportTheme(t)}
                      >
                        导出
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        disabled={busy !== null}
                        onClick={() => void doDeleteTheme(t)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : null}

        <div className="aprow">
          <span className="aprow__label">把当前外观存成主题</span>
          <div className="aprow__side">
            <input
              className="input"
              value={newName}
              placeholder="主题名，比如「深夜写作」"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSaveTheme()
              }}
            />
            <button
              type="button"
              className="btn btn--sm"
              disabled={!newName.trim() || busy !== null}
              onClick={() => void doSaveTheme()}
            >
              保存主题
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy !== null}
              onClick={() => importRef.current?.click()}
            >
              导入主题
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void doImportTheme(f)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
