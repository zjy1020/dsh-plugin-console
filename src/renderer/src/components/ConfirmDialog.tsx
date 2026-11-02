/**
 * ConfirmDialog —— 通用确认弹窗（卸载两步确认的第二关走 requireText）。
 *
 * 数据：state.confirm（actions.askConfirm / actions.requestConfirm 挂上来的待确认请求）
 * 结果：resolveConfirm(true) 执行 / cancelConfirm() 什么都不做
 *
 * 正文三件套：message（发生了什么）→ kv（会改哪些文件、装到哪）→ banner/notes（例外与后续）。
 * 原则：让用户看完就能判断，不写「确认执行此操作吗」这种废话。
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import { useConsole } from '../lib/store'

export function ConfirmDialog() {
  const { state, actions } = useConsole()
  const req = state.confirm
  const busy = state.confirmBusy
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    setText('')
    if (!req) return
    const t = window.setTimeout(() => {
      // 要手打文字的（卸载 / 更新全部）先聚焦输入框，否则聚焦取消按钮，
      // 免得回车误触一次破坏性操作
      if (req.requireText) inputRef.current?.focus()
      else cancelRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [req])

  // busy 期间弹窗还在原地（onConfirm 起了头才关），焦点不能跑出弹窗
  useEffect(() => {
    if (busy) confirmRef.current?.focus()
  }, [busy])

  if (!req) return null

  const needText = typeof req.requireText === 'string' && req.requireText.length > 0
  const matched = !needText || text.trim() === req.requireText
  const banner = req.banner ?? null
  const kv = req.kv ?? []
  const notes = req.notes ?? []

  return (
    <div
      className="overlay overlay--confirm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) actions.cancelConfirm()
      }}
    >
      <div
        className={`dialog dialog--confirm${req.danger ? ' dialog--danger' : ''}${
          busy ? ' dialog--busy' : ''
        }`}
        role="alertdialog"
        aria-modal="true"
        aria-label={req.title}
        aria-busy={busy}
      >
        <div className="dialog__head">
          <span className="dialog__title">{req.title}</span>
        </div>

        <div className="dialog__body">
          <p className="dialog__message selectable">{req.message}</p>

          {kv.length > 0 ? (
            <div className="kv dialog__kv">
              {kv.map((row, i) => (
                <Fragment key={i}>
                  <span className="kv__k">{row.key}</span>
                  <span className={`kv__v${row.mono ? ' mono' : ''} selectable`}>{row.value}</span>
                </Fragment>
              ))}
            </div>
          ) : null}

          {req.bullets && req.bullets.length > 0 ? (
            <ul className="dialog__bullets">
              {req.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : null}

          {banner ? (
            <div
              className={`banner banner--${
                banner.level === 'warn' ? 'warn' : banner.level === 'danger' ? 'danger' : 'info'
              } dialog__banner`}
              role="status"
            >
              <span aria-hidden="true">
                {banner.level === 'warn' ? '▲' : banner.level === 'danger' ? '✕' : 'ⓘ'}
              </span>
              <span>{banner.text}</span>
            </div>
          ) : null}

          {notes.length > 0 ? (
            <ul className="dialog__notes">
              {notes.map((n, i) => (
                <li key={i} className="dialog__note">
                  {n}
                </li>
              ))}
            </ul>
          ) : null}

          {needText ? (
            <label className="field">
              <span className="field__label">
                输入 <span className="mono selectable">{req.requireText}</span> 以确认
              </span>
              <input
                ref={inputRef}
                className="input input--mono"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matched && !busy) actions.resolveConfirm(true)
                }}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                placeholder={req.requireText ?? undefined}
              />
            </label>
          ) : null}
        </div>

        <div className="dialog__foot">
          <span className="dialog__foot-note muted">
            {busy ? '正在执行…' : needText ? '名字不匹配时按钮不可用。' : ''}
          </span>
          <div className="dialog__foot-actions">
            <button
              ref={cancelRef}
              type="button"
              className="btn btn--ghost"
              onClick={actions.cancelConfirm}
              disabled={busy}
            >
              {req.cancelLabel ?? '取消'}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={`btn ${req.danger ? 'btn--danger' : 'btn--primary'}${
                busy ? ' is-loading' : ''
              }`}
              onClick={() => actions.resolveConfirm(true)}
              disabled={!matched || busy}
              aria-busy={busy}
            >
              {busy ? <span className="spinner spinner--sm" /> : null}
              {req.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
