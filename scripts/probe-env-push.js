/**
 * 验证「主进程推 → 渲染层自己好起来」这半条链。
 *
 * 主进程那半条已经有日志证据（diag.log 的 `[env-push]`）。这半条要证的是：
 * 渲染层真的订阅了 EV.envChanged，收到之后会
 *   ① 把环境灌进 store（引导卡自己消失）
 *   ② 弹一句「已自动找到 DSH」
 *   ③ 整轮重拉（profile / 插件列表跟着回来）
 *
 * 触发方式：settingsSet 里带 installRoot —— 主进程会在 setImmediate 里重探并 broadcast。
 * 这条路径与「异步探测命中」走的是同一个 broadcast，所以验它等于验那条。
 *
 * 只读 + 一次无害的写（把 installRoot 写成它本来就已经是的那个值）。
 */

;(async () => {
  const api = window.dsh
  const out = { fail: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const before = await api.runtimeInfo()
  const target = before.installRoot
  if (!target) {
    out.fail.push('前置条件不成立：这台机器当前没有安装根，无法做「重设同一个值」的触发')
    out.pass = false
    return out
  }
  out.target = target

  /* 记录推送前的界面状态 */
  out.before = {
    envset: Boolean(document.querySelector('.envset')),
    toasts: [...document.querySelectorAll('.toast')].length,
    pluginRows: document.querySelectorAll('.plist__row, .prow').length
  }

  /* 触发：写回同一个值 → 主进程重探 → broadcast(EV.envChanged) */
  await api.settingsSet({ installRoot: target })

  /* 等渲染层处理（reloadAll 里有一次 settingsGet + runtimeInfo + profiles + plugins） */
  await sleep(2500)

  const toasts = [...document.querySelectorAll('.toast')].map((t) => ({
    title: t.querySelector('.toast__title')?.textContent?.trim() ?? null,
    detail: t.querySelector('.toast__detail')?.textContent?.trim() ?? null,
    level: t.className
  }))
  out.after = {
    envset: Boolean(document.querySelector('.envset')),
    toasts,
    pluginRows: document.querySelectorAll('.plist__row, .prow').length,
    activeProfile: document.querySelector('.sb__profile-name')?.textContent?.trim() ?? null
  }

  const sawFound = toasts.some((t) => (t.title ?? '').includes('已自动找到 DSH'))
  if (!sawFound) out.fail.push('没看到「已自动找到 DSH」提示 —— 渲染层可能没收到 EV.envChanged')
  if (out.after.envset) out.fail.push('推送之后引导卡还在')
  if (out.after.pluginRows === 0) out.fail.push('推送之后插件列表仍是空的（reloadAll 没跑成）')

  out.pass = out.fail.length === 0
  return out
})()
