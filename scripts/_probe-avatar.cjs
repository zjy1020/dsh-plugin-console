;(async () => {
  const owners = ['tt-a1i','Ebony-Vinyl','vectorize-io','volcengine','Tencent','MemTensor','dsh-market','zhu1090093659','DayuanJiang','buaaflyaway']
  for (const o of owners) {
    const url = `https://github.com/${o}.png`
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      console.log(o, r.status, r.headers.get('content-type'), r.headers.get('content-length'), r.url.slice(0, 60))
    } catch (e) { console.log(o, 'ERR', e.message) }
  }
})()
