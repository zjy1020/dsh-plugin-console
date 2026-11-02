(async () => {
  const s = await window.dsh.settingsSet({ proxy: 'http://127.0.0.1:65535' })
  return JSON.stringify(s, null, 2)
})()