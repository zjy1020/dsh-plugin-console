/**
 * 验收「选完目录先校验再报」这条链（Master 第 4 条反馈）。
 *
 * 为什么不用真对话框测：pickDirectory 弹的是系统原生对话框，脚本点不动它。
 * 但它后面的那条链（settingsSet → 主进程重探 → envRedetect → pickedIsValid）
 * 才是真正决定「说不说找到了」的地方，这一段可以完整走一遍。
 *
 * 三档断言：
 *   A 设一个**不存在的**安装根 → 探测不能把它当安装根认下来
 *   B 设**真的**安装根 → 探测认它，且 node/pnpm 同时被解出来（证明重探补刀生效）
 *   C 收尾把 installRoot 还原成脚本开始时的值（绝不把测试值留给用户）
 *
 * 用法：node scripts\cdp-eval.mjs --file scripts\probe-pick-validate.js
 */

;(async () => {
  const api = window.dsh
  const out = { steps: [], fail: [] }
  const brief = (info) => ({
    installRoot: info?.installRoot ?? null,
    installRootFrom: info?.installRootFrom ?? null,
    nodeOk: Boolean(info?.nodePath),
    pnpmOk: Boolean(info?.pnpmPath)
  })

  const before = await api.settingsGet()
  const originalRoot = before.installRoot ?? ''

  // ---- A：假目录 ----
  await api.settingsSet({ installRoot: 'D:\\__definitely_not_dsh__' })
  const a = await api.envRedetect()
  out.steps.push({ case: 'A-bogus', ...brief(a) })
  if (a.installRoot === 'D:\\__definitely_not_dsh__') {
    out.fail.push('A: 假目录被当成安装根认下来了')
  }

  // ---- B：真目录 ----
  await api.settingsSet({ installRoot: 'D:\\Dowloads\\DeepSeekHarness' })
  const b = await api.envRedetect()
  out.steps.push({ case: 'B-real', ...brief(b) })
  if (b.installRoot !== 'D:\\Dowloads\\DeepSeekHarness') {
    out.fail.push(`B: 真目录没被认下来（拿到 ${b.installRoot ?? 'null'}）`)
  }
  if (!b.nodePath) out.fail.push('B: 认了目录但 nodePath 仍是 null —— 重探补刀没生效')
  if (!b.pnpmPath) out.fail.push('B: 认了目录但 pnpmPath 仍是 null —— 重探补刀没生效')

  // ---- C：还原 ----
  await api.settingsSet({ installRoot: originalRoot })
  const c = await api.envRedetect()
  out.steps.push({ case: 'C-restored', originalRoot, nowRoot: c.installRoot ?? null })

  out.pass = out.fail.length === 0
  return out
})()
