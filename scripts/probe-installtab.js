(async () => {
  const setVal = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const clickByText = (tag, text) => {
    const el = Array.from(document.querySelectorAll(tag)).find((n) => (n.textContent || '').trim() === text)
    el?.click()
    return Boolean(el)
  }

  clickByText('button', '安装插件')
  await sleep(300)
  clickByText('button', '智能输入')
  await sleep(200)

  const input = document.querySelector('input.input--mono')
  if (!input) return JSON.stringify({ ok: false, reason: '找不到输入框' })

  setVal(input, 'https://github.com/dsh-market/dsh-market')
  await sleep(3000)
  const el = document.querySelector('.install__preview')
  return JSON.stringify({ ok: true, text: el ? el.innerText.replace(/\n{2,}/g, '\n') : 'no preview' }, null, 2)
})()