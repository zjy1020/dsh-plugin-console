/**
 * 「新电脑自动匹配」的第二版验收：**从界面刚挂载那一刻开始看**。
 *
 * 第一版（probe-autodiscover.js）失败的原因不是功能没做好，是探针连上去太晚 ——
 * 主进程在 2.5 秒时就已经靠注册表探到安装根并推送了，而探针 16 秒才连上，
 * 那时界面早就好了。所以这一版必须先等到 `.app` 挂载、立刻开测。
 *
 * 判据：
 *   A 挂载那一刻：环境是坏的（引导卡 `.envset` 在，或 installRoot 为空）
 *   B 之后**不点任何按钮**：引导卡自己消失、installRoot 自己出现
 *   C 最终 node / pnpm 都能解出来
 *
 * 用法：node scripts\cdp-eval.mjs --file scripts\probe-autodiscover2.js
 */

;(async () => {
  const api = window.dsh
  const out = { timeline: [], fail: [], mountWaitMs: null }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /* 1) 等到 React 真的挂载（这是用户能看见界面的最早时刻） */
  const t0 = performance.now()
  for (let i = 0; i < 200; i += 1) {
    if (window.dsh && document.querySelector('.app')) break
    await sleep(50)
  }
  out.mountWaitMs = Math.round(performance.now() - t0)

  const snap = async (tag) => {
    let rt = null
    try {
      rt = await api.runtimeInfo()
    } catch {
      rt = null
    }
    return {
      tag,
      atMs: Math.round(performance.now()),
      envset: Boolean(document.querySelector('.envset')),
      installRoot: rt?.installRoot ?? null,
      installRootFrom: rt?.installRootFrom ?? null,
      nodeOk: Boolean(rt?.nodePath),
      pnpmOk: Boolean(rt?.pnpmPath)
    }
  }

  const first = await snap('mount')
  out.timeline.push(first)

  /* 2) 纯等，不点任何东西 */
  let recoveredAtMs = null
  for (let i = 0; i < 400; i += 1) {
    await sleep(100)
    const s = await snap(`+${i * 100}ms`)
    const prev = out.timeline[out.timeline.length - 1]
    if (prev.envset !== s.envset || prev.installRoot !== s.installRoot || prev.nodeOk !== s.nodeOk || prev.pnpmOk !== s.pnpmOk) {
      out.timeline.push(s)
    }
    if (s.installRoot && !s.envset && s.nodeOk && s.pnpmOk) {
      recoveredAtMs = s.atMs - first.atMs
      break
    }
  }

  out.recoveredAfterMs = recoveredAtMs
  /* A 档：挂载那一刻本来就好的机器（比如本机已经有 desktop-install.txt）不算失败，
   * 但要如实标出来 —— 否则会拿一个「本来就没坏」的样本冒充「自己修好了」。 */
  out.wasBrokenAtMount = !first.installRoot || first.envset
  if (!out.wasBrokenAtMount) {
    out.fail.push('挂载那一刻环境就是好的，这次采样没有覆盖到「自动修复」')
  }
  if (recoveredAtMs === null) {
    const last = await snap('final')
    out.final = last
    out.fail.push(`40 秒内没有自己恢复：installRoot=${last.installRoot ?? 'null'} envset=${last.envset}`)
  }
  out.pass = out.fail.length === 0
  return out
})()
