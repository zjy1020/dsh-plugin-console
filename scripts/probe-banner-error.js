/*
 * 验两件事（对应 Master 刚发的两张图）：
 *   1) 顶部警示条不再被悬浮侧栏盖住 —— 量它的 x 与侧栏右边缘
 *   2) 安装失败时，toast 里先给人话、再给压缩过的原文，且同一段不重复
 *
 * 第二件靠真装一个不存在的包来触发（registry 上必然 404），
 * 装完 profile 不会有任何变化，不影响用户状态。
 */
;(async () => {
  const out = { pass: false, fail: [], facts: {} }
  const d = window.dsh
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /* ---------- 1. 警示条位置 ---------- */
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const sb = document.querySelector('.sb')
  const warn = document.querySelector('.app__warn')
  const fatal = document.querySelector('.app__fatal')
  const banner = warn || fatal
  out.facts.sidebar = rectOf(sb)
  out.facts.banner = rectOf(banner)
  out.facts.bannerClass = banner ? banner.className : null
  out.facts.bannerRadius = banner ? getComputedStyle(banner).borderRadius : null
  out.facts.bannerMarginLeft = banner ? getComputedStyle(banner).marginLeft : null
  if (!banner) {
    out.facts.bannerNote = '这台机器当前没有警示条（环境齐 + 没有 warning），位置那条跳过'
  } else if (sb) {
    const sbRight = Math.round(sb.getBoundingClientRect().right)
    out.facts.sidebarRight = sbRight
    out.facts.bannerClearsSidebar = out.facts.banner.x >= sbRight
    if (!out.facts.bannerClearsSidebar) {
      out.fail.push(`警示条 x=${out.facts.banner.x} 仍压在侧栏（右边缘 ${sbRight}）下面`)
    }
  }

  /* ---------- 2. 安装失败的文案 ---------- */
  const before = (await d.plugins('desktop')) || []
  const t0 = Date.now()
  const res = await d.runOp({
    kind: 'install',
    profile: 'desktop',
    spec: 'dsh-definitely-not-a-real-package-xyz'
  })
  out.facts.install = {
    ok: res?.ok ?? null,
    ms: Date.now() - t0,
    message: res?.message ?? null,
    messageLen: (res?.message ?? '').length
  }
  const after = (await d.plugins('desktop')) || []
  out.facts.countBefore = before.length
  out.facts.countAfter = after.length
  if (after.length !== before.length) out.fail.push('装一个不存在的包居然改变了插件数量')

  const msg = res?.message ?? ''
  const zhFirst = /registry 上没有「/.test(msg)
  out.facts.hasChineseExplain = zhFirst
  if (!zhFirst) out.fail.push('失败文案里没有中文解释（应该以「registry 上没有…」开头）')
  /* 同一段 ERR_PNPM_FETCH_404 原文不该出现两次 */
  const dupes = (msg.match(/ERR_PNPM_FETCH_404/g) || []).length
  out.facts.errCodeOccurrences = dupes
  if (dupes > 1) out.fail.push(`ERR_PNPM_FETCH_404 在文案里出现了 ${dupes} 次（应该只留一次原文）`)
  if (/This error happened while installing/i.test(msg)) {
    out.fail.push('文案里还留着 pnpm 的 "This error happened while…" 上下文行')
  }

  /* ---------- 3. toast 里看到的是什么 ---------- */
  await sleep(400)
  const toasts = Array.from(document.querySelectorAll('.toast')).map((t) => ({
    cls: t.className,
    title: t.querySelector('.toast__title')?.textContent ?? '',
    detail: t.querySelector('.toast__detail')?.textContent ?? ''
  }))
  out.facts.toasts = toasts
  const errToast = toasts.find((t) => t.cls.includes('toast--error'))
  if (!errToast) out.fail.push('没看到错误 toast')
  else if (!/registry 上没有/.test(errToast.detail)) {
    out.fail.push('错误 toast 的正文里没有中文解释')
  }

  out.pass = out.fail.length === 0
  return out
})()
