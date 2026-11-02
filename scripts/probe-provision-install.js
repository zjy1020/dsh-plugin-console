/* 切到「安装插件」页，量那块 RuntimeProvision 在空态里的位置与文案。 */
;(async () => {
  const out = { pass: false, fail: [], detail: {} }
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }

  const btns = Array.from(document.querySelectorAll('button'))
  const installBtn = btns.find((b) => (b.textContent ?? '').trim().startsWith('安装插件'))
  out.detail.installBtn = installBtn ? { text: installBtn.textContent.trim(), cls: installBtn.className } : null
  if (!installBtn) {
    out.fail.push('找不到「安装插件」按钮')
    out.pass = false
    return out
  }
  installBtn.click()
  await new Promise((r) => setTimeout(r, 600))

  const prov = document.querySelector('.install .rtprov')
  const go = prov ? prov.querySelector('.rtprov__go') : null
  const opt = prov ? prov.querySelector('.rtprov__opt') : null
  const empty = document.querySelector('.install .empty, .install [class*="empty"]')

  out.detail.install = {
    provision: box(prov),
    goText: go ? go.textContent.trim() : null,
    goDisabled: go ? go.disabled : null,
    optText: opt ? opt.textContent.trim() : null,
    emptyText: empty ? (empty.textContent ?? '').slice(0, 120) : null,
    installChildren: Array.from(document.querySelector('.install')?.children ?? []).map(
      (n) => `${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]}`
    )
  }
  if (!prov) out.fail.push('安装页空态里没有 RuntimeProvision 块')

  // 截屏前把「安装插件」页留在那儿
  out.pass = out.fail.length === 0
  return out
})()
