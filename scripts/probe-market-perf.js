// 量一下插件市场 tab 的渲染量：切过去，数 DOM 节点、量耗时
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  const clickText = (txt, exact) => {
    const b = [...document.querySelectorAll('button, [role="tab"], a')].find((e) => {
      const t = (e.textContent || '').trim();
      return exact ? t === txt : t.startsWith(txt);
    });
    if (b) b.click();
    return Boolean(b);
  };

  out.installTab = clickText('安装插件');
  await nap(400);
  out.marketTab = clickText('插件市场');
  out.subTabs = [...document.querySelectorAll('button, [role="tab"]')]
    .map((t) => (t.textContent || '').trim())
    .filter((t) => t && t.length < 14);

  out.domBefore = document.getElementsByTagName('*').length;
  const t0 = performance.now();
  // 等市场内容出现
  for (let i = 0; i < 40; i += 1) {
    await nap(250);
    if (document.querySelectorAll('[class*="mk-"], [class*="market"]').length > 0) break;
  }
  out.waitMs = Math.round(performance.now() - t0);
  out.domAfter = document.getElementsByTagName('*').length;

  // 各类节点计数
  out.counts = {};
  const classes = ['mk-card', 'mk-row', 'mk-item', 'market__row', 'market__card'];
  for (const c of classes) {
    const n = document.querySelectorAll('.' + c).length;
    if (n) out.counts[c] = n;
  }
  // 兜底：找出重复次数最多的类名
  const tally = {};
  for (const el of document.querySelectorAll('[class]')) {
    for (const cl of el.classList) tally[cl] = (tally[cl] || 0) + 1;
  }
  out.topClasses = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `${k}:${v}`);

  // 长任务/滚动高度
  out.scrollH = document.documentElement.scrollHeight;
  out.innerH = window.innerHeight;
  return out;
})();
