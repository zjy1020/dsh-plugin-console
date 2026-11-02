(async () => {
  const clickByText = (text, tag = 'button') => {
    const nodes = Array.from(document.querySelectorAll(tag))
    const hit = nodes.find((n) => (n.textContent || '').trim() === text)
    if (hit) hit.click()
    return Boolean(hit)
  }
  const clicked = clickByText('安装插件')
  await new Promise((r) => setTimeout(r, 400))
  const inputs = Array.from(document.querySelectorAll('input, textarea')).map((n) => ({
    tag: n.tagName, type: n.type, placeholder: n.placeholder, cls: n.className
  }))
  return JSON.stringify({ clicked, inputs, tabs: Array.from(document.querySelectorAll('.subbar__tab')).map((n) => (n.textContent || '').trim()) }, null, 2)
})()