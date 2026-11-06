(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return (async () => {
    const click = (re) => {
      const el = [...document.querySelectorAll('button, [role="tab"], a')].find((b) => re.test((b.textContent || '').trim()))
      if (!el) return false
      el.click()
      return true
    }
    await sleep(1500)
    click(/^安装插件$/)
    await sleep(2500)
    click(/^插件市场$/)
    await sleep(6000)
    const cards = [...document.querySelectorAll('.mkt__card')]
    const img = cards.filter((c) => c.querySelector('.mkt__icon--img')).length
    const mono = cards.filter((c) => c.querySelector('.mkt__icon--mono')).length
    const srcs = [...document.querySelectorAll('.mkt__icon--img img')].slice(0, 4).map((i) => i.src.slice(0, 70))
    return JSON.stringify({ cards: cards.length, img, mono, srcs })
  })()
})()
