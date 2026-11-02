/**
 * DshControl —— DSH 进程开关。
 *
 * 数据：默认自己订阅（dshStatus() 拿初始状态 + onDshStatus 订阅后续变化，卸载时退订）。
 * 侧栏外壳里由 `SidebarShell` 统一订阅、通过 `view` 推进来，避免同一份状态挂两个监听。
 * 动作：actions.startDsh() / actions.stopDsh() —— 两个都带确认弹窗（退出会中断会话）
 *
 * 状态机：loading（还没读到状态）→ ready（运行中 / 未运行）| error（读不到状态）
 * `headless` 用于侧栏外壳：外壳已经把「点 + 运行中 · N 进程」画在自己的状态卡里了，
 * 这里再画一遍头就重复了，所以只留按钮、路径和提示。
 */

import { useCallback, useEffect, useState } from 'react'
import { api, toMessage } from '../api'
import { useConsole } from '../lib/store'
import { useDshStatus, type DshStatusView } from '../lib/useDshStatus'

type Phase = 'loading' | 'ready' | 'error'

export interface DshControlProps {
  /** 不画状态头（点 + 运行中 · N 进程 + ↻），只留启停按钮 */
  headless?: boolean
  /** 外部传入的状态（侧栏外壳共用一份），不传就自己订阅 */
  view?: DshStatusView
}

function useOwnStatus(): DshStatusView {
  const [status, setStatus] = useState<DshStatusView['status']>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setPhase((p) => (p === 'ready' ? p : 'loading'))
    try {
      const s = await api().dshStatus()
      setStatus(s)
      setPhase('ready')
      setErr(null)
    } catch (e: unknown) {
      setPhase('error')
      setErr(toMessage(e))
    }
  }, [])

  useEffect(() => {
    let alive = true
    void load()

    if (typeof window === 'undefined' || !window.dsh) {
      return () => {
        alive = false
      }
    }

    const off = api().onDshStatus((s) => {
      if (!alive) return
      setStatus(s)
      setPhase('ready')
      setErr(null)
    })

    return () => {
      alive = false
      // 卸载时退订，不然切来切去会叠一堆监听
      off()
    }
  }, [load])

  return {
    status,
    phase,
    error: err,
    reload: load,
    push: (s) => {
      setStatus(s)
      setPhase('ready')
      setErr(null)
    }
  }
}

export function DshControl({ headless = false, view }: DshControlProps) {
  const { actions } = useConsole()
  const own = useOwnStatus()
  const dsh = view ?? own
  const { status, phase, error: err } = dsh
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)

  const load = dsh.reload


  const onStart = async () => {
    setBusy('start')
    const res = await actions.startDsh()
    setBusy(null)
    if (res) dsh.push(res.status)
  }

  const onStop = async () => {
    setBusy('stop')
    const res = await actions.stopDsh()
    setBusy(null)
    if (res) dsh.push(res.status)
  }

  const running = phase === 'ready' && (status?.running ?? false)
  const idle = phase === 'ready' && !running
  const canStart = idle && busy === null
  const canStop = running && busy === null

  return (
    <div className="dshctl" aria-label="DSH 进程">
      {headless ? null : (
        <div className="dshctl__head">
        <span
          className={`dshctl__dot${running ? ' is-on' : ''}${phase === 'error' ? ' is-unknown' : ''}`}
          aria-hidden="true"
        />
        <span className="dshctl__state" role="status">
          {phase === 'loading'
            ? '正在读取 DSH 状态…'
            : phase === 'error'
              ? 'DSH 状态未知'
              : running
                ? 'DSH 运行中'
                : 'DSH 未运行'}
        </span>
        {running && status && status.pids.length > 0 ? (
          <span className="dshctl__pids mono" title={status.pids.join(', ')}>
            {status.pids.length} 进程
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn--sm btn--ghost dshctl__refresh"
          onClick={() => void load()}
          disabled={phase === 'loading' || busy !== null}
          title="重新读取 DSH 进程状态"
          aria-label="重新检测 DSH 状态"
        >
          ↻
        </button>
        </div>
      )}

      {phase === 'error' ? (
        <div className="banner banner--danger dshctl__banner" role="alert">
          <span aria-hidden="true">✕</span>
          <span className="dshctl__banner-text">读不到 DSH 状态：{err}</span>
        </div>
      ) : null}

      <div className="dshctl__actions">
        <button
          type="button"
          className={`btn btn--sm dshctl__btn${canStart ? ' btn--primary' : ''}`}
          onClick={() => void onStart()}
          disabled={!canStart}
          title={running ? 'DSH 已经在运行了' : '拉起 DSH 桌面端（会先弹一次确认）'}
        >
          {busy === 'start' ? <span className="spinner spinner--sm" /> : null}
          启动 DSH
        </button>
        <button
          type="button"
          className="btn btn--sm dshctl__btn"
          onClick={() => void onStop()}
          disabled={!canStop}
          title={running ? '退出正在运行的 DSH（会先弹确认）' : 'DSH 没在运行'}
        >
          {busy === 'stop' ? <span className="spinner spinner--sm" /> : null}
          退出 DSH
        </button>
      </div>

      {idle && status?.exePath ? (
        <p className="dshctl__path mono truncate" title={status.exePath}>
          {status.exePath}
        </p>
      ) : null}

      <p className="dshctl__hint">装完插件要重启 DSH 才会加载。</p>
    </div>
  )
}
