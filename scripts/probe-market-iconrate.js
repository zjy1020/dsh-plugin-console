// 图标覆盖率验收探针（纯读）：
//   切到插件市场 → 首屏 48 张卡里有几张真的出图（声明的 + 按仓库/子目录猜到的），
//   以及这些图是从哪来的、出图需要多久。
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (sel, txt) =>
    [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt));
  const imgs = () => [...document.querySelectorAll('.mkt__card img')];
  const snapshot = () => {
    const list = imgs();
    return {
      cards: document.querySelectorAll('.mkt__card').length,
      imgTags: list.length,
      decoded: list.filter((i) => i.complete && i.naturalWidth > 0).length,
      mono: document.querySelectorAll('.mkt__card .mkt__icon--mono').length,
      empty: [...document.querySelectorAll('.mkt__card')].filter(
        (c) => !c.querySelector('img') && !c.querySelector('.mkt__icon--mono')
      ).length
    };
  };

  const out = { steps: [] };
  const installTab = byText('button', '安装插件');
  if (!installTab) return { error: '没找到「安装插件」入口' };
  installTab.click();
  await nap(200);
  const mktTab = byText('button', '插件市场');
  if (!mktTab) return { error: '没找到「插件市场」tab' };

  const t0 = performance.now();
  mktTab.click();
  for (let i = 0; i < 20; i += 1) {
    const s = snapshot();
    out.steps.push({ ms: Math.round(performance.now() - t0), ...s });
    if (s.decoded > 0 && i > 6) break;
    await nap(500);
  }
  out.final = snapshot();
  out.cardH = (() => {
    const c = document.querySelector('.mkt__card');
    return c ? Math.round(c.getBoundingClientRect().height) : null;
  })();

  const decodedList = imgs().filter((i) => i.complete && i.naturalWidth > 0);
  out.withImage = decodedList.map((i) => ({
    card: (i.closest('.mkt__card')?.querySelector('.mkt__card-name')?.textContent || '').trim(),
    size: `${i.naturalWidth}x${i.naturalHeight}`,
    from: i.src.startsWith('data:') ? 'data-url(本机图标)' : i.src.replace('https://raw.githubusercontent.com/', 'gh:').slice(0, 90)
  }));
  out.monoSample = [...document.querySelectorAll('.mkt__card')]
    .filter((c) => c.querySelector('.mkt__icon--mono'))
    .slice(0, 8)
    .map((c) => (c.querySelector('.mkt__card-name')?.textContent || '').trim());
  out.status = document.querySelector('.mkt__status')?.innerText ?? null;
  return out;
})();
