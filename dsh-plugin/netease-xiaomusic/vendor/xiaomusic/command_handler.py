"""命令处理模块

负责语音指令的解析、匹配和路由。
"""

import asyncio
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from xiaomusic.xiaomusic import XiaoMusic
from xiaomusic.config import KEY_WORD_ARG_BEFORE_DICT
from xiaomusic.const import PLAY_TYPE_RND
from xiaomusic.utils.text_utils import chinese_to_number

if TYPE_CHECKING:
    pass


class CommandHandler:
    """命令处理器

    负责解析用户的语音指令，匹配对应的命令，并路由到相应的处理方法。
    """

    def __init__(self, config, log, xiaomusic_instance: "XiaoMusic"):
        """初始化命令处理器

        Args:
            config: 配置对象
            log: 日志对象
            xiaomusic_instance: XiaoMusic 主类实例，用于调用命令执行方法
        """
        self.config = config
        self.log = log
        self.xiaomusic = xiaomusic_instance
        self.last_cmd = ""

    async def do_check_cmd(self, did="", query="", ctrl_panel=True, **kwargs):
        """检查并执行命令
        这是命令处理的入口方法，负责：
        1. 记录命令
        2. 匹配命令
        3. 执行对应的方法
        4. 处理未匹配的情况

        Args:
            did: 设备ID
            query: 用户查询/命令
            ctrl_panel: 是否来自控制面板
            **kwargs: 其他参数
        """
        self.log.info(f"收到消息:{query} 控制面板:{ctrl_panel} did:{did}")

        # 记录最后一条命令
        self.last_cmd = query

        try:
            device = self.xiaomusic.device_manager.devices[did]

            # 「半小时后关闭音乐」这类延时关闭：先识别时间，别被「关闭音乐」当成立即停止
            minutes = self.parse_stop_delay(query)
            if minutes is not None:
                self.log.info(f"识别为延时关闭: {minutes} 分钟后 (原句:{query!r})")
                await self.xiaomusic.stop_after_minute(did=did, arg1=minutes)
                return

            # 「音量调整为20%」这类音量口令：本地直接调，别交给大模型（会先念一句找歌）
            volume = self.parse_volume(query)
            if volume is not None:
                kind, value = volume
                if kind == "delta":
                    current = int(await device.get_volume() or 0)
                    value = max(0, min(100, current + value))
                self.log.info(f"识别为音量调整: {value} (原句:{query!r})")
                await self.xiaomusic.set_volume(did=did, arg1=value)
                # 小爱应答「好的」时会抢占播放，应答完不一定把外部推流接回去
                asyncio.create_task(device.resume_pushed_url_if_stopped())
                return

            # 匹配命令
            opvalue, oparg = self.match_cmd(device, query, ctrl_panel)

            # 上一首/下一首：最近一次播放来自插件队列时，回到插件里走，而不是本地列表
            if opvalue in ("play_next", "play_prev"):
                if await self.advance_agent_queue(did, device, opvalue):
                    return

            # 明确的非音乐口令（闹钟/天气/时间/家电/闲聊…）：不归 xiaomusic 管。
            # 直接放行，让音箱自己的语音助手接着答 —— 这里绝不能
            # `group_force_stop_xiaoai()`，否则小爱的「好的，已定好闹钟」会被掐掉。
            if self.is_passthrough_to_xiaoai(query, opvalue, ctrl_panel):
                self.log.info(f"非音乐口令，交还小爱: {query!r}")
                return

            # 播放类口令优先交给大模型（见 agent_bridge.py）；失败则回落原逻辑
            if self.should_delegate(query, opvalue, ctrl_panel):
                if await self.delegate_to_agent(did, device, query):
                    return
                if not opvalue:
                    await asyncio.sleep(1)
                    await device.check_replay()
                    return

            if not opvalue:
                # 未匹配到命令，等待后检查是否需要重播
                await asyncio.sleep(1)
                await device.check_replay()
                return

            # 执行命令前先停止小爱，避免播放"不支持"提示
            await device.group_force_stop_xiaoai()

            # 执行命令
            func = getattr(self.xiaomusic, opvalue)
            await func(did=did, arg1=oparg)

        except Exception as e:
            self.log.exception(f"Execption {e}")

    def parse_stop_delay(self, query):
        """把「半小时后关闭音乐」解析成分钟数；不是延时关闭则返回 None。

        支持：半小时 / 半个小时 / 1小时 / 一个小时 / 两小时 / 30分钟 / 十分钟，
        后面跟「后/以后/之后」以及关闭类动词（关闭音乐、关掉、停止、关机）。

        关闭动词后面只允许跟「音乐/播放/了/吧」这类收尾词。否则
        「半个小时后关闭叫我起床」会被误判成延时关机 —— 用户要的是闹钟，
        不是关机，被 xiaomusic 吞掉就等于闹钟没设成。
        """
        q = (query or "").strip()
        if not q:
            return None

        # 带闹钟/提醒意图的句子一律不碰：那是小爱自己的事
        bridge = getattr(self.xiaomusic, "agent_bridge", None)
        if bridge is not None and bridge.is_non_music_intent(q):
            return None

        pattern = (
            r"(半|[\d零一二两三四五六七八九十百]+)\s*(?:个)?\s*(小时|分钟)"
            r"\s*(?:以后|之后|后)\s*(?:关闭|关掉|停止|关|关机)"
            r"\s*(?:音乐|歌曲|播放|小爱)?\s*[了吧啊哦呀。！!.，,~]*\s*$"
        )
        match = re.search(pattern, q)
        if not match:
            return None

        raw, unit = match.group(1), match.group(2)
        if raw == "半":
            count = 0.5
        else:
            try:
                count = int(raw)
            except ValueError:
                try:
                    # 「两」「〇」不在数字表里，先归一化再解析
                    count = chinese_to_number(raw.replace("两", "二").replace("〇", "零"))
                except (KeyError, ValueError):
                    return None
                if count <= 0:
                    return None

        minutes = int(round(count * 60)) if unit == "小时" else int(round(count))
        return minutes if minutes > 0 else None

    def parse_volume(self, query):
        """把音量口令解析成 (类型, 数值)；不是音量口令返回 None。

        类型 `abs` 是目标音量，`delta` 是相对增减（「声音大一点」）。
        这句本来会被当成「没匹配到指令」兜底进大模型，先念一句「好的，正在找歌」
        才轮到模型去调音量 —— 所以必须在 `match_cmd` 之前拦下来本地执行。
        """
        q = (query or "").strip()
        if not q:
            return None

        # 「播放小声说爱你」是点歌，不是调音量：播放类口令一律不进这里
        if re.match(
            r"^(播放|放一首|放点|放个|来一首|来点|来段|我想听|想听|换一首|换一个|再放|再来一首|听一下|听首|整一首|搜一下)",
            q,
        ):
            return None

        word = re.search(r"(音量|声音|喇叭|音响)", q)
        # 没有音量词的「大声点」只认句首短指令，免得撞上歌名
        standalone = re.match(r"^(?:大声|小声)(?:点|一点|些|再|吧|啊|$)", q)
        mute = re.search(r"(静音|别出声|关掉声音)", q)
        if not word and not standalone and not mute:
            return None

        louder = re.search(r"(大一点|大点|大声|调大|加大|增大|提高|高一点)", q)
        quieter = re.search(r"(小一点|小点|小声|调小|减小|降低|关小|低一点)", q)
        if not (louder or quieter or mute) and not re.search(
            r"(\d|[零一二两三四五六七八九十百]|百分之|最大|最高|最小|最低)", q
        ):
            # 只说了「音量」两个字，没方向也没数值
            return None

        if re.search(r"(最大|最高|调满|拉满|开满)", q):
            return ("abs", 100)
        if re.search(r"(最小|最低)", q):
            return ("abs", 1)
        if mute:
            return ("abs", 0)

        percent = re.search(r"(?:百分之|百分)\s*([0-9零一二两三四五六七八九十百]+)", q)
        if percent:
            value = self._volume_number(percent.group(1))
            return ("abs", value) if value is not None else None

        plain = re.search(r"(\d{1,3})\s*[%％]", q)
        if plain:
            return ("abs", max(0, min(100, int(plain.group(1)))))

        if louder or quieter:
            step = 10
            delta = re.search(r"(\d{1,2}|[一二两三四五六七八九十]+)\s*(?:点|格|个)", q)
            if delta:
                amount = self._volume_number(delta.group(1))
                # 「大一点」里的「一」是语气词，不是 1%
                if amount and amount > 1:
                    step = amount
            return ("delta", step if louder else -step)

        # 兜底：「音量 20」这种只说数字的
        rest = re.sub(r"(音量|声音|喇叭|音响)", " ", q)
        raw = re.search(r"(\d{1,3}|[零一二两三四五六七八九十百]{1,5})", rest)
        if not raw:
            return None
        value = self._volume_number(raw.group(1))
        return ("abs", value) if value is not None else None

    def _volume_number(self, raw):
        """把「20」「二十」这类写法转成 0-100 的整数，无效返回 None。"""
        text = str(raw or "").strip()
        if not text:
            return None
        if text.isdigit():
            value = int(text)
        else:
            try:
                value = chinese_to_number(text.replace("两", "二").replace("〇", "零"))
            except (KeyError, ValueError):
                return None
        if value is None or value < 0:
            return None
        return max(0, min(100, int(value)))

    async def advance_agent_queue(self, did, device, opvalue):
        """「上一首/下一首」优先问插件队列；插件没有队列时返回 False 回落本地。"""
        bridge = getattr(self.xiaomusic, "agent_bridge", None)
        if bridge is None or not bridge.is_enabled():
            return False

        direction = "next" if opvalue == "play_next" else "prev"
        # 跟随 xiaomusic 的播放模式：随机播放时「下一首」也从队列里随机取
        random_mode = getattr(device.device, "play_type", None) == PLAY_TYPE_RND
        try:
            song = await bridge.advance(did, direction, random=random_mode)
        except Exception:
            self.log.exception("agent_bridge 队列切换失败")
            return False
        if not song:
            return False

        await device.group_force_stop_xiaoai()
        await self.xiaomusic.play_url(
            did=did,
            arg1=song.get("playUrl") or "",
            duration=int(song.get("durationSec") or 0),
        )
        self.log.info(
            f"agent_bridge 队列 {direction}{'(random)' if random_mode else ''} 已推送 did={did}"
        )
        return True

    def is_passthrough_to_xiaoai(self, query, opvalue, ctrl_panel):
        """这条口令是不是「跟音乐无关、应该让小爱自己答」。

        只有同时满足下面几点才算：不是控制面板输入、没命中任何口令、
        没有播放/问歌意图、且命中了非音乐词表（闹钟/天气/时间/家电/闲聊…）。

        命中后 xiaomusic 什么都不做：不掐小爱、不念 TTS、不问大模型。
        """
        if ctrl_panel or opvalue:
            return False

        bridge = getattr(self.xiaomusic, "agent_bridge", None)
        if bridge is None:
            return False
        if bridge.is_play_intent(query) or bridge.is_query_intent(query):
            return False
        return bridge.is_non_music_intent(query)

    def should_delegate(self, query, opvalue, ctrl_panel):
        """这条口令是否该交给大模型处理。

        优先级（高→低）：
        1. 确定性控制口令（下一首/音量/歌单…） —— 不进大模型
        2. 明确命中播放 / 问歌意图 —— 进大模型（控制面板输入同样适用）
        3. 明确的非音乐口令（闹钟/提醒/天气/时间/家电/闲聊…） —— 永不接管
        4. 其余未命中口令 —— 只在 agent_bridge_when="fallback" 时兜底

        第 3 条是硬闸：小爱自带的能力（设闹钟、报天气、开关灯）一旦被转发，
        xiaomusic 会先 `group_force_stop_xiaoai()` 掐掉小爱的回答，用户的闹钟
        也就设不成了。所以「非音乐对话不接管」不能靠大模型自觉，必须在这里挡。
        """
        bridge = getattr(self.xiaomusic, "agent_bridge", None)
        if bridge is None or not bridge.is_enabled():
            return False

        passthrough = getattr(self.config, "agent_bridge_passthrough", []) or []
        if opvalue and opvalue in passthrough:
            return False

        # 2. 播放 / 问歌意图优先：「播放起床闹铃」点了歌就是点歌
        if bridge.is_play_intent(query) or bridge.is_query_intent(query):
            return True

        # 控制面板是人在页面上点/敲的，其余情况保持原来的确定性行为
        if ctrl_panel:
            return False

        # 3. 明确的非音乐口令：不接管，留给小爱自己回答
        if bridge.is_non_music_intent(query):
            return False

        # 4. 没命中口令、但句子里提到了音乐（「许嵩的歌」）：交给大模型
        if not opvalue and bridge.mentions_music(query):
            return True

        # 5. 其余情况看配置：默认只接播放意图，不再无条件兜底
        when = getattr(self.config, "agent_bridge_when", "play_intent")
        if when == "always":
            return True
        return not opvalue and when in ("play_intent", "fallback")

    async def delegate_to_agent(self, did, device, query):
        """把口令交给大模型；返回是否已经处理完（True 表示调用方应直接返回）。"""
        bridge = getattr(self.xiaomusic, "agent_bridge", None)
        if bridge is None:
            return False

        try:
            # 先停掉小爱自己的回答，再播一句过渡语，掩盖模型往返的延迟。
            # 过渡语只在「点歌」时说；问「在放什么」不该先来一句「正在找歌」。
            await device.group_force_stop_xiaoai()
            tts_text = getattr(self.config, "agent_bridge_tts", "")
            if tts_text and bridge.is_play_intent(query):
                await self.xiaomusic.do_tts(did, tts_text)

            playing = None
            current = device.get_cur_music()
            if current:
                playing = {"name": current}

            result = await bridge.ask(did=did, query=query, device=device, playing=playing)
            if not result or not result.get("handled"):
                return False

            play_url = (result.get("playUrl") or "").strip()
            speak = (result.get("speak") or "").strip()
            self.log.info(
                f"agent_bridge 命中 action={result.get('action')} "
                f"playUrl={'yes' if play_url else 'no'} speak={speak!r}"
            )

            if play_url:
                await self.xiaomusic.play_url(
                    did=did, arg1=play_url, duration=int(result.get("durationSec") or 0)
                )
            elif speak:
                await self.xiaomusic.do_tts(did, speak)
            return True
        except Exception:
            self.log.exception("agent_bridge 处理失败，回落到关键词逻辑")
            return False

    def match_cmd(self, device, query, ctrl_panel):
        """匹配命令

        根据用户输入的查询字符串，匹配对应的命令和参数。

        匹配策略：
        1. 优先完全匹配
        2. 然后按配置的优先级顺序进行模糊匹配
        3. 检查是否在激活命令列表中

        Args:
            device: 设备
            query: 用户查询字符串
            ctrl_panel: 是否来自控制面板

        Returns:
            tuple: (命令值, 命令参数)，未匹配返回 (None, None)
        """
        # 检查是否有待选择的歌曲
        if device._pending_selection:
            patternarg = r"^第?([零一二三四五六七八九十百千万亿]+)[个首条集]$"
            matcharg = re.match(patternarg, query)
            if matcharg:
                self.log.info(f"匹配到选择指令. query:{query}")
                return "select_index", query

        # 优先处理完全匹配
        opvalue = self.check_full_match_cmd(device, query, ctrl_panel)
        if opvalue:
            self.log.info(f"完全匹配指令. query:{query} opvalue:{opvalue}")
            # 自定义口令
            if opvalue.startswith("exec#"):
                code = opvalue.split("#", 1)[1]
                return "exec", code
            return opvalue, ""

        # 按优先级顺序进行模糊匹配
        for opkey in self.config.key_match_order:
            patternarg = rf"(.*){opkey}(.*)"
            # 匹配参数
            matcharg = re.match(patternarg, query)
            if not matcharg:
                continue

            argpre = matcharg.groups()[0]
            argafter = matcharg.groups()[1]
            self.log.debug(
                "matcharg. opkey:%s, argpre:%s, argafter:%s",
                opkey,
                argpre,
                argafter,
            )

            # 根据配置决定参数位置
            oparg = argafter
            if opkey in KEY_WORD_ARG_BEFORE_DICT:
                oparg = argpre

            opvalue = self.config.key_word_dict.get(opkey)

            # 检查是否在激活命令中
            active_cmd_arr = self.config.get_active_cmd_arr()
            if (
                not ctrl_panel
                and not device.is_playing
                and active_cmd_arr
                and opvalue not in active_cmd_arr
                and opkey not in active_cmd_arr
            ):
                self.log.info(f"不在激活命令中 {opvalue}")
                continue

            self.log.info(f"匹配到指令. opkey:{opkey} opvalue:{opvalue} oparg:{oparg}")

            # 自定义口令
            if opvalue.startswith("exec#"):
                code = opvalue.split("#", 1)[1]
                return "exec", code
            return opvalue, oparg

        self.log.info(f"未匹配到指令 {query} {ctrl_panel}")
        return None, None

    def check_full_match_cmd(self, device, query, ctrl_panel):
        """检查是否完全匹配命令

        检查查询字符串是否与配置的命令关键词完全一致。

        Args:
            device: 设备
            query: 用户查询字符串
            ctrl_panel: 是否来自控制面板

        Returns:
            str: 匹配的命令值，未匹配返回 None
        """
        if query not in self.config.key_match_order:
            return None

        active_cmd_arr = self.config.get_active_cmd_arr()
        opvalue = self.config.key_word_dict.get(query)
        # 控制面板/正在播放时允许执行/是否在激活命令中
        if (
            ctrl_panel
            or device.is_playing
            or not active_cmd_arr
            or opvalue in active_cmd_arr
        ):
            return opvalue
