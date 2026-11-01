"""大模型语音桥接模块

把「播放类」语音口令转发给 DSH 插件（`dsh-plugin/netease-xiaomusic`），由大模型
决定歌名与版本、解析直链，再把结论交回 xiaomusic 执行推流。

设计要点：
- 只做「转发 + 解析结果」，不在这里播放；
- 任何异常都返回 None，调用方回落到原有的关键词逻辑；
- 播放动作仍由 xiaomusic 在停掉小爱之后执行，保证顺序确定。
"""

from __future__ import annotations

import re
import time
import uuid

import aiohttp

BRIDGE_ERRORS = (
    aiohttp.ClientError,
    TimeoutError,
    ValueError,
)


class AgentBridge:
    """把语音口令转发给 DSH 插件。"""

    def __init__(self, config_provider, log):
        """
        Args:
            config_provider: 返回当前 Config 的函数（配置可能被热更新）
            log: 日志对象
        """
        self._config_provider = config_provider
        self.log = log
        # 最近一次播放由插件推进的设备：这些设备的「下一首/上一首」应回到插件队列
        self._queue_dids = set()

    @property
    def config(self):
        return self._config_provider()

    def is_enabled(self) -> bool:
        return bool(getattr(self.config, "enable_agent_bridge", False))

    def is_play_intent(self, query: str) -> bool:
        """是否是「想听歌」类口令（命中配置的正则即算）。"""
        q = (query or "").strip()
        if not q:
            return False
        for pattern in getattr(self.config, "agent_bridge_play_patterns", []) or []:
            try:
                if re.match(pattern, q):
                    return True
            except re.error:
                self.log.warning(f"agent_bridge: 非法的播放意图正则 {pattern!r}")
        return False

    async def ask(self, did: str, query: str, device=None, playing=None):
        """向插件发起一次语音请求。

        Args:
            did: 设备 did
            query: ASR 文本
            device: XiaoMusicDevice（可选，用于带上设备名与分组）
            playing: 当前播放信息（可选）

        Returns:
            dict | None: 插件返回的结构化结果；不可用时返回 None
        """
        if not self.is_enabled():
            return None

        url = getattr(self.config, "agent_bridge_url", "")
        if not url:
            return None

        request_id = uuid.uuid4().hex
        payload = {
            "requestId": request_id,
            "did": did,
            "deviceName": getattr(device, "device", None).name if device else "",
            "group": getattr(device, "group_name", "") if device else "",
            "query": query,
            "playing": playing or None,
        }
        headers = {"Content-Type": "application/json"}
        token = getattr(self.config, "agent_bridge_token", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"

        timeout_sec = max(1, int(getattr(self.config, "agent_bridge_timeout", 20)))
        started = time.time()
        try:
            timeout = aiohttp.ClientTimeout(total=timeout_sec)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, json=payload, headers=headers) as resp:
                    body = await resp.text()
                    if resp.status != 200:
                        self.log.warning(
                            f"agent_bridge: HTTP {resp.status} {body[:200]} query={query!r}"
                        )
                        return None
                    try:
                        import json

                        result = json.loads(body)
                    except ValueError:
                        self.log.warning(f"agent_bridge: 返回不是 JSON {body[:200]}")
                        return None
        except BRIDGE_ERRORS as exc:
            self.log.warning(f"agent_bridge: 请求失败 {exc} query={query!r}")
            return None

        elapsed_ms = int((time.time() - started) * 1000)
        self.log.info(
            f"agent_bridge: handled={result.get('handled')} action={result.get('action')} "
            f"elapsed={elapsed_ms}ms query={query!r}"
        )
        if result.get("playUrl"):
            self._queue_dids.add(did)
        return result

    # ── 队列控制：不经过大模型，直接问插件的候选列表 ──────────────────

    def has_queue(self, did: str) -> bool:
        """这台设备最近一次播放是否由插件推进（决定「下一首」走谁）。"""
        return did in self._queue_dids

    def disarm(self, did: str) -> None:
        """本地播放接管时调用：之后「下一首」回到本地逻辑，不再问插件。"""
        self._queue_dids.discard(did)

    async def forget(self, did: str) -> None:
        """停止后清掉队列，避免下次「下一首」还接着旧队列走。"""
        self._queue_dids.discard(did)
        await self._post_async("/forget", {"did": did})

    async def advance(self, did: str, direction: str = "next", random: bool = False):
        """让插件给出下一首/上一首的直链；不可用时返回 None 由调用方回落。

        返回插件原始结果（含 playUrl / song / durationSec），时长用于安排
        再下一首的定时器。不依赖本地标志：先问插件，队列空了自然回落，
        避免标志被本地播放清掉后「下一首」永久走错地方。
        """
        result = await self._post_async(f"/{direction}", {"did": did, "random": bool(random)})
        if not result or not result.get("handled"):
            self._queue_dids.discard(did)
            return None
        url = (result.get("playUrl") or "").strip()
        if not url:
            self._queue_dids.discard(did)
            return None
        self._queue_dids.add(did)
        self.log.info(
            f"agent_bridge: {direction} did={did} song={(result.get('song') or {}).get('name')} "
            f"duration={(result.get('durationSec') or 0)}s"
        )
        return result

    def _endpoint(self, path: str) -> str:
        base = str(getattr(self.config, "agent_bridge_url", "")).rstrip("/")
        for suffix in ("/ask", "/next", "/prev", "/forget"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        return base + path

    async def _post_async(self, path: str, payload: dict):
        headers = {"Content-Type": "application/json"}
        token = getattr(self.config, "agent_bridge_token", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        timeout_sec = max(1, int(getattr(self.config, "agent_bridge_timeout", 20)))
        try:
            timeout = aiohttp.ClientTimeout(total=timeout_sec)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    self._endpoint(path), json=payload, headers=headers
                ) as resp:
                    if resp.status != 200:
                        return None
                    return await resp.json(content_type=None)
        except BRIDGE_ERRORS as exc:
            self.log.warning(f"agent_bridge: {path} 失败 {exc}")
            return None
