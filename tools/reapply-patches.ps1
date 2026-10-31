# 重新应用 XiaoMusic 运行时补丁
# 用法: powershell -ExecutionPolicy Bypass -File tools\reapply-patches.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Error "未找到虚拟环境: $py，请先按 tools/README.md 安装依赖"
    exit 1
}

& $py (Join-Path $root "tools\patches\apply_patches.py")
