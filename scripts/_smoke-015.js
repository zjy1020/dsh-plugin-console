/* v0.1.5 打包版冒烟：一次把三条改动都点到
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/_smoke-015.js
 * 前置：app 已带 --remote-debugging-port 起来，且停在主界面。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const nav = (re) => {
    const b = [...document.querySelectorAll('.sb__item, .sb__nav button')].find((x) => re.test(x.textContent.trim()))
    if (b) b.click()
    return !!b
  }
  const out = {}

  // ① 已装列表：简介中文覆盖率
  nav(/^全部/)
  await sleep(2500)
  const rows = [...document.querySelectorAll('.prow')]
  out.installed = {
    rows: rows.length,
    zh: rows.filter((r) => /[\u4e00-\u9fff]/.test(r.querySelector('.prow__desc')?.textContent || '')).length,
    sample: rows[0]?.querySelector('.prow__desc')?.textContent.trim().slice(0, 30) || null,
  }

  // ② 详情面板：中文 + 原文行
  rows[0]?.querySelector('.prow__main, .prow')?.click()
  await sleep(1200)
  const det = document.querySelector('.detail')
  out.detail = {
    open: !!det,
    zh: det?.querySelector('.detail__desc')?.textContent.trim().slice(0, 36) || null,
    hasSrcLine: !!det?.querySelector('.detail__desc-src'),
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(500)

  // ③ 字体页：能读到系统字体、且没有坏字符
  const hasFontNav = nav(/DSH 字体/)
  await sleep(2500)
  const fonts = await window.dsh.listSystemFonts(true).catch(() => null)
  const fams = fonts?.fonts || []
  out.fonts = {
    nav: hasFontNav,
    panel: !!document.querySelector('.fp'),
    count: fams.length,
    bad: fams.filter((n) => /\uFFFD/.test(n)).length,
    cjk: fams.filter((n) => /[\u4e00-\u9fff]/.test(n)).slice(0, 4),
    rows: document.querySelectorAll('.fp__row').length,
    pad: document.querySelector('.fp') ? getComputedStyle(document.querySelector('.fp')).padding : null,
  }

  // ④ 市场：卡片有图率
  nav(/安装插件/)
  await sleep(1500)
  const tabs = [...document.querySelectorAll('.subbar__tab')]
  tabs[1]?.click()
  await sleep(1500)
  const mktTab = [...document.querySelectorAll('button, [role=tab]')].find((b) => /插件市场/.test(b.textContent.trim()))
  mktTab?.click()
  await sleep(6000)
  const cards = [...document.querySelectorAll('.mkt__card')]
  out.market = {
    cards: cards.length,
    img: document.querySelectorAll('.mkt__icon--img').length,
    mono: document.querySelectorAll('.mkt__icon--mono').length,
  }

  return out
})()
