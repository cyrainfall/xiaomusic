@echo off
chcp 65001 >nul
cd /d "%~dp0"
title XiaoMusic
echo 正在启动 XiaoMusic ... 关闭此窗口即停止服务
".venv\Scripts\xiaomusic.exe" --config config.json
