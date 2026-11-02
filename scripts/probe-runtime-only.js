/* 验收：一台**只有 .dsh、没有桌面端安装目录**的机器上，
 * 装插件这条路是否真的走得通。
 *
 * 这是 Master 那句「关 deepseekharness 安装目录什么事呢，不就是 c 盘的 .dsh 里吗」
 * 的机器化版本：安装根为空时，
 *   ① checkRuntime() 必须仍然 ok（判据只有 node/pnpm）
 *   ② 引导卡不许出现（envBroken 只看 node/pnpm）
 *   ③ 安装页不许被「还没准备好」挡住（profile 在 .dsh 下，照常列得出来）
 *   ④ 真跑一次安装，必须能装上（这是唯一能证明「能用」的证据）
 *
 * 只读 + 一次可回滚的安装（装 dsh-pet，测完立刻卸掉）。
 */
;(async () => {
  const d = window.dsh
  const out = { pass: false, fail: [], facts: {} }

  const q = (sel) => document.querySelector(sel)
  const txt = (el) => (el ? (el.textContent || '').trim() : null)

  /* ---------- ① 运行时判据 ---------- */
  const info = await d.runtimeInfo()
  out.facts.installRoot = info.installRoot
  out.facts.installRootFrom = info.installRootFrom
  out.facts.dshHome = info.dshHome
  out.facts.dshHomeFrom = info.dshHomeFrom
  out.facts.nodePath = info.nodePath
  out.facts.pnpmPath = info.pnpmPath
  out.facts.nodeVersion = info.nodeVersion
  out.facts.pnpmVersion = info.pnpmVersion
  out.facts.warnings = info.warnings

  if (info.installRoot) {
    out.fail.push(`安装根竟然还在（${info.installRoot}）—— 本次实验的前提不成立，结果不可信`)
  }
  if (!info.nodePath) out.fail.push('没找到 node —— 装插件确实会失败，这条是真缺口')
  if (!info.pnpmPath) out.fail.push('没找到 pnpm —— 装插件确实会失败，这条是真缺口')

  /* ---------- ② 引导卡不许出现 ---------- */
  await new Promise((r) => setTimeout(r, 600))
  out.facts.envsetPresent = Boolean(q('.app > .envset'))
  out.facts.appChildren = Array.from(q('.app')?.children ?? []).map(
    (el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).join('.')}`
  )
  if (out.facts.envsetPresent) {
    out.fail.push('安装根为空，引导卡却弹出来了 —— 等于拿一个不影响装插件的字段把整个界面拦住')
  }

  /* ---------- ③ profile 与安装页 ---------- */
  const profiles = await d.profiles()
  out.facts.profiles = profiles.map((p) => p.name)
  const desktop = profiles.find((p) => p.name === 'desktop') ?? profiles[0]
  if (!desktop) out.fail.push('一个 profile 都没有 —— 这台机器本来就装不了插件，实验无意义')

  /* 侧栏上「已安装」应能列出插件；空态「还没准备好」不许出现 */
  const blocked = txt(q('.empty__title'))
  out.facts.emptyTitle = blocked
  if (blocked && blocked.includes('还没准备好')) {
    out.fail.push('安装页被「还没准备好，装不了」挡住了 —— 但 node/pnpm 都在')
  }

  /* ---------- ④ 真跑一次安装 ---------- */
  if (desktop && info.nodePath && info.pnpmPath) {
    const before = await d.plugins(desktop.name)
    out.facts.pluginCountBefore = before.length
    const has = before.some((p) => p.name === 'dsh-pet')
    if (has) {
      out.facts.installSkipped = 'dsh-pet 本来就装着，跳过（避免影响用户现有状态）'
    } else {
      const started = Date.now()
      try {
        const res = await d.runOp({ kind: 'install', profile: desktop.name, spec: 'dsh-pet', version: null })
        out.facts.install = { ok: res.ok, message: res.message, ms: Date.now() - started }
        if (!res.ok) {
          out.fail.push(`安装失败：${res.message}`)
        } else {
          const after = await d.plugins(desktop.name)
          out.facts.pluginCountAfter = after.length
          out.facts.dshPetInstalled = after.some((p) => p.name === 'dsh-pet')
          if (!out.facts.dshPetInstalled) out.fail.push('安装报成功，但插件列表里没有 dsh-pet')
          /* 立刻回滚，别把测试残留留在用户 profile 里 */
          try {
            const undo = await d.runOp({ kind: 'uninstall', profile: desktop.name, spec: 'dsh-pet', version: null })
            out.facts.rollback = { ok: undo.ok, message: undo.message }
            if (!undo.ok) out.fail.push(`回滚失败（用户 profile 里现在多了 dsh-pet）：${undo.message}`)
          } catch (e) {
            out.fail.push(`回滚抛异常（用户 profile 里现在多了 dsh-pet）：${String(e)}`)
          }
        }
      } catch (e) {
        out.fail.push(`安装抛异常：${String(e)}`)
      }
    }
  }

  out.pass = out.fail.length === 0
  return JSON.stringify(out, null, 2)
})()
