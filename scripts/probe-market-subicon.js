// 子目录形态的条目（名字里带 #，如 archify#integrations/deepseek-harness）在仓库根目录下没有图标，
// 但图标很可能在它自己的子目录里。这里量：默认星标排序的前 48 条里有多少是这种形态，
// 以及「把子目录拼进候选路径」能不能把命中率拉起来。
(async () => {
  const CANDS = [
    'assets/icon-180.png',
    'assets/icon.png',
    'icon-180.png',
    'icon.png',
    'assets/icon.svg',
    'icon.svg',
    'assets/logo.png',
    'logo.png'
  ];
  const list = await window.dsh.marketList();
  const all = list.plugins || [];
  const top = all.slice(0, 48); // 目录本身按 added 倒序返回；默认排序在前端做，这里另按星标取
  const byStars = [...all].sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 48);

  const subOf = (name) => {
    const i = name.indexOf('#');
    if (i < 0) return null;
    return name.slice(i + 1).replace(/^\/+|\/+$/g, '');
  };
  const repoOf = (url) => {
    const m = /github\.com\/([^/?#]+)\/([^/?#]+)/.exec(url || '');
    if (!m) return null;
    const repo = m[2].replace(/\.git$/, '');
    return repo === 'tree' ? null : `${m[1]}/${repo}`;
  };
  const tryUrl = (url) =>
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
        resolve({ r, ms: Math.round(performance.now() - t0) });
      };
      const timer = setTimeout(() => finish('timeout'), 5000);
      img.onload = () => finish('load');
      img.onerror = () => finish('error');
      img.src = url;
    });

  const out = {
    total: all.length,
    top48: top.length,
    top48SubForm: top.filter((e) => subOf(e.name)).length,
    byStars48SubForm: byStars.filter((e) => subOf(e.name)).length,
    byStars48Declared: byStars.filter((e) => e.icon).length,
    samples: []
  };

  const picks = byStars.filter((e) => subOf(e.name) && !e.icon).slice(0, 10);
  out.sampled = picks.length;
  for (const entry of picks) {
    const repo = repoOf(entry.url);
    const sub = subOf(entry.name);
    const row = { name: entry.name, repo, sub, rootHit: null, subHit: null };
    if (repo) {
      for (const c of CANDS) {
        const r1 = await tryUrl(`https://raw.githubusercontent.com/${repo}/HEAD/${c}`);
        if (r1.r === 'load') {
          row.rootHit = c;
          break;
        }
      }
      for (const c of CANDS) {
        const r2 = await tryUrl(`https://raw.githubusercontent.com/${repo}/HEAD/${sub}/${c}`);
        if (r2.r === 'load') {
          row.subHit = `${sub}/${c}`;
          break;
        }
      }
    }
    out.samples.push(row);
  }
  out.subHits = out.samples.filter((s) => s.subHit).length;
  out.rootHits = out.samples.filter((s) => s.rootHit).length;
  return out;
})();
