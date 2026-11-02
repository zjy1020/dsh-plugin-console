(async () => {
  const bundled = (list) => list.filter((p) => p.inBundles).sort((a, b) => (a.bundleIndex ?? 0) - (b.bundleIndex ?? 0)).map((p) => p.name)
  const now = bundled(await window.dsh.plugins('desktop', { deep: false }))
  return JSON.stringify({ now }, null, 2)
})()