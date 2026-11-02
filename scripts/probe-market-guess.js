// 「按仓库地址猜图标」的命中率与延迟探针（纯读，不改任何数据）。
// 目录里只有 6% 的条目声明了 icon，其余靠 src/renderer/src/components/MarketTab.tsx 的
// ICON_CANDIDATES 顺序去 raw.githubusercontent 猜。这里抽样复现同一条候选链，记录：
//   · 命中率（多少条能出图）
//   · 每个候选的结果（load / error / timeout）与耗时，用来看「miss 是真 404 还是网络卡住」
// 抽 12 条、每候选 2.5 秒超时（跟卡片里的队列一致），跑完约 1~2 分钟。
(async () => {
  const out = { startedAt: new Date().toISOString() };
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
  const TIMEOUT = 2500;
  const SAMPLE = 12;

  let catalog = null;
  try {
    catalog = await window.dsh.marketList();
  } catch (e) {
    return Object.assign(out, { error: String(e) });
  }
  const all = catalog.plugins || [];
  const pool = all.filter((e) => !e.icon && /github\.com\//.test(e.url || ''));
  out.total = all.length;
  out.declaredIcon = all.filter((e) => e.icon).length;
  out.guessPool = pool.length;

  const pick = [];
  const stride = Math.max(1, Math.floor(pool.length / SAMPLE));
  for (let i = 0; i < pool.length && pick.length < SAMPLE; i += stride) pick.push(pool[i]);
  out.sampled = pick.length;

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
      const timer = setTimeout(() => finish('timeout'), TIMEOUT);
      img.onload = () => finish('load');
      img.onerror = () => finish('error');
      img.src = url;
    });

  /** 按卡片里的候选顺序试一条：命中返回地址，全挂返回 null，同时记下每个候选的结果与耗时 */
  const probeOne = async (entry, cands, timeout) => {
    const m = /github\.com\/([^/?#]+)\/([^/?#]+)/.exec(entry.url || '');
    if (!m) return { name: entry.name, repo: null, hit: null, tries: [] };
    const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
    const tries = [];
    for (const c of cands) {
      const url = `https://raw.githubusercontent.com/${repo}/HEAD/${c}`;
      const res = await new Promise((resolve) => {
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
        const timer = setTimeout(() => finish('timeout'), timeout);
        img.onload = () => finish('load');
        img.onerror = () => finish('error');
        img.src = url;
      });
      tries.push({ c, r: res.r, ms: res.ms });
      if (res.r === 'load') {
        return { name: entry.name, npm: entry.npm ?? null, repo, hit: url.replace('https://raw.githubusercontent.com/', ''), tries };
      }
    }
    return { name: entry.name, npm: entry.npm ?? null, repo, hit: null, tries };
  };

  const rows = [];
  for (const entry of pick) {
    rows.push(await probeOne(entry, CANDS, TIMEOUT));
  }

  // 第二层抽样：只抽 dsh- 开头的（这才是插件目录里的「本体」群体，父 agent 当初 curl 的就是这一类）
  const dshPool = pool.filter((e) => /^dsh[-_]/.test(e.name || ''));
  const dshPick = [];
  const dshStride = Math.max(1, Math.floor(dshPool.length / SAMPLE));
  for (let i = 0; i < dshPool.length && dshPick.length < SAMPLE; i += dshStride) dshPick.push(dshPool[i]);
  out.dshPool = dshPool.length;
  out.dshSampled = dshPick.length;
  const dshRows = [];
  for (const entry of dshPick) {
    dshRows.push(await probeOne(entry, CANDS, TIMEOUT));
  }
  out.dshRows = dshRows;
  out.dshHits = dshRows.filter((r) => r.hit).length;
  out.dshHitRate = `${dshRows.filter((r) => r.hit).length}/${dshRows.length}`;

  out.rows = rows;
  out.hits = rows.filter((r) => r.hit).length;
  out.hitRate = `${rows.filter((r) => r.hit).length}/${rows.length}`;
  out.timeouts = rows.reduce((n, r) => n + r.tries.filter((t) => t.r === 'timeout').length, 0);
  out.errors = rows.reduce((n, r) => n + r.tries.filter((t) => t.r === 'error').length, 0);
  out.loads = rows.reduce((n, r) => n + r.tries.filter((t) => t.r === 'load').length, 0);
  out.avgTryMs = Math.round(
    rows.reduce((s, r) => s + r.tries.reduce((a, t) => a + t.ms, 0), 0) /
      Math.max(1, rows.reduce((s, r) => s + r.tries.length, 0))
  );
  return out;
})();
