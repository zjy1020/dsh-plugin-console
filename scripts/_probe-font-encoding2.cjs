const { execFileSync } = require('node:child_process')
const exe = 'C:\\Windows\\System32\\reg.exe'
const keys = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
]
for (const k of keys) {
  let buf
  try { buf = execFileSync(exe, ['query', k], { encoding: 'buffer', maxBuffer: 1 << 26 }) } catch (e) { console.log(k + ': ERR ' + e.message); continue }
  const u = buf.toString('utf8')
  const g = new TextDecoder('gbk').decode(buf)
  const badU = (u.match(/\uFFFD/g) || []).length
  const badG = (g.match(/\uFFFD/g) || []).length
  console.log('== ' + k + ' bytes=' + buf.length + ' utf8FFFD=' + badU + ' gbkFFFD=' + badG)
  const lines = u.split(/\r?\n/).filter(l => l.includes('\uFFFD'))
  console.log('   utf8 坏行 ' + lines.length)
  lines.slice(0, 5).forEach(l => {
    const name = l.split('    REG_SZ')[0]
    const b = Buffer.from(name, 'utf8')
    console.log('    ' + JSON.stringify(name) + '  hex=' + b.toString('hex').slice(0, 60))
  })
}
