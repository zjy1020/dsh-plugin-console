const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function head(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { method: 'HEAD', redirect: 'follow' }) } catch (e) { await sleep(600) }
  }
  return null
}
;(async () => {
  const owners = ['Ebony-Vinyl','vectorize-io','volcengine','Tencent','MemTensor','dsh-market','zhu1090093659','buaaflyaway','kingcharleslzy-ai','zjy1020']
  for (const o of owners) {
    const r = await head(`https://github.com/${o}.png?size=64`)
    console.log(o, r ? `${r.status} ${r.headers.get('content-type')} len=${r.headers.get('content-length')} ${r.url.slice(0, 50)}` : 'ERR')
    await sleep(300)
  }
})()
