/**
 * PluginIcon —— 插件图标（列表行 20px / 详情头部 56px 共用）。
 *
 * 三种状态：
 *   loading —— 占位方块，轻微呼吸（prefers-reduced-motion 下关掉动画）
 *   ready   —— <img src={dataUrl}>，object-fit: contain，onError 降级到 monogram
 *   none    —— monogram 首字母占位（本机大多数插件没有图标，列表绝不能出现空洞）
 *
 * 缓存：模块级 Map + 在飞 Promise 去重，和主进程 engine/icon.ts 同思路。
 * 绝不抛异常：拿不到图标就走 monogram。
 */

import { useEffect, useState } from 'react'

import '../styles/plugin-icon.css'

export interface PluginIconProps {
  profile: string
  name: string
  /** 边长（px），默认 22 */
  size?: number
  /** 圆角（px），默认 6 */
  radius?: number
  className?: string
}

/* ------------------------------------------------------------------ *
 * 模块级缓存 + 并发去重
 * ------------------------------------------------------------------ */

/** value：dataUrl（有图）或 null（确认没有图 / 请求失败） */
const iconCache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function keyOf(profile: string, name: string): string {
  return `${profile}\u0000${name}`
}

function cachedIcon(profile: string, name: string): string | null | undefined {
  const key = keyOf(profile, name)
  return iconCache.has(key) ? (iconCache.get(key) ?? null) : undefined
}

function requestIcon(profile: string, name: string): Promise<string | null> {
  const key = keyOf(profile, name)
  if (iconCache.has(key)) return Promise.resolve(iconCache.get(key) ?? null)

  const going = inflight.get(key)
  if (going) return going

  const p = (async (): Promise<string | null> => {
    try {
      const dsh = typeof window !== 'undefined' ? window.dsh : undefined
      if (!dsh || typeof dsh.pluginIcon !== 'function') {
        iconCache.set(key, null)
        return null
      }
      const res = await dsh.pluginIcon(profile, name)
      const url = res && res.ok && typeof res.dataUrl === 'string' && res.dataUrl ? res.dataUrl : null
      iconCache.set(key, url)
      return url
    } catch {
      iconCache.set(key, null)
      return null
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, p)
  return p
}

/** 忘了缓存（比如 <img> onError，说明这个 dataUrl 实际不能用） */
function forgetIcon(profile: string, name: string): void {
  iconCache.set(keyOf(profile, name), null)
}

/* ------------------------------------------------------------------ *
 * monogram
 * ------------------------------------------------------------------ */

/** 去掉 scope（@scope/）与 dsh- / dsh 前缀，取首字母大写；实在没字母给 '?' */
export function monogramOf(name: string): string {
  const raw = typeof name === 'string' ? name.trim() : ''
  const base = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  let s = base.replace(/^dsh-+/i, '')
  if (/^dsh$/i.test(s)) s = ''
  if (!s) s = base.replace(/^dsh/i, '')
  const m = /[a-z0-9]/i.exec(s) ?? /[a-z0-9]/i.exec(base) ?? /[a-z0-9]/i.exec(raw)
  return m ? m[0].toUpperCase() : '?'
}

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export function PluginIcon({ profile, name, size = 22, radius = 6, className }: PluginIconProps) {
  /** undefined = 还没结果（加载中）；null = 确认没有图；string = dataUrl */
  const [dataUrl, setDataUrl] = useState<string | null | undefined>(() => cachedIcon(profile, name))

  useEffect(() => {
    const known = cachedIcon(profile, name)
    if (known !== undefined) {
      setDataUrl(known)
      return
    }
    let alive = true
    setDataUrl(undefined)
    void requestIcon(profile, name).then((url) => {
      if (alive) setDataUrl(url)
    })
    return () => {
      alive = false
    }
  }, [profile, name])

  const box = { width: size, height: size, borderRadius: radius } as const
  const cls = className ? ` ${className}` : ''

  if (dataUrl === undefined) {
    return (
      <span
        className={`picon-ph picon-ph--loading${cls}`}
        style={box}
        aria-hidden="true"
        data-icon-state="loading"
        title={`${name} 图标加载中`}
      />
    )
  }

  if (dataUrl) {
    return (
      <img
        className={`picon-img${cls}`}
        style={box}
        src={dataUrl}
        width={size}
        height={size}
        alt={`${name} 图标`}
        draggable={false}
        data-icon-state="ready"
        onError={() => {
          forgetIcon(profile, name)
          setDataUrl(null)
        }}
      />
    )
  }

  return (
    <span
      className={`picon-ph picon-ph--mono${cls}`}
      style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.46)) }}
      aria-hidden="true"
      data-icon-state="mono"
      title={name}
    >
      {monogramOf(name)}
    </span>
  )
}
