$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "conf"
$dst = Join-Path $src ".login-backup"
New-Item -ItemType Directory -Force -Path $dst | Out-Null

$copied = @()
foreach ($f in @("auth.json", ".mi.token")) {
    $p = Join-Path $src $f
    if ((Test-Path $p) -and ((Get-Item $p).Length -gt 0)) {
        Copy-Item $p (Join-Path $dst $f) -Force
        $copied += $f
    }
}
if ($copied.Count -gt 0) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') backed up: $($copied -join ', ')" |
        Out-File -Append -Encoding utf8 (Join-Path $dst "backup.log")
}
