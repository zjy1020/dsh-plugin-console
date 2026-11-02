(async () => {
  const list = await window.dsh.marketList();
  const all = list.plugins || list.entries || [];
  const withIcon = all.filter((e) => e.icon);
  const withNpm = all.filter((e) => e.npm);
  const withRepo = all.filter((e) => e.url);
  return {
    total: all.length,
    withIcon: withIcon.length,
    pct: Math.round((withIcon.length / all.length) * 100),
    withNpm: withNpm.length,
    withRepo: withRepo.length,
    source: list.source, cached: list.cached, fetchedAt: list.fetchedAt,
  };
})();
