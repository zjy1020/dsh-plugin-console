(async () => {
  try {
    const list = await window.dsh.marketList();
    const all = list.plugins || [];
    return { okList: true, total: all.length, withIcon: all.filter((e) => e.icon).length };
  } catch (e) { return { okList: false, err: String(e).slice(0, 200) } }
})();
