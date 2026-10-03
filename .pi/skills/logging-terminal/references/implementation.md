## 13. 实现速查

颜色语义（第 3 节）的最小落地参考；业务代码仍禁止硬编码颜色，优先经终端层语义动作（第 2 节）间接着色。

ANSI 前景色：绿 `32`、黄 `33`、红 `31`、青 `36`、蓝 `34`、灰 `90`；重置 `0`。包裹形式 `\e[{code}m文本\e[0m`。

启用前同时检测：输出是否 TTY、`NO_COLOR` 是否设置、是否 CI 或重定向；任一命中则输出稳定纯文本。

Python（CLI 脚本）：

```python
import os
import sys

TTY = sys.stdout.isatty() and "NO_COLOR" not in os.environ

def say(tag: str, text: str, code: int) -> None:
    line = f"[{tag}] {text}"
    print(f"\033[{code}m{line}\033[0m" if TTY else line)

say("成功", "构建完成", 32)
say("警告", "依赖版本偏低", 33)
say("错误", "测试失败", 31)
```

PowerShell 7（服务端/工具脚本）：

```powershell
$tty = $Host.Name -eq "ConsoleHost" -and -not [Console]::IsOutputRedirected -and -not $env:NO_COLOR

function Say([string]$Tag, [string]$Text, [ConsoleColor]$Color) {
    $line = "[$Tag] $Text"
    if ($tty) { Write-Host $line -ForegroundColor $Color } else { Write-Output $line }
}

Say "成功" "构建完成" Green
Say "警告" "依赖版本偏低" Yellow
Say "错误" "测试失败" Red
```

要点：文字标签 `[成功]`/`[警告]`/`[错误]` 必须随行输出，颜色只是增强；去色后行内容不变。

日志系统起步（Python 标准库，按大小轮转 + 保留上限，满足「不无限叠加」的最小配置）：

```python
import logging
from logging.handlers import RotatingFileHandler

handler = RotatingFileHandler(
    "app.log", maxBytes=5 * 1024 * 1024,  # 单文件 5 MB
    backupCount=3, encoding="utf-8"        # 最多保留 3 个历史文件，共约 20 MB 封顶
)
handler.setFormatter(logging.Formatter(
    "%(asctime)s %(levelname)s %(name)s %(message)s"
))
logger = logging.getLogger("app")
logger.addHandler(handler)
logger.setLevel(logging.INFO)  # debug 默认关闭，排查时再开
```

长期服务按日期轮转换用 `TimedRotatingFileHandler(when="midnight", backupCount=14)`；结构化需求升级时改用 JSON Lines 输出，字段遵循第 4 节。
