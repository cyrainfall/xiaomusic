"""非音乐口令不接管：路由判定 + do_check_cmd 行为验证。

背景：小爱音箱的对话会被 xiaomusic 轮询到，播放类口令转发给插件的大模型。
原来的兜底逻辑会把「六点二十叫我起床」也转发过去，xiaomusic 先
`group_force_stop_xiaoai()` 掐掉小爱的回答，再让模型用 TTS 顶一句
「抱歉，我只能帮你放歌」—— 用户的闹钟就没了。

这里锁住两条边界：
1. 非音乐口令（闹钟/天气/时间/家电/闲聊）既不转发大模型，也不动作；
2. 播放/问歌口令、延时关闭、音量这些原有能力一条都不能少。

用法：
    .venv\\Scripts\\python.exe test\\test_non_music_routing.py
"""

import asyncio
import io
import sys
from pathlib import Path

# Windows 控制台默认 GBK，中文用例名会变成乱码
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xiaomusic.agent_bridge import AgentBridge
from xiaomusic.command_handler import CommandHandler
from xiaomusic.config import Config


class QuietLog:
    def info(self, msg):
        pass

    def debug(self, msg):
        pass

    def warning(self, msg):
        pass

    def exception(self, msg):
        pass


class FakeDevice:
    """记录 xiaomusic 对设备做过什么，用来断言「什么都没做」。"""

    def __init__(self):
        self.is_playing = False
        self._pending_selection = None
        self.device = type("D", (), {"play_type": 0, "name": "小爱音箱"})()

    def __getattr__(self, name):
        # 任何没显式实现的设备方法都返回一个记录调用的协程函数
        def record(*args, **kwargs):
            calls = object.__getattribute__(self, "_calls")
            calls.append(name)

            async def done(*_a, **_k):
                return None

            return done()

        return record


class FakeXiaoMusic:
    def __init__(self, bridge):
        self.agent_bridge = bridge
        self.device_manager = type("DM", (), {"devices": {}})()
        self.touched = []
        self.delegated = []

    async def stop_after_minute(self, did="", arg1=0, **kwargs):
        self.touched.append(("stop_after_minute", arg1))

    async def set_volume(self, did="", arg1=0, **kwargs):
        self.touched.append(("set_volume", arg1))

    async def do_tts(self, *args, **kwargs):
        self.touched.append(("do_tts", args))

    async def play_url(self, *args, **kwargs):
        self.touched.append(("play_url", args))

    async def stop(self, *args, **kwargs):
        self.touched.append(("stop", args))


async def check(cfg, phrase, *, expect_delegate, expect_silent):
    bridge = AgentBridge(lambda: cfg, QuietLog())
    xm = FakeXiaoMusic(bridge)

    async def fake_delegate(did, device, query):
        xm.delegated.append(query)
        return True

    handler = CommandHandler(cfg, QuietLog(), xm)
    handler.delegate_to_agent = fake_delegate

    device = FakeDevice()
    device._calls = []
    xm.device_manager.devices["did"] = device

    await handler.do_check_cmd(did="did", query=phrase, ctrl_panel=False)

    delegated = bool(xm.delegated)
    forced_stop = "group_force_stop_xiaoai" in device._calls
    spoke = any(c[0] == "do_tts" for c in xm.touched)

    problems = []
    if delegated != expect_delegate:
        problems.append(f"delegate={delegated} 期望 {expect_delegate}")
    if expect_silent and forced_stop:
        problems.append("掐掉了小爱（group_force_stop_xiaoai）")
    if expect_silent and spoke:
        problems.append("用 TTS 顶了一句")
    return problems


async def main():
    cfg = Config()
    cfg.enable_agent_bridge = True
    cfg.agent_bridge_tts = "好的，正在找歌"

    # (口令, 是否该转发大模型, 是否要求「什么都不做」)
    cases = [
        # —— 非音乐：绝不能接管，也不能掐小爱 ——
        ("小爱同学 半个小时后关闭叫我起床", False, True),
        ("半个小时后关闭叫我起床", False, True),
        ("六点二十叫我起床", False, True),
        ("半小时后叫我起床", False, True),
        ("设置一个早上七点的闹钟", False, True),
        ("明天天气怎么样", False, True),
        ("现在几点了", False, True),
        ("打开客厅的灯", False, True),
        ("讲个笑话", False, True),
        ("你是谁", False, True),
        # —— 音乐：照旧转发 ——
        ("播放稻香", True, False),
        ("来点周杰伦", True, False),
        ("放首素颜", True, False),
        ("我想听许嵩的歌", True, False),
        ("许嵩的歌", True, False),
        ("在放什么", True, False),
        ("播放起床闹铃", True, False),
    ]

    failures = 0
    for phrase, expect_delegate, expect_silent in cases:
        problems = await check(
            cfg,
            phrase,
            expect_delegate=expect_delegate,
            expect_silent=expect_silent,
        )
        mark = "OK " if not problems else "BAD"
        if problems:
            failures += 1
        detail = f"  <- {'；'.join(problems)}" if problems else ""
        print(f"{mark} delegate={expect_delegate!s:5} | {phrase}{detail}")

    # —— 原有本地能力回归：延时关闭、音量 ——
    bridge = AgentBridge(lambda: cfg, QuietLog())
    local = [
        ("半小时后关闭音乐", "stop_after_minute", 30),
        ("30分钟后关机", "stop_after_minute", 30),
        ("一分钟后关闭音乐", "stop_after_minute", 1),
        ("音量调到百分之二十", "set_volume", 20),
    ]
    for phrase, action, value in local:
        xm = FakeXiaoMusic(bridge)
        xm.device_manager.devices["did"] = FakeDevice()
        h = CommandHandler(cfg, QuietLog(), xm)
        await h.do_check_cmd(did="did", query=phrase, ctrl_panel=False)
        hit = any(c[0] == action and c[1] == value for c in xm.touched)
        if not hit:
            failures += 1
        print(f"{'OK ' if hit else 'BAD'} {action}={value} | {phrase}")

    print(f"\nFAILURES: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
