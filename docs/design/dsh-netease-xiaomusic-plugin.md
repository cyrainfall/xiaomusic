# 设计文档：DSH 插件「网易云音乐 × 小爱音箱」语音播放

| 项目 | 内容 |
| --- | --- |
| 状态 | **v0.21（零安装：插件自带 xiaomusic）** |
| 目标仓库 | `xiaomusic`（本仓库）+ 新增 DSH 插件包 |
| 关键依赖 | `@music163/ncm-cli` ≥ 0.1.7、DeepSeek Harness（DSH）Host 插件体系、xiaomusic HTTP API |
| 参考 | [ncm-cli 官网](https://music.163.com/st/ncmcli#setup)、[NetEase/skills](https://github.com/NetEase/skills) |

---

## 1. 背景与问题

### 1.1 现状链路

xiaomusic 目前通过「轮询小爱对话记录 → 关键词匹配 → 推 URL 给音箱」工作：

```
小爱音箱 --(语音)--> 小米云 ASR
      │
      └─ xiaomusic 轮询 LATEST_ASK_API 拿到 query 文本（conversation.py）
            │
            └─ CommandHandler.do_check_cmd(did, query)
                  ├─ 完全匹配 / 按 key_match_order 模糊匹配（command_handler.py）
                  │     └─ xiaomusic.play / play_next / set_volume ...
                  └─ 未命中 → device.check_replay()（基本等于丢弃）
```

播放落点：`XiaoMusic.play_url(did, url)` → `XiaoDevice.group_player_play(url)` → `mina_service.play_by_music_url(device_id, url)`，
即**音箱直接拉取一个 HTTP 音频 URL**。所以只要拿到「公网可访问的音频直链」，音箱就能播。

现有「AI 识别」仅有一处：`xiaomusic/utils/openai_utils.py:analyze_music_command()`，
用 qwen-flash 从口令中抽取 `{name, artist}`，供在线搜索使用。它只做信息抽取，**不做决策**：选哪首歌、从哪播、播不了怎么办，都不在它的职责内。

### 1.2 ncm-cli 现状（已核实）

| 项 | 结论 |
| --- | --- |
| 安装 | `npm i -g @music163/ncm-cli`，Node ≥ 18 |
| 凭证 | 开放平台 `appId` + `privateKey`，加密存于 `~/.config/ncm-cli/credentials.enc.json`；另有扫码登录态 |
| 播放后端 | 仅 `mpv` 或 `orpheus`（macOS 云音乐客户端），无「输出直链」后端 |
| 命令 | `play/pause/resume/stop/next/prev/seek/volume/queue/state/login/config/commands/cloudupload/cloud/diag/tui`，登录后动态注册 `search/playlist/note` 等 |
| 输出 | 全局 `--output json`（默认 json） |
| 约束 | 播放外命令需带 `--userInput "<意图摘要>"`；执行前需做内容安全审核；`visible=false` 的歌曲不可播 |

**关键缺口**：ncm-cli 能把歌播到本机 mpv，但**没有公开的「给我这首歌的音频直链」命令**（已用 0.1.7 实测静态命令树与 `state` 输出确认）。而这正是「让网易云经过 xiaomusic 给音箱播」的必需环节。第 6 节给出三级解析方案。

### 1.3 要解决的问题

用户说「小爱同学，播放稻香」时：

1. 大模型（而不是关键词表）判断这是不是「想听音乐 / 想控制播放」的意图；
2. 大模型自己决定歌名、歌手、版本（原唱 / live / 翻唱），必要时先搜后选；
3. 由 ncm-cli 承担网易云的鉴权、搜索、VIP 与音质语义；
4. 最终由 xiaomusic 把可播地址推给小爱音箱。

---

## 2. 目标与非目标

### 2.1 目标

- G1 **意图理解**：语音文本经大模型理解，支持「播放稻香」「来点周杰伦」「换一首」「大声点」「这首歌叫什么」等自然表达，不依赖关键词表。
- G2 **网易云优先**：搜索、鉴权、VIP/试听策略全部走 ncm-cli，不另起一套网易云 API 实现。
- G3 **经由 xiaomusic 出声**：播放动作落到 xiaomusic 的 `play_url` 通道，复用其设备/分组/音量/TTS 能力。
- G4 **失败可降级**：大模型、ncm-cli、直链任一环节失败时，回到 xiaomusic 原有行为，不出现「音箱静默卡死」。
- G5 **可独立验证**：插件同时支持「在 DSH 里直接对话触发」（Mode A），便于在不动 xiaomusic 的前提下验收工具链。

### 2.2 非目标

- N1 不做本地音乐库管理、不做歌词同步 UI。
- N2 不替代 xiaomusic 现有本地音乐 / MusicFree / LX 在线源，只做新增通道。
- N3 不做多用户隔离与云端部署，仍假设「一台机器 + 一个网易云账号 + 一个或少数几个音箱」。
- N4 不实现 ncm-cli 自身的安装向导（只做检测 + 明确报错）。
- N5 不做网易云歌单长期同步。
- N6 不做收藏 / 加入歌单 / 每日推荐等**写操作**（只读搜索 + 播放 + 控制）。

---

## 3. 总体架构

```
                       ┌──────────────────────── DSH Host 进程 ────────────────────────┐
                       │                                                              │
  用户语音             │   ┌──────────────────────────────────────────────────────┐   │
     │                 │   │ 插件 @local/netease-xiaomusic                        │   │
     ▼                 │   │                                                      │   │
 小爱音箱 ──ASR──▶ 小米云│   │  ┌────────────┐   ┌──────────────┐  ┌────────────┐  │   │
     ▲                 │   │  │ 语音 Agent │──▶│ 音乐工具集   │─▶│ ncm-cli    │  │   │
     │                 │   │  │ (会话池)   │   │ ncm_* /      │  │ 适配器     │  │   │
     │                 │   │  └─────▲──────┘   │ speaker_*    │  └─────┬──────┘  │   │
     │                 │   │        │          └──────┬───────┘        │         │   │
     │                 │   │  ┌─────┴────────┐        │                │         │   │
     │                 │   │  │ HTTP 路由    │        │                │         │   │
     │                 │   │  │ /dsh/netease │        │                │         │   │
     │                 │   │  │ -voice/ask   │        │                │         │   │
     │                 │   │  └─────▲────────┘        │                │         │   │
     │                 │   └────────┼─────────────────┼────────────────┼─────────┘   │
     │                 └────────────┼─────────────────┼────────────────┼─────────────┘
     │                              │                 │                │
     │                       (2) 结构化结果      (3) 播放/控制      (1) 搜索/解析直链
     │                              │                 │                │
     │                 ┌────────────┴─────────────────▼───────┐        │
     │                 │        xiaomusic (Python/FastAPI)    │        │
     │                 │  CommandHandler ──▶ play_url(did,url)│────────┘
     │                 │  /playtts /device_list /playingmusic │
     │                 └──────────────▲───────────────────────┘
     │                                │ (4) mina play_by_music_url(url)
     └────────────────────────────────┘
```

两条入口共用同一套工具与解析器：

- **Mode A（对话触发）**：用户在 DSH Web GUI / 任意会话里说「让小爱放稻香」，Agent 直接调用工具完成。
- **Mode B（语音触发，本需求主形态）**：小爱语音 → xiaomusic 匹配失败 → 转发给插件 HTTP 路由 → 语音 Agent 跑一轮 → 返回结论 → xiaomusic 执行 TTS + 播放。

---

## 4. 关键流程

### 4.1 Mode A：DSH 对话触发（M1 交付，无需改 xiaomusic）

```
用户: 让小爱放一首稻香
  │
  ├─ speaker_list            → [{did, name, group}] （xiaomusic /device_list）
  ├─ ncm_search("稻香 周杰伦") → [{name, artists, album, duration, encryptedId, originalId, visible}]
  ├─ ncm_play(songId=..., speaker="客厅") 
  │     ├─ resolveStream()  → http(s) 直链
  │     └─ POST xiaomusic /playurl?did=...&url=...   （Basic Auth）
  └─ 回复: 已在「客厅音箱」播放《稻香》- 周杰伦
```

### 4.2 Mode B：小爱语音触发（M2 交付，需 xiaomusic 小补丁）

```
小爱音箱 ──「播放稻香」──▶ 小米云
                                │
xiaomusic ConversationPoller ◀──┘  (query="播放稻香", did="xxx")
        │
        ├─ 路由判定（见 7.3）：硬控制口令走原逻辑；播放类口令一律转大模型
        ├─ enable_agent_bridge? 
        │     ├─ Yes → group_force_stop_xiaoai()   # 先打断小爱自己的回答
        │     ├─ do_tts("好的，正在找歌")           # 覆盖 2~4s 延迟（可配）
        │     └─ POST {bridge}/ask
        │              {requestId, did, deviceName, group, query}
        │                     │
        │                     ├─ 取/建该 did 的语音 Agent 会话
        │                     ├─ agent.followup(用户话术) ; await whenIdle()
        │                     │     ├─ ncm_search → ncm_play(defer=true) 只解析不播
        │                     │     └─ 写入本 requestId 的结果槽
        │                     └─ 返回 {handled, action, speak, playUrl, song}
        │
        ├─ handled=true  → play_url(did, playUrl)（有 speak 且无播放时 TTS）
        └─ handled=false → 关键词未命中则 check_replay()；命中则继续原命令
```

设计要点：

- **播放动作只有一个执行者**。语音链路中由 xiaomusic 在「停小爱之后」执行 `play_url`，保证顺序确定；插件通过 `deferPlay` 上下文开关让工具只解析不落地。对话链路中由工具直接调 xiaomusic API 播放。
- **结果不走自然语言**。工具把结构化结果写进 `requestId → 结果槽`，路由读槽返回；不解析模型回复文本，避免"模型说得漂亮但没播"。
- **超时即放弃**。路由 20 s 上限，Agent 回合 15 s 上限，超时返回 `handled=false`，xiaomusic 回落原逻辑。

---

## 5. DSH 插件设计

### 5.1 包结构

```
dsh-plugin/netease-xiaomusic/
├── package.json           # dsh.bundle.patch + exports + files
├── cordis.patch.yml       # 插入一行插件
├── index.js               # apply(ctx, config)：注册工具 / 路由 / 会话池
├── lib/
│   ├── ncm.js             # ncm-cli 适配器（exec、搜索、解析直链、错误归一）
│   ├── xiaomusic.js       # xiaomusic HTTP 客户端（Basic Auth、playurl、tts、devices）
│   ├── voice-agent.js     # 语音 Agent 会话池、互斥、超时、结果槽
│   ├── intent.js          # 意图提示词、工具白名单、结果规范化
│   └── log.js             # 带 requestId 的结构化日志（URL 脱敏）
├── locale/zh.json         # meta.title / meta.description（中文）
├── locale/en.json
└── icon.svg
```

`package.json` 关键字段：

```json
{
  "name": "@local/netease-xiaomusic",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["index.js", "lib/*.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: netease-xiaomusic
      name: '@local/netease-xiaomusic'
      config:
        xiaomusicBaseUrl: 'http://127.0.0.1:8090'
        voiceBridge:
          enabled: true
          host: '127.0.0.1'
          port: 3071
          token: ''
```

### 5.2 插件入口

```js
import z from '@deepseek-ai/schemastery'

export const name = 'netease-xiaomusic'
export const inject = ['tools', 'agents', 'agentLoop', 'systemPrompt']

export const Config = z.object({
  ncmCliPath: z.string().default('ncm-cli'),
  ncmTimeoutMs: z.number().default(10000),
  xiaomusicBaseUrl: z.string().default('http://127.0.0.1:8090'),
  xiaomusicUser: z.string().default(''),
  xiaomusicPassword: z.string().default(''),
  defaultSpeaker: z.string().default(''),          // did 或分组名
  streamResolver: z.string().default('auto'),      // auto | cookie | outer | xiaomusic
  netease: z.object({
    musicU: z.string().default(''),                // MUSIC_U cookie，敏感
    level: z.string().default('exhigh'),           // standard|higher|exhigh|lossless|hires
  }),
  voiceBridge: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().default(3071),
    token: z.string().default(''),
    agentTimeoutMs: z.number().default(15000),
    maxTurnsPerSession: z.number().default(50),
  }),
})

export function apply(ctx, config) { /* 注册工具、路由、会话池 */ }
```

约束（来自 Harness 插件规范）：所有注册资源必须在 `apply` 内通过 `ctx.effect` / `ctx.on` 创建并返回清理函数；`Config` 在激活时校验该行的 `config`。

### 5.3 工具定义（模型可见）⭐ 核心

用 `defineTool`（`@deepseek-ai/dsh-tools`）注册 6 个工具。**工具即产品**：描述必须写清「什么时候用、不要用它做什么、失败怎么办」。

| 工具 | 作用 | 主要参数 | 返回（规范化） |
| --- | --- | --- | --- |
| `ncm_search` | 搜歌/歌手/歌单，返回可播候选 | `keyword`(必填)、`type`=song\|artist\|playlist、`limit`≤10 | `{items:[{name, artists[], album, durationSec, encryptedId, originalId, visible, playFlag, vipFlag, fee, coverUrl}]}`（实测字段见 16.3） |
| `ncm_play` | 解析直链并播放（可按要求只解析） | `encryptedId`/`originalId` 或 `keyword`、`speaker`、`quality` | `{played:bool, song:{...}, speaker:{did,name}, url}` |
| `ncm_recommend` | 「播放音乐」这类没点名具体歌的请求：拉每日推荐整队列播放 | `count`(默认 30)、`speaker`、`level` | `{label:"每日推荐", items:[30], song, playUrl}` |
| `ncm_control` | 播放控制 | `action`=pause\|resume\|stop\|next\|prev\|seek\|volume、`value`、`speaker` | `{ok, state}` |
| `ncm_status` | 当前播放/设备状态 | `speaker` | `{device:{...}, status, song, positionSec, volume}` |
| `speaker_list` | 列出音箱与分组 | — | `{speakers:[{did, name, group, online}]}` |
| `speaker_say` | TTS 播报 | `text`(必填)、`speaker` | `{ok}` |

#### 5.3.1 泛播放 → 每日推荐 30 首（v0.23）

「播放音乐」「放点歌」「随便放点」「来点好听的」这类说法**没有点名歌名或歌手**。
按关键词搜歌只能搜到名字里正好含「音乐」的歌，等于瞎放（实测原型里会随机落到某个歌手）。

约定：**没点名具体需求 = 要今日推荐**。

```
「播放音乐」→ isGenericPlayRequest() 为真
        → netease.dailyRecommend()       # /api/v3/discovery/recommend/songs
        → 30 首整队列 queue.record(60 上限)
        → 从第 1 首开始播，「下一首」在这 30 首里接着走
```

- 判定在 `resolve.isGenericPlayRequest()`：剥掉动词/量词后只剩「音乐/歌/好听的/随便」
  这类词才算泛请求；「播放日语歌」「来点周杰伦」仍有需求，不算泛请求。
- `ncm_play` 收到泛词会自动转 `ncm_recommend`，不依赖模型记得换工具（提示词也写了）。
- 每日推荐按账号口味由网易云算好，不需要插件自己造推荐器；实测本机账号 30/30 可解析 320k 直链。
- 第一首若解析失败，往后挪最多 3 首再放弃，不因一首没版权让整条 30 首请求失败。
- 拿不到每日推荐（没 cookie / 未登录）时退回公开热歌榜，并在回话里说明；完全没 cookie 则
  明确指出需要 MUSIC_U（直链本身就必须 cookie）。


```js
import { defineTool } from '@deepseek-ai/dsh-tools'

tools.register(defineTool({
  name: 'ncm_play',
  description: [
    '在指定的小爱音箱上播放网易云音乐的歌曲。',
    '当用户想听某一首具体的歌、某位歌手的歌、或某个歌单时使用；',
    '只有歌名没有歌手时，先用 ncm_search 确认候选，避免播错版本。',
    '返回 played=false 时读 error 字段：未登录、VIP 受限、直链解析失败，不要盲目重试同一首歌。',
  ].join(''),
  parameters: {
    keyword: { type: 'string', description: '歌名或“歌名 歌手”，与 songId 二选一' },
    encryptedId: { type: 'string', description: 'ncm_search 返回的 32 位十六进制加密 ID' },
    originalId: { type: 'string', description: 'ncm_search 返回的数字原始 ID，用于生成网易云链接' },
    speaker: { type: 'string', description: '音箱名称、分组名或 did；省略时用插件配置的默认音箱' },
  },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        played: { type: 'boolean', required: true },
        url: { type: 'string' },
        song: { type: 'json' },
        speaker: { type: 'json' },
        error: { type: 'string' },
      },
    },
    render: (_args, v) => [{ type: 'text', text: v.played
      ? `已在「${v.speaker?.name ?? '音箱'}」播放：${v.song?.name} - ${v.song?.artists?.join('/')}`
      : `播放失败：${v.error}` }],
  },
  async execute(args, exec) { /* 见 5.4 */ },
}))
```

工具集刻意不含写操作（收藏、建歌单、每日推荐）：语音场景下写操作的确认成本高于收益，也避免大模型误操作账号（见非目标 N6）。

**工具描述原则**（避免模型乱用）：写明前置条件（先 search 再 play）、写明失败语义、写明范围（仅音乐，不处理其他设备指令）。

### 5.4 语音 Agent 会话池

```js
// voice-agent.js（要点）
const pools = new Map() // did -> { sessionId, turns, queue: Promise }

async function ask(did, query, opts) {
  const slot = pools.get(did) ?? createSlot(did)
  return slot.queue = slot.queue.then(() => runTurn(slot, query, opts))
}

async function runTurn(slot, query, opts) {
  const childCtx = ctx.effect(() => makeScopedCtx())     // 独立子上下文
  childCtx.tools.restrict({ allow: MUSIC_TOOLS })        // 语音 Agent 只能看到音乐工具
  childCtx.systemPrompt.section({ name: 'voice:persona', order: ..., text: VOICE_PROMPT })
  const handle = await ctx.agents.create({ sessionId, parentAgent: undefined, meta: { cwd } })
  const box = beginRequest(opts.requestId)               // requestId -> 结果槽
  handle.agent.followup(userMessage(query, opts))        // UserMessage: 语音文本 + 设备上下文
  await withTimeout(handle.agent.whenIdle(), cfg.agentTimeoutMs)
  return finishRequest(box)
}
```

- **一个音箱一个会话**：复用上下文，支持「再来一首」「换个版本」这类指代。
- **串行化**：同一 did 上排队，避免两次语音交叉播放。
- **轮次上限**：`turns > maxTurnsPerSession` 时清理并重建会话，控制上下文与成本。
- **工具面收敛**：`restrict({allow: [...]})`，语音 Agent 看不到 bash/文件/网络工具——这条是安全边界，不是优化。
- **失败语义**：会话创建失败 / 模型报错 / 超时 → `handled=false`，xiaomusic 回落原逻辑。

### 5.5 HTTP 桥接服务（给 xiaomusic 调）

**不复用 `ctx.webServer`**。实测 DSH Web 的 3080 端口被浏览器 cookie 认证网关守着（无 cookie 直接 401 `dsh web authentication required`），机器对机器调用拿不到那份 cookie；让 xiaomusic 去模拟浏览器登录是错误的方向。因此插件自带一个**仅回环的 HTTP 监听**：

```js
import { createServer } from 'node:http'

const server = createServer(async (req, res) => {
  // 1) 仅 POST {base}/ask；其余 404
  // 2) Authorization: Bearer <token>，timingSafeEqual 比较
  // 3) body ≤ 32KB，JSON 解析失败 400
  // 4) ask() 20s 总超时，超时 504
})
server.listen(config.voiceBridge.port, config.voiceBridge.host)  // 默认 127.0.0.1:3071
ctx.effect(() => () => server.close())
```

- 默认 `127.0.0.1`：xiaomusic 与 DSH 同机，不需要暴露到局域网。
- 若将来要跨机，改 `host: 0.0.0.0` 并务必先换强 token（文档已标注风险）。
- 与 DSH 的会话/工具/agent 全部同进程，桥接只是"入口"，不引入第二个运行时。

请求 / 响应契约：

```jsonc
// POST /ask
{
  "requestId": "0c1f…",           // 幂等键，xiaomusic 生成
  "did": "123456789",
  "deviceName": "客厅音箱",
  "group": "客厅",
  "query": "播放稻香",             // ASR 原文，可能含错别字
  "playing": { "name": "晴天", "artist": "周杰伦" }  // 可选：当前播放，帮助理解「换一首」
}
```

```jsonc
// 200
{
  "handled": true,
  "action": "play",              // play | control | chat | ignored
  "speak": "好的，正在播放稻香",   // 可选 TTS 文案（chat/澄清时用）
  "playUrl": "https://m801.music.126.net/…mp3",
  "song": { "originalId": "185809", "name": "稻香", "artists": ["周杰伦"], "album": "魔杰座" },
  "reason": null,
  "elapsedMs": 2431
}
```

约定：

- `handled=false` + `handled` 为空 → xiaomusic 当作「非音乐指令」处理，沿用原逻辑。
- `action=play` 必须带 `playUrl`；只带 `speak` 表示「识别为音乐意图但只播报」（如澄清「你想听谁的稻香？」）。
- 幂等：同一 `requestId` 10 分钟内重复请求返回缓存结果，避免重试造成二次播放。

---

## 6. 直链解析（本设计最大的技术风险）

### 6.1 为什么难

ncm-cli 的播放后端只有 `mpv` 与 `orpheus`：它内部拿到了音频直链，但**不对外输出**。而 xiaomusic 需要的是「音箱能拉取的 URL」。因此插件需要一条「拿直链」的通道。

### 6.2 三级解析（`streamResolver` 可配置）

> **2026-10-31 实测更新：R1 在本机不可用。** ncm-cli 0.1.7 的 `play` 走 `\\.\pipe\ncm-daemon` 守护进程，daemon 能启动并响应 `getState`，但 `play` 永不返回（3 s 后报「daemon 无响应」），且 **mpv 从未被调起**（用真实 `mpv.exe` 与实现了 mpv JSON-IPC 的桩各验一次，均零调用）。登录后的完整命令树里也**没有任何输出直链的子命令**（`song` 只有 like/dislike/lyric）。因此 R1 不能作为主路径，见 6.5 的现实结论。

| 级别 | 机制 | 优点 | 代价 / 状态 |
| --- | --- | --- | --- |
| **R1 `ncm-tap`**（原首选） | 用临时 `mpv` 旁路截获 ncm-cli 传给播放器的 URL | 完整复用 CLI 的登录态与 VIP 语义 | ❌ **不可用**：`play` 链路在 daemon 处即卡死，mpv 层根本没被触达 |
| **R2 `outer`**（兜底） | `https://music.163.com/song/media/outer/url?id=<originalId>.mp3` 302 → CDN | 零依赖、零登录，立刻可用；**已确认允许降级到此级** | **仅 `fee=0` 曲目有效**（实测 VIP 曲目 302 → `/404`）；128k；不走 ncm-cli |
| **R3 `xiaomusic`**（最终兜底） | 交给 xiaomusic 现有在线源（MusicFree / LX）按「歌名-歌手」解析并播放 | 用户已有配置即可用；播放链路已在生产验证 | 与网易云账号/歌单语义脱节 |

`auto` 策略（R1 失效后）：**S1（cookie + `player/url/v1`）为主** → 无 cookie 或 cookie 失效时降级 R2（仅免费曲目）→ 仍失败降级 R3，并在结果里标注 `source`。

### 6.3 P0 探针结论（2026-10-31 实测）

| # | 探针 | 结果 |
| --- | --- | --- |
| 1 | `play` 的 JSON 输出是否含直链 | ❌ `play` 无任何 stdout，`state` 始终 `stopped` |
| 2 | URL 是否出现在 mpv argv / IPC | ❌ mpv 从未被调用（两种桩均验证） |
| 3 | 直链能否被小爱音箱直接拉取 | ✅ 已端到端验证：`/playurl` 后 8 s 内 `status=1` |
| 4 | 直链有效期 | ✅ 路径时间戳显示 TTL ≈ 25 min |

> 结论：**"从 ncm-cli 拿直链"这条路在 0.1.7 上走不通**。ncm-cli 的可用价值收敛为「搜索 + 选歌 + VIP/可播性判定」，直链必须另找出处（6.5）。

### 6.5 直链来源：已选定 S1 并端到端验证

ncm-cli 能给出：准确搜索（含 `encryptedId`/`originalId`/`artists`/`duration`/`visible`/`playFlag`/`vipFlag`/`songFee`）、登录态、VIP 归属判定；
**给不出**：音频直链。

| 方案 | 直链来源 | 评估 |
| --- | --- | --- |
| **S1 网页 API + `MUSIC_U`（选定 ✅）** | `music.163.com/api/song/enhance/player/url/v1` | 纯 HTTP 无签名；VIP 全曲 320k/FLAC；实测通过 |
| S2 xiaomusic 在线源 | MusicFree / LX | ❌ 排除：本机只装了 `bilibili`、`猫耳FM`，没有网易云源 |
| S3 逆向开放平台签名 | `/openapi/...` + 私钥签名 | 暂不采用：工作量大、易随版本失效 |

**实现契约（已实测）**：

```http
GET https://music.163.com/api/song/enhance/player/url/v1?ids=[<originalId>]&level=<level>&encodeType=mp3
Cookie: MUSIC_U=<cookie>
Referer: https://music.163.com/
```

响应 `data[0]`：`{code, br, size, type, url, fee, freeTrialInfo}`。判定规则：

| 观测 | 含义 | 处理 |
| --- | --- | --- |
| `code==200 && url && !freeTrialInfo` | 完整曲目 | 直接播放 |
| `code==-110` | cookie 失效 / 未登录 | 报 `NCM_COOKIE_INVALID`，提示更新 cookie；可选降级 R2 |
| `code==404` 或 `url` 为空 | 该曲目无版权/已下架 | 报 `NCM_NO_SOURCE`，让 Agent 换候选 |
| `freeTrialInfo != null` | 只能试听 | 报 `NCM_VIP_REQUIRED` |

`level` 映射：`standard`(128k) / `higher`(192k) / `exhigh`(320k，默认) / `lossless` / `hires`。
实测 320k mp3 单曲约 10–12 MB、FLAC 30–55 MB；小爱音箱对 mp3 兼容性最好，**默认 `exhigh`**，`lossless` 仅作为配置项。

**与"经过网易云 CLI"的关系**：CLI 仍是「听懂之后的第一跳」——搜索、选版本、判可播性全部由它完成；只有最后一步"把这首歌变成音箱能拉的 URL"换成带账号 cookie 的官方接口。这条边界已在 6.2 的 R1 失效后成为唯一可行且已验证的路径。


### 6.4 附带问题：直链过期与 VIP 试听

- 直链通常带签名与短 TTL：**解析后立即播放**，不做长时间缓存；重播时重新解析。这是本方案的主要残余风险（探针 4 要量化 TTL）。
- 用户账号已确认是 **VIP**，因此正常路径应拿到完整时长与高音质；`NCM_VIP_REQUIRED` 降级只作为「单曲下架 / 版权受限」的保底分支保留。
- 若音箱拉取 CDN 失败（跨网/防盗链），可选 `preferLocalCache`：插件下载到 xiaomusic 音乐目录再播本地 URL（离线可用，但占磁盘、首播变慢）。

---

## 7. xiaomusic 侧改动（Mode B 必需）

改 3 个文件，约 60 行。

### 7.1 配置项（`xiaomusic/config.py`）

```python
enable_agent_bridge: bool = True
agent_bridge_url: str = "http://127.0.0.1:3071/ask"
agent_bridge_token: str = ""
agent_bridge_timeout: int = 20            # 秒
# play_intent=播放类口令优先转发、未命中兜底转发；fallback=仅未命中转发；always=全部转发
agent_bridge_when: str = "play_intent"
# 播放意图正则（命中即交给大模型，优先于关键词表）
agent_bridge_play_patterns: list[str] = field(default_factory=lambda: [
    r"^(播放|放一首|放点|放个|来一首|来点|来段|我想听|想听|换一首|换一个|再放|再来一首|听一下|听首|整一首|搜一下).*",
])
# 即使命中这些 opvalue 也保持本地执行（确定性控制，不进大模型）
agent_bridge_passthrough: list[str] = field(default_factory=lambda: [
    "play_next", "play_prev", "play_music_list", "play_music_list_index",
    "set_play_type_one", "set_play_type_all", "set_play_type_rnd",
    "set_play_type_sin", "set_play_type_seq", "set_volume", "stop",
    "stop_after_minute", "gen_music_list",
])
agent_bridge_tts: str = "好的，正在找歌"    # 空串表示不预播报
```

### 7.2 新增 `xiaomusic/agent_bridge.py`

```python
class AgentBridge:
    """把语音文本转发给 DSH 插件，返回结构化指令。"""
    async def ask(self, did, query, device, playing=None) -> dict | None:
        # httpx.AsyncClient(timeout=self.config.agent_bridge_timeout)
        # headers: Authorization: Bearer <token>
        # body: {requestId, did, deviceName, group, query, playing}
        # 任何异常/非 200 → 返回 None（调用方回落）
```

### 7.3 接入点（`xiaomusic/command_handler.py:do_check_cmd`）

```python
# xiaomusic/command_handler.py
opvalue, oparg = self.match_cmd(device, query, ctrl_panel)

delegate = False
if opvalue:
    # 关键词表命中：仅当它是"播放类"且不属于确定性控制时才转交大模型
    delegate = (self.xiaomusic.agent_bridge.is_play_intent(query)
                and opvalue not in self.config.agent_bridge_passthrough)
elif not ctrl_panel:
    # 未命中：播放类优先转发；其余按 agent_bridge_when 决定是否兜底转发
    delegate = (self.xiaomusic.agent_bridge.is_play_intent(query)
                or self.config.agent_bridge_when in ("play_intent", "fallback"))

if delegate:
    await device.group_force_stop_xiaoai()
    if self.config.agent_bridge_tts:
        await self.xiaomusic.do_tts(did, self.config.agent_bridge_tts)
    result = await self.xiaomusic.agent_bridge.ask(did, query, device)
    if result and result.get("handled"):
        if result.get("playUrl"):
            await self.xiaomusic.play_url(did=did, arg1=result["playUrl"])
        if result.get("speak"):
            await self.xiaomusic.do_tts(did, result["speak"])   # 仅未播放或需要澄清时带 speak
        return
    # 大模型明确说"不是音乐指令"或失败 → 回到原逻辑
    if not opvalue:
        await asyncio.sleep(1)
        await device.check_replay()
        return

if not opvalue:
    await asyncio.sleep(1)
    await device.check_replay()
    return
# …原执行路径（停小爱 → getattr(xiaomusic, opvalue)）
```

`agent_bridge.py` 中的判定：

```python
def is_play_intent(self, query: str) -> bool:
    q = query.strip()
    return any(re.match(p, q) for p in self.config.agent_bridge_play_patterns)
```

**路由优先级（确定性由高到低）**：

| 优先级 | 命中条件 | 执行方 | 例子 |
| --- | --- | --- | --- |
| 1 | `ctrl_panel=True`（Web 控制面板） | 原逻辑 | 页面里点播放 |
| 2 | 关键词命中且 `opvalue ∈ passthrough` | 原逻辑 | 「下一首」「播放列表第 3 首」「音量 30」 |
| 3 | 播放类 / 问歌正则命中 | **大模型** | 「播放稻香」「来点周杰伦」「换个版本」「在放什么」 |
| 4 | 非音乐正则命中（且未命中 3） | **小爱自己** | 「六点二十叫我起床」「明天天气」「开灯」 |
| 5 | 提到音乐但没动词（且未命中 4） | **大模型** | 「许嵩的歌」 |
| 6 | 其余未命中，仅 `when=fallback` 时 | **大模型** | 「小爱，整点活儿」 |
| 7 | 其余命中 | 原逻辑 | 「分钟后关机」「加入收藏」 |

#### 7.3.1 非音乐口令必须放行（v0.22 修正）

首版把「未命中口令」整段兜底给大模型（`agent_bridge_when=play_intent` 时也兜底），
结果是**任何一句语音都会被接管**：

```
「六点二十叫我起床」→ 未命中关键词 → 兜底转发
  → group_force_stop_xiaoai()          # 先掐掉小爱正要说的「好的，已定好闹钟」
  → do_tts("好的，正在找歌")            # 再念一句找歌
  → 模型：speaker_say("抱歉，我只能帮你放歌…")
  → 闹钟没设成，用户听到的是道歉
```

小爱自带的能力（闹钟、天气、时间、家电、闲聊）**必须留在音箱自己手里**。
修法是加一道确定性硬闸，并取消无条件兜底：

```python
# 1) 非音乐口令：直接 return，不掐小爱、不念 TTS、不问大模型
if self.is_passthrough_to_xiaoai(query, opvalue, ctrl_panel):
    self.log.info(f"非音乐口令，交还小爱: {query!r}")
    return

# 2) 兜底只在显式配置时发生
when = getattr(self.config, "agent_bridge_when", "play_intent")
return not opvalue and when == "fallback"
```

三个新配置项（都有默认值，老配置文件不受影响）：

| 配置 | 作用 | 例子 |
| --- | --- | --- |
| `agent_bridge_non_music_patterns` | 命中即永不接管 | 闹钟 / 叫我起床 / 天气 / 几点 / 开灯 / 讲笑话 |
| `agent_bridge_query_patterns` | 「问歌」也算音乐意图 | 「在放什么」「这首歌叫什么」 |
| `agent_bridge_music_patterns` | 句子里提到音乐就交给大模型 | 「许嵩的歌」（没有播放动词） |

另有两处配套修正：

- `parse_stop_delay()` 的关闭动词后只允许「音乐/播放/了/吧」收尾，否则
  「半**个小时后关闭**叫我起床」会被误判成延时关机，把闹钟吞掉；
- `delegate_to_agent()` 只在**点歌**时念「好的，正在找歌」，问「在放什么」
  不该先来一句找歌。

插件侧（`lib/bridge.js`）另有两道保险：提示词先判「是不是音乐请求」，
不是就一个工具都不调、直接结束；万一模型仍用 `speaker_say` 应答，
`isNonMusic()` 会把这条 chat 结果丢掉（`handled=false`），播放结果从不受影响。

回归用例见 `test/test_non_music_routing.py`（在修好前的代码上会挂 8 条）。

注意 `播放列表第 3 首` 同时命中「播放」正则与 `play_music_list_index`，靠优先级 2 保持本地执行——这是这张表存在的唯一原因。

### 7.4 兼容性

- 全部新增字段有默认值，老配置文件不受影响；**默认开启**（用户已确认接受该行为），只需填 `agent_bridge_url` 与 `agent_bridge_token`。
- 只改「命令分发」这一层：控制类口令、定时任务、TTS、播放列表逻辑均不受影响。
- 设置页可选新增 4 个字段（`enable_agent_bridge` / `agent_bridge_url` / `agent_bridge_token` / `agent_bridge_when`），非必须——首版可通过 `setting.json` 手改。
- 回滚方式：`enable_agent_bridge=false`，行为与今天完全一致。

### 7.5 分组播放（回答问题 3）

xiaomusic 的「分组」不是插件概念，而是它自己的一层设备聚合：

```jsonc
// conf/setting.json
{ "group_list": "did_客厅1:客厅,did_客厅2:客厅,did_卧室:卧室" }
```

- `device_manager` 按 `did:组名` 解析出 `groups = {"客厅": [id1, id2], "卧室": [id3]}`；
- 未配置组名的设备，**默认自成一组**（组名 = 设备名）；
- 播放时 `group_player_play(url)` 把**同一个 URL 推给组内所有 device_id**，实现多台音箱同步播放同一首。

对插件的意义只有两点：

1. `speaker` 参数应同时接受 **did / 设备名 / 组名**（先精确匹配 did，再匹配设备名，最后当组名处理）；
2. 语音链路里 xiaomusic 转发请求时会带上 `group`，插件默认把「播放」落在**该设备所在组**，与用户对 xiaomusic 的既有预期一致。

单台音箱时分组等价于自身，无需任何额外配置。

---

## 8. 意图识别设计

### 8.1 语音 Agent 的提示词要点

```
你是「小爱音箱音乐助手」。输入是音箱 ASR 文本，可能有错别字、语气词、口头语。
1. 先判断意图类别：播放 / 控制 / 查询 / 闲聊 / 非音乐。
2. 播放意图：先 ncm_search，再 ncm_play；同名歌优先原唱、studio 版本；用户说了歌手就以歌手为准。
3. 控制意图：直接 ncm_control / ncm_status，不要重新搜歌。
4. 指代（“这首”“再来一个”“换个版本”）结合对话历史与当前播放状态解析。
5. 找不到歌时，最多换一次关键词；仍找不到就一句话说明，不要连续重试。
6. 只处理音乐与音箱相关请求；其他请求让 handled=false 交回 xiaomusic。
7. 不要复述工具参数、不要输出 JSON、不要提“工具”。
```

### 8.2 与关键词表的关系

| 场景 | 处理 |
| --- | --- |
| 「下一首」「音量 30」「播放列表第 3 首」 | xiaomusic 关键词表命中且属确定性控制 → **不进大模型**（快、稳） |
| 「播放稻香」「来点周杰伦」「换个版本」 | 命中播放类正则 → **一律进大模型**（即使关键词表也命中） |
| 「小爱同学，放点适合睡觉的歌」 | 语义模糊，正是大模型的价值区 |
| 「分钟后关机」「加入收藏」 | 关键词命中且非播放类 → 原逻辑 |
| 大模型超时/失败 | 回落 `check_replay`，行为与今天一致 |

即：**确定性控制指令留在本地（毫秒级），播放意图交给大模型（秒级、更聪明）**。这条边界由 7.3 的优先级表保证，不靠模型自觉。

### 8.3 结果归一

工具把三类「语义失败」转成模型能处理的结构化错误，而不是抛异常：

| 错误 | 触发 | Agent 行为 |
| --- | --- | --- |
| `NCM_NOT_INSTALLED` | `ncm-cli --version` 失败 | 说明未安装，不重试 |
| `NCM_NOT_LOGGED_IN` | `login --check` 非 0 | 返回二维码链接，提示用户登录 |
| `NCM_VIP_REQUIRED` | 直链解析出试听 | 换候选或告知 |
| `XIAOMUSIC_UNREACHABLE` | API 连不通 | 说明音箱服务不可达 |
| `SPEAKER_NOT_FOUND` | did/名称无匹配 | 列出可用音箱 |

---

## 9. 配置示例

插件 `config`（写入 `cordis.patch.yml` 的对应行）：

```yaml
xiaomusicBaseUrl: 'http://127.0.0.1:8090'
xiaomusicUser: 'admin'
xiaomusicPassword: '******'
defaultSpeaker: '客厅'
streamResolver: 'auto'
ncmCliPath: 'ncm-cli'
voiceBridge:
  enabled: true
  host: '127.0.0.1'
  port: 3071
  token: '<32 字节随机串>'
  agentTimeoutMs: 15000
```

xiaomusic `conf/setting.json`：

```jsonc
{
  "enable_agent_bridge": true,
  "agent_bridge_url": "http://127.0.0.1:3071/ask",
  "agent_bridge_token": "<与插件一致的随机串>",
  "agent_bridge_when": "play_intent",
  "agent_bridge_tts": "好的，正在找歌",
  "group_list": "did_客厅:客厅"
}
```

> 网络提示（实测）：DSH Web 只监听 `100.64.0.8:3080`，`127.0.0.1:3080` 与 `192.168.31.94:3080` 均 `ECONNREFUSED`；且该端口有 cookie 认证。所以桥接走插件自带的 `127.0.0.1:3071`，与 DSH Web 的监听地址无关。

---

## 10. 安全与隐私

| 面 | 措施 |
| --- | --- |
| 桥接监听 | 独立 `http.Server`，默认只绑 `127.0.0.1:3071`；强制 Bearer token（`timingSafeEqual`）；body ≤ 32 KB；仅 POST；20 s 超时；不复用 DSH Web 端口，避免与浏览器 cookie 认证耦合 |
| xiaomusic API | 用 HTTP Basic（`httpauth_password`）；若用户 `disable_httpauth=true` 则显式告警「本机 API 无鉴权」 |
| 语音 Agent 工具面 | `tools.restrict({allow: MUSIC_TOOLS})`，语音链路无法触达 bash/文件/网络工具 |
| ncm-cli | 不在日志中输出 `privateKey`/cookie/完整签名 URL；非播控命令统一带 `--userInput` 摘要；执行前做内容安全审核（沿用 ncm-cli skill 的规则） |
| 用户语音文本 | 只进会话日志，不落独立文件；日志中 query 原样保留（排障需要），直链做域名+路径截断 |
| 凭据存放 | `appId/privateKey` 只在 ncm-cli 自己的加密配置中，插件不复制、不读取；`MUSIC_U` 只存在于插件 config 与内存，不写日志、不回显 |
| 版权 | 仅个人使用场景；不提供下载/转存能力（`preferLocalCache` 默认关闭） |

---

## 11. 性能预算

| 环节 | 目标 | 说明 |
| --- | --- | --- |
| 语音 → xiaomusic 拿到 query | 0.5–2 s | 现有轮询间隔决定（`pull_ask_sec`） |
| 预播报 TTS | +1 s | 掩盖后续延迟，可关 |
| 大模型回合（含 1–2 次工具调） | 2–4 s | 用轻量模型；工具描述精简 |
| ncm-cli 搜索 | 0.5–1.5 s | 冷启动 Node 进程约 0.3 s |
| 直链解析 | 0.5–1.5 s | 单次 HTTP（`player/url/v1`），无进程拉起 |
| 推流到出声 | 3–8 s | 实测：`playurl` 返回后 ≤8 s 生效（`status=1`），含音箱拉流缓冲 |
| **端到端** | **5–9 s** | 超过 12 s 视为体验失败，需排查模型或 CLI |

优化项：`ncm-cli` 常驻（若其支持）、搜索结果缓存 10 分钟、直链解析与 TTS 并行、Agent 会话复用省去系统提示组装。

---

## 12. 可观测性

- 每条请求一个 `requestId`，贯穿插件日志、Agent 会话、xiaomusic 日志。
- 结构化日志字段：`requestId, did, query, intent, tools[], resolver, urlHost, elapsedMs, outcome`。
- `/stats`（可选，GET，需 token）：近 100 次请求的成功率、P50/P95 延迟、降级次数。
- 失败计数达阈值时，在 GUI 会话里推送一条提示（复用 `systemPrompt.context` 或直接写会话事件）。

---

## 13. 交付分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0 探针**（0.5 天） | 6.3 的 4 个验证；确认直链来源与音箱可播性 | **✅ 全部完成**：直链可播、TTL 25 min、R1 失效、S1（cookie）VIP 可播 |
| **M1 插件 + Mode A**（2 天） | bundle 骨架、6 个工具、ncm/xiaomusic 适配器、R1/R2 解析 | 在 DSH 里说「让小爱放稻香」，客厅音箱播放；失败有结构化原因 |
| **M2 语音链路**（1.5 天） | HTTP 路由、语音 Agent 会话池、xiaomusic 补丁、TTS 过渡 | 对着音箱说「播放稻香」，5–9 s 内出声；说「下一首」仍走原关键词 |
| **M3 体验打磨**（1 天） | 指代与多轮、歌单/歌手批量、降级链完善、统计与日志、locale/icon | 连续 20 条真实语音指令，成功率 ≥ 85% |

M1 可以完全不改 xiaomusic 就交付价值，建议先做 M1 再决定是否进入 M2。

---

## 14. 测试计划

| 层 | 用例 |
| --- | --- |
| 单元 | `ncm.js` 输出归一（含畸形 JSON、非 0 退出、超时）；URL 有效性判定；`streamResolver` 降级顺序 |
| 契约 | 伪造 xiaomusic + 伪造 ncm-cli 可执行文件，验证路由请求/响应与幂等 |
| 集成 | 真实 ncm-cli（已登录/未登录两态）；真实 xiaomusic `/playurl` + `/playtts` |
| 端到端 | 音箱实机：播放/暂停/下一首/音量/查歌名/找不到歌/网络断开 |
| 故障注入 | ncm-cli 崩溃、直链 403、DSH 进程重启、token 错误、Agent 超时 |
| 回归 | 关闭 `enable_agent_bridge` 后，原关键词口令行为与基线一致 |

---

## 15. 风险与对策

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| 1 | ncm-cli 无可用的直链输出手段 | 阻塞核心链路 | 6.2 三级降级；R1 失败立即 R2/R3；P0 先验证 |
| 2 | mpv 旁路依赖实现细节，版本升级失效 | 功能回退 | 旁路只作为 resolver 的一种，失败自动降级；版本变化时打日志告警 |
| 3 | 大模型延迟过高，用户以为没反应 | 体验差 | 预播报 TTS、超时降级、轻量模型、结果快速路径（歌名精确命中直接播） |
| 4 | 小爱 ASR 错字导致搜错歌 | 播错内容 | 先 search 再 play；同名多候选时 Agent 选原唱并在 TTS 里确认歌名 |
| 5 | VIP 歌曲只能试听 | 播 30 s 就停 | 账号已确认 VIP，风险降为「单曲版权受限」：归一为 `NCM_VIP_REQUIRED`，换 `visible` 候选或明确告知 |
| 6 | 直链过期 | 播放失败 | 实测 TTL ≈ 25 min，无需 Referer/UA；解析后立即播放；`preferLocalCache` 可选兜底 |
| 7 | 语音 Agent 上下文膨胀 | 成本、串味 | 每设备会话 + 轮次上限重建 + 只保留近 N 轮 |
| 8 | 两个入口同时对同一音箱操作 | 抢播 | 按 did 串行队列 + xiaomusic 侧 `cancel_all_tasks` |
| 9 | 插件与 xiaomusic 版本漂移 | 接口失效 | 契约固定为 7.x 列出的 5 个端点；插件启动自检 `/device_list` |

---

## 16. 决策与未决问题

### 16.1 已确认（2026-10-31 评审）

| # | 决策 | 落点 |
| --- | --- | --- |
| 1 | **接受**给 xiaomusic 打补丁 | 第 7 节，M2 纳入范围 |
| 2 | **播放类口令一律交给大模型**（`agent_bridge_when=play_intent`，默认开启） | 7.3 路由优先级表、8.2 |
| 3 | 分组播放 = xiaomusic 的多设备聚合，插件 `speaker` 参数按 did/设备名/组名解析 | 7.5 |
| 4 | ncm-cli 与开放平台 `appId/privateKey` 已就绪，账号为 VIP | 6.4、风险 5 降级 |
| 5 | TTS 用默认策略：预播「好的，正在找歌」，播成功不再播报 | 7.1 `agent_bridge_tts` |
| 6 | 允许降级到 `outer/url`（128k） | 6.2 R2、`streamResolver=auto` |
| 7 | 不做收藏/歌单/推荐等写操作 | 非目标 N6、5.3 |
| 8 | 单台音箱 | M2 先做单设备；`speaker` 参数与分组解析保留，后续加设备零改动 |

### 16.2 仍需确认

无。直链方案已定为 S1（6.5）并端到端验证。

### 16.3 验证备注（2026-10-31 本机实测，P0 部分完成）

| 探针 | 结果 | 结论 |
| --- | --- | --- |
| `command -v ncm-cli` / `mpv` | 两者均不在 PATH | R1 与搜索类探针需先安装；R2 可离线验证 |
| `outer/url`，`fee=0` 曲目（《海阔天空》Cover，id=3362265838） | 302 → `m701.music.126.net/...`，带 Range 请求返回 206 `audio/mpeg`，首字节 `ID3\x04` | **R2 可用**，无需 Referer/UA |
| `outer/url`，`fee=1` 曲目（《稻香》id=185809） | 302 → `http://music.163.com/404` | **R2 对 VIP 曲目无效**，VIP 内容必须走 R1 |
| 直链时间戳 | 路径含 `20261031213512`，请求时刻为 `211012` | TTL ≈ 25 分钟；播放前实时解析即可，无需长缓存 |
| xiaomusic 本地服务 | `GET http://127.0.0.1:8090/device_list` → 200，设备「小爱音箱Pro」在线（miotDID=425774956，hardware=LX06，`disable_httpauth=true`） | 接口连通 |
| **端到端播放** | 免费曲目直链 → `GET /playurl?did=425774956&url=…` 返回 `{"code":0}`，`/getplayerstatus` 在 8 s、15 s、22 s 均为 `status=1` | **✅ 网易云 CDN 直链可被小爱音箱直接播放，无需 Referer/UA/中转** |
| DSH Web 监听 | 仅 `100.64.0.8:3080` 可达（401 cookie 认证）；`127.0.0.1:3080`、`192.168.31.94:3080` 均 `ECONNREFUSED` | 桥接不能复用 Web 端口，改为插件自建 `127.0.0.1:3071`（5.5） |
| ncm-cli 安装/登录 | 0.1.7，`config set` 写入 appId/privateKey 成功，扫码登录成功（账号 `deepinspring`，`vipDetail` 显示会员有效期至 2030） | 凭证链路可用 |
| `search` 输出 | `{code,data:{recordCount,records:[{originalId,id,name,duration,artists[{name}],album{name},visible,playFlag,vipFlag,songFee,coverImgUrl,qualities,...}]}}`；`id` 即 32 位加密 ID | 搜索是最可靠的一段；选歌应过滤 `visible && playFlag` |
| `play` | 起 `\\.\pipe\ncm-daemon`，daemon 响应 `getState`，但 `play` 3 s 超时「daemon 无响应」；真实 `mpv.exe`、mpv JSON-IPC 桩、`winpty` 三种方式下 mpv 均零调用 | ❌ CLI 播放链路不可用；**无任何命令输出直链** |
| 目录差异 | 搜「周杰伦 稻香」只返回翻唱（周杰伦版权不在网易云）；搜「李荣浩 年少有为」可返回原唱但 `visible=false` | 选歌需强依赖 `visible`/`playFlag`，并向用户说明"原唱可能不在曲库" |
| **S1 直链解析** | 带 `MUSIC_U` 调 `player/url/v1`：VIP 曲目 `code=200`、320k、11 MB 全曲；`level=lossless` 返回 FLAC 30–55 MB；无 `freeTrialInfo` | ✅ VIP 完整音质可用 |
| **VIP 端到端播放** | 《李白》320k 直链 → `/playurl` → `status=1` 持续 20 s，随后 `/device/stop` 归位 | ✅ **完整链路（搜索→解析→音箱）已验证** |
| cookie 失效表现 | 无 cookie 时 VIP 曲目返回 `code=-110` | 插件需把 `-110` 归一为 `NCM_COOKIE_INVALID` |

由此产生的两条实现约束：

1. **R2 不能作为 VIP 内容的兜底**——VIP 曲目必须拿到 R1 的直链，否则应明确报 `NCM_VIP_REQUIRED` 而不是「静默降到 128k」。
2. **TTL 约 25 分钟**——足够「解析即播」，但不足以「先缓存歌单再播」；歌单场景必须逐首解析。

---

## 17. 实现进度（M1 / M2）

### 17.0 M2：语音链路（已落地并实测）

| 组件 | 落点 |
| --- | --- |
| xiaomusic 配置 | `config.py`：`enable_agent_bridge` / `agent_bridge_url` / `agent_bridge_token` / `agent_bridge_timeout` / `agent_bridge_when` / `agent_bridge_play_patterns` / `agent_bridge_passthrough` / `agent_bridge_tts` |
| 转发模块 | 新增 `xiaomusic/agent_bridge.py`（`is_play_intent` + `ask`，异常一律返回 `None` 回落） |
| 路由 | `command_handler.should_delegate()` / `delegate_to_agent()`：控制类口令本地执行，播放类口令转大模型 |
| 插件桥接 | `lib/bridge.js`：`127.0.0.1:3071/ask`，每台音箱一个 Agent 会话，工具延迟播放（只解析不推流） |

**实测（2026-10-31，`POST /cmd {"cmd":"播放李白"}` 模拟语音）**：

```
22:45:10  TTS「好的，正在找歌」
22:45:18  agent_bridge handled=True action=play elapsed=5699ms
22:45:18  手动推送链接：http://m804.music.126.net/...（VIP 320k）
          /getplayerstatus 连续 22 秒 status=1，随后手动停止
```

**M2 踩到的四个坑（都已修）**：

1. `/cmd` 路由默认 `ctrl_panel=True`，被路由当成"控制面板"放行 → 改为「面板来的播放意图同样转交」，只保留确定性控制口令不走大模型。
2. 桥接里 `ctx.agentDefaultModel` 未声明 `inject` → 加 `inject: ['tools','agents','agentDefaultModel']`。
3. 新建根 Agent 必须显式给 `agentOptions`（provider/model）并用 `setup(agentCtx)` 加工具 guard 与 persona，否则回合立刻空转结束。
4. **venv 里的 `xiaomusic` 是非 editable 安装**：控制台脚本跑的是 `.venv/Lib/site-packages/xiaomusic` 的副本，改仓库代码不生效。已把 `config.py`/`command_handler.py`/`xiaomusic.py`/`agent_bridge.py` 同步进 site-packages；长期应改成 `pip install -e .`（本次因离线未做）。

### 17.0.1 修正：开放平台的 `visible`/`playFlag` 不可信

用户实测「播放许嵩素颜」被拒（回"没版权"），实测数据：

| 来源 | 结果 |
| --- | --- |
| `ncm-cli search song`（开放平台） | 《素颜》许嵩/何曼婷 `id=167827`，**`visible=false playFlag=false vip=false fee=0`**，30 条结果几乎全部如此 |
| `player/url/v1`（带 VIP cookie，同一 id） | **`code=200`、320k、9.5 MB、无 `freeTrialInfo`** —— 完全可播 |

结论：`visible`/`playFlag` 描述的是**开放平台自身的授权窗口**，不代表该账号能不能播；把它当硬门槛会误杀大量正常歌曲。

修正（已上线）：

- `ncm_play` 不再因 `playFlag=false` 拒绝，改为**照常解析直链，由 `player/url/v1` 的返回码决定成败**；
- 选歌评分改为「歌名精确 > 歌名包含 > 歌手命中 > 可播标志」，避免为了一个"可播"的翻唱而丢掉用户点名的原唱；
- `ncm_search` 输出把「可播/不可播」改成「接口标记受限」，明确它只是提示。

复测：`ncm_play(keyword="许嵩 素颜")` → 播放《素颜》许嵩/何曼婷（320k），语音链路 `handled=True`，11.7 s 推流成功。

### 17.0.2 队列：「下一首/上一首」回到网易云

插件用 `/playurl` 推的是裸 URL，xiaomusic 的 `cur_music` / 播放游标不会更新，于是它原来的「下一首」会在**陈旧的本地歌单**里前进（实测：放《素颜》→ 说「下一首」→ 播了「陶喆歌曲50首精选」）。

修正（M2.1）：

| 层 | 改动 |
| --- | --- |
| 插件 | 新 `lib/queue.js`：按 did 记住最近一次搜索的候选与索引；桥接新增 `POST /next`、`/prev`、`/forget`，返回解析好的直链，**不经过大模型**（≈1 s） |
| xiaomusic | `play_next`/`play_prev` 命中关键词后先问插件队列；插件没有队列就回落本地 `_play_next` |
| 失效处理 | 本地播放（`_playmusic`）与「停止」时 `forget` 掉插件队列，避免之后「下一首」串回网易云 |
| 自动续播 | `queue.autoAdvance`（**默认关**）：到歌曲时长后若设备已停就推下一首；带「中途被停则不续」的时间守卫 |

**实测（真机）**：

```
播放许嵩素颜        → status=1
下一首             → 新直链（另一首）status=1
下一首             → 新直链          status=1
上一首             → 新直链          status=1
停止               → status=2
```

顺带发现一个既有配置缺口：`key_word_dict` 里有「停止/停止播放」，但 `key_match_order` 漏了它们，导致「停止」根本不匹配。已补进 `conf/setting.json` 的匹配顺序。

**队列候选范围修正（用户反馈「下一首还是同一首」）**：

- 模型常见做法是 `ncm_search` → 带 `encryptedId/originalId` 调 `ncm_play`，而带 ID 的路径原先只把**当前这一首**记入队列，`next` 只能在 1 条里绕回自己；
- 修复：`ncm_play` 记住最近一次搜索（5 分钟内、同 ID 命中即复用整张候选表）；`queue.record` 按**去重后的歌名**建队列，把同名翻唱/live 收拢掉。

修正后实测（单实例、干净日志）：

```
播放许嵩的歌 → 未匹配 → TTS → agent_bridge handled=play（歌1）
下一首       → next … song=幻听
下一首       → next … song=又小雪
停止         → 收到，再见
```

**同名去重加强（用户反馈「还是同名」再修）**：

原先只按「去括号后的标题字符串」去重，`许嵩-素颜（少爷Bootleg）` 这类**带前缀的变体**会漏网，队列里于是并存两条“素颜”。

| 改动 | 说明 |
| --- | --- |
| 标题指纹 | 去掉括号内容、所有非文字数字字符（`-`/`·`/空格）、大小写 |
| 包含判定 | 一个标题包含另一个（长度≥2）即视为同一首，`许嵩素颜` ≡ `素颜` |
| 补货 | 队列去重后不足 2 首时，用网页搜索接口（支持更宽的结果集）按 **原关键词 → 当前歌手** 依次补一批，跨批次继续去重 |

实测（连点三次「下一首」）：

```
播放素颜   → 有何不可 → 幻听 → 庐州月
播放许嵩的歌 → 天龙八部之宿敌 → 雅俗共赏
```

**随机播放与回退（v0.13 / v0.14）**：

| 能力 | 实现 |
| --- | --- |
| 默认随机 | `queue.mode` 默认 `random`：队列总是随机取（排除当前这首），不依赖小爱的模式；`follow` 才跟随 `PLAY_TYPE_RND`，`sequential` 强制顺序 |
| 跟随随机模式 | `queue.mode=follow` 时，xiaomusic 把设备 `play_type` 一起发给插件 |
| 上一首 | 维护播放历史栈，`上一首` 回退到「刚才真的播过的那首」，两种模式下都正确 |
| 自动续播 | 沿用当前队列的随机/顺序设置 |

验证：单测 `顺序 1→2→3→4…`、`随机 5→6→2→7…`（无相邻重复）、`next 5→3` 后 `prev` 回到 5；真机日志出现 `agent_bridge 队列 next(random) 已推送`。

**顺带修的两个延迟问题**：

1. 语音回合原先要 `ncm_search` + `ncm_play` 两次工具调用，实测有一次超过 20 s 桥接超时直接失败 → persona 改为**只调一次 `ncm_play`（内部自带搜索）**；桥接超时从 20 s 提到 35 s。
2. `ncm_play` 命中关键词后会把候选写进队列，因此单次调用仍能支撑后续「下一首」。




### 17.0.3 延时关闭：「半小时后关闭音乐」被当成立即停止

用户说「半个小时后关闭音乐」时音乐立刻停了。原因：`key_word_dict` 里有 `关闭音乐 → stop`，模糊匹配命中后直接把整句当成立即停止，时间部分被丢掉（`分钟后关机` 只认「分钟」，不认「小时/半小时」）。

修正：在 `match_cmd` 之前加 `parse_stop_delay()`：

| 输入 | 解析 |
| --- | --- |
| 半个小时后关闭音乐 / 半小时之后关机 | 30 分钟 |
| 一个小时后关闭音乐 / 1小时后关机 | 60 分钟 |
| 两小时后关掉音乐 | 120 分钟（「两」归一化为「二」再解析） |
| 十分钟后停止播放 | 10 分钟 |
| 关闭音乐（无时间） | `None` → 仍走原来的立即停止 |

命中后直接调用 `stop_after_minute(minutes)`，并回一句「收到，N 分钟后将关机」。

实测：播放中执行 `1分钟后关闭音乐` → 日志 `识别为延时关闭: 1 分钟后` → 立即检查仍在播放 → 65 秒后 `status=2`。

### 17.0.4 「播放许嵩的歌」没有播歌：语音会话被归档 + 歌名搜索不认识歌手

用户说「小爱同学，播放许嵩的歌」时只听到「好的，正在找歌」，然后没有音乐。日志里只有一行：

```
agent_bridge: handled=False action=None elapsed=88ms query='播放许嵩的歌'
```

88 ms 就返回、且插件侧**没有任何 `followup` 轨迹**，说明这一轮根本没有进入模型。查会话记录发现每轮都是：

```
turn/start → agent/inbox/spliced → turn/end reason={"kind":"blocked"}
```

`blocked` 来自 `dsh-api-session-controller`：

```js
ctx.on("agent/pre-step", (payload, next) =>
  underArchivedSession(ctx, payload.agent) ? Promise.resolve({ kind: "reject" }) : next())
```

即**该 Session 被归档后，每一步都会被拒**。而插件的语音会话是普通根会话，会出现在 GUI 会话列表里，用户批量归档旧会话时把它一起归档了（`~/.dsh/storages/workspace.json` 的 `archivedSessionIds` 里就有那几个语音会话 id）。

修正（`lib/bridge.js`）：

1. `ensureRunnable(ctx, sessionId)`：每轮开始前检查 `ctx.workspaceRegistry.archivedSessionIds`，命中则 `unarchiveSession(sessionId)`。
2. 每轮结束后用 `lastTurnReason(handle)` 读最近一条 `turn/end`；若为 `blocked` 且本轮没有任何工具结果，恢复会话后**重试一次**。
3. `inject` 增加 `workspaceRegistry`。

修完这一步还有第二个独立问题：**歌手请求被当成歌名搜索**。

```
搜索 "许嵩的歌" → 结果全是别人的歌：《许嵩的歌》— 爱伦、《写给许嵩的歌》— 申坤…
```

标题里带「许嵩」两字但歌手不是许嵩，排序里「歌名完全相等」权重最高，于是要么播了别人的同名歌，要么模型认为「听不出是哪首歌」而放弃。同时旧打分里 `playable`（开放平台的授权标记，不可信）还压过歌手匹配，实测播出了曹格的《寂寞寂寞不好》。

修正（新增 `lib/resolve.js`）：

1. `parseArtistRequest()` 把口语句子拆成主体 + 是否是歌手请求：
   `播放许嵩的歌` → `{core:"许嵩", marker:true}`；`来点周杰伦` → `{core:"周杰伦"}`（搜索弱匹配时也按歌手解析）；`来生缘` 保持歌名解析。
2. 歌手请求走歌手目录：`type=100` 搜歌手 → 精确同名才算命中（`不许嵩手` 之类不算）→ `/api/artist/top/song` 取热门歌，前 5 首里随机挑一首（避免每次都开同一首）。
3. 打分去掉 `playable` 加成，只按「标题精确匹配 > 标题包含 > 歌手被提到」排序，等分保持搜索原序；实测《素颜》从「陈瑞（可播）」回到许嵩/何曼婷原版、《来生缘》回到刘德华。
4. `ncm_search` 与队列补货（`refill`）复用同一个解析器，所以队列里也只会是这位歌手的歌。
5. 语音提示词显式列出判定顺序（先 `ncm_play`，说了歌手就算说清楚），避免小模型把歌手请求当成「没听清」而只回话不播。

实测（真机音箱，走完整 xiaomusic 链路 `POST /cmd`）：

```
10:27:34 handled=True action=play elapsed=3584ms query='播放许嵩的歌'
10:27:38 play_by_url ... → getplayerstatus status=1（在播）
播放歌曲：多余的解释 — 许嵩
```

> 排查提示：调试时用 `curl -d '{"query":"中文"}'` 在 Windows shell 下会把中文发成乱码字节（会话记录里能看到 `С������Pro`），模型因此判「没听清」。要验证请用 UTF-8 的 Node/Python 脚本发请求（`tools/*.mjs` 里的 `.tmp-probe/ask-test.mjs`）。

### 17.0.5 「一分钟后关闭音乐」确认完就没声了

现象：`播放许嵩的歌` → 音乐正常 → `一分钟后关闭音乐` → 听到「收到，1分钟后将关机」→ **音乐不再响起**（但 60 秒后确实停了）。

原因是被自己的确认语打断后没人负责续播。链路是：

```
stop_after_minute() → do_tts("收到,1分钟后将关机")
  → 推 TTS mp3（play_by_url 会顶掉正在放的流）
  → TTS 定时器 duration+2 秒后 → stop(arg1="notts") → 音箱静音
  → do_tts 里的 check_replay()
```

`check_replay()` 只认 xiaomusic 自己维护的 `is_playing` / 播放列表；而插件的歌是走 `/playurl` 直接推给音箱的，`is_playing` 一直是 `False`，于是日志一句 `不会继续播放歌曲. isplaying:False` 就静音收场。

修正（`xiaomusic/device_player.py` + `xiaomusic.py`）：

1. `_pushed_url`：`play_url()` 推流成功时记下地址；本地播放（`_playmusic`）、用户明确停止（`stop(arg1!="notts")`）、定时关闭真正触发后都清空。
2. `do_tts(value, resume_after=False)`：`stop_after_minute()` 传 `resume_after=True`，把「说完要续播」挂到 TTS 定时器上。
3. TTS 定时器在 `stop(arg1="notts")` 之后若 `resume` 为真，就 `resume_pushed_url()` 用 `group_player_play(地址)` 把刚才那首重新推回去。
4. 只有延时关闭这一条路径会续播；「好的，正在找歌」这类 TTS 不续播，避免把上一首又塞回来。

实测（真机，完整链路）：

```
10:35:21  识别为延时关闭: 1 分钟后
10:35:26  TTS 播放定时器时间到 → stop now → 恢复被打断的推流: http://m804...
10:36:21  stop now  → getplayerstatus status=2
```

中间 +3/+6/+10/+15 s 轮询 `status=1`，音乐一直在放，60 秒后准确停止。

已知限制：小米音箱的 `play_by_url` 没有 seek，续播会把**当前这首从头开始**（不是接着 1 分 30 秒继续）。要严格续上需要改用 xiaomusic 的 `continue_play`（`play_by_music_url _type=1`，依赖小米音乐 API 的 audioID），属于另一条技术路线，暂不引入。

### 17.0.6 「音量调整为20%」被当成点歌，先念「好的，正在找歌」

现象：放着歌时说「音量调整为20%」→ 听到「好的，正在找歌」，音量不变。

原因在路由：`agent_bridge_when=play_intent` 的兜底分支是「没匹配到任何口令 → 交给大模型」，而 xiaomusic 的 `key_word_dict` 里**根本没有音量类口令**（只有 `set_volume` 这个方法，没有关键词指向它）。于是：

```
match_cmd("音量调整为20%") → opvalue="" → should_delegate() → True
  → delegate_to_agent() → 先 TTS「好的，正在找歌」 → 再问模型
```

模型那边只会调 `ncm_control(volume=20)`，但音箱该有的原生音量反馈已经变成一句错误的「正在找歌」。

修正（`xiaomusic/command_handler.py`）：在 `match_cmd` 之前加 `parse_volume()`，本地直接调 `set_volume`，完全不进大模型、不出 TTS、不打断音乐。

| 说法 | 解析 |
| --- | --- |
| 音量调整为20% / 音量调到20 / 音量20 | `abs 20` |
| 音量调到百分之二十 / 声音调到三十 | `abs 20` / `abs 30`（中文数字） |
| 声音大一点 / 大声点 / 声音小一点 | `delta ±10`（先读 `get_volume()` 再加减，夹在 0-100） |
| 音量最大 / 音量最小 / 静音 | `abs 100` / `abs 1` / `abs 0` |
| 音量 | `None`（没方向没数值，不猜） |

防误判两条：以播放动词开头（播放/放点/来点/听一下…）的句子直接 `None`，否则「播放**小声**说爱你」会被当成调音量；没有音量词的「大声点」只认句首短指令，免得撞上歌名。

实测（真机）：

```
10:57:01  识别为音量调整: 20 (原句:'音量调整为20%')
          set_volume → getplayerstatus {"status":1,"volume":20}   ← 音乐没被打断
```

顺带验证：「声音大一点」→ 20→30；「音量最大」→ 100；「播放小声说爱你」→ 仍走点歌。

### 17.0.7 「音量调整为20%」之后只听到一声「好的」，音乐没了

v0.18 之后音量确实改了（日志 `识别为音量调整: 20`），但用户听到的是音箱自己回一句「好的」，之后就没声了。

区分两个来源：

| 触发方式 | 结果 |
| --- | --- |
| HTTP `/cmd` 直接调 `set_volume` | `status` 一直 = 1，音乐不受影响 |
| 对着音箱说同一句话 | 小爱自己的语音助手接管，先「好的」再**暂停当前播放** |

也就是说暂停不是 `player_set_volume` 造成的，而是**小爱应答时抢占了播放**；外部推流不在 xiaomusic 的播放列表里，`check_replay` 救不回来，所以停在静音。

修正（`xiaomusic/device_player.py` + `command_handler.py`）：新增 `resume_pushed_url_if_stopped()`，音量口令执行完后起一个后台任务——延迟 2 秒、最多轮询 8 秒，一旦发现设备 `status != 1` 就用 `_pushed_url` 重新推一次。

```
11:02:26  识别为音量调整: 25
11:02:27  （模拟小爱应答）TTS「好的」→ 抢占播放
11:02:33  TTS 停止 → 检测到未在播放 → 恢复被打断的推流
          getplayerstatus {"status":1,"volume":25}
```

只对「本地处理、又不换歌」的口令做这件事（目前是音量）；「停止」会清掉 `_pushed_url`，不会被这条逻辑捡回来。续播仍是从头开始（`play_by_url` 无 seek）。

### 17.0.8 一首播完之后没有下一首

现象：点了一首歌，放完就静默了，不会接着放。

原因是**外部推流没有「播完」这个概念**：xiaomusic 只在 `_playmusic()` 里（它自己从那首歌的文件算出时长后）调用 `set_next_music_timeout()` 安排下一首；插件的歌是 `/playurl` 直接推的，从来没进过它的播放列表，也就没有时长、没有定时器。插件这边的 `queue.autoAdvance` 默认关闭（当初是为了不跟 xiaomusic 抢「下一首」），两边都没人管。

修正链路：

1. 插件把时长带上：`xm.playUrl(did, url, {durationSec})` → `/playurl?...&duration=秒`；
   `/next` `/prev` 的响应也带 `durationSec`，由 `queue.advance()` 用 `song.durationSec` 或「流大小 ÷ 码率」算出来兜底。
2. xiaomusic 收到 `duration` 就 `set_next_music_timeout(duration + delay_sec)`：`delay_sec` 抵消推流本身的耗时。
3. 定时器到点走 `_play_next()`，新增的第一步是 `_play_from_agent_queue("next")`：插件队列有货就 `bridge.advance()` 取下一首 → 推流 → **再排下一首的定时器**，如此接力。
4. 插件队列空了就不回落本地歌单（否则会莫名跳到「世界纯音乐100首」），直接停并把 `_pushed_url` 清掉。

顺带修掉一个会让「刚点的歌秒没」的竞态：TTS 定时器触发的 `stop()` 里那几个 mina 调用要好几秒（`force_stop_xiaoai` → `player_pause` → `player_stop`），如果这期间推了新歌，stop 收尾时会把新歌一起掐掉。现在 `stop()` 记录自己的 task，推流前 `settle_before_play()` 先等它跑完。

实测（真机）：

```
11:44:19  手动推送链接：…（播放许嵩的歌）
11:44:20  277 秒后将会播放下一首歌曲
11:46:01  （为缩短验证）重新推送 duration=20
11:46:21  定时器时间到了
11:46:22  agent_bridge: next did=… song=清明雨上 duration=220s
11:46:22  220 秒后将会播放下一首歌曲      ← 接力排上，不是只下一首
          getplayerstatus {"status":1}
```



### 17.0.9 零安装：把 xiaomusic 变成插件的依赖

需求：装完 DSH 插件就能用，不要再让用户自己跑 `start-xiaomusic.bat`，也不要先手工装 Python 包。

问题在于此前 xiaomusic 是**并列的外部服务**：用户自己建 venv、自己 `pip install`、自己起进程，插件只是个客户端。补丁（`agent_bridge.py`、`command_handler.py`、`device_player.py`、`xiaomusic.py`、`config.py`、`api/routers/device.py`）还必须手抄进站点包，`pip install -U` 一升级就全丢。

改造：新增 `lib/runtime.js`，把整条安装链搬到插件里。

| 步骤 | 实现 |
| --- | --- |
| 解释器 | `uv venv --python 3.12 <home>/.venv`；没有 uv 退回 `python -m venv`；也可用 `xiaomusic.python` 指定已有解释器 |
| 包 | `pip install xiaomusic==<version>`，先清华镜像后官方源 |
| 补丁 | `vendor/xiaomusic/` 6 个文件覆盖进站点包，`home/.dsh-overlay.json` 记版本+文件哈希，升级/重装后自动重打 |
| 配置 | `home/config.json` 不存在才按需生成（绝对路径、`get_duration_type=mutagen`、已开桥接）；`home/conf/setting.json` 已存在则只补桥接键 |
| 进程 | `python -m xiaomusic.cli --config config.json`，健康检查 `/getsetting` 轮询到就绪，崩溃指数退避重启，插件卸载时 `taskkill /T` |
| 端口 | 已有服务能响应 `/getsetting` 就直接复用，不抢；只有端口被占但无响应才报 `PORT_BUSY` |
| 站点包定位 | 问解释器要 `sysconfig.get_paths()["purelib"]`，而不是猜 `Lib/site-packages`（复用外部解释器时猜错） |

配置归一化的两处配合：

- `baseUrl` 指向非本机地址 → 自动 `managed:false`，只连外部服务；`managed:false` 也可显式写；
- `username`/`httpauthPassword` 才是 xiaomusic 的 HTTP basic auth，小米账号密码不再误当 API 密码发出。

工具侧新增 `xm_setup`：报告「服务是否就绪 / cookie 在不在 / 认到哪些音箱」，并支持写入小米账号、`miDid`、MUSIC_U（写文件，不走日志），改完自动重启。其余工具在动作前 `awaitRuntime()`，首次安装那几十秒里等待而不是误报「连不上 xiaomusic」。

实测（真机，全新目录）：

```
home = C:\Users\cyx\AppData\Local\Temp\xm-runtime-probe
[INFO] 用 uv 创建 Python 环境（…\.venv）
[INFO] 安装 xiaomusic==0.6.1（当前 无），首次安装约需 10-60 秒
[INFO] 已覆盖 6 个补丁文件到 …\.venv\Lib\site-packages\xiaomusic
[INFO] 已生成默认配置 …\config.json
[INFO] xiaomusic 已就绪 http://127.0.0.1:8091
start() => { ok: true, started: true } 6164ms
getsetting: enable_agent_bridge=true, agent_bridge_url=http://127.0.0.1:3071/ask,
            music_path=…\music, hostname=http://100.64.0.8, get_duration_type=mutagen
补丁生效: parse_volume=True parse_stop_delay=True resume_pushed_url=True settle_before_play=True
```

接管已有安装（`home` 里已有 `config.json` + `conf/setting.json`）：

```
[INFO] 已在 conf/setting.json 打开语音桥接
start() => { ok: true, started: true }
config.json  music_path 保留 = true | hostname 保留 = true
setting.json music_path 保留 = true | key_word_dict 保留 = true
setting.json enable_agent_bridge = true | agent_bridge_url = http://127.0.0.1:3071/ask
```

即用户自己的歌单目录和口令配置不被覆盖，只多出桥接键。

已知边界：托管运行时不带 ffmpeg（TTS 时长改走 mutagen，B 站转码类功能不可用）；小米账号扫码登录仍需打开 xiaomusic 的 Web 界面，`xm_setup` 只做账号密码。

### 17.1 M1 结构

**代码位置**：`dsh-plugin/netease-xiaomusic/`（bundle 包名 `@local/netease-xiaomusic`）。

```
dsh-plugin/netease-xiaomusic/
├── package.json          # dsh.bundle.patch + exports(locale/icon)
├── cordis.patch.yml      # 插入 netease-xiaomusic 行
├── index.js              # apply(ctx, config)：建客户端 + 托管运行时 + 注册 7 个工具
├── lib/
│   ├── config.js         # 运行时配置归一化（无 Config 导出）
│   ├── runtime.js        # 托管 xiaomusic：建环境/装包/打补丁/生成配置/守护进程
│   ├── ncm.js            # ncm-cli 定位（解析 .cmd shim）+ 搜索 + 错误归一
│   ├── netease.js        # player/url/v1 + MUSIC_U + 歌手目录
│   ├── resolve.js        # 口语请求 → 候选（歌手请求 vs 歌名请求）+ 打分
│   ├── xiaomusic.js      # HTTP 客户端（设备/推流/TTS/控制/状态）
│   └── tools.js          # 7 个 raw JSON-Schema 工具定义
├── vendor/xiaomusic/     # 打过补丁的 xiaomusic 源码（覆盖进站点包）
│   ├── agent_bridge.py
│   ├── command_handler.py
│   ├── config.py
│   ├── device_player.py
│   ├── xiaomusic.py
│   └── api/routers/device.py
├── locale/{zh,en}.json
└── icon.svg
```

**工具**：`xm_setup`、`speaker_list`、`ncm_search`、`ncm_play`、`ncm_control`、`ncm_status`、`speaker_say`。

**实现取舍（与设计稿的偏差，均已实测）**：

| 项 | 设计 | 实现 | 原因 |
| --- | --- | --- | --- |
| 工具注册 | `defineTool` | `ctx.tools.register(raw JSON-Schema)` | 本地目录安装的 bundle 无法可靠解析宿主包；`dsh-xiaoai-bridge` 同样做法 |
| Config | schemastery `Config` 导出 | 不导出，`normalizeConfig()` 运行时修正 | 同上；字段少，手写归一化足够 |
| 安装 | `install_bundle` 一行 | 需要 profile `.npmrc` 三行（见下） | 运行时是 `0.2.1-rc.3`，pnpm 对 peer 的 `^0.2.1` 范围在 registry 上无匹配版本 |
| pause/resume | 设计里有 | **未实现** | xiaomusic 没有 pause/resume API，`ncm_control` 只做 stop/next/prev/volume |
| 直链 | R1 旁路 | S1（cookie） | R1 在 0.1.7 不可用（6.2） |

**profile 侧副作用**（`C:\Users\cyx\.dsh\profiles\web\.npmrc`）：

```ini
ignore-workspace-root-check=true   # pnpm add 指向 workspace 根目录
auto-install-peers=false           # 关闭 peer 自动安装
strict-peer-dependencies=false     # 让缺失 peer 降级为 warning
```

没有这三条时，`install_bundle` 会因 `@deepseek-ai/dsh-tools@>=0.2.1 <0.3.0-0`（stable 0.2.1 从未发布）失败。

**待办**：M2 再补设置页字段（需要 `Config` 导出与 schemastery 依赖）；cookie 目前走文件即可用。

**cookie 注入（已实现，无需重启）**：按 `环境变量 DSH_NETEASE_MUSIC_U` → `config.netease.musicU` → `config.netease.cookieFile`（默认 `~/.dsh/netease-music-u.txt`）的顺序解析，**每次解析直链时重新读文件**，所以换 cookie 只要覆盖文件，不必重启 Host。文件内容允许带 `MUSIC_U=` 前缀。

**播放真实性回读（实现中发现的问题）**：`/playurl` 是「把 URL 代理给设备」，不会更新 xiaomusic 自己的 `is_playing`/`cur_music`，因此 `/playingmusic` 会一直报"没在播放"。修正为：

| 位置 | 处理 |
| --- | --- |
| `ncm_play` | 推流后轮询 `/getplayerstatus` 最多 6 s，只有设备真的 `status=1` 才说「已在…播放」，否则如实说「已下发但没读到播放」 |
| `ncm_status` | 以设备 `status` 为准；xiaomusic 没记录时用插件自己记住的最后一次推流（歌名/歌手），并标注「来源：本插件的直链推流」 |
| `ncm_control(stop)` | 清掉这份记录 |

**重载方式**：链接安装（`link:`）下改代码不会自动生效，`plugin_manager set_plugin enabled=false` 再 `true`（entryId `include:netease-xiaomusic`）即可加载新代模块。

### 17.1 M1 验收记录（模型层，真机音箱）

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | `speaker_list()` | ✅ `小爱音箱Pro（did=425774956，LX06，在线）` |
| 2 | `ncm_search("李荣浩 李白")` | ✅ 3 条候选，标注 `[可播/VIP]` 与两种 ID |
| 3 | `ncm_play(keyword=…)` | ✅ `已在「小爱音箱Pro」播放：李白 — 李荣浩《模特》（320k MP3）` |
| 4 | `ncm_status()` | ✅ `正在播放：李白 — 李荣浩（来源：本插件的直链推流，音量 15）` |
| 5 | 间隔后再次 `ncm_status()` | ✅ 状态保持，未丢失 |
| 6 | `ncm_control("stop")` → `ncm_status()` | ✅ 先「已停止」，后回到「当前没有在播放」 |
| 7 | 失败路径 | ✅ cookie 缺失时原样返回 `-110 需要更新 MUSIC_U`，不静默失败 |

四处状态（play 文案 / status / stop / 最终状态）互相印证，无「说已播放但状态说没在播」的矛盾。

**剩余差异**：`ncm_play` 会带上专辑与码率，`ncm_status` 只有歌名歌手——详略不同，可后续统一口径。

## 附录 A：ncm-cli 命令映射

| 场景 | 命令 |
| --- | --- |
| 搜索 | `ncm-cli search song --keyword "…" --output json` |
| 播放单曲 | `ncm-cli play --song --encrypted-id <32hex> --original-id <num>` |
| 暂停/继续/停止 | `ncm-cli pause` / `resume` / `stop` |
| 上下曲 | `ncm-cli next` / `prev` |
| 音量 | `ncm-cli volume <0-100>` |
| 进度 | `ncm-cli seek <seconds>` |
| 状态 | `ncm-cli state --output json` |
| 队列 | `ncm-cli queue` / `queue add` / `queue clear` |
| 登录态 | `ncm-cli login --check`，必要时 `login --background` |
| 命令树 | `ncm-cli commands`（登录后含动态命令） |

## 附录 B：xiaomusic 关键接口

| 用途 | 接口 |
| --- | --- |
| 设备列表 | `GET /device_list` |
| 播放 URL | `GET /playurl?did=<did>&url=<urlencoded>` |
| TTS | `GET /playtts?did=<did>&text=<text>` |
| 当前播放 | `GET /playingmusic` |
| 播放状态 | `GET /getplayerstatus?did=<did>` |
| 推送 URL（POST） | `POST /api/device/pushUrl` `{did, url}` |
| 执行口令 | `POST /cmd` `{did, cmd}` |
| 鉴权 | HTTP Basic（`httpauth_password`），`disable_httpauth=true` 时跳过 |

## 附录 C：修订记录

| 版本 | 变更 |
| --- | --- |
| v0.1 | 初稿：双入口架构、6 个工具、三级直链解析、xiaomusic 补丁方案、分期与风险 |
| v0.2 | 评审后：确认打补丁；路由改为「播放类口令一律转大模型」并补优先级表（7.3）；新增分组播放说明（7.5）；VIP 已确认，试听降级降级为保底（6.4 / 风险 5）；补决策记录（16） |
| v0.3 | 第 2 轮评审：TTS 默认策略、允许 outer 降级、不做写操作（N6）、单设备；P0 部分实测结果入档（16.3），据实修正 R2 边界（仅 `fee=0` 可用） |
| v0.4 | 端到端播放实测通过（16.3），风险「音箱拉不了网易云直链」关闭；实测 DSH Web 认证与监听地址，桥接改为插件自带 `127.0.0.1:3071` 监听（5.5 / 9 / 10） |
| v0.5 | 本机安装并登录 ncm-cli 0.1.7 后实测：搜索可用且字段齐备、VIP 有效；但 `play` 的 daemon 链路不可用、命令树无直链输出，**R1 判定失效**（6.2/6.3）；新增直链来源三方案与选型表（6.5），待用户决策 |
| v0.6 | 用户提供 `MUSIC_U`；实测 S1 拿到 VIP 全曲直链（320k/FLAC），并端到端在「小爱音箱Pro」播放 20 s 成功 → **直链方案定稿**（6.5 写入完整契约与 `code` 判定表），S2 因缺网易云源被排除 |
| v0.7 | M1 落地：`dsh-plugin/netease-xiaomusic` 6 个工具已安装并生效；补 cookie 文件注入、播放真实性回读、链接安装的重载方式（17）；实测修掉了「推流后状态显示未播放」的缺陷；模型层 + 真机音箱验收通过（17.1） |
| v0.8 | M2 落地：xiaomusic 语音路由 + 插件桥接（`127.0.0.1:3071`）；`POST /cmd「播放李白」` 全链路实测通过（TTS 5.7 s 后推流，连续播放 22 s+）；记录四个实现坑（17.0），含 venv 非 editable 的有效性陷阱 |
| v0.9 | 实测发现开放平台 `visible`/`playFlag` 不可信（《素颜》标记不可播但 320k 直链正常）；`ncm_play` 改为以直链返回码判定，选歌改为按歌名/歌手评分（17.0.1），复测通过 |
| v0.10 | M2.1：插件队列 + `/next` `/prev` `/forget`，`下一首/上一首` 不再串回本地旧歌单；补 `key_match_order` 缺失的停止类口令；实测「播放→下一首×2→上一首→停止」全通过（17.0.2） |
| v0.11 | 修「下一首还是同一首」：带 ID 播放时复用最近一次搜索结果作为候选，并按去重歌名建队列；单实例干净复测 `许嵩→幻听→又小雪` |
| v0.12 | 去重加强：标题指纹（去括号/标点/大小写）+ 包含判定折叠「许嵩-素颜」类变体；队列不足 2 首时按「关键词→歌手」用网页搜索补货；实测 `素颜→有何不可→幻听→庐州月`、`许嵩的歌→天龙八部之宿敌→雅俗共赏` |
| v0.13 | 队列支持随机（跟随 xiaomusic `PLAY_TYPE_RND`）与历史回退；修复一次 20 s 桥接超时（persona 改为单次 `ncm_play`，超时提到 35 s） |
| v0.14 | `queue.mode` 默认 `random`（不再依赖小爱模式），可切 `follow` / `sequential`；单测确认三种模式行为 |
| v0.15 | 修「半小时后关闭音乐」被当成立即停止：新增 `parse_stop_delay()`，支持半小时/小时/分钟三种单位并回读确认；实测 1 分钟定时准确（17.0.3） |
| v0.16 | 修「播放许嵩的歌」不播：①语音会话被 GUI 归档 → 步进被 `reject(blocked)`，加 `ensureRunnable()` 自愈 + 一次重试；②歌手请求改走歌手目录（新增 `lib/resolve.js`），打分去掉不可信的 `playable` 权重；真机实测 `播放许嵩的歌 → 多余的解释/素颜（许嵩）`（17.0.4） |
| v0.17 | 修「一分钟后关闭音乐」确认完就没声：推流地址被 TTS 顶掉后无人续播，新增 `_pushed_url` + `resume_pushed_url()`，只在延时关闭这条路径续播；真机实测 10:35:26 续播、10:36:21 准确停止（17.0.5） |
| v0.18 | 修「音量调整为20%」被当点歌（先念「好的，正在找歌」）：xiaomusic 没有音量关键词，口令兜底进了大模型；新增 `parse_volume()` 在 `match_cmd` 前本地执行，支持绝对/相对/最大最小/静音，且不影响以播放动词开头的句子；实测调音量不再打断音乐（17.0.6） |
| v0.19 | 修音量口令后「只听到一声好的，音乐没了」：小爱自己的语音助手应答时会抢占播放，外部推流无人续上；新增 `resume_pushed_url_if_stopped()`，音量口令后轮询 8 秒，发现设备未播放即重新推流；实测应答后自动续播、音量保持（17.0.7） |
| v0.20 | 修「播完没有下一首」：外部推流没有时长、xiaomusic 不会排下一首；插件随 `/playurl` 带 `durationSec`，xiaomusic 据此排定时器，到点走 `_play_from_agent_queue()` 回插件队列接力，队列空了不乱跳本地歌单；同时用 `settle_before_play()` 消除「TTS 定时器 stop 收尾掐掉新歌」的竞态；实测 20 秒压缩验证：定时器到点 → 清明雨上（许嵩）→ 继续排下一首（17.0.8） |
| v0.21 | 零安装：新增 `lib/runtime.js` 托管 xiaomusic（uv/python 建环境 → pip 装包 → 覆盖 vendor 补丁 → 生成配置 → 守护进程），不再需要 `start-xiaomusic.bat`；新增 `xm_setup` 工具做首次配置与自检；`baseUrl` 指向外部时自动降级为纯客户端。实测全新目录 6.2 秒完成安装+补丁+启动，接管已有安装时保留原 `music_path`/口令表（17.0.9） |

| v0.22 | 修「非音乐对话也被 xiaomusic 接管」：「六点二十叫我起床」原本走未命中兜底进大模型，xiaomusic 先掐掉小爱的应答、再让模型用 TTS 道歉，闹钟没设成。现在 `is_passthrough_to_xiaoai()` 把闹钟/天气/时间/家电/闲聊直接放行给小爱（不掐、不念 TTS、不转发），兜底改为只在 `agent_bridge_when=fallback` 时生效；新增 `agent_bridge_non_music_patterns` / `agent_bridge_query_patterns` / `agent_bridge_music_patterns`；`parse_stop_delay` 不再把「半个小时后关闭叫我起床」当延时关机；插件侧提示词先判音乐意图，并用 `isNonMusic()` 兜底丢弃非音乐的 chat 回复（17.0.10）|
| v0.23 | 泛播放改为每日推荐：「播放音乐」「放点歌」「随便放点」这类没点名歌名/歌手的请求，不再当歌名去搜（原行为会随机落到某个歌手），改为拉账号「每日推荐」30 首整队列推给音箱，「下一首」在 30 首内接力；新增 `ncm_recommend` 工具与 `resolve.isGenericPlayRequest()`，`ncm_play` 遇泛词自动转推荐；队列上限 20→60（原先 30 首会被截断）；无 cookie/取不到推荐时退回公开热歌榜（17.0.11）|
