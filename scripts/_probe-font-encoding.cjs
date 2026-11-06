const { execFileSync } = require('node:child_process')
const exe = 'C:\\Windows\\System32\\reg.exe'
const out = execFileSync(exe, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'], { encoding: 'buffer', maxBuffer: 1 << 26 })
const utf8 = out.toString('utf8')
let gbk = ''
try { gbk = new TextDecoder('gbk').decode(out) } catch (e) { gbk = 'GBK-FAIL ' + e.message }
const bad = s => (s.match(/\uFFFD/g) || []).length
const cjk = s => (s.match(/[\u4e00-\u9fff]/g) || []).length
console.log('bytes', out.length)
console.log('utf8: FFFD=' + bad(utf8) + ' cjk=' + cjk(utf8))
console.log('gbk : FFFD=' + bad(gbk) + ' cjk=' + cjk(gbk))
const lines = gbk.split(/\r?\n/).filter(l => /[\u4e00-\u9fff]/.test(l)).slice(0, 4)
console.log('gbk CJK 样例:'); lines.forEach(l => console.log('  ' + l.trim()))
const ulines = utf8.split(/\r?\n/).filter(l => /[\u4e00-\u9fff]/.test(l)).slice(0, 2)
console.log('utf8 CJK 样例:'); ulines.forEach(l => console.log('  ' + l.trim()))
console.log('OEMCP:', execFileSync(exe, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { encoding: 'utf8' }).trim())
