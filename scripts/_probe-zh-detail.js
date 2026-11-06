(() => {
  const rows = [...document.querySelectorAll('.prow')]
  const pick =
    rows.find((r) => /dsh-context$/.test(r.dataset.pluginName || '')) ||
    rows.find((r) => /billion-context/.test(r.dataset.pluginName || '')) ||
    rows[2]
  pick.querySelector('.prow__name').click()
  return new Promise((res) => {
    setTimeout(() => {
      const name = document.querySelector('.detail__title')?.textContent?.trim() ?? ''
      const zh = document.querySelector('.detail .detail__desc')?.textContent?.trim() ?? ''
      const srcEl = document.querySelector('.detail .detail__desc-src')
      res({
        clicked: pick.dataset.pluginName,
        detailName: name,
        zhDesc: zh.slice(0, 90),
        zhLen: zh.length,
        hasSrcLine: !!srcEl,
        srcText: srcEl ? srcEl.textContent.trim().slice(0, 110) : null
      })
    }, 900)
  })
})()
