---
name: windows-environment
description: >-
  Windows 工作环境规范：PowerShell 7 为默认 shell、UTF-8 与行尾保留、含空格路径引用、仅改大小写时的过渡文件名、PowerShell/CMD/Git Bash/WSL 语法差异与路径混用禁令、跨平台脚本约束。在 Windows 下执行命令、编写跨平台脚本或处理路径问题时加载。
---

# Windows 工作环境规范

## 1. Shell 与编码

- 当前机器为 Windows；shell 使用 PowerShell 7。
- 默认使用 UTF-8，并保留项目现有行尾风格。

## 2. 路径处理

- 路径可能包含空格时正确引用参数；本项目根目录路径含中文（`D:\桌面\lin-workflow`），命令中一律加引号。
- 不假设文件系统区分大小写；仅修改文件名大小写时，使用中间文件名过渡。
- 注意 PowerShell、CMD、Git Bash 和 WSL 的路径及环境变量语法差异；未经确认不混用 Windows 与 WSL 路径。

## 3. 脚本兼容

- 跨平台脚本不依赖仅在 Bash 中有效的语法。
- 文件操作优先使用 PowerShell 原生命令；调用外部工具时确认其在 Windows 下的实际行为，不凭 POSIX 经验假设。
