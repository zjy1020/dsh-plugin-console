(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = () => document.querySelectorAll('.mkt__card').length;
  const out = { samples: [] };
  out.now = count();
  for (let i = 0; i < 5; i += 1) { await nap(2000); out.samples.push({ t: (i + 1) * 2, cards: count() }); }
  out.cardsAfter10s = count();
  out.dom = document.getElementsByTagName('*').length;
  return out;
})();
