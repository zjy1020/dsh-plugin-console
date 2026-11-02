// 图标网络路径核对（纯读）：目录图标是 https://raw.githubusercontent.com/... 的图，
// 卡片里靠 <img> 直接加载。这里量：能不能加载、失败是立刻被拦还是真的 404、CSP 有没有拦。
(async () => {
  const out = {};
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  out.csp = csp ? csp.getAttribute('content') : null;
  out.onLine = navigator.onLine;
  out.location = location.href;

  const violations = [];
  const onViolation = (e) => violations.push({ blocked: e.blockedURI, directive: e.effectiveDirective });
  document.addEventListener('securitypolicyviolation', onViolation);

  const tryUrl = (url, flavor) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const img = new Image();
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        img.onload = null;
        img.onerror = null;
        clearTimeout(timer);
        resolve({ url, flavor, r, ms: Math.round(performance.now() - t0) });
      };
      const timer = setTimeout(() => finish('timeout'), 6000);
      img.onload = () => finish(`load ${img.naturalWidth}x${img.naturalHeight}`);
      img.onerror = () => finish('error');
      img.src = url;
    });

  const tests = [
    ['声明 icon（自己声明、之前实测能加载）', 'https://raw.githubusercontent.com/DayuanJiang/next-ai-draw-io/main/packages/dsh-plugin/icon.png'],
    ['猜的候选（已知命中过）', 'https://raw.githubusercontent.com/Utmotc/dsh-balance-card/HEAD/assets/icon.svg'],
    ['肯定存在的公共图', 'https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png'],
    ['肯定不存在的路径', 'https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nope-xyz.png']
  ];
  out.results = [];
  for (const [flavor, url] of tests) out.results.push(await tryUrl(url, flavor));

  // fetch 也试一把（卡片的连接策略里 connect-src 只有 self，预期直接失败）
  try {
    const t0 = performance.now();
    const res = await fetch('https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png', { method: 'HEAD' });
    out.fetch = { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out.fetch = { error: String(e && e.message ? e.message : e) };
  }

  // 卡片里现在有几张真图
  out.cardImgs = document.querySelectorAll('.mkt__card img').length;
  out.cardDecoded = [...document.querySelectorAll('.mkt__card img')].filter((i) => i.complete && i.naturalWidth > 0)
    .length;
  out.violations = violations;
  document.removeEventListener('securitypolicyviolation', onViolation);
  out.resources = performance
    .getEntriesByType('resource')
    .filter((r) => /raw\.githubusercontent/.test(r.name))
    .slice(-8)
    .map((r) => ({ name: r.name.slice(-60), ms: Math.round(r.duration), size: r.transferSize, end: Math.round(r.responseEnd) }));
  return out;
})();
