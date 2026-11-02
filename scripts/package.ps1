# package.ps1 —— 一条命令出 Windows 安装包（NSIS）。
#
# 为什么要这个脚本：
#   这台机器上 `npx` 不可用（`npm error could not determine executable to run`），
#   所以 `package.json` 里那条 `pnpm run dist` 走不通 —— 它内部用的就是 `npx` 那一层。
#   打包还需要四个环境变量（镜像、代理、禁用签名探测、清掉 ELECTRON_RUN_AS_NODE），
#   散在命令行里每次手写一遍，早晚漏一个。漏掉 ELECTRON_RUN_AS_NODE 的表现是
#   electron-builder 退化成用 Node 跑、报一堆莫名其妙的错。
#
# 用法：
#   pwsh -File scripts\package.ps1              # 类型检查 + 构建 + 出安装包
#   pwsh -File scripts\package.ps1 -SkipChecks  # 跳过类型检查（调试用）
#
# 产物：release\DSH-Plugin-Console-<version>-setup.exe（+ .blockmap）
#
# 注意：electron-builder 会**覆盖** release\ 目录。要留旧包先自己复制走。

[CmdletBinding()]
param(
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'

# 项目根目录。
# 为什么写得这么绕：不同调用姿势下「脚本所在目录」能从三个地方拿到，而且
# Windows PowerShell 5.1 用 -File 调用时 $PSScriptRoot 会是空串 —— 于是
# Split-Path -Parent $null 直接抛 "Cannot bind argument to parameter 'Path'
# because it is null"，报错长得完全不像路径问题。
#
# ★ 另一个坑：$PSCommandPath / $MyInvocation.MyCommand.Path 是**脚本文件的完整路径**，
#   不是目录。早先直接把它们当 $here 用，结果 $root 算成了 ...\scripts 自己，
#   于是后面所有相对路径（node_modules、release）全落到 scripts\ 下，一个都找不到。
#   现在统一先归一成目录，再取上一级。
$here = $PSScriptRoot
if (-not $here -and $PSCommandPath) { $here = Split-Path -Parent $PSCommandPath }
if (-not $here -and $MyInvocation.MyCommand.Path) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $here) { $here = (Get-Location).Path }
$root = Split-Path -Parent $here
if (-not $root) { $root = $here }
Set-Location $root
Write-Host "脚本目录：$here"
Write-Host "项目根：$root"

# 本机 node 的真实路径。DSH 运行时自带的那个，全局 PATH 里没有 node。
$node = 'C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { throw "找不到 node：$node" }

function Step($title) { Write-Host "`n=== $title ===" -ForegroundColor Cyan }

if (-not $SkipChecks) {
  Step 'typecheck（主进程）'
  & $node 'node_modules/typescript/bin/tsc' --noEmit -p tsconfig.node.json
  if ($LASTEXITCODE -ne 0) { throw "typecheck(node) 失败，exit $LASTEXITCODE" }

  Step 'typecheck（渲染层）'
  & $node 'node_modules/typescript/bin/tsc' --noEmit -p tsconfig.web.json
  if ($LASTEXITCODE -ne 0) { throw "typecheck(web) 失败，exit $LASTEXITCODE" }
}

Step '构建（electron-vite build）'
& $node 'node_modules/electron-vite/bin/electron-vite.js' build
if ($LASTEXITCODE -ne 0) { throw "构建失败，exit $LASTEXITCODE" }

Step '打包（electron-builder --win --x64）'

# 不签名（没有证书，不探测以免卡在证书发现上）。
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
# 走国内镜像，否则下载 electron 与 nsis 二进制会挂很久。
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
# VPN 在 65535。
$env:HTTP_PROXY = 'http://127.0.0.1:65535'
$env:HTTPS_PROXY = 'http://127.0.0.1:65535'
# 关键：DSH 环境里这个变量是 1，子进程继承后 electron 会退化成用 Node 跑。
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

& $node 'node_modules/electron-builder/out/cli/cli.js' --win --x64 --config electron-builder.yml
if ($LASTEXITCODE -ne 0) { throw "打包失败，exit $LASTEXITCODE" }

Step '产物'
Get-ChildItem 'release\*.exe', 'release\*.blockmap' -ErrorAction SilentlyContinue | ForEach-Object {
  $sha = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  '{0}  {1:N2} MB  SHA256 {2}' -f $_.FullName, ($_.Length / 1MB), $sha
}
