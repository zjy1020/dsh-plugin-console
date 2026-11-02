// 用合成 DragEvent 触发拖拽提示层（合成 File 拿不到真实路径，所以会走到「拿不到路径」那条分支，
// 这一测只验证覆盖层与提示文案渲染，不验证导入本身）
(() => {
  const dt = new DataTransfer()
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'demo.png', { type: 'image/png' }))
  window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }))
  window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))

  const el = document.querySelector('.wpdrop')
  return {
    overlay: !!el,
    cls: el ? el.className : null,
    title: document.querySelector('.wpdrop__title')?.textContent ?? null,
    sub: document.querySelector('.wpdrop__sub')?.textContent ?? null,
    frameBorder: el ? getComputedStyle(document.querySelector('.wpdrop__frame')).borderColor : null
  }
})()
