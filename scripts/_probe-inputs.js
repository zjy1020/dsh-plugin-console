(() => {
  const ins = [...document.querySelectorAll('input')].map((i) => ({
    ph: i.placeholder,
    cls: i.className,
    type: i.type
  }))
  const tabs = [...document.querySelectorAll('.tabs button, .seg button, [role=tab]')].map((b) =>
    b.textContent.trim()
  )
  return { ins, tabs }
})()
