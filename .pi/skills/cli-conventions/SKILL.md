---
name: cli-conventions
description: >-
  CLI 命令输入习惯：命令不带参数直接运行，数据经交互式问答（带默认值）、配置文件、环境变量或管道传入，避免参数值进入 shell 历史与进程列表、规避引号转义与中文路径问题；非交互环境兜底与例外场景。开发命令行工具、脚本入口或 main 函数时加载。
---

# CLI 命令输入习惯

## 1. 无参数原则

CLI 直接以命令名运行，不携带位置参数或取值参数（`-t value`、`--key=value` 一类）。需要数据时按优先级换用：

1. 交互式问答：运行后逐项提示输入，每项带默认值，回车接受。
2. 配置文件：`.env`、`config.json` 等放在约定位置，命令自行读取。
3. 环境变量：CI 与脚本调用的机器对机器场景。
4. 管道：批处理数据从 stdin 读入，如 `cat data.json | mytool`。

理由：参数值会进入 shell 历史与进程列表（敏感信息泄露）；含空格、中文或引号的值在 PowerShell/CMD/Bash 间转义规则不同，易错；无参数运行加默认值降低记忆负担，第一次就能跑通。

## 2. 交互式设计

- 提示格式 `项目名 [默认值]: `，回车直接接受默认值；无默认值的关键项给出示例。
- 无效输入重试同一提示，不做全局退出；重试次数有限（如 3 次）后取默认值或报错退出。
- 敏感值输入用掩码（PowerShell `Read-Host -MaskAsPassword`）；提示中不回显已输入的密钥。
- 交互提示使用终端语义 `input`/`select`（颜色与降级规则遵循 `logging-terminal` Skill 第 2、3 节）。
- 非交互环境（CI、管道、重定向）不得阻塞：检测到非 TTY 时改用环境变量或配置文件，缺值则输出 `[错误]` 说明缺什么、怎么传，以非零码退出。

## 3. 例外场景

允许带参数的情况：

- `--help`、`--version` 这类自描述 flag。
- 自动化管道与脚本间调用（值来自脚本变量而非人工输入），例如 `install.ps1 -Target project`。
- 单个明确的一次性开关（如 `--yes` 跳过确认），但不传任意值。

## 4. 示例

Python（`uv run mytool`，无参数）：

```python
def ask(prompt: str, default: str) -> str:
    value = input(f"{prompt} [{default}]: ").strip()
    return value or default

def main() -> None:
    host = ask("服务地址", "127.0.0.1")
    port = int(ask("端口", "8000"))

if __name__ == "__main__":
    main()
```

PowerShell 7：

```powershell
$host_ = Read-Host "服务地址 [127.0.0.1]"
if (-not $host_) { $host_ = "127.0.0.1" }
```

## 5. 边界

- 本习惯约束新建的 CLI 与脚本入口；已有的批处理脚本（如 `marketplace/install.ps1`）属自动化例外，不回改。
- 库代码不感知交互；交互只发生在入口层，解析后的值以参数传入库函数。
