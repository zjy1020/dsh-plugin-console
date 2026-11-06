(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const stat = () => {
    const cards = [...document.querySelectorAll('.mkt__card')]
    return {
      cards: cards.length,
      img: cards.filter((c) => c.querySelector('.mkt__icon--img')).length,
      mono: cards.filter((c) => c.querySelector('.mkt__icon--mono')).length,
      srcs: [...document.querySelectorAll('.mkt__icon--img img')].slice(0, 3).map((i) => i.src.slice(0, 80))
    }
  }
  return (async () => {
    const out = []
    for (let i = 0; i < 5; i++) {
      out.push({ t: i * 4000, ...stat() })
      await sleep(4000)
    }
    return JSON.stringify(out, null, 1)
  })()
})()
