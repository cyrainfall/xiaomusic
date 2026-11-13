# 本地部署工具

这套脚本用于在 Windows 上常驻运行 XiaoMusic，解决三件事：开机自启、登录态持久化、夜间不监听。

## 文件说明

| 文件 | 作用 |
|---|---|
| `start-service.cmd` | 启动器：单实例检查 → 恢复登录备份 → 按当前小时决定是否监听 → 启动服务 |
| `backup-login.ps1` | 把 `conf/auth.json`、`conf/.mi.token` 备份到 `conf/.login-backup/` |
| `apply-listen-schedule.py` | 启动时按当前小时设置 `enable_pull_ask`（02:00–10:00 不监听） |
| `register-tasks.ps1` | 注册/更新两个计划任务（服务自启、每 10 分钟登录备份） |
| `patch-venv.sh` | 把 `xiaomusic/*.py` 六个补丁文件覆盖进某个 venv 的站点包；`--check` 只体检 |

## 补丁别丢：`patch-venv.sh`

`pip install -U xiaomusic` 会把站点包退回原版，症状是「开风扇」被当点歌、
先念一句「好的，正在找歌」（原版 `should_delegate()` 未命中就转发）。补丁
不只在 `tools/patches/`（那两处文本替换里），还包括 `xiaomusic/*.py` 本身。

```bash
tools/patch-venv.sh --check                 # 体检仓库 .venv（有差异退出码 1）
tools/patch-venv.sh --check ~/.dsh/xiaomusic/.venv
tools/patch-venv.sh                         # 重打仓库 .venv（改完必须重启服务）
```

插件侧也加了同一道哨：复用已运行的 xiaomusic 前会探 `/getsetting`，没有
`agent_bridge_non_music_patterns` 就告警，不再静默采纳原版。

## 首次部署

```powershell
# 1. 装依赖（虚拟环境放在仓库内）
python -m venv .venv
.venv\Scripts\python.exe -m pip install -U xiaomusic -i https://pypi.tuna.tsinghua.edu.cn/simple

# 2. 准备 ffmpeg（放到 ffmpeg/bin，并把该目录加入 PATH）
#    yt-dlp 也建议复制到同一目录，程序内部按裸命令名调用

# 3. 生成 config.json（参考 config-example.json），至少设置：
#    hostname = http://<本机局域网IP>，port = public_port = 8090

# 4. 注册计划任务
powershell -ExecutionPolicy Bypass -File tools\register-tasks.ps1
```

## 日常操作

```powershell
schtasks /run   /tn XiaoMusic     # 启动
schtasks /end   /tn XiaoMusic     # 停止
tasklist | findstr xiaomusic      # 看进程
```

启动结果会追加到 `tools/startup.log`，方便确认当天是否开启了监听。

## 运行时补丁

`.venv` 中的两处修改不在 git 管理范围，`pip install -U xiaomusic` 升级后会被覆盖：

| 补丁 | 作用 |
|---|---|
| `api_routers_file.py.patch` | B 站转码流：读超时 60s → 120s，去掉 600s 总时长硬切断 |
| `js_plugin_manager.py.patch` | 允许在后台启用"未加载"的插件（修复 `启用插件失败: undefined`） |

重新应用（幂等，可重复执行）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\reapply-patches.ps1
```

## 已知限制

- 服务以当前用户身份在登录后启动，未登录时不会运行；
- 登录态依赖 `conf/setting.json` 里的账号密码（或 `conf/.mi.token`），两者都不在版本库里；
- `start-service.cmd` 必须是 **CRLF** 换行，否则 cmd.exe 解析会截断命令。
