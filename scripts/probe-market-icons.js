(async () => {
  const t0 = performance.now();
  const list = await window.dsh.marketList();
  const ms = Math.round(performance.now() - t0);
  const all = list.plugins || list.entries || [];
  const withIcon = all.filter((e) => e.icon);
  const samples = withIcon.slice(0, 12).map((e) => ({ name: e.name, icon: e.icon }));
  const hosts = {};
  for (const e of withIcon) {
    try { const h = new URL(e.icon).host; hosts[h] = (hosts[h] || 0) + 1; } catch { hosts['<bad>'] = (hosts['<bad>'] || 0) + 1; }
  }
  return {
    ms, source: list.source, cached: list.cached, fetchedAt: list.fetchedAt,
    total: all.length, withIcon: withIcon.length,
    topLevelKeys: Object.keys(list),
    entryKeys: all[0] ? Object.keys(all[0]) : [],
    samples, hosts,
  };
})();
