/**
 * Toasts —— 右下角通知栈。3.5 秒自动消失，可手动关。
 *
 * 例外：**错误不自动消失**。
 * 右下角这一块宽度有限、正文还会折行，3.5 秒够看一句「保存失败」，不够看完一条安装失败的
 * 完整原因（用户反馈过「提示一闪就没了，只记得有个红色的东西」，说的就是这种）。
 * 关掉它的按钮本来就在，让用户自己决定什么时候看完。
 *
 * 数据：state.toasts（来自 actions.toast / 主进程 onToast 事件）
 */

import { useEffect } from 'react'
import type { ToastItem } from '../lib/store'
import { useConsole } from '../lib/store'

const AUTO_DISMISS_MS = 3500

function ToastRow({ item }: { item: ToastItem }) {
  const { actions } = useConsole()

  useEffect(() => {
    // 错误留着，等用户自己关：一条读不完的错误提示等于没提示
    if (item.level === 'error') return
    const t = window.setTimeout(() => actions.dismissToast(item.id), AUTO_DISMISS_MS)
    return () => window.clearTimeout(t)
  }, [actions, item.id, item.level])

  return (
    <div className={`toast toast--${item.level}`} role="status" aria-live="polite">
      <span className="toast__mark" aria-hidden="true">
        {item.level === 'success' ? '✓' : item.level === 'error' ? '✕' : item.level === 'warn' ? '▲' : 'ⓘ'}
      </span>
      <div className="toast__body">
        <div className="toast__title">{item.title}</div>
        {item.detail ? <div className="toast__detail">{item.detail}</div> : null}
      </div>
      <button
        type="button"
        className="icon-btn toast__close"
        onClick={() => actions.dismissToast(item.id)}
        aria-label="关闭通知"
        title="关闭"
      >
        ✕
      </button>
    </div>
  )
}

export function Toasts() {
  const { state } = useConsole()
  if (state.toasts.length === 0) return null

  return (
    <div className="toasts" aria-label="通知">
      {state.toasts.map((t) => (
        <ToastRow item={t} key={t.id} />
      ))}
    </div>
  )
}