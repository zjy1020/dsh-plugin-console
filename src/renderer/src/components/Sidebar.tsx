/**
 * Sidebar —— 左栏：profile 切换 / 过滤导航 / 环境摘要 / 设置入口。
 *
 * 数据：profiles() → state.profiles；当前选中 → state.activeProfile；
 *       计数 → countFilters(plugins)
 * 选中 profile 会持久化到 settings.defaultProfile（selectProfile 内部调 settingsSet）。
 */

import { useConsole, FILTERS } from '../lib/store'
import { DshControl } from './DshControl'
import { EnvPanel, EnvSummaryLine } from './EnvPanel'

export function Sidebar() {
  const { state, actions, counts } = useConsole()

  return (
    <aside className="sidebar" aria-label="侧栏">
      <div className="sidebar__scroll">
        <section className="sidebar__section">
          <h2 className="section-title">
            Profile
            <span className="sidebar__count mono">{state.profiles.length}</span>
          </h2>

          {state.profiles.length === 0 ? (
            <p className="sidebar__empty">
              {state.ready ? '一个 profile 都没找到。检查设置里的 DSH_HOME 是否正确。' : '正在探测 profile…'}
            </p>
          ) : (
            <ul className="profiles">
              {state.profiles.map((p) => {
                const active = p.name === state.activeProfile
                return (
                  <li key={p.name}>
                    <button
                      type="button"
                      className={`profiles__item${active ? ' is-active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => {
                        if (!active) void actions.selectProfile(p.name)
                      }}
                      title={p.dir}
                    >
                      <span className="profiles__name truncate">{p.name}</span>
                      <span className="profiles__meta mono">
                        {p.depCount} 插件 · {p.bundleCount} 加载层
                      </span>
                      {p.hasNodeModules ? null : (
                        <span className="badge badge--warn profiles__badge">未初始化</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <hr className="divider" />

        <section className="sidebar__section">
          <h2 className="section-title">过滤</h2>
          <nav aria-label="插件过滤">
            <ul className="filters">
              {FILTERS.map((f) => {
                const active = state.filter === f.key
                return (
                  <li key={f.key}>
                    <button
                      type="button"
                      className={`filters__item${active ? ' is-active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      title={f.hint}
                      onClick={() => actions.setFilter(f.key)}
                    >
                      <span className="filters__label">{f.label}</span>
                      <span className="filters__count mono">{counts[f.key]}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          <label className="switch sidebar__switch" title="bundles 里有一堆 @deepseek-ai/* 官方层，默认不显示">
            <input
              type="checkbox"
              checked={state.showBuiltinLayer}
              onChange={(e) => actions.setShowBuiltinLayer(e.target.checked)}
            />
            显示官方内置层
          </label>
        </section>
      </div>

      <div className="sidebar__foot">
        <EnvSummaryLine />
        <DshControl />
        <EnvPanel />
        <div className="sidebar__actions">
          <button type="button" className="btn btn--sm btn--block" onClick={actions.openSettings}>
            设置
            <span className="kbd" aria-hidden="true">
              ,
            </span>
          </button>
          <button
            type="button"
            className={`btn btn--sm${state.logsOpen ? ' btn--ghost' : ''}`}
            onClick={() => (state.logsOpen ? actions.closeLogs() : actions.openLogs())}
            title="操作日志"
            aria-pressed={state.logsOpen}
          >
            日志
            {state.op ? <span className="spinner spinner--sm" /> : null}
          </button>
        </div>
      </div>
    </aside>
  )
}