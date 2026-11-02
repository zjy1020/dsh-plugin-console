/*
 * 验「装指定版本 / 降级」这条路真的通 —— 走界面真实用的那种 spec 形态。
 *
 * 为什么要有这个探针：上一版探针传的是 `{kind:'install', spec:'dsh-pet', version:'0.3.8'}`，
 * 而 OpRequest 里根本没有 version 字段（版本是拼在 spec 里的），于是它测的是「传了个
 * 主进程不认识的字段」这种不存在的情形，报出来的「版本哑火」是假结论。
 * 真实链路是 VersionPicker → option.spec（`dsh-pet@0.3.8`）→ runOp({spec})，
 * 所以这里必须按 `name@version` 测。
 *
 * 只动 dsh-pet 一个包，且结束时把它还原成开始时那个版本。
 */
;(async () => {
  const out = { pass: false, fail: [], facts: {} }
  const d = window.dsh
  const NAME = 'dsh-pet'
  const PROFILE = 'desktop'
  const DOWN = '0.3.8'

  const list = async () => (await d.plugins(PROFILE)) || []
  const find = (arr, n) => arr.find((p) => p && p.name === n) || null

  const before = await list()
  const orig = find(before, NAME)
  if (!orig) {
    out.fail.push('这台机器上没装 dsh-pet，换一个已装的包再测')
    return out
  }
  out.facts.originalVersion = orig.version ?? null
  out.facts.countBefore = before.length
  if ((orig.version ?? '') === DOWN) {
    out.fail.push(`原版本已经是 ${DOWN}，没有降级空间`)
    return out
  }

  /* 1. 降级：spec 用 `name@version`，和界面上选版本时传的一模一样 */
  const spec = `${NAME}@${DOWN}`
  const t0 = Date.now()
  const res = await d.runOp({ kind: 'install', profile: PROFILE, spec })
  out.facts.downgrade = { spec, ok: res?.ok ?? false, message: res?.message ?? null, ms: Date.now() - t0 }

  const mid = await list()
  const midPet = find(mid, NAME)
  out.facts.versionAfterDowngrade = midPet ? (midPet.version ?? null) : null
  if (!res || res.ok !== true) out.fail.push(`降级操作失败：${res?.message ?? '无返回'}`)
  else if (!midPet) out.fail.push('降级后这个包从列表里消失了')
  else if (midPet.version !== DOWN) out.fail.push(`降级后版本是 ${midPet.version}，期望 ${DOWN}`)

  /* 2. 还原回原版本 */
  const restoreSpec = `${NAME}@${orig.version}`
  const t1 = Date.now()
  const back = await d.runOp({ kind: 'install', profile: PROFILE, spec: restoreSpec })
  out.facts.restore = { spec: restoreSpec, ok: back?.ok ?? false, message: back?.message ?? null, ms: Date.now() - t1 }

  const end = await list()
  const endPet = find(end, NAME)
  out.facts.versionFinal = endPet ? (endPet.version ?? null) : null
  out.facts.countAfter = end.length
  if (!back || back.ok !== true) out.fail.push(`还原失败：${back?.message ?? '无返回'}`)
  else if (endPet && endPet.version !== orig.version) out.fail.push(`还原后版本是 ${endPet.version}，期望 ${orig.version}`)

  out.pass = out.fail.length === 0
  return out
})()
