/**
 * GapStrip —— 缝隙刻度。这是整个产品唯一的记忆点。
 *
 * 一格 = 一个依赖；实心 = 它进了 `dsh.profile.bundles`（DSH 真的会加载它）；
 * 下沉的空心缺口 = 装了但不在 bundles 里（`dsh.bundle.patch` 没声明，或者被停用了）。
 *
 * 为什么是它：本工具的核心语义就是「装了 ≠ 加载了」。一行 18px 的刻度带把
 * 「18 个依赖里 4 个没进加载层」这件事变成能逐位读的机器状态，而不是一个数字。
 *
 * 位置口径：格的水平次序 = 它在 `bundles` 数组里的下标（这就是「位置承载信息」）。
 * 不在 bundles 里的排到最后 —— 它们没有下标可占，用下沉把这一点画出来。
 */

import type { PluginRecord } from '../../../shared/types'

/** 超过这个格数就换密排（1px 间隙会把刻度糊成一条黑带） */
const DENSE_LIMIT = 56
/** 收起态的竖向柱固定段数，多了也画不下 */
const V_TICKS = 42

export interface GapStripProps {
  plugins: PluginRecord[]
  /** 竖向窄柱（收起态） */
  vertical?: boolean
  /** 数据不可信（列表加载失败）时传入，刻度带会改成错误态而不是假装有数据 */
  error?: string | null
  onPick?: (rec: PluginRecord) => void
}

interface Tick {
  rec: PluginRecord
  /** bundles 里的下标；不在 bundles 里给 null */
  index: number | null
  loaded: boolean
}

function buildTicks(plugins: PluginRecord[]): Tick[] {
  const ticks: Tick[] = plugins
    .filter((p) => p.installed)
    .map((p) => ({
      rec: p,
      index: p.inBundles && typeof p.bundleIndex === 'number' ? p.bundleIndex : null,
      loaded: p.inBundles && !p.disabled
    }))

  ticks.sort((a, b) => {
    // 有下标的在前、按下标排；没下标的排到最后（它们在 bundles 里没有位置）
    if (a.index !== b.index) {
      if (a.index === null) return 1
      if (b.index === null) return -1
      return a.index - b.index
    }
    return a.rec.name.localeCompare(b.rec.name)
  })

  return ticks
}

function titleOf(t: Tick): string {
  const where = t.index === null ? 'bundles 无此下标' : `bundles[${t.index}]`
  const state = t.loaded ? '已加载' : t.index === null ? '不在加载列表' : '已被停用'
  return `${t.rec.name} · ${where} · ${state}`
}

export function GapStrip({ plugins, vertical = false, error = null, onPick }: GapStripProps) {
  const ticks = buildTicks(plugins)

  if (error) {
    return (
      <div
        className="gap-strip gap-strip--error"
        role="img"
        aria-label={`加载层状态读不出来：${error}`}
        title={error}
      />
    )
  }

  if (ticks.length === 0) {
    return (
      <div
        className="gap-strip gap-strip--empty"
        role="img"
        aria-label="这个 profile 里还没有已安装的插件"
      />
    )
  }

  const gaps = ticks.filter((t) => !t.loaded).length
  const shown = vertical ? ticks.slice(0, V_TICKS) : ticks
  const cls = [
    'gap-strip',
    vertical ? 'gap-strip--v' : '',
    !vertical && shown.length > DENSE_LIMIT ? 'gap-strip--dense' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      role="img"
      aria-label={`加载层刻度：共 ${ticks.length} 个已装插件，${ticks.length - gaps} 个已加载，${gaps} 个不在加载列表`}
    >
      {shown.map((t) => {
        const cls = `gap-strip__tick${t.loaded ? '' : ' gap-strip__tick--gap'}`
        const label = titleOf(t)
        if (!onPick) {
          return <span key={t.rec.name} className={cls} title={label} />
        }
        return (
          <button
            key={t.rec.name}
            type="button"
            className={cls}
            title={label}
            aria-label={label}
            onClick={() => onPick(t.rec)}
          />
        )
      })}
      {vertical && ticks.length > V_TICKS ? (
        <span className="gap-strip__more mono" title={`还有 ${ticks.length - V_TICKS} 个`}>
          +{ticks.length - V_TICKS}
        </span>
      ) : null}
    </div>
  )
}
