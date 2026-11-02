/**
 * EmptyState —— 统一的空态 / 错误态 / 引导态。
 * 所有「没东西」的地方都走这里，保证文案与排版一致。
 */

import type { ReactNode } from 'react'

export type EmptyTone = 'neutral' | 'warn' | 'danger'

export interface EmptyStateProps {
  title: string
  hint?: ReactNode
  /** 顶部的小图标（emoji / svg 都行） */
  icon?: ReactNode
  tone?: EmptyTone
  action?: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean }
  secondaryAction?: { label: string; onClick: () => void }
  /** 附注：小字细节，如错误原文 */
  footnote?: string
  compact?: boolean
}

export function EmptyState({
  title,
  hint,
  icon,
  tone = 'neutral',
  action,
  secondaryAction,
  footnote,
  compact = false
}: EmptyStateProps) {
  return (
    <div className={`empty empty--${tone}${compact ? ' empty--compact' : ''}`} role="status">
      {icon ? (
        <div className="empty__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className="empty__title">{title}</p>
      {hint ? <p className="empty__hint">{hint}</p> : null}
      {action || secondaryAction ? (
        <div className="empty__actions">
          {action ? (
            <button
              type="button"
              className={`btn${action.primary ? ' btn--primary' : ''}`}
              onClick={action.onClick}
              disabled={action.disabled}
            >
              {action.label}
            </button>
          ) : null}
          {secondaryAction ? (
            <button type="button" className="btn btn--ghost" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {footnote ? <p className="empty__foot mono selectable">{footnote}</p> : null}
    </div>
  )
}