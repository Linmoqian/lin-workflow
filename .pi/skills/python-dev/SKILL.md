---
name: python-dev
description: >-
  Python 开发规范：PEP 8 与项目既有配置、Ruff 格式化与静态检查、命名约定、环境与依赖、并发、CLI 输出。编写或修改 Python 代码时加载。
---

# Python 开发规范

## 基本原则
- UV
- Python 代码遵循 PEP 8，优先遵循项目已有配置和风格。
- 使用 Ruff 执行格式化和静态检查；已有等效工具链时，不擅自替换。
- 简单脚本保持简单，不为一次性任务增加不必要的抽象或并发。

## 命名

- 变量、函数和模块使用 `snake_case`。
- 类使用 `PascalCase`。
- 常量使用 `UPPER_SNAKE_CASE`。

## 环境与依赖

- 仅在 Python 且采用 conda 管理环境的项目中，保留项目根目录的 `environment.yml`。
- 执行 Python 命令前确认当前 conda 环境；不主动创建新环境，除非工程师明确要求。
- 遵循项目现有依赖管理方式和锁定文件，不擅自迁移到 conda、pip 或其他工具。
- 新增依赖应使用项目既有包管理器，并保持依赖声明同步。

## 并发

- 仅在任务确实受益时使用并发，并说明选择依据。
- I/O 密集任务可考虑多线程或 `asyncio`。
- CPU 密集任务优先考虑向量化、多进程、NumPy、PyTorch 或 CUDA。
- 不为所有脚本强制使用多线程。

## CLI 输出

- 输出应语义清晰、稳定、可复制和可日志化，不使用闪烁刷新。
- 避免使用 `*`、`-`、`=` 等字符堆叠成分隔线。
- CLI 层必要时使用颜色：绿色表示成功，黄色表示警告，红色表示错误，青色表示交互提示，蓝色表示高亮或链接，灰色表示次要信息。
- 库代码不强制输出彩色日志；应由调用方决定展示方式。

## 工程环境与 uv

- 涉及 Python 时默认使用 uv 管理环境与依赖：`uv venv`、`uv add`、`uv sync`、`uv run`。
- 执行 Python 命令优先用 `uv run`，或确认项目 `.venv` 已激活；不主动创建新环境，除非工程师明确要求。
- 项目根目录采用 uv 管理时保留 `pyproject.toml` 与 `uv.lock`。

## 代码风格细则

- 文件头以一行中文注释说明用途，例如 `# 一次LLM的对话`；代码顶部注释 `Created on <代码更新时间>` 与 `@author: https://github.com/Linmoqian`。
- 导入顺序：标准库在前，空一行后接第三方库。
- 模块级常量使用 `UPPER_SNAKE_CASE`，如 `TCP_IP`、`TCP_PORT`、`MODEL_PATH`。
- 函数调用采用竖式展开，参数逐行书写，末参数不加逗号：
```python
server = socket.socket(
    socket.AF_INET,
    socket.SOCK_STREAM
)
```
- 不写 docstring，以中文行内注释解释步骤与原因；`print` 使用 f-string，流式输出用 `end="", flush=True`。

## 测试与演示脚本

- 测试与演示脚本按模块分子目录，各目录附带简短 `README.md`、必要的 `.gitignore` 与 `.env.example`。
- 脚本命名 `test_*.py`，直接以 `python` 运行，不依赖 pytest；统一以 `if __name__ == "__main__":` 作入口。

## TCP 脚本惯例

- 服务端设置 `SO_REUSEADDR` 后执行 `bind`/`listen` 并循环 `accept`。
- 消息以 UTF-8 编码、`\n` 作帧分隔，接收端用缓冲字符串累积拆分。
- `try/finally` 保证 `close()`。

## 密钥加载

- 密钥经 `.env` 加载：`load_dotenv(Path(__file__).with_name(".env"))`；`.env` 不入库、`.env.example` 入库。
