(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const input = document.querySelector('.fpick__search')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(500)
  const list = document.querySelector('.fpick__list')
  const items = [...document.querySelectorAll('.fpick__item .fpick__itemname')].map((n) => n.textContent)
  list.scrollTop = 400
  await sleep(200)
  return {
    rendered: items.length,
    count: document.querySelector('.fpick__count')?.textContent,
    boxH: Math.round(list.getBoundingClientRect().height),
    scrollH: list.scrollHeight,
    scrolledTo: list.scrollTop,
    visibleAfterScroll: [...document.querySelectorAll('.fpick__item .fpick__itemname')].slice(18, 24).map((n) => n.textContent),
  }
})()
