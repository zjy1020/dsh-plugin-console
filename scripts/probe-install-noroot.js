/* 在「只有 .dsh、没有安装根」的状态下走一遍**真安装**，证明：
 *   ① 安装根为空时不再走官方通道（officialAvailable(installRoot) === false）
 *   ② 退化路径 runPnpm 的参数顺序已修好（以前是 node --reporter=... pnpm.cjs → exit 9）
 *   ③ 真能从 registry 下包、写进 node_modules、进 bundles
 *   ④ 回滚回原版本
 *
 * 用 dsh-pet 钉一个旧版本（0.3.8）再装回 0.4.0 —— 这个包本来就装着，
 * 降级→还原的净效果是「用户状态不变」，比装一个全新包更安全。
 */
;(async () => {
  const d = window.dsh
  const out = { pass: false, fail: [], facts: {} }
  const NAME = 'dsh-pet'
  const DOWN = '0.3.8'
  const UP = '0.4.0'

  const info = await d.runtimeInfo()
  out.facts.installRoot = info.installRoot
  if (info.installRoot) out.fail.push('安装根还在，实验前提不成立')

  const before = await d.plugins('desktop')
  const orig = before.find((p) => p.name === NAME)
  out.facts.originalVersion = orig ? orig.version : null
  out.facts.countBefore = before.length
  if (!orig) return JSON.stringify({ pass: false, fail: [`${NAME} 本来没装，本脚本的前提不成立`] }, null, 2)

  /* ① 降级：走 runPnpm 退化路径 */
  const t0 = Date.now()
  try {
    const res = await d.runOp({ kind: 'install', profile: 'desktop', spec: NAME, version: DOWN })
    out.facts.downgrade = { ok: res.ok, message: res.message, ms: Date.now() - t0 }
    if (!res.ok) out.fail.push(`降级安装失败：${res.message}`)
  } catch (e) {
    out.fail.push(`降级抛异常：${String(e)}`)
  }

  const mid = await d.plugins('desktop')
  const midPet = mid.find((p) => p.name === NAME)
  out.facts.versionAfterDowngrade = midPet ? midPet.version : null
  if (!midPet) {
    out.fail.push('降级后插件从列表里消失了')
  } else if (midPet.version !== DOWN) {
    out.fail.push(`降级后版本是 ${midPet.version}，期望 ${DOWN}`)
  }

  /* ② 装回原版本 */
  const t1 = Date.now()
  try {
    const res = await d.runOp({ kind: 'install', profile: 'desktop', spec: NAME, version: UP })
    out.facts.restore = { ok: res.ok, message: res.message, ms: Date.now() - t1 }
    if (!res.ok) out.fail.push(`还原安装失败：${res.message}`)
  } catch (e) {
    out.fail.push(`还原抛异常：${String(e)}`)
  }

  const after = await d.plugins('desktop')
  const endPet = after.find((p) => p.name === NAME)
  out.facts.versionFinal = endPet ? endPet.version : null
  out.facts.countAfter = after.length
  if (!endPet) out.fail.push('还原后插件不见了')
  else if (endPet.version !== (orig.version ?? UP)) {
    out.fail.push(`还原后版本是 ${endPet.version}，期望 ${orig.version}`)
  }
  if (after.length !== before.length) out.fail.push(`插件数量变了：${before.length} → ${after.length}`)

  out.pass = out.fail.length === 0
  return JSON.stringify(out, null, 2)
})()
