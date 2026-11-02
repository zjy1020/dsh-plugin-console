# 把探针用的那个 Electron 实例的窗口请到前台（窗口被压住时 CDP 截出来是黑屏）。
# 只找命令行里带指定 user-data-dir 标记的进程，不会碰别的实例。
param([string]$Tag = 'dsh-probe-9334')

Add-Type -Namespace Shot -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
'@

$targets = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Tag*" } |
  ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
  Where-Object { $_.MainWindowHandle -ne 0 }

foreach ($p in $targets) {
  [void][Shot.Win]::ShowWindow($p.MainWindowHandle, 9)   # SW_RESTORE
  [void][Shot.Win]::BringWindowToTop($p.MainWindowHandle)
  [void][Shot.Win]::SetForegroundWindow($p.MainWindowHandle)
  "foreground: pid=$($p.Id) hwnd=$($p.MainWindowHandle)"
}
if (-not $targets) { "foreground: 没找到带 $Tag 标记的窗口" }
