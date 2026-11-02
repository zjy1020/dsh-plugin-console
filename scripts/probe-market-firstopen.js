(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (txt) => {
    const b = [...document.querySelectorAll('button, [role="tab"]')].find((e) => (e.textContent || '').trim().startsWith(txt));
    if (b) b.click();
    return Boolean(b);
  };
  const count = () => document.querySelectorAll('.mkt__card').length;
  const out = { steps: [] };
  click('安装插件');
  await nap(400);
  const t0 = performance.now();
  click('插件市场');
  for (let i = 1; i <= 6; i += 1) { await nap(1000); out.steps.push({ t: i, cards: count() }); }
  out.openMs = Math.round(performance.now() - t0);
  out.cards = count();
  out.dom = document.getElementsByTagName('*').length;
  return out;
})();
