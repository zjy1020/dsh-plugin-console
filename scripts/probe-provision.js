/* 验「补全前置」这条链路：
 *   A. window.dsh 上三个方法都在
 *   B. runtimeSource() 报出可用 + 分块体积 + upToDate
 *   C. 界面上引导卡 / InstallPanel 里那块 RuntimeProvision 的渲染是否正确
 *      （本机环境是齐的，所以两块都不该出现 —— 这一档要如实报出来，不许假装验过）
 *
 * 注意：cdp-eval.mjs 把脚本当 Runtime.evaluate 的表达式求值，
 * 所以必须是 IIFE 表达式，不能写裸 return。
 */
;(async () => {
  const out = { pass: false, fail: [], detail: {} }
  const d = window.dsh
  if (!d) {
    out.fail.push('window.dsh 不存在')
    return out
  }

  // A. 三通道
  out.detail.channel = {
    runtimeSource: typeof d.runtimeSource === 'function',
    runtimeProvision: typeof d.runtimeProvision === 'function',
    onProvisionProgress: typeof d.onProvisionProgress === 'function'
  }
  for (const [k, v] of Object.entries(out.detail.channel)) {
    if (!v) out.fail.push(`缺通道 ${k}`)
  }

  // B. 源可用性
  try {
    const info = await d.runtimeSource()
    out.detail.source = {
      ok: info.ok,
      dir: info.dir,
      target: info.target,
      desktopVersion: info.desktopVersion,
      platform: info.platform,
      arch: info.arch,
      node: info.node,
      pnpm: info.pnpm,
      python: info.python,
      upToDate: info.upToDate,
      problem: info.problem,
      total: info.total,
      parts: info.parts
    }
    if (!info.ok) out.fail.push(`runtimeSource 报不可用：${info.problem}`)
    if (info.ok && !info.dir) out.fail.push('runtimeSource ok 但没有 dir')
    if (info.ok && (!info.parts || !info.parts.node || info.parts.node.bytes <= 0)) {
      out.fail.push('node 分块体积为 0，planCopy 可能没走通')
    }
    if (info.ok && (!info.parts || !info.parts.pnpm || info.parts.pnpm.bytes <= 0)) {
      out.fail.push('pnpm 分块体积为 0')
    }
    // 本机 dsh-runtimes 是齐的 → 必须报 upToDate，否则说明幂等判据坏了
    if (info.ok && info.upToDate !== true) out.fail.push('本机运行时是齐的，upToDate 应该是 true')
  } catch (e) {
    out.fail.push(`runtimeSource 抛错：${e && e.message ? e.message : String(e)}`)
  }

  // C. 界面：本机环境齐 → 引导卡与安装页那块都不该出现
  const envset = document.querySelector('.envset')
  const provisionInCard = document.querySelector('.envset .rtprov')
  const provisionInInstall = document.querySelector('.install .rtprov')
  const whyNodes = document.querySelectorAll('.rtprov__why')
  out.detail.ui = {
    envsetPresent: Boolean(envset),
    provisionInCard: Boolean(provisionInCard),
    provisionInInstall: Boolean(provisionInInstall),
    whyCount: whyNodes.length,
    whyTexts: Array.from(whyNodes).map((n) => n.textContent),
    appChildren: Array.from(document.querySelector('.app')?.children ?? []).map(
      (n) => `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')}`
    )
  }
  // 本机环境齐：引导卡不该出现（出现了说明判据又退回去了）
  if (envset) out.fail.push('本机环境是齐的，.envset 不该出现')

  // D. 真跑一次 provision：本机 upToDate 应当直接返回 copied:false（幂等）
  try {
    const t0 = performance.now()
    const res = await d.runtimeProvision()
    out.detail.provision = { ...res, wallMs: Math.round(performance.now() - t0) }
    if (!res.ok) out.fail.push(`幂等路径返回失败：${res.message}`)
    if (res.copied) out.fail.push('本机已是最新，不该真的拷（copied 应为 false）')
  } catch (e) {
    out.fail.push(`runtimeProvision 抛错：${e && e.message ? e.message : String(e)}`)
  }

  out.pass = out.fail.length === 0
  return out
})()
