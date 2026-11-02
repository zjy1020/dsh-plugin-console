(async () => {
  const list = await window.dsh.marketList();
  const all = list.plugins || [];
  const noIcon = all.filter((e) => !e.icon).slice(0, 24);

  const cands = [
    'assets/icon.png', 'assets/icon-180.png', 'assets/icon-512.png', 'assets/logo.png',
    'icon.png', 'icon-180.png', 'logo.png', 'public/icon.png', 'public/logo.png',
    'docs/icon.png', 'assets/icon.jpg', 'assets/icon.webp'
  ];

  const repoOf = (e) => {
    const m = /github\.com\/([^/]+)\/([^/]+)/.exec(e.url || '');
    return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
  };

  const probe = (url, ms = 8000) =>
    new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => { img.src = ''; resolve(null); }, ms);
      img.onload = () => { clearTimeout(t); resolve({ url, w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(t); resolve(null); };
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    });

  const results = [];
  let hits = 0;
  for (const e of noIcon) {
    const r = repoOf(e);
    if (!r) { results.push({ name: e.name, hit: false, why: 'no-github-url' }); continue }
    let found = null;
    for (const c of cands) {
      const u = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/HEAD/${c}`;
      const ok = await probe(u);
      if (ok) { found = { ...ok, cand: c }; break }
    }
    if (found) hits += 1;
    results.push({ name: e.name, repo: `${r.owner}/${r.repo}`, hit: Boolean(found), cand: found?.cand ?? null, size: found ? `${found.w}x${found.h}` : null });
  }
  return { tested: noIcon.length, hits, rate: `${hits}/${noIcon.length}`, results };
})();
