const { openSync, readSync, closeSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

function u16be(buf) {
  if (buf.length % 2) buf = buf.subarray(0, buf.length - 1)
  return Buffer.from(buf).swap16().toString('utf16le')
}
function readFamily(file) {
  let fd
  try { fd = openSync(file, 'r') } catch { return null }
  try {
    const hdr = Buffer.alloc(12)
    if (readSync(fd, hdr, 0, 12, 0) < 12) return null
    let base = 0
    if (hdr.toString('latin1', 0, 4) === 'ttcf') {
      const head = Buffer.alloc(16)
      readSync(fd, head, 0, 16, 0)
      base = head.readUInt32BE(12)
      readSync(fd, hdr, 0, 12, base)
    }
    const numTables = hdr.readUInt16BE(4)
    if (!numTables || numTables > 512) return null
    const dir = Buffer.alloc(numTables * 16)
    if (readSync(fd, dir, 0, dir.length, base + 12) < dir.length) return null
    let off = 0, len = 0
    for (let i = 0; i < numTables; i += 1) {
      const r = dir.subarray(i * 16, i * 16 + 16)
      if (r.toString('latin1', 0, 4) === 'name') { off = r.readUInt32BE(8); len = r.readUInt32BE(12); break }
    }
    if (!off || !len || len > 2_000_000) return null
    const tbl = Buffer.alloc(len)
    if (readSync(fd, tbl, 0, len, off) < len) return null
    const count = tbl.readUInt16BE(2)
    const strOff = tbl.readUInt16BE(4)
    if (count > 4096) return null
    const found = {}
    for (let i = 0; i < count; i += 1) {
      const p = 6 + i * 12
      if (p + 12 > tbl.length) break
      const plat = tbl.readUInt16BE(p), lang = tbl.readUInt16BE(p + 4)
      const id = tbl.readUInt16BE(p + 6), l = tbl.readUInt16BE(p + 8), o = tbl.readUInt16BE(p + 10)
      if (id !== 1 && id !== 16) continue
      const raw = tbl.subarray(strOff + o, strOff + o + l)
      let v = null
      if (plat === 0 || plat === 3) v = u16be(raw)
      else if (plat === 1) v = raw.toString('latin1')
      if (!v) continue
      v = v.replace(/\0/g, '').trim()
      if (!v) continue
      const en = plat === 3 && lang === 0x409
      if (!found[id] || (en && !found[id].en)) found[id] = { v, en }
    }
    const typo = found[16] ? found[16].v : null
    const legacy = found[1] ? found[1].v : null
    return typo || legacy
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

const winFonts = join(process.env.SystemRoot || 'C:\\Windows', 'Fonts')
const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
const keys = ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']
const entries = []
for (const key of keys) {
  let text = ''
  try {
    const buf = execFileSync(exe, ['query', key], { encoding: 'buffer', windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    text = new TextDecoder('gbk').decode(buf)
  } catch { continue }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}REG_SZ\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    entries.push({ display: m[1].trim(), data: m[2].trim() })
  }
}
const t0 = Date.now()
const byDisplay = new Map()
const families = new Map()
let parsed = 0, failed = 0
for (const e of entries) {
  const p = /^[A-Za-z]:\\/.test(e.data) ? e.data : join(winFonts, e.data)
  let fam = null
  if (existsSync(p)) { fam = readFamily(p); if (fam) parsed += 1; else failed += 1 }
  else failed += 1
  const shown = fam || e.display.replace(/\s*\((?:TrueType|OpenType|Type 1|All res)\)\s*$/i, '').trim()
  byDisplay.set(e.display, shown)
  const k = shown.toLowerCase()
  if (!families.has(k)) families.set(k, shown)
}
const ms = Date.now() - t0
const list = [...families.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }))
console.log(JSON.stringify({ entries: entries.length, parsed, failed, families: list.length, ms }, null, 1))
console.log('含 nerd 的家族:', list.filter((n) => /nerd/i.test(n)))
console.log('含 microsoft 的家族:', list.filter((n) => /microsoft/i.test(n)).slice(0, 12))
console.log('前 20:', list.slice(0, 20))
