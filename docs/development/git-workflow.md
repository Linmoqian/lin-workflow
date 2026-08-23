# Git 工作流规范

## 工作区保护

- 开始修改前运行 `git status --short`，识别并保留用户已有改动。
- 只修改当前任务直接需要的文件，不覆盖、不清理、不格式化无关改动。
- 发现与任务文件重叠的未知改动时，停止修改并确认处理方式。
- 禁止使用 `git reset --hard`、`git clean -fd`、`git checkout -- <path>` 等可能丢失工作区内容的高风险命令。
- 未经明确要求，不改写提交历史，不强制推送。

## 精准暂存

- 暂存前检查 `git diff` 和 `git status --short`。
- 使用 `git add <明确文件路径>` 或 `git add -p` 精准暂存。
- 禁止使用 `git add .`、`git add -A` 或其他可能混入无关改动的宽泛命令。
- 暂存后运行 `git diff --cached`，确认提交只包含当前任务改动。

## 提交前条件

提交前必须满足以下条件：

1. 改动范围与任务一致，没有混入无关文件。
2. 相关格式化、静态检查、测试和构建已通过；无法运行的检查已明确记录原因。
3. `TODO.md` 已按项目要求更新：完成项标记完成，不删除历史事项。
4. 已复查 `git diff --cached`，确认没有密钥、令牌、个人信息或调试残留。

## 提交信息

- 遵循 Conventional Commits：`<type>(<scope>): <中文描述>`。
- 提交信息只使用一行，用一句话高度概括本次提交的唯一目的；描述使用简洁中文，不使用笼统表述。
- 常用类型包括 `feat`、`fix`、`docs`、`refactor`、`test`、`build`、`ci` 和 `chore`。
- 提交信息不得提及 AI、自动生成或模型身份。

示例：

```text
docs(development): 补充 Git 工作流规范
fix(window): 修复无边框窗口拖拽失效
```

## 本地提交与推送边界

- 完成有效修改并通过必要检查后，应创建本地提交，无需额外询问。
- 一个提交只承载一个清晰目的；存在无关改动时必须分离或排除。
- 创建或切换分支、变基、合并等操作不得擅自扩大任务范围。
- 推送会改变远程状态，必须取得用户明确同意后执行。
- 未获同意时，工作在本地提交处结束，并汇报提交结果与待推送分支。

## Git 提交钩子

- 项目钩子位于 `.githooks/`，包含：
  - `pre-commit`：检查暂存区空白错误、疑似敏感文件，以及 `AGENTS.md` 与 `CLAUDE.md` 的一致性。
  - `commit-msg`：检查 Conventional Commits、单行一句话描述和禁止的 AI 生成字样。
- 克隆仓库后，在 PowerShell 中运行：

```powershell
& .\.githooks\setup.ps1
```

- 启用脚本只修改当前仓库的 `core.hooksPath`，不会修改全局 Git 配置；提交前必须确认 `git config --local --get core.hooksPath` 返回 `.githooks`。
- 钩子失败时必须修复问题后重新提交；除工程师明确授权的紧急情况外，禁止使用 `git commit --no-verify` 绕过检查。
- 钩子只能阻止可机械判定的错误，不能替代代码 Review、测试、构建和人工安全判断。
