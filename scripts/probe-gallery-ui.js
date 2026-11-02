// 点开一个「有很多 README 截图」的插件，等图片区加载完，dump 图片区文本
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // 找到 dsh-pet 那一行（包内 README 图最多）
  const rows = [...document.querySelectorAll('.prow')];
  const row = rows.find((r) => (r.textContent || '').includes('dsh-pet'));
  out.rowFound = Boolean(row);
  if (row) {
    const nameBtn = row.querySelector('.prow__name') || row;
    nameBtn.click();
  }

  // 等图片区抓完（主进程要取字节）
  await nap(7000);

  const thumbs = [...document.querySelectorAll('.gal__thumb')];
  out.thumbCount = thumbs.length;
  out.thumbSizes = thumbs.slice(0, 3).map((t) => {
    const img = t.querySelector('img');
    return img ? `${img.naturalWidth}x${img.naturalHeight} loaded=${img.complete}` : 'no-img';
  });

  const gal = document.querySelector('.gal');
  out.galleryClass = gal ? gal.className : null;
  out.sectionText = gal ? gal.innerText.replace(/\n+/g, ' | ').slice(0, 300) : null;
  out.detailOpen = Boolean(document.querySelector('.detail'));
  return out;
})();
