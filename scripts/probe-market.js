/**
 * probe-market.js —— 在运行中的插件台里直接调 window.dsh.marketList()，验收目录接口。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market.js
 * 第一次调用会真去 npm 拉 dsh-plugin-catalog（几兆，慢）；第二次应该走缓存。
 */
(async () => {
  const out = {}

  const t0 = performance.now()
  const r = await window.dsh.marketList()
  const ms1 = Math.round(performance.now() - t0)

  out.first = {
    ms: ms1,
    ok: r.ok,
    total: r.total,
    categories: (r.categories || []).length,
    source: r.source,
    cached: r.cached,
    updated: r.updated,
    fetchedAt: r.fetchedAt,
    error: r.error,
    warnings: r.warnings,
    pluginsLen: (r.plugins || []).length,
    first3: (r.plugins || []).slice(0, 3).map((p) => ({
      name: p.name,
      stars: p.stars,
      downloads: p.downloads,
      npm: p.npm,
      install: p.install,
      installed: p.installed,
      cats: p.categories
    })),
    topCategories: (r.categories || []).slice(0, 6).map((c) => `${c.id}:${c.count}`),
    installedCount: (r.plugins || []).filter((p) => p.installed).length,
    withCapabilities: (r.plugins || []).filter((p) => (p.capabilities || []).length > 0).length,
    scannedOnly: (r.plugins || []).filter((p) => (p.capabilities || []).length === 0 && p.capabilityCheckedAt).length,
    neverScanned: (r.plugins || []).filter((p) => (p.capabilities || []).length === 0 && !p.capabilityCheckedAt).length,
    deprecated: (r.plugins || []).filter((p) => p.deprecated).length,
    noZhDesc: (r.plugins || []).filter((p) => !p.description || !(p.description['zh-CN'] || p.description['zh'])).length
  }

  const t1 = performance.now()
  const r2 = await window.dsh.marketList()
  out.second = {
    ms: Math.round(performance.now() - t1),
    total: r2.total,
    cached: r2.cached,
    source: r2.source,
    sameLength: (r2.plugins || []).length === (r.plugins || []).length
  }

  // 目录里自己的那条（dshmarket 就发布这个目录）
  const hit = (r.plugins || []).filter((p) => /dsh[-_]?market/i.test(`${p.name} ${p.npm || ''} ${p.url || ''}`))
  out.dshmarket = hit.map((p) => ({
    name: p.name,
    owner: p.owner,
    npm: p.npm,
    url: p.url,
    install: p.install,
    stars: p.stars,
    added: p.added,
    cats: p.categories,
    desc: (p.description || {})['zh-CN'] || (p.description || {})['zh'] || (p.description || {})['en'] || null
  }))

  return out
})()
