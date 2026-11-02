/**
 * api.ts —— window.dsh 的薄封装 + 两个自研 hook。
 *
 * 设计原则：
 *  1. 渲染进程永远不直接摸 window.dsh，走这里才能统一错误文案与兜底。
 *  2. 所有异步错误都转成字符串，交给 store / toast 显示，绝不让异常把界面打死。
 *  3. useQuery 的 deps 只接受原始值（内部会序列化成 key），避免数组长度变化。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DshConsoleApi } from '../../shared/ipc'

/* ------------------------------------------------------------------ *
 * 基础
 * ------------------------------------------------------------------ */

export function hasDsh(): boolean {
  if (typeof window === 'undefined') return false
  const d = window.dsh as DshConsoleApi | undefined
  return !!d && typeof d.profiles === 'function'
}

/** 取 preload 注入的 API；没注入直接抛，由调用方转成 UI 错误 */
export function api(): DshConsoleApi {
  if (!hasDsh()) {
    throw new Error(
      'window.dsh 不可用：preload 未注入。检查 preload 构建产物是否生成、contextIsolation 是否为 true。'
    )
  }
  return window.dsh
}

/** 任何 unknown 错误 → 一句能显示给人看的话 */
export function toMessage(err: unknown): string {
  if (err === null || err === undefined) return '未知错误'
  if (err instanceof Error) return err.message || err.name || 'Error'
  if (typeof err === 'string') return err
  if (typeof err === 'number' || typeof err === 'boolean') return String(err)
  if (typeof err === 'object') {
    const anyErr = err as { message?: unknown; error?: unknown }
    if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message
    if (typeof anyErr.error === 'string' && anyErr.error) return anyErr.error
    try {
      return JSON.stringify(err)
    } catch {
      return Object.prototype.toString.call(err)
    }
  }
  return String(err)
}

/** 把 Promise 错误变成 { data, error }，绝不抛 */
export async function safeCall<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null }
  } catch (err) {
    return { data: null, error: toMessage(err) }
  }
}

/* ------------------------------------------------------------------ *
 * useQuery —— 极简数据请求 hook
 * ------------------------------------------------------------------ */

export interface QueryOptions {
  /** false 时不自动请求，只能手动 reload()（用于「点了才算」的场景） */
  enabled?: boolean
}

export interface QueryResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** 手动重新请求（即使 enabled 为 false 也生效） */
  reload: () => void
  /** 本地覆盖数据（乐观更新用） */
  setData: (value: T | null) => void
}

/** deps 序列化：只支持原始值 / 可 JSON 化的轻量对象 */
function depsKey(deps: readonly unknown[]): string {
  return deps
    .map((d) => {
      if (d === null || d === undefined) return '∅'
      const t = typeof d
      if (t === 'string' || t === 'number' || t === 'boolean') return String(d)
      try {
        return JSON.stringify(d)
      } catch {
        return String(d)
      }
    })
    .join('\u0001')
}

export function useQuery<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[] = [],
  options: QueryOptions = {}
): QueryResult<T> {
  const { enabled = true } = options
  const fnRef = useRef(fn)
  fnRef.current = fn

  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const tokenRef = useRef(0)
  const key = depsKey(deps)
  const shouldFetch = enabled || nonce > 0

  useEffect(() => {
    if (!shouldFetch) return
    const token = tokenRef.current + 1
    tokenRef.current = token
    let alive = true
    setLoading(true)
    setError(null)
    fnRef
      .current()
      .then(
        (value) => {
          if (alive && token === tokenRef.current) {
            setData(value)
            setLoading(false)
          }
        },
        (err: unknown) => {
          if (alive && token === tokenRef.current) {
            setError(toMessage(err))
            setLoading(false)
          }
        }
      )
    return () => {
      alive = false
    }
  }, [shouldFetch, nonce, key])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setDataSafe = useCallback((value: T | null) => setData(value), [])

  return { data, loading, error, reload, setData: setDataSafe }
}

/* ------------------------------------------------------------------ *
 * useAsyncAction —— 命令式异步动作（点击触发）
 * ------------------------------------------------------------------ */

export interface AsyncAction<A extends unknown[], R> {
  run: (...args: A) => Promise<R | null>
  pending: boolean
  error: string | null
  reset: () => void
}

export function useAsyncAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
): AsyncAction<A, R> {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const mounted = useRef(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (...args: A): Promise<R | null> => {
    setPending(true)
    setError(null)
    try {
      const result = await fnRef.current(...args)
      return result
    } catch (err) {
      if (mounted.current) setError(toMessage(err))
      return null
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [])

  const reset = useCallback(() => setError(null), [])

  return { run, pending, error, reset }
}

/* ------------------------------------------------------------------ *
 * useDebouncedValue —— 输入防抖（InstallPanel 的 400ms）
 * ------------------------------------------------------------------ */

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}
