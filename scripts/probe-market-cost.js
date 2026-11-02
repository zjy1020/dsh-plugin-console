// 精确量：① marketList IPC 耗时 ② 切到市场 tab 到卡片出现 ③ 首屏 48 张卡的网络负担
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // ① 直接量 IPC
  const t0 = performance.now();
  let list = null;
  try { list = await window.dsh.marketList({}); } catch (e) { out.ipcError = String(e && e.message); }
  out.ipcMs = Math.round(performance.now() - t0);
  out.entries = list && list.plugins ? list.plugins.length : null;
  out.source = list ? list.source : null;
  out.cached = list ? list.cached : null;
  out.payloadKb = list ? Math.round(JSON.stringify(list).length / 1024) : null;

  // ② 切 tab 计时
  const click = (txt) => {
    const b = [...document.querySelectorAll('button, [role="tab"]')].find((e) =>
      (e.textContent || '').trim().startsWith(txt)
    );
    if (b) b.click();
    return Boolean(b);
  };
  out.clickInstall = click('安装插件');
  await nap(300);

  const before = document.getElementsByTagName('*').length;
  const t1 = performance.now();
  out.clickMarket = click('插件市场');
  let cards = 0;
  for (let i = 0; i < 120; i += 1) {
    cards = document.querySelectorAll('.mkt__card').length;
    if (cards > 0) break;
    await nap(50);
  }
  out.tabToCardsMs = Math.round(performance.now() - t1);
  out.cards = cards;
  out.domDelta = document.getElementsByTagName('*').length - before;

  await nap(2500);

  // ③ 图标状态：有多少张卡在等图标 / 已经拿到
  out.iconImgs = document.querySelectorAll('.mkt__icon img, .picon-img').length;
  out.iconPlaceholders = document.querySelectorAll('.mkt__icon .picon-ph, .mkt__icon [class*="ph"]').length;
  out.spinners = document.querySelectorAll('[class*="loading"], [class*="skeleton"]').length;
  out.perf = performance.getEntriesByType('resource').length;
  return out;
})();
