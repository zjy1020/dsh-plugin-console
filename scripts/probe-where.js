(async () => {
  const tabs = [...document.querySelectorAll('[role="tab"], button')]
    .filter((e) => /已安装|安装插件|智能输入|搜索 npm|手动 spec|导入清单|插件市场/.test(e.textContent || ''))
    .map((e) => ({ t: (e.textContent || '').trim().slice(0, 14), sel: e.getAttribute('aria-selected'), cls: e.className.slice(0, 40) }));
  return {
    url: location.hash || location.pathname,
    tabs,
    mktCards: document.querySelectorAll('.mkt__card').length,
    prow: document.querySelectorAll('.prow').length,
    visibleText: (document.querySelector('.app__main')?.innerText || '').slice(0, 260),
  };
})();
