---
name: dependency-management
description: >-
  依赖管理规范：包管理器统一使用 pnpm（JavaScript/TypeScript）与 uv（Python）、不混用 npm/yarn、不顺便升级或重写锁文件、pnpm dlx 临时执行、新增依赖前评估体积维护许可证安全与兼容性。新增、升级或移除项目依赖前加载。
---

# 依赖管理规范

## 1. 通用规则

- 包管理器统一使用 `pnpm`（JavaScript/TypeScript）与 `uv`（Python）；不引入 `npm`、`yarn` 或其他包管理器，不因普通代码修改升级依赖或重写锁文件。
- 仅在依赖实际变化时修改锁文件，不顺便升级无关依赖。
- 不主动全局安装依赖，优先使用项目本地工具或 `pnpm dlx` 等临时执行方式。
- 引入新依赖前，评估现有依赖或标准库能否满足需求，以及体积、维护状态、许可证、安全、兼容性和迁移成本。

## 2. Python 与 uv

- Python 项目一律使用 uv 管理环境与依赖：`uv venv`、`uv add`、`uv sync`、`uv run`。
- 执行 Python 命令优先用 `uv run`，或确认项目 `.venv` 已激活；不主动创建新环境，除非工程师明确要求。
- 项目根目录涉及 Python 且采用 uv 管理时，保留 `pyproject.toml` 与 `uv.lock`。

## 3. JavaScript 与 TypeScript

- 统一使用 `pnpm` 安装、升级与移除依赖，锁文件为 `pnpm-lock.yaml`。
- 新增依赖写入对应 workspace 的清单文件，不手动编辑锁文件。
