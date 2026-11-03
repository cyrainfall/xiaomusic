#!/bin/bash
# 延迟重启 DSH Web，好让本轮回复先送达用户。
# 由 PowerShell Start-Process 拉起，与当前 Host 进程树脱钩：
# Host 被杀不会连带杀掉这个脚本。
set -u

LOG=/c/Users/cyx/.local/state/dsh-restart/manual-restart.log
mkdir -p "$(dirname "$LOG")"

sleep 8

{
  echo "=== $(date '+%F %T') 开始重启（用户要求：插件重载） ==="
  /c/Users/cyx/.local/bin/restart-dsh-cyx240.sh
} >>"$LOG" 2>&1
