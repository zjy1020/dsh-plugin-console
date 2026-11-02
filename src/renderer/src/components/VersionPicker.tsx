/**
 * VersionPicker —— 版本选择面板。
 *
 * 自包含：挂载后自己调 `window.dsh.versions()` 拉版本 / 标签 / 分支，自己渲染，
 * 父组件只负责接收「用户点了哪一条」（onPick）并拿去跑安装 / 降级。
 *
 * 交互约定：
 *   - 顶部搜索框客户端过滤（匹配 label 与 value，不区分大小写），挂载即聚焦；
 *   - 列表按 kind 分组（标签 / 版本 / 分支），组内保持后端给的顺序；
 *   - 底部「将执行」一行实时显示 `pnpm add <spec>` —— 用户在点之前就该知道会发生什么；
 *   - 键盘 ↑ / ↓ 移动高亮、Enter 选中、Esc 取消；真 role="listbox" + aria-activedescendant，
 *     不是「tabIndex + onClick」那种假装可达。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'

import type { VersionList, VersionOption } from '../../../shared/types'
import { api, toMessage } from '../api'
import '../styles/version-picker.css'

export interface VersionPickerProps {
  profile: string
  /** 包名、npm spec 或 GitHub 链接 */
  input: string
  /** 当前已装版本，用来标出「当前」和升降方向 */
  current?: string | null
  /** 选中一个版本时回调；父组件负责拿去跑安装 / 降级 */
  onPick: (option: VersionOption) => void
  /** 取消（Esc 或不选） */
  onCancel?: () => void
  /** 紧凑模式：用在行内展开时，去掉部分说明文字 */
  compact?: boolean
}

/** 分组顺序：标签（npm 的 dist-tag + git 的 tag）→ 版本 → 分支 */
const GROUPS: { title: string; kinds: VersionOption['kind'][] }[] = [
  { title: '标签', kinds: ['dist-tag', 'tag'] },
  { title: '版本', kinds: ['version'] },
  { title: '分支', kinds: ['branch'] }
]

const DIRECTION_TEXT: Record<'up' | 'down' | 'same', string> = {
  up: '升级',
  down: '降级',
  same: '当前'
}

/** 只到日：2026-08-14 */
function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function matches(option: VersionOption, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle)
}

export default function VersionPicker({
  profile,
  input,
  current = null,
  onPick,
  onCancel,
  compact = false
}: VersionPickerProps): ReactElement {
  const [list, setList] = useState<VersionList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [nonce, setNonce] = useState(0)

  const searchRef = useRef<HTMLInputElement | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)

  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const listId = `vpick-list-${uid}`
  const optionId = (index: number): string => `vpick-opt-${uid}-${index}`

  const trimmed = input.trim()
  const cur = current ?? null

  /* ---------------- 拉数据 ---------------- */

  useEffect(() => {
    let alive = true
    setActive(0)
    setError(null)

    if (!trimmed) {
      setList(null)
      setLoading(false)
      setError('请输入包名或 GitHub 链接')
      return () => {
        alive = false
      }
    }

    setLoading(true)
    void (async () => {
      try {
        const result = await api().versions(trimmed, { profile, current: cur })
        if (!alive) return
        setList(result)
      } catch (err) {
        if (!alive) return
        setList(null)
        setError(toMessage(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [trimmed, profile, cur, nonce])

  /* 输入换了就清掉搜索词 */
  useEffect(() => {
    setQuery('')
  }, [trimmed])

  /* 搜索词变了 → 高亮回到第一项 */
  useEffect(() => {
    setActive(0)
  }, [query])

  /* 搜索框自动聚焦（刚挂载 / 换了包） */
  useEffect(() => {
    searchRef.current?.focus()
  }, [trimmed])

  /* ---------------- 过滤 + 分组 ---------------- */

  const filtered = useMemo<VersionOption[]>(() => {
    const options = list?.options ?? []
    if (!query) return options
    return options.filter((o) => matches(o, query))
  }, [list, query])

  /** groups 的顺序 = 渲染顺序；每行带一个「全列表下标」，键盘导航用的就是它 */
  const groups = useMemo(() => {
    let cursor = 0
    const out: { title: string; rows: { option: VersionOption; index: number }[] }[] = []
    for (const group of GROUPS) {
      const rows = filtered
        .filter((o) => group.kinds.includes(o.kind))
        .map((option) => ({ option, index: cursor++ }))
      if (rows.length > 0) out.push({ title: group.title, rows })
    }
    return out
  }, [filtered])

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])

  /* 列表变短时把高亮收回到有效范围 */
  useEffect(() => {
    setActive((i) => (i < flat.length ? i : 0))
  }, [flat.length])

  /* 高亮项滚进可视区 */
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active, flat.length])

  /* ---------------- 键盘 ---------------- */

  const move = useCallback(
    (delta: number) => {
      setActive((i) => {
        const n = flat.length
        if (n === 0) return 0
        const next = i + delta
        if (next < 0) return n - 1
        if (next >= n) return 0
        return next
      })
    },
    [flat.length]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
        return
      }
      if (e.key === 'Enter') {
        const row = flat[active]
        if (row) {
          e.preventDefault()
          onPick(row.option)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // 必须吃掉冒泡：App.tsx 上挂着全局 Esc 处理（关详情面板 / 关弹窗），
        // 只关版本面板的时候不能让整个详情面板跟着一起关。
        e.stopPropagation()
        onCancel?.()
      }
    },
    [active, flat, move, onCancel, onPick]
  )

  /* ---------------- 状态 ---------------- */

  const errorText = error ?? (list && !list.ok ? list.error : null)
  const activeRow = flat[active] ?? null
  const activeId = activeRow ? optionId(activeRow.index) : undefined

  const meta = list && list.ok ? [cur ? `当前 ${cur}` : null, list.latest ? `latest ${list.latest}` : null].filter(Boolean).join(' · ') : ''

  return (
    <div className={`vpick${compact ? ' vpick--compact' : ''}`} onKeyDown={handleKeyDown}>
      <div className="vpick__head">
        <input
          ref={searchRef}
          className="vpick__search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索版本 / 标签 / 分支"
          aria-label="搜索版本"
          aria-controls={listId}
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
        />
        {!compact && meta ? <span className="vpick__meta">{meta}</span> : null}
      </div>

      {loading ? (
        <div className="vpick__status vpick__status--loading" role="status">
          正在读取版本列表…
        </div>
      ) : errorText ? (
        <div className="vpick__status vpick__status--error" role="alert">
          <span className="vpick__error">{errorText}</span>
          <button type="button" className="vpick__retry" onClick={() => setNonce((n) => n + 1)}>
            重试
          </button>
        </div>
      ) : !list || list.options.length === 0 ? (
        <div className="vpick__status" role="status">
          这个包没有可选版本
        </div>
      ) : flat.length === 0 ? (
        <div className="vpick__status" role="status">
          没有匹配的版本
        </div>
      ) : (
        <div
          className="vpick__list"
          id={listId}
          role="listbox"
          tabIndex={0}
          aria-label="可安装的版本、标签与分支"
          aria-activedescendant={activeId}
        >
          {groups.map((group) => (
            <div className="vpick__group" key={group.title}>
              <div className="vpick__group-title">{group.title}</div>
              {group.rows.map((row) => {
                const date = formatDate(row.option.publishedAt)
                const dir = row.option.direction
                return (
                  <div
                    key={row.index}
                    id={optionId(row.index)}
                    role="option"
                    aria-selected={row.index === active}
                    className={`vpick__row${row.index === active ? ' vpick__row--active' : ''}${
                      dir === 'same' ? ' vpick__row--muted' : ''
                    }`}
                    onMouseEnter={() => setActive(row.index)}
                    onClick={() => onPick(row.option)}
                    ref={(el) => {
                      if (row.index === active) activeRef.current = el
                    }}
                  >
                    <span className="vpick__label">{row.option.label}</span>
                    <span className="vpick__spacer" aria-hidden="true" />
                    {date ? <span className="vpick__date">{date}</span> : null}
                    {dir ? <span className={`vpick__badge vpick__badge--${dir}`}>{DIRECTION_TEXT[dir]}</span> : null}
                  </div>
                )
              })}
            </div>
          ))}

          {list.truncated ? (
            <div className="vpick__truncated">只显示前 {list.options.length} 个，用搜索框过滤</div>
          ) : null}
        </div>
      )}

      {!compact && list && list.warnings.length > 0 ? (
        <div className="vpick__warn">
          {list.warnings.map((w) => (
            <span className="vpick__warn-line" key={w}>
              {w}
            </span>
          ))}
        </div>
      ) : null}

      <div className="vpick__preview">
        <span className="vpick__preview-label">将执行</span>
        {activeRow ? (
          <code className="vpick__preview-cmd">pnpm add {activeRow.option.spec}</code>
        ) : (
          <span className="vpick__preview-empty">选一个版本后这里会显示要执行的命令</span>
        )}
        {!compact ? <span className="vpick__hint">↑↓ 选择 · Enter 确认 · Esc 取消</span> : null}
      </div>
    </div>
  )
}
