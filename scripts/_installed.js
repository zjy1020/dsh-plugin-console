;(async () => {
  const d = window.dsh
  const ps = await d.plugins('desktop')
  return JSON.stringify(
    ps.map((p) => ({ name: p.name, ver: p.version, src: p.sourceKind, removable: p.removable })),
    null,
    2
  )
})()
