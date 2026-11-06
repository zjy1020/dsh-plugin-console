(() => {
  const rows = [...document.querySelectorAll('.prow')]
  const out = rows.slice(0, 20).map((r) => {
    const name = r.querySelector('.prow__name')?.textContent?.trim() ?? ''
    const desc = r.querySelector('.prow__desc')?.textContent?.trim() ?? ''
    const hasCJK = /[\u4e00-\u9fff]/.test(desc)
    return { name, desc: desc.slice(0, 46), hasCJK }
  })
  // 顺带核一下 store 里记录是否真的带 descZh
  const withZh = out.filter((x) => x.hasCJK).length
  return { total: out.length, withCJK: withZh, rows: out }
})()
