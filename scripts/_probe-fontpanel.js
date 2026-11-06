(() => {
  const nav = [...document.querySelectorAll('.sb__nav button')].find((b) =>
    /DSH 字体/.test(b.textContent || '')
  )
  if (!nav) {
    return { err: 'no nav item', navText: [...document.querySelectorAll('.sb__nav button')].map((b) => b.textContent.trim()) }
  }
  nav.click()
  return new Promise((res) => {
    setTimeout(() => {
      const root = document.querySelector('.fp, .font-panel, [class*=font]') || document.querySelector('.app__view')
      const btns = [...root.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean)
      const texts = [...root.querySelectorAll('p, h3, h4, label, .fp__note, .fp__meta')]
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 26)
      res({
        navClicked: true,
        rootClass: root.className,
        rootTag: root.tagName,
        btnCount: btns.length,
        btns: btns.slice(0, 24),
        texts,
        html: root.innerHTML.length
      })
    }, 1500)
  })
})()
