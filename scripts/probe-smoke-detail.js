/* 打包版冒烟的第二眼：截图里两处可疑点用 DOM 核实
 *   1) 左上角 profile 芯片显示「未选择」，但列表里有 22 个插件 —— 到底是真没选还是文案没更新
 *   2) 右下角错误 toast 的正文有没有被裁
 */
;(async () => {
  const out = { facts: {} }
  const r = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
  }

  /* ---- 1. profile 芯片 ---- */
  const chip =
    document.querySelector('.sb__profile') ||
    document.querySelector('.sb__title') ||
    document.querySelector('.sb__brand-text')
  out.facts.profileChip = chip
    ? { cls: chip.className, text: (chip.textContent || '').trim().replace(/\s+/g, ' ') }
    : null

  /* 主面板里的 profile 下拉/选择器 */
  const subbar = document.querySelector('.subbar')
  out.facts.subbarText = subbar ? (subbar.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) : null

  /* 已装数量徽章 */
  const countEl = document.querySelector('.plist__count') || document.querySelector('.toolbar__count')
  out.facts.countText = countEl ? (countEl.textContent || '').trim() : null

  /* 列表行数 */
  out.facts.pluginRows = document.querySelectorAll('.prow, .plugin-row, [data-plugin-name]').length
  const rows = Array.from(document.querySelectorAll('.prow, .plugin-row')).slice(0, 3)
  out.facts.firstRows = rows.map((el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80))

  /* ---- 2. toast 有没有被裁 ---- */
  const toast = document.querySelector('.toast--error')
  if (toast) {
    const detail = toast.querySelector('.toast__detail')
    out.facts.toast = {
      box: r(toast),
      scrollH: toast.scrollHeight,
      clientH: toast.clientHeight,
      detail: detail
        ? {
            box: r(detail),
            scrollH: detail.scrollHeight,
            clientH: detail.clientHeight,
            clipped: detail.scrollHeight > detail.clientHeight + 1,
            textLen: (detail.textContent || '').length
          }
        : null
    }
  } else out.facts.toast = null

  /* ---- 3. 实际选中的 profile（store 视角） ---- */
  const info = await window.dsh.runtimeInfo()
  const profiles = await window.dsh.profiles()
  out.facts.profiles = profiles
  out.facts.runtimeDshHome = info.dshHome ?? null

  return out
})()
