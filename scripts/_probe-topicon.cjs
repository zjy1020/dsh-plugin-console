const fs = require('fs')
const arr = JSON.parse(fs.readFileSync(process.env.CAT, 'utf8')).plugins
const RE = /github\.com\/([^/?#]+)\/([^/?#]+)/
const ICON = ['assets/icon-180.png','assets/icon.png','icon-180.png','icon.png','assets/icon.svg','public/icon.png','icon.svg']
const SUBC = ['icon.svg','assets/icon-180.png','assets/icon.png','icon.png','assets/icon.svg','icon-180.png']
const repoOf = (u) => { const m = RE.exec(u || ''); if (!m) return null; const r = m[2].replace(/\.git$/, ''); if (!m[1] || !r || r === 'tree') return null; return m[1] + '/' + r }
const subOf = (e) => { const h = e.name.indexOf('#'); const f = h >= 0 ? e.name.slice(h + 1) : ''; if (f) return f.replace(/^\/+|\/+$/g, ''); const m = /github\.com\/[^/]+\/[^/]+\/(?:tree|blob)\/[^/]+\/(.+)$/.exec(e.url || ''); return m ? m[1] : null }
;(async () => {
  const top = [...arr].sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 12)
  const out = []
  for (const e of top) {
    const repo = repoOf(e.url), sub = subOf(e)
    const cands = sub ? [...SUBC.map((c) => sub + '/' + c), ...ICON.slice(0, 3)] : ICON
    let hit = null
    for (const c of cands) {
      const url = 'https://raw.githubusercontent.com/' + repo + '/HEAD/' + c
      try { const r = await fetch(url, { method: 'HEAD' }); if (r.ok) { hit = c; break } } catch (err) { hit = 'ERR ' + err.message; break }
    }
    out.push({ name: e.name, repo, sub, declared: e.icon ? 1 : 0, shots: (e.screenshots || []).length, hit, tried: cands.length })
  }
  console.log(JSON.stringify(out, null, 1))
})()
