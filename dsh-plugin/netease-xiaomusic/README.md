# @local/netease-xiaomusic

DSH 插件：让小爱音箱播放网易云音乐。

**装好这个插件就够了。** 它自带 xiaomusic 运行时 —— 首次加载时自动建 Python 环境、
安装 xiaomusic、打上语音转发补丁、生成配置并启动服务。不需要另外跑
`start-xiaomusic.bat`，也不需要手动装 Python 包。

- **选歌**：`ncm-cli` 搜索并挑版本；
- **直链**：网易云播放器接口 + 账号 `MUSIC_U` cookie（VIP 全曲 320k / FLAC）；
- **出声**：插件托管（或复用）的 xiaomusic 把 URL 推给小爱音箱。

## 安装

```bash
npm i -g @music163/ncm-cli
ncm-cli login --background      # 扫码登录网易云
```

然后在 DSH 里安装本目录（`plugin_manager` 的 `install_bundle`，target = 本目录绝对路径，
或让 agent 代劳）。装完即可用 —— 首次加载会在后台完成 xiaomusic 的安装，约 10–60 秒。

## 首次配置

| 需要什么 | 怎么给 |
| --- | --- |
| 小米账号 | 让模型调 `xm_setup`（account + password），或写进 row config 的 `xiaomusic.account/password` |
| 网易云 cookie | 让模型调 `xm_setup`（musicU），或写 `~/.dsh/netease-music-u.txt` |
| 默认音箱 | 只有一台时自动选中；多台时用 `xm_setup` 的 miDid 或 config 的 `defaultSpeaker` |

`xm_setup` 不带参数时报告现状：服务是否就绪、cookie 有没有、认到了哪些音箱。

## 工具

| 工具 | 用途 |
| --- | --- |
| `xm_setup` | 查看运行状态；配置小米账号 / cookie；改完自动重启 |
| `speaker_list` | 列出音箱（did / 名称 / 型号 / 在线） |
| `ncm_search` | 搜歌，返回可播候选与两种 ID |
| `ncm_play` | 播放（`keyword` 或 `encryptedId`+`originalId`），推流后回读设备状态 |
| `ncm_control` | `stop` / `next` / `prev` / `volume` |
| `ncm_status` | 当前在放什么（以设备状态为准） |
| `speaker_say` | TTS 播报 |

## 配置项（row config）

```yaml
enabled: true
xiaomusic:
  managed: true           # false = 只连外部已经跑着的 xiaomusic
  home: ''                # 托管目录，留空 => ~/.dsh/xiaomusic
  version: '0.6.1'        # 装哪个 xiaomusic
  port: 8090
  hostname: ''            # 音箱取音频用的地址，留空 => 自动探测局域网 IP
  account: ''             # 小米账号
  password: ''
  miDid: ''               # 多台音箱时固定默认设备
  python: ''              # 指定解释器（复用已有环境时用）
defaultSpeaker: ''
ncmCli: 'ncm-cli'
netease:
  musicU: ''              # 留空则读 cookieFile
  cookieFile: '~/.dsh/netease-music-u.txt'
  level: 'exhigh'         # standard|higher|exhigh|lossless|hires
queue:
  mode: 'random'          # random（默认）| follow | sequential
```

`baseUrl` 指向非本机地址时自动按「外部服务」处理，不会去装或启动本地副本。

## 托管运行时做了什么

1. `uv venv`（没有 uv 就退回 `python -m venv`）建环境在 `home/.venv`；
2. `pip install xiaomusic==<version>`，先用清华镜像，失败再回退官方源；
3. 把 `vendor/xiaomusic/` 里 6 个打过补丁的文件覆盖进站点包，并用
   `home/.dsh-overlay.json` 记录版本与文件哈希 —— 升级或重装后自动重打；
4. `home/config.json` 不存在才生成（`get_duration_type=mutagen`，免装 ffmpeg）；
   `home/conf/setting.json` 已存在则只补 `enable_agent_bridge` 等桥接键；
5. 用该解释器启动 `python -m xiaomusic.cli --config config.json`，崩溃自动重启
   （快速崩溃时指数退避），插件卸载时结束进程。

端口已被占用且能响应 `/getsetting` 时直接复用，不会去抢。

## 已知限制

- `ncm-cli` 的 `play` 在 0.1.7 上不可用（daemon 无响应），播放不经过 CLI 的播放器；
- 小米账号的扫码登录仍需要打开 xiaomusic 的 Web 界面（`http://<本机>:8090`），
  `xm_setup` 只支持账号密码；
- 托管运行时不带 ffmpeg：TTS 时长走 mutagen，B 站/本地转码类功能不可用；
- `ncm_control` 没有 `pause`/`resume`，因为 xiaomusic 没有对应接口。
