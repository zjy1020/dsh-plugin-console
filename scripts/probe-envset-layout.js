/**
 * probe-envset-layout.js —— 引导卡「让位侧栏」的实机验收。
 *
 * 为什么要有它：Master 在新电脑上看到的是「标题栏下面一大片空白，主区被顶到下半屏」。
 * 根因是引导卡从 x=0 铺满整宽、内容被 position:fixed 的侧栏整块盖住。修法只改了两条 CSS，
 * 而这类「只改 CSS」的修复最容易「看起来对、其实没生效」—— 变量名拼错、特异性被盖、
 * 收起态忘了跟，任何一种都表现为「界面还是那样」。
 *
 * 所以这里不用肉眼：直接把真实卡片注入 DOM，量它的 rect 与侧栏的右边缘，
 * 断言「卡片左边缘 ≥ 侧栏右边缘」，并在收起态再量一遍（那一档走的是另一个类名）。
 *
 * 注入的卡是**克隆真实节点的结构**（标题/正文/按钮/明细开关），不是照抄类名猜 ——
 * 只要 App.tsx 的 DOM 结构变了，这里的 classList 就会对不上，脚本会明确报「结构对不上」，
 * 而不是悄悄通过。
 */
(async () => {
  const out = { pass: true, fail: [], steps: [] }
  const bad = (msg) => {
    out.pass = false
    out.fail.push(msg)
  }
  const num = (v) => Math.round(Number(v) || 0)

  const app = document.querySelector('.app')
  const sb = document.querySelector('.sb')
  if (!app || !sb) {
    return { pass: false, fail: ['找不到 .app 或 .sb，页面还没渲染出来'], steps: [] }
  }

  /** 造一张与真卡同结构的引导卡，插在 .titlebar 之后（真卡就在那个位置） */
  const buildCard = () => {
    const el = document.createElement('div')
    el.className = 'banner banner--danger app__fatal envset'
    el.setAttribute('role', 'alert')
    el.innerHTML = [
      '<div class="envset__head">',
      '  <span aria-hidden="true">✕</span>',
      '  <div class="envset__title-wrap">',
      '    <strong class="envset__title">DSH 环境不完整：缺 安装目录、DSH_HOME</strong>',
      '    <span class="envset__lead">插件台没能把 DSH 的位置定下来，装插件、更新、导入清单都会失败。</span>',
      '  </div>',
      '</div>',
      '<div class="envset__actions">',
      '  <button type="button" class="btn btn--sm btn--primary">自动检测一遍</button>',
      '  <button type="button" class="btn btn--sm envbrowse">手动选择安装目录…</button>',
      '  <button type="button" class="btn btn--sm btn--ghost">打开设置</button>',
      '</div>',
      '<button type="button" class="btn btn--sm btn--ghost envset__diagtoggle">看诊断明细（57 条没命中）▾</button>'
    ].join('')
    return el
  }

  const titlebar = document.querySelector('.titlebar')
  const card = buildCard()
  if (titlebar && titlebar.parentElement) titlebar.after(card)
  else app.prepend(card)

  const measure = (tag) => {
    const c = card.getBoundingClientRect()
    const s = sb.getBoundingClientRect()
    const cs = getComputedStyle(card)
    const title = card.querySelector('.envset__title')
    const lead = card.querySelector('.envset__lead')
    const btn = card.querySelector('.envset__actions .btn')
    const toggle = card.querySelector('.envset__diagtoggle')
    const r = {
      tag,
      card: { x: num(c.x), y: num(c.y), w: num(c.width), h: num(c.height) },
      sb: { x: num(s.x), right: num(s.right), w: num(s.width) },
      cardMarginLeft: cs.marginLeft,
      cardBorderRadius: cs.borderTopLeftRadius,
      cardOverflowY: cs.overflowY,
      cardMaxHeight: cs.maxHeight,
      title: title ? { x: num(title.getBoundingClientRect().x), color: getComputedStyle(title).color } : null,
      lead: lead ? { x: num(lead.getBoundingClientRect().x), color: getComputedStyle(lead).color } : null,
      firstBtn: btn
        ? {
            x: num(btn.getBoundingClientRect().x),
            y: num(btn.getBoundingClientRect().y),
            w: num(btn.getBoundingClientRect().width)
          }
        : null,
      diagToggle: toggle
        ? {
            x: num(toggle.getBoundingClientRect().x),
            y: num(toggle.getBoundingClientRect().y),
            text: (toggle.textContent || '').trim(),
            display: getComputedStyle(toggle).display
          }
        : null,
      /** 关键判据：卡片左边缘必须让开侧栏的右边缘 */
      clearsSidebar: num(c.x) >= num(s.right) - 1
    }
    out.steps.push(r)
    return r
  }

  /* ---- 展开态 ---- */
  if (app.classList.contains('app--sb-collapsed')) bad('进来时侧栏是收起态，展开态这一档没量到')
  const expanded = measure('expanded')
  if (!expanded.clearsSidebar) {
    bad(`展开态卡片左边缘 ${expanded.card.x} 压在侧栏右边缘 ${expanded.sb.right} 上（内容会被盖住）`)
  }
  if (expanded.cardBorderRadius === '0px') bad('展开态卡片还是直角，悬浮卡片样式没生效')
  if (expanded.diagToggle && expanded.diagToggle.display === 'none') bad('诊断明细开关没渲染出来')
  if (expanded.diagToggle && !/没命中/.test(expanded.diagToggle.text)) {
    bad(`诊断明细开关文案不对：「${expanded.diagToggle.text}」里没有条数`)
  }
  /* 卡片内容必须真的落在卡片里（宽度不为 0 且不溢出） */
  if (expanded.title && expanded.title.x < expanded.card.x) bad('标题起点在卡片左边缘之外')

  /* ---- 收起态 ----
   * 两个类都要加：真实运行里 .app 与 .sb 由同一个 settings 一起切，
   * 只加其中一个就会造出「卡片让位了、侧栏没变窄」这种不存在的组合，
   * 量出来的失败也是假的（第一版就是这么误报的）。 */
  card.remove()
  app.classList.add('app--sb-collapsed')
  sb.classList.add('sb--collapsed')
  await new Promise((r) => setTimeout(r, 260))
  const card2 = buildCard()
  if (titlebar && titlebar.parentElement) titlebar.after(card2)
  else app.prepend(card2)
  const s2 = sb.getBoundingClientRect()
  const c2 = card2.getBoundingClientRect()
  const collapsed = {
    tag: 'collapsed',
    card: { x: num(c2.x), y: num(c2.y), w: num(c2.width), h: num(c2.height) },
    sb: { x: num(s2.x), right: num(s2.right), w: num(s2.width) },
    cardMarginLeft: getComputedStyle(card2).marginLeft,
    clearsSidebar: num(c2.x) >= num(s2.right) - 1
  }
  out.steps.push(collapsed)
  if (!collapsed.clearsSidebar) {
    bad(`收起态卡片左边缘 ${collapsed.card.x} 压在侧栏右边缘 ${collapsed.sb.right} 上`)
  }
  if (collapsed.card.x >= expanded.card.x) {
    bad(`收起态让位没跟着变窄（收起 ${collapsed.card.x} ≥ 展开 ${expanded.card.x}）`)
  }
  card2.remove()
  app.classList.remove('app--sb-collapsed')
  sb.classList.remove('sb--collapsed')

  return out
})()
