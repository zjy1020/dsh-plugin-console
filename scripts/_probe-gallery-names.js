/* 点名几个包的图集原始结果：只看 URL / 尺寸 / warnings。 */
(async () => {
  const names = [
    '@tt-a1i/archify-dsh',
    'dshmarket',
    'dsh-market',
    'dsh-pet',
    '@vectorize-io/hindsight-coding-agents'
  ]
  const out = { profile: 'desktop', dumps: [] }
  for (const name of names) {
    try {
      const r = await window.dsh.pluginGallery('desktop', name)
      out.dumps.push({
        name,
        ok: r?.ok,
        origin: r?.origin,
        count: r?.images?.length ?? 0,
        error: r?.error ?? null,
        warnings: r?.warnings ?? [],
        images: (r?.images ?? []).map((i) => `${i.width}x${i.height} ${String(i.url).slice(0, 110)}`)
      })
    } catch (e) {
      out.dumps.push({ name, err: String(e).slice(0, 120) })
    }
  }
  return out
})()
