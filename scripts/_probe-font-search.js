(async () => {
  const inp = document.querySelector('.fpick__search')
  if (!inp) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(inp, '黑体')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 400))
  const items = [...document.querySelectorAll('.fpick__item .fpick__itemname')].map((e) => e.textContent.trim())
  return { count: items.length, bad: items.filter((t) => /\uFFFD/.test(t)).length, items }
})()
