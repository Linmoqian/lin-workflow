# pi 插件市场

lin-workflow 的 pi Skill 浏览与安装入口。本目录是零依赖静态交付物，可直接托管到 GitHub Pages 或任意静态服务器。

## 内容

| 文件 | 用途 |
| --- | --- |
| `generate.ps1` | 扫描 `.pi/skills/*/SKILL.md` 的 frontmatter，叠加手工分类映射，生成 `skills.json` |
| `install.ps1` | Windows 安装器（PowerShell 7）：全平台 skill 与子代理安装，含 Codex/Claude 格式转换 |
| `install.sh` | Linux/macOS 安装器（bash），与 install.ps1 参数同构 |
| `skills.json` | 市场索引（生成产物，随 skill 变化重新生成后提交） |
| `index.html` | 市场页面：搜索、分类浏览、整包安装命令与单 Skill 启用配置复制 |

## 使用

1. Skill 增删或描述变更后重新生成索引：`pwsh marketplace/generate.ps1`，随改动一并提交 `skills.json`。
2. 本地预览：`python -m http.server` 后访问 `http://localhost:8000/marketplace/`（`file://` 协议无法 fetch 索引）。

## 安装（按平台）

双脚本功能对齐：Windows 用 `pwsh marketplace/install.ps1`，Linux/macOS 用 `bash marketplace/install.sh`；`-Target`/`--target` 可逗号分隔多选。

| 平台 | 命令（pwsh 版，bash 版同参数） | 安装位置 |
| --- | --- | --- |
| pi（包管理） | `pi install git:github.com/Linmoqian/lin-workflow` | 由 pi 管理 |
| pi（原生） | `pwsh marketplace/install.ps1 -Target pi -Agents` | `~/.pi/agent/{skills,agents}` |
| pi 与 Codex 共享 | `pwsh marketplace/install.ps1` | `~/.agents/skills/` |
| Codex | `pwsh marketplace/install.ps1 -Target codex -Agents` | `~/.codex/{skills,agents}` |
| Claude Code | `pwsh marketplace/install.ps1 -Target claude -Agents` | `~/.claude/{skills,agents}` |
| dsh（DeepSeek Harness） | `pwsh marketplace/install.ps1 -Target dsh` | `~/.dsh/skills/` |
| 当前项目全平台 | `pwsh marketplace/install.ps1 -Target project -Agents` | `./.agents` `./.claude` `./.dsh` skill + `./.codex` `./.claude` agents |
| 全部用户级平台 | `pwsh marketplace/install.ps1 -Target agents,codex,claude,dsh,pi -Agents` | 各平台用户级目录 |

按名单安装：加 `-Skills python-dev,tauri`（bash 版 `--skills`）；查看可用清单：`-List`（`--list`）。

### 子代理转换说明

- **Codex**（依据 openai/codex agent-roles 源码）：`name`/`description`/`aliases`→`nickname_candidates`/`thinking`→`model_reasoning_effort`（max→xhigh）/正文→`developer_instructions`（`contact_supervisor` 改 `send_message`）；spawn 时 `agent_type=<name>` 引用。
- **Claude Code**（依据 code.claude.com 官方文档）：`name`/`description` + 工具名映射（`read→Read`、`grep→Grep`、`find→Glob`、`ls→LS`、`bash→Bash`、`edit→Edit`、`write→Write`、`web_search→WebSearch`、`fetch_content→WebFetch`；`pwsh_exec`、`test_pilot`、`contact_supervisor` 等无对应项丢弃），`contact_supervisor` 句子改写为「在最终回复中列出需主代理决策事项」。
- **dsh**：仅安装 skill；子代理无公开契约，跳过。
- pi 专属字段（`tools` 白名单、`systemPromptMode`、`inheritProjectContext`、`inheritSkills`）在无对应的平台不迁移。

## 分类映射

`generate.ps1` 内的 `$categoryMap` 手工维护 skill 到分类的归属；新增 skill 未列入映射时归入「其他」。
