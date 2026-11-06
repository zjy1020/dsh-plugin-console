/* 直接问主进程要 GalleryResult：看过滤/排序/宽高比三级筛子到底做了什么，
 * 顺便扫一遍市场前几张卡，确认「没有截图的插件」仍然是 ok:true + images:0。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { steps: [] }
  const log = (s) => out.steps.push(s)

  if (!window.dsh?.pluginGallery) {
    out.err = 'window.dsh.pluginGallery 不可用'
    return out
  }

  const btns = () => Array.from(document.querySelectorAll('button'))
  const clickText = (re) => {
    const b = btns().find((x) => re.test(x.textContent || ''))
    if (b) {
      b.click()
      return true
    }
    return false
  }
  if (!document.querySelector('.mkt')) {
    if (clickText(/安装插件/)) await sleep(700)
    if (!document.querySelector('.mkt') && clickText(/插件市场/)) await sleep(1300)
  }
  const closeBtn = document.querySelector('.mkt__sheet-close')
  if (closeBtn) {
    closeBtn.click()
    await sleep(500)
  }

  const profiles = await window.dsh.profiles().catch(() => null)
  out.profiles = Array.isArray(profiles) ? profiles.map((p) => (typeof p === 'string' ? p : p?.name)).slice(0, 6) : profiles
  const profile = document.querySelector('.mkt__card') ? (out.profiles?.[0] || 'desktop') : 'desktop'
  out.profile = profile

  const setSearch = async (kw) => {
    const input = document.querySelector('.mkt input[placeholder*="搜"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, kw)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1500)
    return true
  }

  const dump = async (name) => {
    const r = await window.dsh.pluginGallery(profile, name)
    return {
      name,
      ok: r?.ok,
      origin: r?.origin,
      count: r?.images?.length ?? 0,
      error: r?.error ?? null,
      warnings: r?.warnings ?? [],
      images: (r?.images ?? []).map((i) => `${i.width}x${i.height} ${String(i.url).slice(0, 96)}`)
    }
  }

  /* 1. 赞助商那张案子：archify */
  if (await setSearch('archify')) {
    const first = document.querySelector('.mkt__card-name')?.textContent || ''
    out.archifyName = first
    if (first) out.archify = await dump(first)
  }

  /* 2. 扫市场前 8 张卡：看空态与张数 */
  if (await setSearch('dsh')) {
    const names = Array.from(document.querySelectorAll('.mkt__card-name'))
      .slice(0, 8)
      .map((e) => e.textContent || '')
      .filter(Boolean)
    out.sweep = []
    for (const n of names) {
      try {
        const r = await window.dsh.pluginGallery(profile, n)
        out.sweep.push({
          n,
          ok: r?.ok,
          n0: r?.images?.length ?? 0,
          warn: (r?.warnings ?? []).length,
          note: (r?.warnings ?? []).join(' ｜ ').slice(0, 120) || null
        })
      } catch (e) {
        out.sweep.push({ n, err: String(e).slice(0, 80) })
      }
    }
  }
  return out
})()
