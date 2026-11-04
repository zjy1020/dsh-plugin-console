# 修「任务栏图标不跟着变」——清 Windows 图标缓存并重建 explorer。
#
# 什么时候用：exe 里已经是新图标、窗口 WM_GETICON 也已经是新图标，
# 但任务栏按钮还是老样子。这时问题在 explorer 的 iconcache_*.db 里，
# 不在应用代码里。详见 docs/_log.md 的「任务栏图标一直是 Electron 默认原子图」。
#
# 用法：pwsh -File scripts\fix-icon-cache.ps1
#      或右键「使用 PowerShell 运行」

$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
if (-not (Test-Path $dir)) {
  Write-Host "找不到图标缓存目录：$dir"
  exit 1
}

$files = @(Get-ChildItem -Path $dir -Filter 'iconcache_*.db' -File -ErrorAction SilentlyContinue)
if ($files.Count -eq 0) {
  Write-Host '没找到 iconcache_*.db，可能已经被清过了。直接重启 explorer 即可。'
} else {
  $mb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
  Write-Host "找到 $($files.Count) 个图标缓存文件，共 $mb MB"
}

Write-Host '正在重启资源管理器（任务栏会闪一下，属正常）…'
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

foreach ($f in $files) {
  try {
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
  } catch {
    Write-Host "删不掉（可能被占用，跳过）：$($f.Name)"
  }
}

Start-Sleep -Seconds 1
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
  Write-Host '资源管理器没自己起来，手动拉起…'
  Start-Process explorer.exe
}

Write-Host ''
Write-Host '完成。如果目标应用正在运行，任务栏那一格应该已经换成新图标了；'
Write-Host '还是老样子的话，把应用关掉重开一次。'