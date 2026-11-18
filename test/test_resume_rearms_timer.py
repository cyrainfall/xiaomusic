"""TTS 打断外部推流后，必须把「下一首」定时器重建回来。

背景（用户报的场景）：
    1. 「小爱同学，播放许嵩的歌」   -> 插件推一首，xiaomusic 按时长排好下一首定时器
    2. 「小爱同学，半个小时后关闭音乐」-> 确认语 TTS 打断推流
       TTS 说完要 stop(notts)，而 stop 里会 cancel_group_next_timer()
    3. resume_pushed_url() 把歌重新推一遍，但当时没有重建定时器
    结果：这一首放完就彻底静音，表现成「只播放完当前歌曲，没有续播」。

修法：play_url 记住这条推流的时长（_pushed_duration），恢复推流后按它重建
「下一首」定时器（重新推流等于从头播，所以用完整时长）。

用法：
    .venv\\\\Scripts\\\\python.exe test/test_resume_rearms_timer.py
"""

import asyncio
import io
import sys
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xiaomusic.device_player import XiaoMusicDevice
from xiaomusic.xiaomusic import XiaoMusic

URL = "http://example.invalid/song.mp3"


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


def make_device(duration=239, delay_sec=0):
    """不跑 __init__，只装上恢复推流用到的那几个字段。"""
    dev = XiaoMusicDevice.__new__(XiaoMusicDevice)
    dev.device = type("D", (), {"did": "425774956", "play_type": 2})()
    dev.config = type("C", (), {"delay_sec": delay_sec})()
    dev.log = QuietLog()
    dev._pushed_url = URL
    dev._pushed_duration = duration
    dev._next_timer = None
    dev._stop_timer = None
    dev.pushed = []
    dev.timers = []

    async def group_player_play(url, name=""):
        dev.pushed.append(url)

    async def set_next_music_timeout(sec):
        dev.timers.append(sec)

    dev.group_player_play = group_player_play
    dev.set_next_music_timeout = set_next_music_timeout
    return dev


class Case:
    def __init__(self):
        self.failures = 0

    def check(self, name, ok, detail=""):
        if not ok:
            self.failures += 1
        print(f"{'OK ' if ok else 'BAD'} {name}" + (f"  <- {detail}" if detail else ""))


async def case_resume_rearms(c):
    dev = make_device()
    ok = await dev.resume_pushed_url()
    c.check("resume_after_tts   重新推流 + 重建定时器",
            ok is True and dev.pushed == [URL] and dev.timers == [239],
            f"pushed={dev.pushed} timers={dev.timers}")


async def case_delay_sec(c):
    dev = make_device(delay_sec=2)
    await dev.resume_pushed_url()
    c.check("delay_sec         定时器含 delay_sec",
            dev.timers == [241], f"timers={dev.timers}")


async def case_no_url(c):
    dev = make_device()
    dev._pushed_url = ""
    ok = await dev.resume_pushed_url()
    c.check("no_url            没有推流就不动",
            ok is False and dev.pushed == [] and dev.timers == [],
            f"pushed={dev.pushed} timers={dev.timers}")


async def case_unknown_duration(c):
    dev = make_device(duration=0)
    ok = await dev.resume_pushed_url()
    c.check("unknown_duration  照常恢复播放，但不瞎排定时器",
            ok is True and dev.pushed == [URL] and dev.timers == [],
            f"pushed={dev.pushed} timers={dev.timers}")


async def case_user_stop_clears(c):
    dev = make_device()
    dev._clear_pushed()
    ok = await dev.resume_pushed_url()
    c.check("user_stop         用户停过的歌不会被 TTS 捡回来",
            ok is False and dev._pushed_url == "" and dev._pushed_duration == 0
            and dev.pushed == [],
            f"pushed={dev.pushed}")


async def case_play_url_records(c):
    dev = make_device(duration=0)
    fake_self = type("XM", (), {})()
    fake_self.log = QuietLog()
    fake_self.config = type("C", (), {"delay_sec": 0})()
    fake_self.device_manager = type("DM", (), {"devices": {"did": dev}})()

    async def settle_before_play(timeout=10.0):
        return None

    dev.settle_before_play = settle_before_play
    await XiaoMusic.play_url(fake_self, did="did", arg1=URL, duration=200)
    c.check("play_url          记住时长并排定时器",
            dev._pushed_duration == 200 and dev.timers == [200],
            f"duration={dev._pushed_duration} timers={dev.timers}")

    # 记住的时长正是恢复时用的那个：这是整条链的关键
    dev.timers.clear()
    await dev.resume_pushed_url()
    c.check("play_url -> resume 时长接力",
            dev.timers == [200], f"timers={dev.timers}")


async def case_delayed_stop_tts(c):
    dev = make_device()
    spoken = []

    async def do_tts(value, resume_after=False):
        spoken.append((value, resume_after))

    dev.do_tts = do_tts
    await dev.stop_after_minute(30, tts_text="收到,30分钟后关闭音乐")
    c.check("stop_after_minute 确认语只说关音乐，且说完要接着放",
            spoken == [("收到,30分钟后关闭音乐", True)],
            f"spoken={spoken}")
    if dev._stop_timer is not None:
        dev._stop_timer.cancel()

    dev2 = make_device()
    spoken2 = []

    async def do_tts2(value, resume_after=False):
        spoken2.append((value, resume_after))

    dev2.do_tts = do_tts2
    await dev2.stop_after_minute(30)
    c.check("stop_after_minute 缺省文案仍是原来的",
            spoken2 == [("收到,30分钟后将关机", True)], f"spoken={spoken2}")
    if dev2._stop_timer is not None:
        dev2._stop_timer.cancel()


async def main():
    c = Case()
    await case_resume_rearms(c)
    await case_delay_sec(c)
    await case_no_url(c)
    await case_unknown_duration(c)
    await case_user_stop_clears(c)
    await case_play_url_records(c)
    await case_delayed_stop_tts(c)
    print(f"\nFAILURES: {c.failures}")
    return 1 if c.failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
