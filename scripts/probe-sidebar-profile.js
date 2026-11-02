/* 精确抓左上角那行 profile 文案 —— 截图里显示「未选择 · 已安装」，
 * 而主面板 subbar 里明明是「desktop · node_modules 就绪」。二者矛盾，必须查清。
 */
;(async () => {
  const out = { facts: {} }
  const sb = document.querySelector('.sb')
  if (!sb) return { error: 'no .sb' }

  /* 把侧栏前 120px 高度内所有有文字的元素列出来 */
  const all = Array.from(sb.querySelectorAll('*'))
  out.facts.sidebarTexts = all
    .filter((el) => {
      const t = (el.textContent || '').trim()
      if (t === '' || t.length > 60) return false
      const b = el.getBoundingClientRect()
      return b.height > 0 && b.width > 0 && b.y < 160
    })
    .map((el) => {
      const b = el.getBoundingClientRect()
      return {
        cls: el.className && typeof el.className === 'string' ? el.className : '',
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().replace(/\s+/g, ' '),
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height)
      }
    })
    .slice(0, 30)

  /* 侧栏状态卡里的「插件 N / 加载层 N / 缺口 N」 */
  const readouts = Array.from(sb.querySelectorAll('.sb__readout')).map((el) => ({
    text: (el.textContent || '').trim().replace(/\s+/g, ' '),
    cls: el.className
  }))
  out.facts.readouts = readouts

  /* 底部 profile 选择器（如果有） */
  const profSel =
    sb.querySelector('.sb__profile') ||
    sb.querySelector('[class*="profile"]') ||
    sb.querySelector('select')
  out.facts.profileSelector = profSel
    ? {
        cls: profSel.className,
        tag: profSel.tagName.toLowerCase(),
        text: (profSel.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
      }
    : null

  return out
})()
