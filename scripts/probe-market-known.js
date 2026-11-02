// 逐条核对父 agent curl 命中的那 4 个仓库 + 他报的 4 个 miss，确认「按仓库猜图标」这条路本身通不通，
// 以及 HEAD 分支能不能拿到（HEAD = 默认分支，父 agent 特别要求用 HEAD 而不是 main）。
(async () => {
  const CANDS = [
    'assets/icon-180.png',
    'assets/icon.png',
    'icon-180.png',
    'icon.png',
    'assets/logo.png',
    'logo.png',
    'public/icon.png',
    'public/logo.png',
    'assets/icon.svg'
  ];
  const NAMES = [
    'dsh-effort-slider-universal',
    'dsh-inline-edit',
    'dsh-folder-launcher',
    'dsh-session-inbox',
    'dsh-plugin-workspace-split',
    'dsh-pages',
    'dsh-prompt-library',
    'dsh-model-router'
  ];
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const list = await window.dsh.marketList();
  const all = list.plugins || [];
  const out = { total: all.length, rows: [] };

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
      const timer = setTimeout(() => finish('timeout'), 6000);
      img.onload = () => finish('load');
      img.onerror = () => finish('error');
      img.src = url;
    });

  for (const name of NAMES) {
    const entry = all.find((e) => e.name === name || e.name.startsWith(`${name}#`) || e.name.startsWith(`${name}/`));
    if (!entry) {
      out.rows.push({ name, found: false });
      continue;
    }
    const m = /github\.com\/([^/?#]+)\/([^/?#]+)/.exec(entry.url || '');
    const repo = m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
    const row = { name, found: true, repo, declared: entry.icon || null, url: entry.url, tries: [], hit: null };
    if (repo) {
      for (const c of CANDS) {
        const url = `https://raw.githubusercontent.com/${repo}/HEAD/${c}`;
        const res = await tryUrl(url);
        row.tries.push({ c, r: res.r, ms: res.ms });
        if (res.r === 'load') {
          row.hit = c;
          break;
        }
      }
      if (!row.hit) {
        // 再用声明的分支名兜一次 main / master，确认是不是分支名的问题
        for (const c of ['assets/icon-180.png', 'assets/icon.png', 'assets/icon.svg']) {
          for (const br of ['main', 'master']) {
            const url = `https://raw.githubusercontent.com/${repo}/${br}/${c}`;
            const res = await tryUrl(url);
            if (res.r === 'load') {
              row.hitOnBranch = `${br}/${c}`;
              break;
            }
          }
          if (row.hitOnBranch) break;
        }
      }
    }
    out.rows.push(row);
    await nap(120);
  }

  out.hits = out.rows.filter((r) => r.hit || r.hitOnBranch).length;
  return out;
})();
