(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  // 1) 字体家族
  const fonts = await window.dsh.listSystemFonts(false)
  out.fonts = { count: fonts.count, source: fonts.source, note: fonts.note, nerd: fonts.fonts.filter((n) => /nerd/i.test(n)), cjk: fonts.fonts.filter((n) => /[\u4e00-\u9fff]/.test(n)).length }
  // 2) 侧栏五项 + 字体页
  const nav = [...document.querySelectorAll('button')].find((b) => /DSH 字体/.test(b.textContent || ''))
  out.hasFontNav = !!nav
  if (nav) {
    nav.click()
    await sleep(1500)
    out.fpExists = !!document.querySelector('.fp')
    const pad = getComputedStyle(document.querySelector('.fp'))
    out.fpPadding = pad.padding
    const trigger = document.querySelector('.fpick__trigger')
    if (trigger) {
      trigger.click()
      await sleep(500)
      out.pickerItems = document.querySelectorAll('.fpick__item').length
      out.pickerCount = document.querySelector('.fpick__count')?.textContent
      document.body.click()
      await sleep(200)
    }
  }
  // 3) 已装列表中文简介
  const plug = [...document.querySelectorAll('button')].find((b) => /全部/.test(b.textContent || ''))
  if (plug) {
    plug.click()
    await sleep(1500)
    const rows = [...document.querySelectorAll('.prow')].length
    const descs = [...document.querySelectorAll('.prow__desc')].map((n) => n.textContent || '')
    out.installed = { rows, cjk: descs.filter((d) => /[\u4e00-\u9fff]/.test(d)).length }
  }
  return out
})()
