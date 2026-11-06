const { app } = require('electron')
const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
app.whenReady().then(() => {
  const exe = 'C:\\Windows\\System32\\reg.exe'
  const src = process.env.ELECTRON_RUN_AS_NODE
  let report = { electronRunAsNode: src === undefined ? '(unset)' : src, keys: {} }
  for (const k of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
    try {
      const buf = execFileSync(exe, ['query', k], { encoding: 'buffer', maxBuffer: 1 << 26 })
      const u = buf.toString('utf8')
      const g = new TextDecoder('gbk').decode(buf)
      const lines = u.split(/\r?\n/).filter(l => l.includes('\uFFFD'))
      const cjkLine = u.split(/\r?\n/).find(l => /[\u4e00-\u9fff]/.test(l)) || ''
      report.keys[k.split('\\')[0] + ':bytes'] = buf.length
      report.keys[k.split('\\')[0] + ':utf8FFFD'] = (u.match(/\uFFFD/g) || []).length
      report.keys[k.split('\\')[0] + ':gbkFFFD'] = (g.match(/\uFFFD/g) || []).length
      report.keys[k.split('\\')[0] + ':badLines'] = lines.length
      report.keys[k.split('\\')[0] + ':utf8CJKline'] = cjkLine.trim()
      report.keys[k.split('\\')[0] + ':utf8CJKhex'] = Buffer.from(cjkLine.trim().split('    REG_SZ')[0], 'utf8').toString('hex').slice(0, 48)
      const head = buf.subarray(0, 240)
      report.keys[k.split('\\')[0] + ':rawHeadHex'] = head.toString('hex')
    } catch (e) { report.keys[k.split('\\')[0] + ':ERR'] = e.message }
  }
  writeFileSync('scripts\\_fontenc-electron.json', JSON.stringify(report, null, 2), 'utf8')
  app.quit()
})
