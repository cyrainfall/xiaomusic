#!/usr/bin/env bash
# 把打过补丁的 xiaomusic 源码覆盖进某个虚拟环境的站点包。
#
# 为什么需要它：xiaomusic 的补丁不止 tools/patches/apply_patches.py 里那两处
# 文本替换 —— agent_bridge / 非音乐闸门 / 推流续播这些都改在 xiaomusic/*.py
# 本身。只要谁在某个 venv 里 `pip install -U xiaomusic`，站点包就会退回原版，
# 表现是「开风扇」被当点歌、先念一句「好的，正在找歌」。2026-11-13 就是这么
# 复发的：跑着的是仓库 .venv（原版），补丁只在 ~/.dsh/xiaomusic/.venv 里。
#
# 用法：
#   tools/patch-venv.sh                 # 默认打仓库 .venv
#   tools/patch-venv.sh ~/.dsh/xiaomusic/.venv
#   tools/patch-venv.sh --check         # 只检查，不写文件
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/xiaomusic"

FILES=(
  agent_bridge.py
  command_handler.py
  config.py
  device_player.py
  xiaomusic.py
  api/routers/device.py
)

MODE="apply"
VENV="$ROOT/.venv"
# 参数可以任意顺序：tools/patch-venv.sh --check ~/.dsh/xiaomusic/.venv
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) VENV="$arg" ;;
  esac
done

# Windows venv 用 Lib/site-packages，Linux/macOS 用 lib/pythonX.Y/site-packages
if [ -d "$VENV/Lib/site-packages/xiaomusic" ]; then
  SITE="$VENV/Lib/site-packages/xiaomusic"
else
  SITE="$(ls -d "$VENV"/lib/python*/site-packages/xiaomusic 2>/dev/null | head -1 || true)"
fi

if [ -z "${SITE:-}" ] || [ ! -d "$SITE" ]; then
  echo "[ERR] 找不到站点包（venv=$VENV）。先在这个环境里 pip install xiaomusic。" >&2
  exit 2
fi

echo "源码: $SRC"
echo "站点: $SITE"

missing=0
for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then
    echo "[SKIP] 源文件不存在: $f"
    continue
  fi
  if cmp -s "$SRC/$f" "$SITE/$f"; then
    echo "[OK]   $f 已是最新"
    continue
  fi
  if [ "$MODE" = "check" ]; then
    echo "[DIFF] $f 与源码不一致（需要重打）"
    missing=$((missing + 1))
    continue
  fi
  mkdir -p "$(dirname "$SITE/$f")"
  cp "$SRC/$f" "$SITE/$f"
  echo "[DONE] $f 已覆盖"
done

if [ "$MODE" = "check" ]; then
  if [ "$missing" -gt 0 ]; then
    echo
    echo "有 $missing 个文件是原版：非音乐口令会被当点歌处理。"
    echo "修：tools/patch-venv.sh \"$VENV\" 然后重启服务。"
    exit 1
  fi
  echo "全部已打补丁。"
  exit 0
fi

echo
echo "覆盖完成。要让改动生效，必须重启这个环境跑着的 xiaomusic。"
echo "验证：curl -s http://127.0.0.1:8090/getsetting | grep -c agent_bridge_non_music_patterns  # 应为 1"
