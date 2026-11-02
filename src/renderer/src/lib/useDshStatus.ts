/**
 * useDshStatus —— 订阅 DSH 进程状态的一处实现。
 *
 * 抽出来是因为侧栏要同时用两处：状态卡（点 + 「N 进程」）和 DshControl（启停按钮）。
 * 两边各自订阅会挂两个 IPC 监听、也会出现「点已变、文字还没变」的错帧。
 */

import { useCallback, useEffect, useState } from 'react'
import type { DshStatus } from '../../../shared/types'
import { api, toMessage } from '../api'

export type DshPhase = 'loading' | 'ready' | 'error'

export interface DshStatusView {
  status: DshStatus | null
  phase: DshPhase
  error: string | null
  reload: () => Promise<void>
  /** 启停操作拿到新状态后直接推进来，不用等下一次轮询 */
  push: (s: DshStatus) => void
}

export function useDshStatus(): DshStatusView {
  const [status, setStatus] = useState<DshStatus | null>(null)
  const [phase, setPhase] = useState<DshPhase>('loading')
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const s = await api().dshStatus()
      setStatus(s)
      setPhase('ready')
      setError(null)
    } catch (e: unknown) {
      setPhase('error')
      setError(toMessage(e))
    }
  }, [])

  const push = useCallback((s: DshStatus) => {
    setStatus(s)
    setPhase('ready')
    setError(null)
  }, [])

  useEffect(() => {
    let alive = true
    void reload()

    if (typeof window === 'undefined' || !window.dsh) {
      return () => {
        alive = false
      }
    }

    const off = api().onDshStatus((s) => {
      if (!alive) return
      push(s)
    })

    return () => {
      alive = false
      // 卸载时退订，不然切来切去会叠一堆监听
      off()
    }
  }, [reload, push])

  return { status, phase, error, reload, push }
}
