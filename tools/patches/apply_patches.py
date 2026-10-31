"""重新应用 XiaoMusic 的运行时补丁（幂等）。

补丁针对 .venv/Lib/site-packages/xiaomusic 里的文件，
`pip install -U xiaomusic` 升级后需要重新执行一次。

用法：
    .venv\\Scripts\\python.exe tools\\patches\\apply_patches.py
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PKG = ROOT / ".venv" / "Lib" / "site-packages" / "xiaomusic"

# (相对包目录的路径, 旧文本, 新文本, 说明)
PATCHES = [
    (
        "api/routers/file.py",
        "timeout=aiohttp.ClientTimeout(total=600, sock_read=60)",
        "timeout=aiohttp.ClientTimeout(total=None, sock_read=120)",
        "放宽 B 站转码流超时（原 60s 断流 / 600s 硬切断）",
    ),
    (
        "js_plugin_manager.py",
        "    def enable_plugin(self, plugin_name: str) -> bool:\n"
        "        if plugin_name in self.plugins:\n",
        "    def enable_plugin(self, plugin_name: str) -> bool:\n"
        '        # 未启用的插件在启动时不会被加载，此处先补一个占位，避免"永远启用不了"\n'
        "        if plugin_name not in self.plugins:\n"
        '            self.plugins[plugin_name] = {"name": plugin_name, "enabled": False}\n'
        "        if plugin_name in self.plugins:\n",
        "允许在后台启用未加载的插件（原逻辑永远返回 false）",
    ),
]


def main() -> int:
    if not PKG.is_dir():
        print(f"[ERR] 未找到包目录: {PKG}")
        return 2

    changed = 0
    for rel, old, new, desc in PATCHES:
        path = PKG / rel
        if not path.is_file():
            print(f"[SKIP] {rel} 不存在")
            continue
        text = path.read_text(encoding="utf-8")
        if new in text:
            print(f"[OK]   {rel}: 已应用（{desc}）")
            continue
        if old not in text:
            print(f"[WARN] {rel}: 找不到目标代码，可能版本已变，需手工处理（{desc}）")
            continue
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
        changed += 1
        print(f"[DONE] {rel}: 已打补丁（{desc}）")

    if changed:
        print("\n补丁已写入，请重启 XiaoMusic 服务后生效：")
        print("    schtasks /end /tn XiaoMusic && schtasks /run /tn XiaoMusic")
    return 0


if __name__ == "__main__":
    sys.exit(main())
