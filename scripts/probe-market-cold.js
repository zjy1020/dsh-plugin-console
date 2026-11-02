// 量一次「冷启动」目录抓取：force 忽略磁盘缓存，走完整下载 + 解包 + 解析
(async () => {
  const t0 = performance.now();
  let res = null;
  let err = null;
  try { res = await window.dsh.marketList({ force: true }); } catch (e) { err = String(e && e.message); }
  const ms = Math.round(performance.now() - t0);
  return {
    ms,
    err,
    ok: res ? res.ok : null,
    entries: res && res.plugins ? res.plugins.length : null,
    source: res ? res.source : null,
    cached: res ? res.cached : null,
    fetchedAt: res ? res.fetchedAt : null,
    payloadKb: res ? Math.round(JSON.stringify(res).length / 1024) : null,
    warnings: res ? res.warnings : null
  };
})();
