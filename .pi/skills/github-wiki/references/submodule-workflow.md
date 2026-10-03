# Wiki 子模块注册、更新与同步（github-wiki references）

## 4. Wiki 初始化与子模块注册

Wiki 首次创建或迁移时按以下顺序执行：

1. 在仓库设置中确认 Wiki 已启用，并核对维护人员权限。
2. 在确认远程地址后，将 Wiki 仓库注册为子模块；不要直接复制页面或覆盖远程历史。

以下命令中的尖括号占位符必须替换为实际仓库信息后再执行：

```powershell
git submodule add https://github.com/<owner>/<repository>.wiki.git docs/wiki
git submodule update --init --recursive
git -C docs/wiki status --short
```

3. 在 `docs/wiki/` 内创建独立的本地工作分支，例如 `docs/wiki-initial`，完成页面编写和本地检查；不要在主仓库分支中直接改写子模块历史。
4. 先建立最小可用页面集合，再逐步补充专题内容。
5. 检查链接、代码块、命令、图片、版本信息、敏感信息和导航结构。
6. 由维护人员在子模块仓库内进行内容 Review，并记录未覆盖项、潜在风险和待办。
7. 工程师确认页面范围、子模块目标提交和发布内容后，才允许向 Wiki 远程仓库推送。
8. 子模块提交推送成功后，在主仓库检查 gitlink 变更和 `.gitmodules`，再提交新的子模块指针。
9. 发布后从干净环境执行 `git submodule update --init --recursive`，打开 `Home`、`_Sidebar` 和新增页面，确认导航、渲染和链接可用。

## 5. 子模块日常更新

更新 Wiki 必须先更新子模块自身，再更新主仓库指针：

```powershell
git -C docs/wiki fetch origin
git -C docs/wiki pull --ff-only
git -C docs/wiki status --short
```

完成页面 Review 后，在子模块仓库中提交并推送；随后回到主仓库执行：

```powershell
git diff --submodule=log -- docs/wiki
git add .gitmodules docs/wiki
git diff --cached --submodule=log
```

- 主仓库只提交 `.gitmodules` 和子模块提交指针，不把 Wiki 文件复制到主仓库提交中。
- 不得在未 Review 的情况下使用 `git submodule update --remote` 更新指针。
- 子模块未初始化、指针未推送或远程提交不可访问时，不得把主仓库指针发布给其他协作者。
- 子模块的提交信息遵循 Wiki 仓库已有规范；没有独立规范时，使用项目的 Conventional Commits 和单行一句话描述。

## 6. 克隆与协作者同步

首次克隆主仓库后必须初始化子模块：

```powershell
git clone <主仓库地址>
Set-Location <主仓库目录>
git submodule update --init --recursive
```

切换主仓库分支或拉取包含 Wiki 更新的提交后，应再次运行 `git submodule update --init --recursive`，确认 `docs/wiki/` 指向主仓库记录的精确提交。
