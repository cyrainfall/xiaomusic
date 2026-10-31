@echo off
rem XiaoMusic launcher: single instance + login-restore + PATH
setlocal
cd /d "%~dp0.."
set "ROOT=%CD%"
set "PATH=%ROOT%\ffmpeg\bin;%PATH%"

rem --- 1. single instance guard ---
netstat -ano | findstr ":8090" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [XiaoMusic] port 8090 already in use, another instance is running. Exit.
    exit /b 0
)

rem --- 2. restore login state if runtime files are missing ---
if not exist "conf\auth.json" if exist "conf\.login-backup\auth.json" (
    copy /y "conf\.login-backup\auth.json" "conf\auth.json" >nul
    echo [XiaoMusic] restored auth.json from backup
)
if not exist "conf\.mi.token" if exist "conf\.login-backup\.mi.token" (
    copy /y "conf\.login-backup\.mi.token" "conf\.mi.token" >nul
    echo [XiaoMusic] restored .mi.token from backup
)

rem --- 3. 按当前时间决定是否监听语音（02:00-10:00 不监听）---
if exist "conf\setting.json" if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" "tools\apply-listen-schedule.py" >> "tools\startup.log" 2>&1
)

rem --- 4. start ---
title XiaoMusic
".venv\Scripts\xiaomusic.exe" --config "config.json"
