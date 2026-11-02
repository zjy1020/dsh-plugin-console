/**
 * PluginList —— 中间主列：工具条 + 表头 + 行列表 + 各种非 happy path。
 *
 * 数据：plugins(profile, {deep:false}) → state.plugins；过滤后 → store.visible
 * 进度：checkUpdates → onUpdateProgress（state.check / state.progress）
 */

import { useState } from 'react'

import { useConsole, hasUpdateError, isUpdateTarget } from '../lib/store'
import type { PluginRecord } from '../../../shared/types'
import { formatProgress, percentOf } from '../lib/format'
import { EmptyState } from './EmptyState'
import { PluginRow } from './PluginRow'

/**
 * 这一行为什么不能勾选（给禁用的复选框当 title）。
 * 直接禁用不给理由的话，用户会以为这行漏了，而不是「它本来就不需要更新」。
 */
function pickBlockReason(rec: PluginRecord): string {
  if (!rec.installed) return '没装到这个 profile 里，要更新先「重新安装」'
  if (rec.builtin) return '官方内置包随 DSH 一起发布，更新走 DSH 自身的升级'
  if (rec.sourceKind === 'link' || rec.sourceKind === 'workspace') {
    return '本地开发来源（link / workspace），更新走 git 或源目录，不走 npm'
  }
  if (hasUpdateError(rec)) return '上次检查更新失败，先重新点「检查更新」'
  return '已经是最新版'
}

function SkeletonRows({ count = 7 }: { count?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="skeleton-row" key={i}>
          <div className="skeleton-row__main">
            <span className="skeleton skeleton--line" style={{ width: `${38 + ((i * 7) % 30)}%` }} />
            <span className="skeleton skeleton--line skeleton--sm" style={{ width: `${52 + ((i * 11) % 28)}%` }} />
          </div>
          <span className="skeleton skeleton--pill" />
          <span className="skeleton skeleton--pill skeleton--wide" />
        </div>
      ))}
    </div>
  )
}

export function PluginList() {
  const { state, actions, visible, counts } = useConsole()
  /* 导出清单执行中：挡住重复点击（保存对话框是系统模态，连点会叠出两个对话框） */
  const [exporting, setExporting] = useState(false)

  const profile = state.profiles.find((p) => p.name === state.activeProfile) ?? null
  const hasSearch = state.search.trim().length > 0
  const hasFilter = state.filter !== 'all'
  const checking = state.check?.running ?? false
  const opBusy = state.op !== null
  /*
   * 「更新全部」和「更新选中」在主进程是同一个分支（kind 都是 update-all 走 opUpdate(ctx,hooks,req,true)），
   * 只有 label 分得开。不分开的话，点「更新选中」时转圈会出现在「更新全部」那个按钮上 ——
   * 界面指着一个没在干活的按钮说「它在跑」，正是这次要消灭的那类谎。
   */
  const updatingSelected = opBusy && (state.op?.label.startsWith('更新选中') ?? false)
  const updatingAll = opBusy && state.op?.kind === 'update-all' && !updatingSelected
  /* 可导出条数：跟主进程导出清单同一口径（已安装 + 可卸载，即第三方已装的那些），
     官方内置层夹在 state.plugins 里但不算数，所以别直接用 state.plugins.length */
  const exportable = state.plugins.filter(
    (p) =>
      p.installed &&
      p.removable &&
      /* link: / file: / workspace: 指向本机目录，清单拿去别的机器装不上，主进程导出时也跳过它们 —— 口径必须一致 */
      p.sourceKind !== 'link' &&
      p.sourceKind !== 'file' &&
      p.sourceKind !== 'workspace'
  ).length

  /* ---------------- 批量更新的勾选 ---------------- *
   * 勾选集合本身存在 store（state.picks），这里只算「当前可见的那些能勾 / 勾了几个」：
   * 表头全选只作用于看得见的行，否则在「可更新」筛选下点全选会连带勾上被筛掉的包。 */
  const pickableVisible = visible.filter(isUpdateTarget).map((p) => p.name)
  const pickedSet = new Set(state.picks)
  const pickedCount = state.picks.length
  const pickedVisible = pickableVisible.filter((name) => pickedSet.has(name)).length
  const allPicked = pickableVisible.length > 0 && pickedVisible === pickableVisible.length
  const somePicked = pickedVisible > 0 && !allPicked

  /** 导出清单：store 负责弹保存对话框、写文件、成功/失败各自弹 toast；
   *  用户取消（error === '已取消'）是正常路径，store 已经静默，这里不补报错 */
  const onExportManifest = async () => {
    if (exporting) return
    setExporting(true)
    try {
      await actions.exportManifest()
    } finally {
      setExporting(false)
    }
  }

  const body = (() => {
    if (!state.activeProfile) {
      return (
        <EmptyState
          icon="◍"
          title="没有可操作的 profile"
          hint="主进程没在 DSH_HOME 下找到任何 profile。去设置里确认 DSH_HOME 与安装根是否正确。"
          action={{ label: '打开设置', onClick: actions.openSettings, primary: true }}
          secondaryAction={{ label: '重新探测', onClick: () => void actions.reloadAll() }}
        />
      )
    }

    if (state.pluginsLoading && state.plugins.length === 0) {
      return <SkeletonRows />
    }

    if (state.pluginsError) {
      return (
        <EmptyState
          tone="danger"
          icon="!"
          title="读取插件列表失败"
          hint="主进程返回了错误。可能是 profile 的 package.json 损坏，或 node_modules 读取权限不足。"
          footnote={state.pluginsError}
          action={{ label: '重试', onClick: () => void actions.loadPlugins(), primary: true }}
        />
      )
    }

    if (state.plugins.length === 0) {
      return (
        <EmptyState
          icon="＋"
          title="这个 profile 还没装插件"
          hint={
            profile?.hasNodeModules
              ? 'dependencies 是空的。输入一个 GitHub 仓库地址或 npm 包名就能装上第一个。'
              : '这个 profile 连 node_modules 都没有（未初始化）。安装第一个插件时 pnpm 会自动把它建起来。'
          }
          action={{ label: '去安装插件', onClick: () => actions.setView('install'), primary: true }}
          secondaryAction={{ label: '刷新', onClick: () => void actions.loadPlugins() }}
        />
      )
    }

    if (visible.length === 0) {
      if (hasSearch || hasFilter) {
        return (
          <EmptyState
            icon="⌕"
            title={hasSearch ? `没有匹配「${state.search.trim()}」的插件` : '这个分类下没有插件'}
            hint={
              hasSearch
                ? '搜索只匹配包名、描述与 keywords。清掉搜索框看全部。'
                : `当前过滤是「${state.filter}」。换个分类或回到「全部」。`
            }
            action={{
              label: '清除搜索与过滤',
              onClick: () => {
                actions.setSearch('')
                actions.setFilter('all')
              },
              primary: true
            }}
          />
        )
      }
      return (
        <EmptyState
          icon="▤"
          title="列表里的插件都被「官方内置层」开关挡住了"
          hint="这个 profile 的依赖全是 @deepseek-ai/* 官方层。打开开关就能看到它们。"
          action={{
            label: '显示官方内置层',
            onClick: () => actions.setShowBuiltinLayer(true),
            primary: true
          }}
        />
      )
    }

    return (
      <div className="plist__rows" role="rowgroup">
        {visible.map((rec) => (
          <PluginRow
            key={rec.id}
            rec={rec}
            selected={state.selectedId === rec.id}
            busy={opBusy}
            pickable={isUpdateTarget(rec)}
            picked={pickedSet.has(rec.name)}
            pickBlockReason={pickBlockReason(rec)}
            onTogglePick={actions.togglePick}
          />
        ))}
      </div>
    )
  })()

  return (
    <section className="plist" aria-label="插件列表">
      <div className="toolbar">
        <div className="toolbar__search">
          <span className="toolbar__search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            className="input input--lg toolbar__input"
            placeholder="搜索插件名 / 描述 / keywords"
            value={state.search}
            data-search-input="true"
            onChange={(e) => actions.setSearch(e.target.value)}
            aria-label="搜索插件"
          />
          {hasSearch ? (
            <button
              type="button"
              className="icon-btn toolbar__clear"
              onClick={() => actions.setSearch('')}
              aria-label="清空搜索"
              title="清空搜索"
            >
              ✕
            </button>
          ) : (
            <span className="toolbar__hint kbd" aria-hidden="true">
              Ctrl K
            </span>
          )}
        </div>

        <div className="toolbar__actions">
          <label
            className="switch toolbar__switch"
            title="bundles 里有一堆 @deepseek-ai/* 官方层，默认不显示以免淹没列表"
          >
            <input
              type="checkbox"
              checked={state.showBuiltinLayer}
              onChange={(e) => actions.setShowBuiltinLayer(e.target.checked)}
            />
            官方内置层
          </label>

          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void actions.checkUpdates()}
            disabled={checking || !state.activeProfile || state.plugins.length === 0}
            title="逐个查 registry，检查哪些包有更新"
          >
            {checking ? <span className="spinner spinner--sm" /> : null}
            {checking ? '检查中…' : '检查更新'}
          </button>

          {/* 只在真的勾了东西时才出现：没勾选的时候它就是一个永远禁用的按钮，占地方 */}
          {pickedCount > 0 ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void actions.updateSelected()}
              disabled={opBusy}
              title={`只更新勾选的这 ${pickedCount} 个（确认弹窗里列出的就是执行名单）`}
            >
              {updatingSelected ? <span className="spinner spinner--sm" /> : null}
              更新选中 ({pickedCount})
            </button>
          ) : null}

          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void actions.updateAll()}
            disabled={updatingAll || opBusy || counts.updatable === 0}
            title={counts.updatable === 0 ? '没有可更新的插件' : `更新 ${counts.updatable} 个插件`}
          >
            {updatingAll ? <span className="spinner spinner--sm" /> : null}
            更新全部{counts.updatable > 0 ? ` (${counts.updatable})` : ''}
          </button>

          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void actions.loadPlugins()}
            disabled={state.pluginsLoading || !state.activeProfile}
            title="重新读取当前 profile 的插件（Ctrl+Shift+R）；已查到的更新结论会保留，不必重查"
          >
            {state.pluginsLoading ? <span className="spinner spinner--sm" /> : '⟳'}
            刷新
          </button>

          <button
            type="button"
            className="btn btn--sm btn--ghost toolbar__export"
            onClick={() => void onExportManifest()}
            disabled={exporting || exportable === 0}
            title={
              exportable === 0
                ? '没有可导出的插件：清单只收第三方已装的插件（官方内置层不算），先在「＋ 安装插件」里装一个'
                : `把当前 profile 的 ${exportable} 个插件导出成 JSON 清单，之后可以在「安装插件 → 导入清单」里一键装回来`
            }
          >
            {exporting ? <span className="spinner spinner--sm" /> : null}
            导出清单
          </button>

          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => actions.setView('install')}
            title="输入 GitHub 仓库地址或 npm 包名安装"
          >
            ＋ 安装插件
          </button>

          <button
            type="button"
            className={`btn btn--sm${state.logsOpen ? '' : ' btn--ghost'}`}
            /* 为什么改走 toggleLogs：侧栏那一项和这个按钮必须同一套语义，
             * 否则「点一下开、再点一下关」只有一边成立，另一边变成哑炮 */
            onClick={actions.toggleLogs}
            aria-pressed={state.logsOpen}
            title={state.logsOpen ? '收起操作日志' : '展开操作日志'}
          >
            日志{state.logs.length > 0 ? ` (${state.logs.length})` : ''}
          </button>
        </div>
      </div>

      {state.check ? (
        <div className="checkbar" role="status" aria-live="polite">
          <div className="checkbar__text">
            {checking ? (
              <>
                <span className="spinner spinner--sm" />
                <span>检查更新 {formatProgress(state.check.done, state.check.total)}</span>
                {state.progress?.name ? (
                  <span className="mono muted truncate">{state.progress.name}</span>
                ) : null}
              </>
            ) : (
              <>
                <span className="checkbar__done">更新检查完成</span>
                <span className="mono muted">
                  可更新 {counts.updatable} · 失败 {state.progress?.error ?? 0} · 跳过{' '}
                  {state.progress?.skipped ?? 0}
                </span>
              </>
            )}
          </div>
          <div
            className={`progress${checking ? '' : ' progress--full'}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentOf(state.check.done, state.check.total)}
          >
            <div
              className="progress__fill"
              style={{ width: `${percentOf(state.check.done, state.check.total)}%` }}
            />
          </div>
        </div>
      ) : null}

      {profile && !profile.hasNodeModules ? (
        <div className="banner banner--warn plist__banner" role="status">
          <span aria-hidden="true">▲</span>
          <span>
            profile「{profile.name}」还没有 node_modules（未初始化）。这里列出来的是 package.json 里的依赖声明，
            装第一个插件或执行更新时会自动跑一次 pnpm 安装。
          </span>
        </div>
      ) : null}

      <div className="plist__head" role="row">
        <span className="plist__col plist__col--main plist__head-main">
          {/*
            三态全选：只覆盖「当前可见且能勾选」的行。
            indeterminate 不是 HTML 属性（写不进 JSX），只能在 ref 回调里赋 DOM 属性 ——
            所以下面这个 ref 每次渲染都会重跑一遍，把「部分选中」的横杠状态同步上去。
          */}
          <label
            className="checkbox plist__pick-all"
            title={
              pickableVisible.length === 0
                ? '当前列表里没有可勾选的插件'
                : `全选当前列表里 ${pickableVisible.length} 个可更新的插件`
            }
          >
            <input
              type="checkbox"
              ref={(el) => {
                if (el) el.indeterminate = somePicked && !allPicked
              }}
              checked={allPicked}
              disabled={pickableVisible.length === 0}
              onChange={(e) => actions.setPicks(e.target.checked ? pickableVisible : [])}
              aria-label="全选可更新的插件"
            />
          </label>
          插件
        </span>
        <span className="plist__col plist__col--ver">版本</span>
        <span className="plist__col plist__col--ops">操作</span>
      </div>

      <div className="plist__body">{body}</div>

      <footer className="plist__foot">
        <span className="mono muted">
          显示 {visible.length} / 共 {state.plugins.length}
        </span>
        <span className="plist__foot-gap" />
        {counts.updatable > 0 ? (
          <span className="badge badge--accent">{counts.updatable} 个可更新</span>
        ) : null}
        {counts.disabled > 0 ? <span className="badge badge--muted">{counts.disabled} 个已停用</span> : null}
        {state.showBuiltinLayer ? <span className="badge badge--muted">含官方内置层</span> : null}
        {state.op ? (
          <span className="plist__foot-op">
            <span className="spinner spinner--sm" />
            <span className="truncate">{state.op.label}</span>
          </span>
        ) : null}
      </footer>
    </section>
  )
}