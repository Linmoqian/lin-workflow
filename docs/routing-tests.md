# Skill 路由抽测集

人工验收 skill 路由准确性的标准用例：向 agent 描述左侧任务，观察其加载的 skill 是否与期望一致。用于 skill 体系变更后（新增、合并、description 修改）的路由回归。

| # | 任务描述 | 期望加载 | 易混淆的干扰项 |
| --- | --- | --- | --- |
| 1 | 修改 CMakeLists.txt 加编译选项 | cmake | cpp-dev |
| 2 | 写一个 Python 脚本批量处理 CSV | python-dev | cli-conventions |
| 3 | Tauri 应用热更新失效，前端改动不生效 | hot-reload | tauri、frontend-dev |
| 4 | 给 Tauri 应用加自动更新功能 | tauri | rust-dev |
| 5 | 提交本次改动并写提交信息 | git-workflow | project-engineering |
| 6 | 审查这个 PR 的改动质量 | code-review | verification |
| 7 | 记录今天做的一个技术决策 | dev-log | writing、logging-terminal |
| 8 | 给 CLI 工具加彩色状态输出 | logging-terminal | dev-log、cli-conventions |
| 9 | 为新增接口编写接口文档 | api-documentation | writing |
| 10 | 新增一个 npm 依赖前评估 | dependency-management | project-engineering |
| 11 | 写一份技术调研报告并导出 PDF | writing | research-workflow |
| 12 | 搭建机器人仿真环境做回放测试 | simulation-hil | robotics、system-safety |

使用方式：逐条把「任务描述」作为自然请求发给 agent，检查其是否读取了期望 skill 的 SKILL.md（或 references）；命中干扰项即路由失败，回到对应 description 修正触发词与边界词后复测。
