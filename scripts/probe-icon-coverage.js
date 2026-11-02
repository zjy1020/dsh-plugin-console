(async () => {
  const out = { t0: Date.now() };
  const list = await window.dsh.marketList();
  const all = list.plugins || [];
  const probe = (url, ms = 6000) =>
    new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => { resolve(false); }, ms);
      img.onload = () => { clearTimeout(t); resolve(true); };
      img.onerror = () => { clearTimeout(t); resolve(false); };
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    });
  const cands = ['assets/icon-180.png', 'assets/icon.png', 'icon-180.png', 'icon.png', 'assets/logo.png', 'logo.png', 'public/icon.png', 'public/logo.png', 'assets/icon.svg'];
  const repoOf = (u) => { const m = /github\.com\/([^/]+)\/([^/]+)/.exec(u || ''); return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null; };

  const declared = all.filter((e) => e.icon).slice(0, 12);
  let dOk = 0;
  for (const e of declared) if (await probe(e.icon)) dOk += 1;
  out.declared = { sampled: declared.length, loaded: dOk };

  const missing = all.filter((e) => !e.icon).slice(0, 12);
  let gOk = 0; const who = [];
  for (const e of missing) {
    const r = repoOf(e.url); if (!r) continue;
    for (const c of cands) {
      if (await probe(`https://raw.githubusercontent.com/${r.owner}/${r.repo}/HEAD/${c}`)) { gOk += 1; who.push(`${r.owner}/${r.repo} -> ${c}`); break }
    }
  }
  out.guess = { sampled: missing.length, hit: gOk, who };
  out.ms = Date.now() - out.t0;
  return out;
})();
