(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null)
  return (async () => {
    const cards = [...document.querySelectorAll('.mkt__card')]
    if (!cards.length) return JSON.stringify({ err: '市场没打开' })
    const card = cards.find((c) => /dsh-dream-skin/.test(txt(c)))
    const src = card || cards[0]
    const btn = src.querySelector('.mkt__card-act button')
    const label = txt(src).slice(0, 40)
    if (!btn) return JSON.stringify({ err: '这张卡没有安装按钮', label })
    btn.click()
    await sleep(1800)
    const dlg = document.querySelector('.overlay--confirm .dialog--confirm')
    const out = {
      卡片: label,
      弹窗存在: !!dlg,
      标题: dlg ? dlg.getAttribute('aria-label') : null,
      正文: dlg ? txt(dlg).slice(0, 260) : null
    }
    // 关掉，别真装
    if (dlg) {
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      document.dispatchEvent(esc)
      await sleep(600)
      out.关掉了 = !document.querySelector('.overlay--confirm')
    }
    return JSON.stringify(out, null, 1)
  })()
})()
