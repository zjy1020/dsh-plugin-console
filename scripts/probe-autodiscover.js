/**
 * 「新电脑自动匹配」的端到端验收 —— 不点任何按钮，看它能不能自己好起来。
 *
 * 模拟手法（与真·新电脑的差距写在下面）：
 *   1) 清掉 settings.installRoot / dshHome（用户从没填过）
 *   2) 把 desktop-install.txt 改名（那条提示文件不在）
 *   3) 把两个快捷方式改名（桌面 + 开始菜单）
 *   4) 用 DSH_HOME 指向一个不存在的目录启动（dsh-runtimes 无从展开）
 * 这样同步路由会全灭 → 界面出引导卡 → 只剩异步路由（注册表 / 进程 / 磁盘扫描）能救。
 *
 * 验收判据（全部自动，不需要人点）：
 *   A 首屏（第 1.5 秒）：环境应当是坏的（引导卡在）
 *   B 之后**不做任何操作**，轮询最多 30 秒：引导卡应当自己消失，installRoot 自己出现
 *   C 最终 node / pnpm 都解出来，能直接装插件
 *
 * 用法：node scripts\cdp-eval.mjs --file scripts\probe-autodiscover.js
 */

;(async () => {
  const api = window.dsh
  const out = { timeline: [], fail: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const snap = async (tag) => {
    const rt = await api.runtimeInfo()
    const card = document.querySelector('.envset')
    return {
      tag,
      at: Math.round(performance.now()),
      envset: Boolean(card),
      installRoot: rt.installRoot ?? null,
      installRootFrom: rt.installRootFrom ?? null,
      dshHome: rt.dshHome ?? null,
      nodeOk: Boolean(rt.nodePath),
      pnpmOk: Boolean(rt.pnpmPath)
    }
  }

  out.timeline.push(await snap('t0'))

  /* 不做任何操作，纯等 —— 这正是用户会做的事：打开软件，看着它 */
  let recoveredAt = null
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000)
    const s = await snap(`t+${i + 1}s`)
    /* 只在状态变化时记，避免 30 条一样的 */
    const prev = out.timeline[out.timeline.length - 1]
    if (
      !prev ||
      prev.envset !== s.envset ||
      prev.installRoot !== s.installRoot ||
      prev.nodeOk !== s.nodeOk ||
      prev.pnpmOk !== s.pnpmOk
    ) {
      out.timeline.push(s)
    }
    if (s.installRoot && !s.envset && s.nodeOk && s.pnpmOk) {
      recoveredAt = i + 1
      break
    }
  }

  out.recoveredAtSec = recoveredAt
  out.pass = recoveredAt !== null && out.fail.length === 0
  if (recoveredAt === null) {
    const last = await snap('final')
    out.final = last
    out.fail.push(
      `30 秒内没有自己恢复：installRoot=${last.installRoot ?? 'null'} envset=${last.envset} node=${last.nodeOk} pnpm=${last.pnpmOk}`
    )
  }
  return out
})()
