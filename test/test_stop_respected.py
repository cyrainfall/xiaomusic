"""「关闭音乐」后不再自动续播：定时器判定逻辑的回归测试。

背景：xiaomusic 推完一首外部流会排一个「下一首」定时器，到点直接 `_play_next()`。
如果用户在小爱侧关掉了（语音口令被小爱自己吃掉、用 App 停、或夜间不监听时段），
xiaomusic 全程没收到 stop，定时器照旧把下一首推回去 —— 表现就是「关了音乐过几分钟
又自己响」。修法是旁路采样「最后一次确认在播」的时刻，用它与到点的差值区分：

- 自然播完：最后在播 ~到点前十几秒 → 继续下一首；
- 中途被关：最后在播停在关闭点 → 相差大半首歌 → 不续播。

用法：
    .venv\\Scripts\\python.exe test/test_stop_respected.py
"""

import asyncio
import io
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xiaomusic.const import PLAY_TYPE_SIN
from xiaomusic.device_player import XiaoMusicDevice


class QuietLog:
    def info(self, msg):
        pass

    def debug(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass

    def exception(self, msg):
        pass


class FakeBridge:
    def __init__(self):
        self.forgotten = []

    async def forget(self, did):
        self.forgotten.append(did)


def make_device():
    """不跑 __init__，只装上判定用到的那几个字段。"""
    dev = XiaoMusicDevice.__new__(XiaoMusicDevice)
    dev.device = type("D", (), {"play_type": 0, "did": "425774956"})()
    dev.is_playing = False
    dev._pushed_url = ""
    dev._next_timer = None
    dev._last_playing_at = 0.0
    dev._playback_watch = None
    dev._watch_armed = False
    dev.log = QuietLog()
    dev.bridge = FakeBridge()
    dev.xiaomusic = type("XM", (), {"agent_bridge": dev.bridge})()
    dev.stopped_calls = []

    async def fake_stop(arg1=""):
        dev.stopped_calls.append(arg1)

    dev.stop = fake_stop

    async def fake_play_next():
        dev.stopped_calls.append("play_next")

    dev._play_next = fake_play_next
    return dev


async def case(dev, *, armed, last_playing_ago, sec=200):
    """按给定状态跑一次定时器到点，返回走了哪条分支。"""
    dev._pushed_url = "http://example/stream.mp3"
    dev._watch_armed = armed
    dev._last_playing_at = time.time() - last_playing_ago
    dev.stopped_calls.clear()
    dev.bridge.forgotten.clear()

    # 把 sec 压到 0：直接验证到点分支，不真的等
    await XiaoMusicDevice.set_next_music_timeout(dev, 0)
    timer = dev._next_timer
    if timer is not None:
        try:
            await asyncio.wait_for(asyncio.shield(timer), timeout=2)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
    if dev.stopped_calls and dev.stopped_calls[0] == "play_next":
        return "advance"
    if dev.bridge.forgotten:
        return "respect_stop"
    return "other"


async def main():
    failures = 0

    checks = [
        # (名称, armed, 最后在播距今秒数, 期望分支)
        ("自然播完（最后在播 10s 前）", True, 10, "advance"),
        ("自然播完（最后在播 20s 前）", True, 20, "advance"),
        ("中途被关（最后在播 150s 前）", True, 150, "respect_stop"),
        ("中途被关（最后在播 600s 前）", True, 600, "respect_stop"),
        # 本地歌单没武装：永远照旧续播
        ("本地播放（未武装）", False, 600, "advance"),
    ]

    for name, armed, ago, expected in checks:
        dev = make_device()
        got = await case(dev, armed=armed, last_playing_ago=ago)
        ok = got == expected
        if not ok:
            failures += 1
        print(f"{'OK ' if ok else 'BAD'} {got:<13} 期望 {expected:<13} | {name}")

    # 单曲播放：仍然只停不续播
    dev = make_device()
    dev.device.play_type = PLAY_TYPE_SIN
    got = await case(dev, armed=True, last_playing_ago=10)
    ok = got == "other" and dev.stopped_calls == ["notts"]
    if not ok:
        failures += 1
    print(f"{'OK ' if ok else 'BAD'} {'single' if ok else got:<13} 期望 single        | 单曲播放只停不续播")

    print(f"\nFAILURES: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
