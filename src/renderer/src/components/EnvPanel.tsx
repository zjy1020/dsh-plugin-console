/**
 * EnvPanel —— 环境摘要（侧栏底部，可折叠）。
 *
 * 数据：RuntimeInfo（store.state.runtime）
 * 交互：「重新探测」用 useQuery(enabled:false) 手动触发 runtimeInfo()，成功后写回 store。
 */

import { useEffect, useState } from 'react'
import type { RuntimeInfo } from '../../../shared/types'
import { api, useQuery } from '../api'
import { formatBytes } from '../lib/format'
import { useConsole } from '../lib/store'

function Row({ label, value, mono = true, tone }: { label: string; value: string; mono?: boolean; tone?: 'warn' | 'danger' | 'mute' }) {
  return (
    <div className="env__row">
      <span className="env__key">{label}</span>
      <span
        className={`env__val truncate${mono ? ' mono' : ''}${tone === 'warn' ? ' env__val--warn' : ''}${
          tone === 'danger' ? ' env__val--danger' : ''
        }${tone === 'mute' ? ' env__val--mute' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

export function EnvPanel() {
  const { state, actions } = useConsole()
  const [open, setOpen] = useState(false)
  const probe = useQuery<RuntimeInfo>(() => api().runtimeInfo(), [], { enabled: false })

  useEffect(() => {
    if (probe.data) actions.applyRuntime(probe.data)
    // actions 是 useMemo 稳定引用，不会引起循环
  }, [probe.data, actions])

  const runtime = state.runtime
  const warnCount = runtime?.warnings.length ?? 0

  return (
    <section className={`env${open ? ' is-open' : ''}`} aria-label="环境摘要">
      <button
        type="button"
        className="env__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="env-body"
      >
        <span className={`env__caret${open ? ' is-open' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span className="env__title">环境</span>
        {warnCount > 0 ? (
          <span className="badge badge--warn env__warn-badge">{warnCount} 项告警</span>
        ) : (
          <span className="env__dot" aria-hidden="true" />
        )}
        <span className="env__state mono">{runtime ? '已探测' : '未探测'}</span>
      </button>

      {open ? (
        <div className="env__body" id="env-body">
          {!runtime ? (
            <p className="env__empty">还没探测到环境。点下面的「重新探测」。</p>
          ) : (
            <>
              <Row label="DSH_HOME" value={runtime.dshHome} />
              <Row label="安装根" value={runtime.installRoot ?? '未找到'} tone={runtime.installRoot ? undefined : 'warn'} />
              <Row label="桌面端版本" value={runtime.desktopVersion ?? '未知'} />
              <Row label="runtime" value={runtime.runtimeVersion ?? '未知'} />
              <Row label="node" value={runtime.nodeVersion ?? '未找到'} tone={runtime.nodeVersion ? undefined : 'danger'} />
              <Row label="pnpm" value={runtime.pnpmVersion ?? '未找到'} tone={runtime.pnpmVersion ? undefined : 'danger'} />
              <Row label="node.exe" value={runtime.nodePath ?? '—'} tone={runtime.nodePath ? 'mute' : 'warn'} />
              <Row label="pnpm 入口" value={runtime.pnpmPath ?? '—'} tone={runtime.pnpmPath ? 'mute' : 'warn'} />
              <Row label="dsh CLI" value={runtime.dshCliPath ?? '—'} tone={runtime.dshCliPath ? 'mute' : 'warn'} />

              {warnCount > 0 ? (
                <div className="env__warnings">
                  <p className="env__warnings-title">告警</p>
                  <ul>
                    {runtime.warnings.map((w, i) => (
                      <li key={`${i}-${w}`}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}

          <div className="env__actions">
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => probe.reload()}
              disabled={probe.loading}
            >
              {probe.loading ? <span className="spinner spinner--sm" /> : null}
              重新探测
            </button>
            {probe.error ? <span className="env__err">{probe.error}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** 侧栏里给的极小环境摘要（折叠态也看得见的关键值） */
export function EnvSummaryLine() {
  const { state } = useConsole()
  const runtime = state.runtime
  const size = state.plugins.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0)
  return (
    <p className="sidebar__envline mono" title={runtime?.dshHome ?? ''}>
      {runtime?.runtimeVersion ? `runtime ${runtime.runtimeVersion}` : 'runtime ?'} · 已装占用{' '}
      {size > 0 ? formatBytes(size) : '—'}
    </p>
  )
}