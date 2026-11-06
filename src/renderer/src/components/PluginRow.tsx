/**
 * PluginRow —— 单行插件。紧凑一行（52px），点整行开右侧详情。
 *
 * 数据：PluginRecord（来自 plugins(profile, {deep:false})）
 * 操作：actions.updateOne / toggleOne / uninstall / reinstall / revealPath
 * 勾选：批量更新用，勾选状态由 PluginList 从 store 传进来（这里不自己存）
 */

import type { PluginRecord } from '../../../shared/types'
import { describeSource, describeUpdateKind, formatBytes, orDash } from '../lib/format'
import { pluginDesc } from '../lib/desc'
import { hasUpdateError, useConsole } from '../lib/store'
import { PluginIcon } from './PluginIcon'

export interface PluginRowProps {
  rec: PluginRecord
  selected: boolean
  busy: boolean
  /** 这一行能不能被勾选（可更新、且主进程不会跳过它） */
  pickable: boolean
  /** 已经勾上了吗 */
  picked: boolean
  /** 不能勾选时的原因，给禁用的复选框当 title —— 直接禁用不解释，用户会以为这行漏了 */
  pickBlockReason: string
  onTogglePick: (name: string) => void
}

export function PluginRow({
  rec,
  selected,
  busy,
  pickable,
  picked,
  pickBlockReason,
  onTogglePick
}: PluginRowProps) {
  const { actions } = useConsole()
  const source = describeSource(rec.sourceKind)

  const versionText = orDash(rec.version ?? rec.specVersion)
  const latest = rec.latestVersion
  const updatable = rec.updateAvailable && rec.installed
  const missing = !rec.installed

  const rowClass = [
    'prow',
    updatable ? 'is-updatable' : '',
    rec.disabled ? 'is-disabled' : '',
    missing ? 'is-missing' : '',
    selected ? 'is-selected' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const onRowClick = () => actions.select(rec.id)

  return (
    <div
      className={rowClass}
      role="row"
      tabIndex={-1}
      onClick={onRowClick}
      data-plugin-name={rec.name}
      title={pluginDesc(rec) ?? rec.name}
    >
      <div className="prow__main">
        <div className="prow__line1">
          {/*
            批量操作的复选框（2026-11-03 放宽：可批量更新 / 停用 / 启用 / 卸载的行都可用，
            其余渲染成禁用态 + title 说明为什么）。
            stopPropagation 是必须的：整行的 onClick 是「打开右侧详情」，
            不拦住的话点一下复选框会顺带把详情也切走。
          */}
          <span
            className={`checkbox prow__pick${pickable ? '' : ' is-off'}`}
            onClick={(e) => e.stopPropagation()}
            title={pickable ? (picked ? '取消勾选' : '勾选，纳入批量操作') : pickBlockReason}
          >
            <input
              type="checkbox"
              checked={picked}
              disabled={!pickable}
              onChange={() => onTogglePick(rec.name)}
              aria-label={
                pickable
                  ? `${picked ? '取消勾选' : '勾选'} ${rec.name}，纳入批量操作`
                  : `${rec.name} 不参与批量操作：${pickBlockReason}`
              }
            />
          </span>
          <PluginIcon profile={rec.profile} name={rec.name} size={20} radius={5} />
          <button
            type="button"
            className="prow__name mono truncate"
            onClick={(e) => {
              e.stopPropagation()
              onRowClick()
            }}
            aria-expanded={selected}
            title={`${rec.name}${rec.spec ? `  ·  ${rec.spec}` : ''}`}
          >
            {rec.name}
          </button>

          <span className={`badge badge--${source.tone} prow__badge`}>{source.label}</span>

          {rec.disabled ? <span className="badge badge--muted prow__badge">已停用</span> : null}
          {rec.builtin ? <span className="badge badge--muted prow__badge">官方内置</span> : null}
          {hasUpdateError(rec) ? (
            <span className="badge badge--danger prow__badge" title={rec.updateError ?? undefined}>
              更新失败
            </span>
          ) : null}
          {missing ? <span className="badge badge--warn prow__badge">未安装</span> : null}
          {rec.disabledInPatch ? (
            <span className="badge badge--warn prow__badge" title="cordis.patch.yml 里有 disabled: true">
              patch 停用
            </span>
          ) : null}
        </div>

        <div className="prow__line2">
          <span className="prow__desc truncate">{orDash(pluginDesc(rec))}</span>
          {rec.sizeBytes !== null ? (
            <span className="prow__size mono" title="node_modules 占用">
              {formatBytes(rec.sizeBytes)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="prow__versions">
        <span className="prow__ver mono" title="当前版本">
          {versionText}
        </span>
        <span
          className={`prow__latest mono${updatable ? ' is-updatable' : ''}`}
          title={updatable ? `可更新：${describeUpdateKind(rec.updateKind)}` : '最新版本'}
        >
          {updatable ? `→ ${orDash(latest)}` : rec.updateError ? '检查失败' : latest ? `= ${latest}` : '—'}
        </span>
      </div>

      <div className="prow__actions" onClick={(e) => e.stopPropagation()}>
        {updatable ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => void actions.updateOne(rec)}
            disabled={busy}
            title={describeUpdateKind(rec.updateKind)}
          >
            更新
          </button>
        ) : null}

        {missing ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void actions.reinstall(rec)}
            disabled={busy}
            title={`用 spec「${rec.spec}」重新安装`}
          >
            重新安装
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void actions.toggleOne(rec)}
            disabled={busy}
            title={
              rec.disabled
                ? '重新加入 dsh.profile.bundles，重启 DSH 后生效'
                : '从 dsh.profile.bundles 里移除，重启 DSH 后生效'
            }
          >
            {rec.disabled ? '启用' : '停用'}
          </button>
        )}

        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => void actions.revealPath(rec.path)}
          disabled={!rec.path}
          title={rec.path ?? '没有安装路径'}
        >
          目录
        </button>

        <button
          type="button"
          className="btn btn--sm btn--ghost prow__danger"
          onClick={() => void actions.uninstall(rec)}
          disabled={busy || !rec.removable}
          title={
            rec.removable
              ? '两步确认后调用 pnpm remove'
              : rec.builtin
                ? '官方内置包，主进程不允许卸载'
                : '被其他包依赖，主进程判定不可卸载'
          }
        >
          卸载
        </button>
      </div>
    </div>
  )
}