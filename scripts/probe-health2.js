/* 环境还原后的健康快照：installRoot 应该回来了，不该再有警示条 */
;(async () => {
  const d = window.dsh
  const info = await d.runtimeInfo()
  const rows = (await d.plugins('desktop')) || []
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
  }
  return {
    installRoot: info.installRoot ?? null,
    installRootFrom: info.installRootFrom ?? null,
    dshHome: info.dshHome ?? null,
    nodeOk: Boolean(info.nodePath),
    pnpmOk: Boolean(info.pnpmPath),
    warnings: info.warnings ?? [],
    pluginCount: rows.length,
    warnPresent: Boolean(document.querySelector('.app__warn')),
    envsetPresent: Boolean(document.querySelector('.envset')),
    sidebar: r('.sb'),
    main: r('.app__main'),
    docScrollable: document.scrollingElement
      ? document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight
      : null
  }
})()
