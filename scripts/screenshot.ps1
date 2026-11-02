# 截取指定窗口（默认按标题匹配器找可见窗口），保存为 PNG。
#
# 关键点（都是踩过的坑）：
#   1. 必须先把自己设为 per-monitor DPI aware，否则在 150% 缩放的显示器上
#      GetWindowRect 返回的是被虚拟化过的逻辑坐标，BitBlt 只抓到窗口左上角的
#      一块（表现为「右边一大片黑的 / 内容被硬切」）。
#   2. GetWindowRect 把 DWM 阴影算进外侧矩形，用 DWMWA_EXTENDED_FRAME_BOUNDS
#      取真正的可见边框。
#   3. Electron 是 GPU 合成的，PrintWindow(PW_RENDERFULLCONTENT) 比 CopyFromScreen
#      更稳（窗口被遮挡也能拍）；失败自动退回 CopyFromScreen。
#   4. 刚显示的窗口第一帧可能是黑的（Chromium 未重绘），所以默认连拍 -Repeat 张，
#      用最后一张。
#
# 用法：
#   pwsh -File scripts\screenshot.ps1 -Match "DSH 插件台"
#   pwsh -File scripts\screenshot.ps1 -Match "DSH" -Out docs\shots\x.png -Repeat 2
#   pwsh -File scripts\screenshot.ps1 -FullScreen
param(
  [string]$Match = 'DSH',
  [string]$Out = '',
  [switch]$FullScreen,
  [int]$DelayMs = 700,
  [int]$Repeat = 2,
  [ValidateSet('auto', 'print', 'screen')]
  [string]$Method = 'auto'
)

Add-Type -AssemblyName System.Drawing

if (-not ('Win32Shot' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;

public class Win32Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder str, int maxCount);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dpiX, out uint dpiY);

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const uint PW_RENDERFULLCONTENT = 2;

  // per-monitor v2
  public static void EnableDpiAwareness() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
  }

  public static bool TryFrame(IntPtr hWnd, out RECT r) {
    r = new RECT();
    int hr = DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT)));
    if (hr == 0 && (r.Right - r.Left) > 0 && (r.Bottom - r.Top) > 0) return true;
    return GetWindowRect(hWnd, out r);
  }
}
'@
}

[Win32Shot]::EnableDpiAwareness()

function Get-Windows {
  $list = New-Object System.Collections.ArrayList
  $cb = [Win32Shot+EnumProc]{
    param($h, $l)
    if ([Win32Shot]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][Win32Shot]::GetWindowTextW($h, $sb, 512)
      $t = $sb.ToString()
      if ($t) {
        $r = New-Object Win32Shot+RECT
        if ([Win32Shot]::TryFrame($h, [ref]$r)) {
          $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
          if ($w -gt 200 -and $ht -gt 150) {
            [void]$list.Add([pscustomobject]@{ H = $h; Title = $t; X = $r.Left; Y = $r.Top; W = $w; Ht = $ht })
          }
        }
      }
    }
    return $true
  }
  [void][Win32Shot]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Capture-Print([IntPtr]$hWnd, [int]$w, [int]$ht) {
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = $false
  try { $ok = [Win32Shot]::PrintWindow($hWnd, $hdc, [Win32Shot]::PW_RENDERFULLCONTENT) } finally { $g.ReleaseHdc($hdc) }
  $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); return $null }
  return $bmp
}

function Capture-Screen([int]$x, [int]$y, [int]$w, [int]$ht) {
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $g.Dispose()
  return $bmp
}

$target = $null
if (-not $FullScreen) {
  $cands = Get-Windows | Where-Object { $_.Title -like "*$Match*" }
  $target = $cands | Sort-Object { $_.W * $_.Ht } -Descending | Select-Object -First 1
  if ($null -eq $target) {
    Write-Host "没找到标题匹配 '$Match' 的可见窗口，改为全屏截图。"
    $FullScreen = $true
  }
}

if ($FullScreen) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $h = $vs.Height
  $title = 'FullScreen'
  $rect = $null
} else {
  if ([Win32Shot]::IsIconic($target.H)) { [void][Win32Shot]::ShowWindow($target.H, 9) }
  [void][Win32Shot]::SetForegroundWindow($target.H)
  Start-Sleep -Milliseconds $DelayMs
  $rect = New-Object Win32Shot+RECT
  [void][Win32Shot]::TryFrame($target.H, [ref]$rect)
  $x = $rect.Left; $y = $rect.Top
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  $title = $target.Title
}

if (-not $Out) {
  $dir = Join-Path (Get-Location) 'docs\shots'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Out = Join-Path $dir ("shot-" + (Get-Date -Format 'HHmmss') + ".png")
}
$outDir = Split-Path -Parent $Out
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# 连拍：第一帧可能是黑的（Chromium 尚未重绘），用最后一张
$bmp = $null
$used = ''
for ($i = 1; $i -le [Math]::Max(1, $Repeat); $i++) {
  if ($bmp) { $bmp.Dispose() }
  if (-not $FullScreen -and $Method -ne 'screen') {
    $shot = Capture-Print $target.H $w $h
    if ($shot) { $bmp = $shot; $used = 'print' }
  }
  if (-not $bmp -and $Method -ne 'print') {
    $bmp = Capture-Screen $x $y $w $h
    $used = 'screen'
  }
  if ($i -lt $Repeat) {
    Start-Sleep -Milliseconds 350
    if ($bmp) { $bmp.Dispose(); $bmp = $null }
  }
}

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "窗口: $title"
Write-Host "区域: ${w}x${h} @ ($x,$y)  方式: $used"
Write-Host "输出: $Out"