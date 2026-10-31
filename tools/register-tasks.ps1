$root = "C:\Users\cyx\Documents\repository_git\xiaomusic"
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# --- 1. XiaoMusic task -> launcher script ---
$act = New-ScheduledTaskAction -Execute (Join-Path $root "tools\start-service.cmd") -WorkingDirectory $root
$trg = New-ScheduledTaskTrigger -AtLogOn -User $me
$prn = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 2 -RestartInterval ([TimeSpan]::FromMinutes(1))
Register-ScheduledTask -TaskName "XiaoMusic" -Action $act -Trigger $trg -Principal $prn -Settings $set -Force | Out-Null

# --- 2. login backup task every 10 minutes ---
$bakAct = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root "tools\backup-login.ps1") + '"') -WorkingDirectory $root
$bakTrg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$bakPrn = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "XiaoMusicLoginBackup" -Action $bakAct -Trigger $bakTrg -Principal $bakPrn -Force | Out-Null

Write-Output "== XiaoMusic =="
(Get-ScheduledTask -TaskName "XiaoMusic").Actions | Format-List Execute, Arguments
Write-Output "== XiaoMusicLoginBackup =="
(Get-ScheduledTask -TaskName "XiaoMusicLoginBackup").Actions | Format-List Execute, Arguments
