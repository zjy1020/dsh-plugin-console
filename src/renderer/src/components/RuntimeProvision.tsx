/**
 * RuntimeProvision —— 「缺 node / pnpm」时的那颗一键补全按钮 + 真实进度。
 *
 * ── 它解决的是哪一步 ────────────────────────────────────────────────────
 * 插件台装包只要两样东西：node.exe 和 pnpm 入口，都在
 * `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies` 里。这两样不是我们装的，
 * 是 DSH 桌面端第一次启动时从 `<安装根>/resources/runtime/primary-runtime` 展开的。
 *
 * 于是新电脑上就有个死结：用户很可能**正是为了装插件**才打开插件台，而它的第一句话
 * 是「装不了插件：缺 pnpm，你自己去开一下 DSH」。他开不了 —— 或者开了也没用
 * （DSH_HOME 指到别处、上次没展开完、.dsh 被删过）。这时最该给的不是说明，是那颗按钮。
 *
 * ── 三个界面决定 ────────────────────────────────────────────────────────
 * 1. **体积先说**。「拷 111 MB」写在按钮上，用户按下去之前就知道要等多久；
 *    藏起来的话，点完看到进度条慢慢爬会以为卡死了。
 * 2. **python 是选项、不是默认**。三块载荷实测 node 89.4 MB + pnpm 21.6 MB +
 *    python 146.2 MB ≈ 257 MB，而装插件只需要前两块（111 MB）。python 是 Office 技能
 *    用的，默认不拷；想拷的人自己勾 —— 但我们把体积标在旁边，让他知道自己在选什么。
 * 3. **进度是真的**。拷六千多个文件要十几秒，没有进度的按钮和卡死没有区别。
 *    主进程每 120ms 推一次，这里只负责画。
 */

import { useEffect, useRef, useState } from 'react'
import type { ProvisionProgress, RuntimeSourceInfo } from '../../../shared/types'
import { onProvisionProgressFn, runtimeProvisionFn, runtimeSourceFn } from './EnvDiagnostics'

function mb(bytes: number): string {
  if (!bytes) return '0 MB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface Props {
  /** 补全成功之后叫一声 —— 调用方据此重拉环境（或直接把新 RuntimeInfo 灌进 store） */
  onDone?: () => void
  /** 额外的类名，方便两处调用方各给一点间距 */
  className?: string
}

export function RuntimeProvision({ onDone, className }: Props) {
  const sourceFn = runtimeSourceFn()
  const provisionFn = runtimeProvisionFn()
  const progressFn = onProvisionProgressFn()

  const [info, setInfo] = useState<RuntimeSourceInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProvisionProgress | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [withPython, setWithPython] = useState(false)
  /* onDone 每次渲染都是新函数，但订阅只该建一次 —— 用 ref 拿最新的那个，
   * 免得每次父组件重渲染都把订阅拆了重建（那会在拷贝途中漏掉进度帧）。 */
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  /* 一进来就问一次「能不能补」。拿不到通道就什么都不显示 ——
   * 那颗按钮按下去只会炸出一句内部错误，比不显示更糟。 */
  useEffect(() => {
    if (!sourceFn) return
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const next = await sourceFn()
        if (alive) setInfo(next)
      } catch {
        /* 查询失败就当「不能补」：下面会退化成不显示按钮 */
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [sourceFn])

  /* 进度订阅：整个组件生命周期只建一次。 */
  useEffect(() => {
    if (!progressFn) return
    const off = progressFn((p) => {
      setProgress(p)
      if (p.phase === 'done') setResult(p.message)
      if (p.phase === 'fail') setFailed(p.message)
    })
    return off
  }, [progressFn])

  const doProvision = async () => {
    if (!provisionFn) return
    setRunning(true)
    setFailed(null)
    setResult(null)
    setProgress(null)
    try {
      /* 勾了 python 才拷 python。默认只拷 node + pnpm（111 MB）——
       * 装插件只用到这两块，python 是 Office 技能的事，不该让所有人陪着等 146 MB。 */
      const res = await provisionFn(withPython ? ['node', 'pnpm', 'python'] : ['node', 'pnpm'])
      if (res.ok) {
        setResult(res.message)
        doneRef.current?.()
      } else {
        setFailed(res.message)
      }
    } catch (e: unknown) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  /* 拿不到通道 → 什么都不显示（不占位、不留一句「功能不可用」） */
  if (!sourceFn || !provisionFn) return null
  /* 正在查 → 也先不显示。这个查询在主进程里可能要跑一次异步富化（注册表 / 进程），
   * 几百毫秒；先显示一个「查一下能不能补」的空壳会让卡片抖一下。 */
  if (loading && !info) return null

  /* 源不可用（没装桌面端 / 载荷架构不符）：不显示按钮，只把原因说清楚。
   * 这时用户唯一的出路是「手动指定 .dsh 目录…」那颗按钮，别在这里重复给。 */
  if (!info || !info.ok) {
    return info?.problem ? <p className={`rtprov__why ${className ?? ''}`.trim()}>{info.problem}</p> : null
  }

  /* 已经是最新的：不用按钮，一句话收尾 */
  if (info.upToDate) {
    return (
      <p className={`rtprov__why ${className ?? ''}`.trim()}>
        运行时已经是最新的了（{info.desktopVersion}），不用再拷。
      </p>
    )
  }

  const baseBytes = info.parts.node.bytes + info.parts.pnpm.bytes
  const pyBytes = info.parts.python.bytes
  const willCopy = withPython ? baseBytes + pyBytes : baseBytes
  const pct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.copiedBytes / progress.totalBytes) * 100))
      : 0

  return (
    <div className={`rtprov ${className ?? ''}`.trim()}>
      <div className="rtprov__row">
        <button
          type="button"
          className="btn btn--sm btn--primary rtprov__go"
          onClick={() => void doProvision()}
          disabled={running}
          title={`从 ${info.dir ?? ''} 拷到 ${info.target ?? ''}（DSH 桌面端启动时干的是同一件事）`}
        >
          {running ? <span className="spinner spinner--sm" /> : null}
          {running ? '正在补全…' : `一键补全运行时（拷 ${mb(willCopy)}）`}
        </button>

        <label className="rtprov__opt" title={`python 只在 Office 技能里用得到，装插件不需要；体积 ${mb(pyBytes)}`}>
          <input
            type="checkbox"
            checked={withPython}
            disabled={running}
            onChange={(e) => setWithPython(e.target.checked)}
          />
          连 python 一起（+{mb(pyBytes)}）
        </label>
      </div>

      {/* 进度：只在真的在跑或刚跑完时出现。三段信息分开写 ——
          百分比给「还要多久」，文件计数给「它没停」，当前路径给「它在干什么」。 */}
      {running || progress ? (
        <div className="rtprov__prog" role="status" aria-live="polite">
          <div className="rtprov__bar" aria-hidden="true">
            <span className="rtprov__fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="rtprov__meta">
            <span className="rtprov__pct mono">{pct}%</span>
            <span className="rtprov__msg">
              {progress?.message ?? '正在准备…'}
            </span>
            {progress?.current ? (
              <span className="rtprov__cur mono selectable" title={progress.current}>
                {progress.current}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {result ? <p className="rtprov__ok">{result}</p> : null}
      {failed ? <p className="rtprov__fail">{failed}</p> : null}

      {/* 来源一句话说清楚：出问题时用户要能指出「你拷的是哪份」 */}
      <p className="rtprov__from">
        来源：<span className="mono selectable">{info.dir}</span>（{info.desktopVersion} · {info.platform}/{info.arch}）
      </p>
    </div>
  )
}
