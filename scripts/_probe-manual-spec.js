/* 填手动 spec 框 */
(() => {
  const inp = document.querySelector('.input--mono, input[placeholder]')
  if (!inp) return 'no input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(inp, 'github:0xyxy/dsh-maid-atelier-tod')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()
