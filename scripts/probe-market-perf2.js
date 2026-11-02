/**
 * probe-market-perf2.js —— 量插件市场 tab 的首屏与滚动开销（parent 要的三个数）。
 *   1) 切到市场 tab → 首屏出卡片的时间（ms）+ DOM 节点基线/增量
 *   2) 连续往下滚：帧间隔（p50/p95/max）、每段可见卡片数（有没有空白）、自动续批是否工作
 *   3) 搜索/分类切换的响应时间、图标懒加载证据
 * 用法：CDP_PORT=9334 node scripts/cdp-eval.mjs --file scripts/probe-market-perf2.js
 */
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const nodes = () => document.getElementsByTagName('*').length
  const cards = () => document.querySelectorAll('.mkt__card').length
  const out = {}

  const longTasks = []
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(Math.round(e.duration))
    })
    po.observe({ entryTypes: ['longtask'] })
  } catch {}

  out.rafFires = await new Promise((resolve) => {
    let done = false
    requestAnimationFrame(() => {
      done = true
      resolve(true)
    })
    setTimeout(() => !done && resolve(false), 900)
  })

  // 基线：先停在别的 tab（没进过市场）
  if (!document.querySelector('.install__tab')) {
    byText('button', '安装插件')?.click()
    await nap(500)
  }
  byText('.install__tab', '智能输入')?.click()
  await nap(400)
  out.domBaseline = nodes()

  // 1) 切到市场：首屏时间
  const t0 = performance.now()
  byText('.install__tab', '插件市场')?.click()
  let firstCardMs = null
  for (let i = 0; i < 300; i++) {
    if (cards() > 0) {
      firstCardMs = Math.round(performance.now() - t0)
      break
    }
    await nap(10)
  }
  // 等 DOM 连续稳定（5 次取样不变）
  let last = -1
  let stable = 0
  const settleFrom = performance.now()
  while (performance.now() - settleFrom < 5000) {
    const c = nodes()
    if (c === last) {
      stable += 1
      if (stable >= 5) break
    } else stable = 0
    last = c
    await nap(40)
  }
  out.firstPaint = {
    firstCardMs,
    settleMs: Math.round(performance.now() - t0),
    domBaseline: out.domBaseline,
    domAfter: last,
    domDelta: last - out.domBaseline,
    cards: cards(),
    status: (document.querySelector('.mkt__status')?.innerText || '').replace(/\n+/g, ' | ').trim(),
    longTasks: { count: longTasks.length, totalMs: longTasks.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...longTasks), list: longTasks.slice(0, 10) }
  }

  // 图标懒加载证据（首屏只有可见卡片该拿真图标）
  const iconCount = (sel) => document.querySelectorAll(sel).length
  out.iconsAtTop = {
    cards: cards(),
    mono: iconCount('.mkt__card .mkt__icon--mono'),
    localPluginIcon: iconCount('.mkt__card [class*="picon"]'),
    remoteImg: iconCount('.mkt__card .mkt__icon--img'),
    lazyBoxes: iconCount('.mkt__card .mkt__icon-box'),
    holes: [...document.querySelectorAll('.mkt__card')].filter((c) => !c.querySelector('.mkt__icon, [class*="picon"]')).length
  }

  // 2) 滚动：帧间隔 + 可见卡片 + 自动续批
  let scroller = document.querySelector('.mkt__grid')?.parentElement ?? null
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
    scroller = scroller.parentElement
  }
  out.scroller = scroller ? { cls: scroller.className, clientH: scroller.clientHeight, scrollH: scroller.scrollHeight } : null

  const frames = []
  let stop = false
  let prev = performance.now()
  const tick = () => {
    const now = performance.now()
    frames.push(Math.round((now - prev) * 10) / 10)
    prev = now
    if (!stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const steps = []
  if (scroller) {
    for (let i = 0; i < 12; i++) {
      scroller.scrollTop = Math.min(scroller.scrollTop + Math.round(scroller.clientHeight * 0.9), scroller.scrollHeight)
      await nap(170)
      const sc = scroller.getBoundingClientRect()
      const visibleCards = [...document.querySelectorAll('.mkt__card')].filter((c) => {
        const r = c.getBoundingClientRect()
        return r.bottom > sc.top && r.top < sc.bottom
      }).length
      steps.push({
        i,
        scrollTop: Math.round(scroller.scrollTop),
        cards: cards(),
        dom: nodes(),
        visibleCards,
        atBottom: Math.round(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight - 4
      })
      if (steps[i].atBottom) break
    }
  }
  await nap(200)
  stop = true
  frames.shift()
  const sorted = [...frames].sort((a, b) => a - b)
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null)
  out.scroll = {
    steps,
    frames: {
      count: frames.length,
      p50: q(0.5),
      p95: q(0.95),
      max: sorted.length ? sorted[sorted.length - 1] : null,
      over33ms: frames.filter((f) => f > 33).length,
      over50ms: frames.filter((f) => f > 50).length
    },
    autoLoadWorked: steps.length > 0 && steps[steps.length - 1].cards > out.firstPaint.cards,
    blanks: steps.filter((s) => s.visibleCards === 0).length
  }

  // 3) 搜索 / 分类切换响应
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  if (scroller) scroller.scrollTop = 0
  await nap(200)
  const input = document.querySelector('.mkt__input')
  let t1 = performance.now()
  setter.call(input, 'dsh-market')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  let searchMs = null
  for (let i = 0; i < 200; i++) {
    const names = [...document.querySelectorAll('.mkt__card-name')].map((n) => n.textContent)
    if (names.length > 0 && names.length < 30) {
      searchMs = Math.round(performance.now() - t1)
      break
    }
    await nap(10)
  }
  out.search = { ms: searchMs, hits: cards() }
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nap(500)

  const sel = document.querySelector('.mkt__select')
  t1 = performance.now()
  if (sel) {
    sel.value = sel.options[2]?.value ?? sel.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }
  let catMs = null
  for (let i = 0; i < 200; i++) {
    const st = document.querySelector('.mkt__status')?.innerText || ''
    if (!/筛出 8281 /.test(st)) {
      catMs = Math.round(performance.now() - t1)
      break
    }
    await nap(10)
  }
  out.category = { ms: catMs, status: (document.querySelector('.mkt__status')?.innerText || '').replace(/\n+/g, ' | ').trim(), cards: cards() }
  if (sel) {
    sel.value = 'all'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await nap(400)
  }
  out.after = { cards: cards(), dom: nodes(), shown: (document.querySelector('.mkt__more-count')?.textContent || '').trim() }
  return out
})()
