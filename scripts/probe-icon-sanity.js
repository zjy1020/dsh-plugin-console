(async () => {
  const probe = (url, ms = 10000) =>
    new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => { resolve({ url, status: 'timeout' }); }, ms);
      img.onload = () => { clearTimeout(t); resolve({ url, status: 'ok', w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = (e) => { clearTimeout(t); resolve({ url, status: 'error' }); };
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    });

  const known = 'https://raw.githubusercontent.com/AkiNoYo-desu/dsh-effort-slider-universal/main/assets/icon-180.png';
  const knownHead = 'https://raw.githubusercontent.com/AkiNoYo-desu/dsh-effort-slider-universal/HEAD/assets/icon-180.png';
  const guess1 = 'https://raw.githubusercontent.com/LeeScenic/dsh-sidebar-sections/HEAD/assets/icon.png';
  const guess2 = 'https://raw.githubusercontent.com/LeeScenic/dsh-sidebar-sections/main/assets/icon.png';

  const [a, b, c, d] = await Promise.all([probe(known), probe(knownHead), probe(guess1), probe(guess2)]);

  // 顺便用 fetch 看真实状态码
  const f = async (u) => {
    try { const r = await fetch(u, { method: 'GET', referrerPolicy: 'no-referrer' }); return { u: u.slice(60), code: r.status }; }
    catch (e) { return { u: u.slice(60), code: 'ERR ' + String(e).slice(0, 60) }; }
  };
  const codes = await Promise.all([f(known), f(knownHead), f(guess1), f(guess2)]);

  return { images: [a, b, c, d].map((x) => ({ ...x, url: x.url.slice(60) })), fetchCodes: codes, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null };
})();
