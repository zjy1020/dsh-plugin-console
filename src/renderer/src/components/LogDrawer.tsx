/**
 * LogDrawer —— 运行日志页（主区 view）。
 *
 * 数据：onOpLog → state.logs（store 里已按 opId 折叠 \r 进度行）；onOpDone → state.lastResult
 * 动作：cancelOp(opId) / restartDsh() / clearLogs() / setView('plugins')
 *
 * 这一版把它做成了纯文本流（用户原话：「日志只是显示信息的而不是这样的」）：
 *   1. 头顶的「转圈 + 操作名」和「成功 / 失败 (code N)」徽章没有了 ——
 *      运行状态与结论变成流里的 `[操作] … 开始` / `[完成] …` / `[失败] …` 行；
 *   2. 通道不再是小标签，只是正文前的一段纯文本前缀 [sys] / [out] / [err]；
 *   3. 结果卡片（边框 + 底色 + 徽章列表）整块没有了，依赖变化压成缩进一档的文本行；
 *   4. 「重启 DSH」是唯一保留下来的控件形状 —— 它是动作不是装饰，还会中断当前会话，
 *      必须看得见、点得着，所以做成无边框的文字按钮（复用 base.css 的 .link-btn），
 *      功能一点没少：仍然调 actions.restartDsh()。
 *
 * 2026-11：从「底部抽屉」改成主区 view（用户原话：「日志为什么点开之后还是在已安装，
 * 而不是显示日志呢」）。open 守卫删了 —— 由 App.tsx 的 app__view 按 view === 'logs'
 * 条件渲染；右上角 ✕ 变成「回到已安装」。
 *
 * 观看相关的覆盖全在 styles/logdrawer.css，那里有完整的特异性账本
 * （为什么新建文件而不是改 components.css、每条选择器凭什么赢）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatClock } from '../lib/format'
import { useConsole } from '../lib/store'
import '../styles/logdrawer.css'

/**
 * 状态行：`[sys]` 前缀 + 与日志完全相同的行结构。
 *
 * 为什么做成一个小组件而不是再写三遍：状态与日志必须是同一条流 —— 一旦结构被复制三份，
 * 下次改行结构就会漏掉其中一处，抽屉里就会出现两种行距。
 * 时间是调用方给的（op 用开始时间、result 用结束时间），语义不比以前弱。
 */
function NoteLine({ at, fail, children }: { at: number; fail?: boolean; children: ReactNode }) {
  return (
    <div className={`logline logline--system logdrawer__note${fail ? ' logdrawer__note--fail' : ''}`}>
      <span className="logline__at">{formatClock(at)}</span>
      <span className="logline__chan">[sys]</span>
      <span className="logline__text">{children}</span>
    </div>
  )
}

export function LogDrawer() {
  const { state, actions } = useConsole()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const logs = state.logs
  const op = state.op
  const result = state.lastResult

  /* 跟到最新：只有用户停在底部时才自动滚。
   *
   * 依赖里为什么多了 op?.startedAt 与 result?.endedAt：
   * 状态行现在住在滚动区**里面**的流末尾（以前结果卡片是固定高度的块，永远露在外面）。
   * 一次操作结束时若后面没有新日志跟进，这个 effect 不重跑，「[完成] …」就停在视口下面 ——
   * 所以把这两次状态变化也算作「有内容进流」。下面的 onScroll 判断一个字没动：
   * 那是踩过坑才有的（24px 那个阈值就是坑本身）。 */
  useEffect(() => {
    if (!autoScroll) return
    const el = boxRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [autoScroll, logs.length, logs[logs.length - 1]?.text, op?.startedAt, result?.endedAt])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setAutoScroll(distance < 24)
  }

  const canCancel = op !== null && op.opId !== null

  /* 结论行的正文。为什么优先用主进程的 message：它自带包名
   * （「已更新 3 个包：dsh-context、…」），我们自己拼一句「N 个包有变化」会把它丢掉；
   * 自拼的那句只在 message 为空时兜底。失败时按「code N · 原因」拼。 */
  let resultText = ''
  if (result) {
    if (result.ok) {
      resultText =
        result.message || (result.changes.length > 0 ? `${result.changes.length} 个包有变化` : '没有依赖变化')
    } else {
      const bits: string[] = []
      if (result.code !== null) bits.push(`code ${result.code}`)
      if (result.message) bits.push(result.message)
      resultText = bits.join(' · ')
    }
  }

  return (
    <section className="logdrawer" aria-label="操作日志">
      <div className="logdrawer__head">
        {/* 操作名与成功/失败徽章从这里撤走了：日志区不再兼职状态灯 */}
        <span className="logdrawer__title">操作日志</span>

        <span className="logdrawer__actions">
          {!autoScroll ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                setAutoScroll(true)
                const el = boxRef.current
                if (el) el.scrollTop = el.scrollHeight
              }}
              title="回到最新并恢复自动滚动"
            >
              ↓ 回到最新
            </button>
          ) : null}
          {canCancel ? (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => void actions.cancelOp()}
              title="中断当前 pnpm 进程"
            >
              取消
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={actions.clearLogs}
            disabled={logs.length === 0}
          >
            清空
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => actions.setView('plugins')}
            aria-label="回到已安装"
            title="回到已安装 (Esc)"
          >
            ✕
          </button>
        </span>
      </div>

      <div className="logdrawer__box" ref={boxRef} onScroll={onScroll} tabIndex={0} role="log" aria-live="polite">
        {/* 空态：只有真的什么都没有时才出现 —— 有状态行在流里的时候再显示这句话会自相矛盾 */}
        {logs.length === 0 && !op && !result ? (
          <div className="logdrawer__empty">还没有操作日志。安装 / 更新 / 卸载时 pnpm 的输出会实时流到这里。</div>
        ) : (
          <>
            {logs.map((line) => (
              <div
                key={line.id}
                className={`logline logline--${line.channel}${line.progress ? ' logline--progress' : ''}`}
              >
                <span className="logline__at">{formatClock(line.at)}</span>
                <span className="logline__chan">
                  {line.channel === 'system' ? '[sys]' : line.channel === 'stderr' ? '[err]' : '[out]'}
                </span>
                <span className="logline__text">{line.text === '' ? '\u00a0' : line.text}</span>
              </div>
            ))}

            {/* 运行中：原来是标题旁的转圈 + 操作名。这一行随操作结束消失
                （reducer 在 opDone 时把 op 置 null），所以不会被误读成历史记录。 */}
            {op ? (
              <NoteLine at={op.startedAt}>
                [操作] {op.label} 开始
              </NoteLine>
            ) : null}

            {/* 结论：原来是带边框的结果卡片 + 徽章。 */}
            {result ? (
              <>
                <NoteLine at={result.endedAt} fail={!result.ok}>
                  {result.ok ? '[完成]' : '[失败]'} {result.kind}
                  {resultText ? ` · ${resultText}` : ''}
                </NoteLine>

                {/* 依赖变化：原先是卡片里一排带底色的小徽章。
                    padEnd 是为了让等宽字体下 action 那一列对齐（最长的 action 是 9 个字符）。 */}
                {result.changes.map((c) => (
                  <div className="logdrawer__change" key={`${c.action}:${c.name}`}>
                    {`${c.action.padEnd(9)}  ${c.name}  ${c.from ?? '—'} → ${c.to ?? '—'}`}
                  </div>
                ))}

                {result.restartRequired ? (
                  <NoteLine at={result.endedAt}>
                    [提示] 需要重启 DSH 才会加载新版本
                    <button
                      type="button"
                      className="link-btn logdrawer__restart-btn"
                      onClick={() => void actions.restartDsh()}
                      title="会中断当前 DSH 会话"
                    >
                      重启 DSH
                    </button>
                  </NoteLine>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
