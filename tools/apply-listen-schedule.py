"""启动时按当前小时决定是否开启语音监听。

规则：02:00 - 10:00 不监听，其余时间监听。
用法：python apply-listen-schedule.py [模拟小时]
"""

import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTING = os.path.join(ROOT, "conf", "setting.json")

hour = int(sys.argv[1]) if len(sys.argv) > 1 else datetime.datetime.now().hour
listen = not (2 <= hour < 10)

try:
    with open(SETTING, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

if data.get("enable_pull_ask") != listen:
    data["enable_pull_ask"] = listen
    with open(SETTING, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[XiaoMusic] hour={hour} -> enable_pull_ask={listen}")
else:
    print(f"[XiaoMusic] hour={hour} -> enable_pull_ask={listen} (unchanged)")
