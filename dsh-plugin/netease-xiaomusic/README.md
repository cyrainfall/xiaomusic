# @local/netease-xiaomusic

DSH 插件：让「小爱音箱」播放网易云音乐。

- **选歌**：`ncm-cli` 搜索并判断可播性（`visible` / `playFlag` / `vipFlag`）；
- **直链**：网易云播放器接口 + 账号 `MUSIC_U` cookie（VIP 全曲 320k / FLAC）；
- **出声**：`xiaomusic` 把 URL 推给音箱（`/playurl`）。

## 安装

```bash
# 1. 依赖
npm i -g @music163/ncm-cli
ncm-cli login --background   # 扫码登录

# 2. 安装插件（在 DSH 里用 plugin_manager，或让 agent 代劳）
#    target = 本目录绝对路径
```

安装后 `plugin_manager` 会把本目录以 `link:` 方式挂进 profile；改代码后需要
`set_plugin enabled=false` 再 `true`（entryId `include:netease-xiaomusic`）才会加载新模块。

## 配置 cookie

把浏览器里网易云的 `MUSIC_U` cookie 值写进：

```
~/.dsh/netease-music-u.txt
```

（可带 `MUSIC_U=` 前缀；每次解析直链都会重新读文件，换 cookie 不用重启。）

也可以用环境变量 `DSH_NETEASE_MUSIC_U`，或 row config 的 `netease.musicU`。

## 工具

| 工具 | 用途 |
| --- | --- |
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
  baseUrl: 'http://127.0.0.1:8090'
  username: ''          # xiaomusic 开启 HTTP 认证时填
  password: ''
defaultSpeaker: ''      # did 或设备名；只有一台时自动选中
ncmCli: 'ncm-cli'
netease:
  musicU: ''            # 留空则读 cookieFile
  cookieFile: '~/.dsh/netease-music-u.txt'
  level: 'exhigh'       # standard|higher|exhigh|lossless|hires
timeouts:
  ncmMs: 15000
  xiaomusicMs: 8000
queue:
  mode: 'random'        # random（默认）| follow（跟随小爱播放模式）| sequential
  autoAdvance: false    # 放完自动接下一首（带"中途被停就不续"守卫）
```

## 已知限制

- `ncm-cli` 的 `play` 在 0.1.7 上不可用（daemon 无响应），因此播放不经过 CLI 的播放器；
- `ncm_control` 没有 `pause`/`resume`，因为 xiaomusic 没有对应接口；
- 只能选择 `visible && playFlag` 的条目，版权受限的会明确拒绝。
