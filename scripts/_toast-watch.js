/* 装一个常驻的 Toast 记录器：Toast 会自动消失，光靠轮询会漏。
 * 之后任何一次操作产生的 Toast 都会被记进 globalThis.__TOASTS。
 */
(() => {
  if (globalThis.__TOAST_WATCH) return { ok: true, already: (globalThis.__TOASTS || []).length }
  globalThis.__TOASTS = []
  const record = (node) => {
    if (!(node instanceof Element)) return
    const t = node.classList && node.classList.contains('toast') ? node : node.querySelector && node.querySelector('.toast')
    if (!t) return
    globalThis.__TOASTS.push({
      at: new Date().toISOString(),
      klass: t.className,
      title: (t.querySelector('.toast__title') || {}).textContent || '',
      detail: ((t.querySelector('.toast__detail') || {}).textContent || '').slice(0, 500),
    })
  }
  const mo = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) record(n)
  })
  mo.observe(document.body, { childList: true, subtree: true })
  document.querySelectorAll('.toast').forEach(record)
  globalThis.__TOAST_WATCH = mo
  return { ok: true, watching: true }
})()
