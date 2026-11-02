(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (txt) => {
    const b = [...document.querySelectorAll('button, [role="tab"]')].find((e) =>
      (e.textContent || '').trim().startsWith(txt)
    );
    if (b) b.click();
    return Boolean(b);
  };
  click('安装插件');
  await nap(500);
  click('插件市场');
  await nap(3000);
  return { cards: document.querySelectorAll('.mkt__card').length, dom: document.getElementsByTagName('*').length };
})();
