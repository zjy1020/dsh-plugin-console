(async () => {
  const list = await window.dsh.marketList();
  const all = list.plugins || [];
  const noIcon = all.filter((e) => !e.icon).slice(0, 25);
  return noIcon.map((e) => ({ name: e.name, url: e.url, owner: e.owner }));
})();
