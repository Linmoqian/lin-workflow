# 项目数字孪生地图维护规范

## 1. 目的

本文件规定如何维护项目 Overview 的结构化地图，以及如何保证页面中的状态、风险和“完成”结论可追溯、可验证、不会静默过期。

地图不是数据库，也不是 Agent 的记忆。真实代码、Git、测试、构建、文档和人工决策是事实来源；.overview/*.json 是一次观测后的结构化投影；overview/ 只负责渲染。

核心原则：

> 地图可以过期，但不能在过期时假装自己是最新状态。

本规范同时是后续“更新项目地图”Skill 的执行依据。

## 2. 文件职责与维护边界

| 文件 | 内容 | 默认维护者 |
| --- | --- | --- |
| .overview/project.json | 项目目标、版本、阶段、指标、Roadmap、当前作业面、完成结论 | 人工目标 + Agent 推导 |
| .overview/modules.json | 模块清单、健康等级、测试覆盖、变更信号、风险理由 | Agent 推导 |
| .overview/architecture.json | 架构层、关系和边界 | Agent 发现 + 人工确认 |
| .overview/tasks.json | 任务状态、里程碑、优先级、验收证据 | 人工任务 + Agent 观测 |
| .overview/risks.json | 风险、严重度、触发信号和下一步行动 | Agent 发现 + 人工处置 |
| .overview/decisions.json | 已确认的架构决策和影响 | 人工维护 |
| .overview/changelog.json | 从重要提交压缩出的项目变化 | Agent 提取 |
| .overview/snapshot.json | 观测时间、提交、工作区、来源覆盖和未知项 | Agent 生成 |

overview/index.html、overview/app.js 和 overview/style.css 是只读渲染器，不得成为项目状态、任务状态、风险结论或人工决策的事实来源。

如果 Agent 推导结果与人工确认的目标、优先级或架构决策冲突，以人工确认内容为准；冲突应记录为风险或待确认事项，不得静默覆盖。

## 3. 标准维护流程

### 3.1 读取前置上下文

开始前必须读取：

~~~text
AGENTS.md
CLAUDE.md
TODO.md
docs/development/project-overview-maintenance.md
现有 .overview/*.json
~~~

检查工作区：

~~~powershell
git status --short
git branch --show-current
git rev-parse HEAD
git log -10 --oneline
~~~

已有未提交改动属于工程师的工作。不得覆盖、回滚、格式化或删除与本次地图更新无关的改动。如果无法区分改动来源，暂停并报告。

### 3.2 采集事实和证据

Agent 必须优先读取真实来源：

- 当前代码和目录结构。
- 当前分支、HEAD、最近提交和工作区状态。
- 测试、构建、静态检查和覆盖率结果。
- TODO、FIXME、未实现分支和异常处理。
- 依赖、接口、模块边界和架构文档。
- 已有验收记录、现场测试记录和人工决策。

重要结论应记录适用的来源、观测提交、观测时间、命令或文件范围、结果和可信度。

没有观测到的数据必须标记为 unknown、missing、not_run 或 unverified。禁止把未知自动转换成 0、通过、稳定或验收完成。

### 3.3 创建快照身份

一次完整更新使用一个 snapshotId。所有 .overview/*.json 必须使用相同的 snapshotId、generatedAt 和 observedCommit。

快照至少记录：

~~~json
{
  "snapshotId": "snap-<timestamp>-<commit>",
  "generatedAt": "2026-08-24T10:30:00+08:00",
  "observedCommit": "7d2b9c1",
  "branch": "main",
  "workingTree": "clean",
  "freshness": {
    "status": "fresh",
    "reason": "关键数据源已完成观测"
  },
  "sourceCoverage": {
    "git": true,
    "tests": true,
    "build": true,
    "architecture": true,
    "fieldAcceptance": false
  },
  "unknowns": []
}
~~~

新鲜度状态使用：

~~~text
fresh
aging
stale
partial
unknown
inconsistent
~~~

以下任一情况都不能标记为 fresh：

- 工作区存在未纳入快照的改动。
- 当前 HEAD 与 observedCommit 不一致。
- 关键测试、构建或验收来源未运行或未找到。
- 不同 JSON 的 snapshotId 不一致。
- 快照时间无法确认或位于未来。

静态 HTML 不能自行读取当前 Git 状态。因此页面只能展示“最后一次观测结果”；代码变化后必须重新测绘。

### 3.4 更新结构化数据

建议按以下顺序更新：

1. 更新项目阶段、当前目标和 Roadmap。
2. 更新任务状态和验收证据。
3. 更新模块健康度和架构关系。
4. 更新风险及其下一步行动。
5. 提取重要变更到 changelog.json。
6. 记录人工确认的架构决策，不改写历史决策。
7. 最后写入 snapshot.json，声明本次观测范围。

一次更新中的所有 JSON 必须属于同一快照。生成失败时，不得留下部分新快照和部分旧快照混合的状态。

## 4. 状态机与完成结论

### 4.1 任务状态

| 状态 | 含义 | 是否可称为完成 |
| --- | --- | --- |
| planned | 已计划，尚未开始 | 否 |
| doing | 正在实现或验证 | 否 |
| implemented | 代码已实现，但验收证据不足 | 否 |
| verified | 技术验证通过，但尚未完成业务验收 | 否 |
| accepted | 必需验收标准都有有效证据 | 是 |
| blocked | 存在明确阻塞，无法继续推进 | 否 |
| paused | 经确认主动暂缓 | 否 |

正常生命周期为：

~~~text
planned → doing → implemented → verified → accepted
~~~

blocked 和 paused 表示推进条件，不等价于实现生命周期。后续 Skill 如果需要表达“已实现但仍被阻塞”，应将生命周期和条件拆成独立字段，不要增加含义重叠的新状态名。

规则：

- commit 存在不能证明任务完成。
- 代码能构建不能证明现场验收完成。
- 测试通过不能自动替代业务验收。
- implemented 不能渲染成“已完成”。
- verified 不能渲染成“验收通过”。
- blocked 和 paused 必须有原因或关联风险。
- 不得删除已完成任务；历史任务应保留并标记状态。

### 4.2 验收证据

验收证据必须能回溯到当前代码快照，至少说明：

~~~text
证据类型：test / build / field / review / manual
结果：passed / failed / unknown / superseded
观测提交
观测时间
测试命令、记录编号或文件范围
覆盖的验收标准
~~~

如果新提交触及旧证据覆盖的代码范围，旧证据必须重新确认，或标记为 superseded / stale。

### 4.3 项目完成结论

项目完成结论必须区分：

~~~text
supported      当前证据支持完成
unsupported    当前证据明确不支持完成
unknown        证据不足，无法判断
~~~

只有同时满足以下条件，才能使用 supported：

- 所有必需里程碑和验收门槛均为 accepted。
- 所有必需验收证据覆盖当前 observedCommit。
- 构建和必要测试通过。
- 没有未处置的关键阻塞。
- 关键来源覆盖完整。
- 工作区状态与完成结论一致。

只要存在证据缺失，优先使用 unknown；存在明确失败或阻塞时使用 unsupported。两者都不能渲染为“完成”。

## 5. 进度、健康度与风险

### 5.1 里程碑进度

必须至少区分：

~~~text
实现进度
验收进度
~~~

如果数据足够，继续区分技术验证进度和业务验收进度。进度应由任务权重、验收门槛和状态计算，不得仅凭 Agent 判断填写精确百分比。doing 不自动等于 50%；未观测的任务不自动计入完成。

### 5.2 模块健康等级

允许的健康等级：

~~~text
stable
active
risk
broken
dormant
experimental
unknown
~~~

每个健康等级必须保存理由和信号。可用信号包括构建或测试失败、最近变更频率、测试覆盖率、长期 TODO/FIXME、文件规模、耦合度、异常依赖、API 变化和长期未维护。

缺少观测数据时使用 unknown，不能默认显示 stable 或 dormant。

### 5.3 风险雷达

风险必须包含风险对象、严重度、当前状态、触发信号、关联模块或任务、下一步行动、最后观测时间和可信度。

accepted 表示人工接受风险，不表示风险消失；stale 表示近期没有重新观测，也不表示风险已经解决。

## 6. 变更摘要与架构决策

changelog.json 只提取对项目有实际影响的变化：新功能、缺陷修复、架构调整、依赖或 API 变化、测试构建变化和高风险技术债处理。

每条摘要必须保留原始 commit 引用。不能从含糊的 commit 标题推断不存在的功能，也不要重复记录纯格式化、机械重命名或无行为变化的提交。

decisions.json 是人工确认的架构决策记录。Agent 可以发现并提出候选决策，但不得删除、改写或把推测写成已确认决策。

## 7. 更新后的强制校验

### 7.1 JSON 和快照校验

~~~powershell
Get-ChildItem .overview -Filter *.json | ForEach-Object {
  $null = Get-Content -Raw $_.FullName | ConvertFrom-Json
  Write-Output "[成功] $($_.Name) JSON 可解析"
}

$snapshotIds = Get-ChildItem .overview -Filter *.json |
  ForEach-Object { (Get-Content -Raw $_.FullName | ConvertFrom-Json).snapshotId } |
  Sort-Object -Unique

if ($snapshotIds.Count -ne 1) {
  throw "[错误] .overview JSON 的 snapshotId 不一致"
}
~~~

### 7.2 结构校验

必须检查：

- 所有文件存在且包含 schemaVersion、kind、snapshotId、generatedAt。
- ID 唯一且稳定。
- 架构关系引用存在的节点。
- 任务、模块、风险和决策引用存在的目标。
- 状态、健康等级和风险等级属于约定枚举。
- 时间字段为带时区的 ISO 8601 时间。
- accepted 任务存在有效验收证据。
- supported 完成结论满足全部必要门槛。
- 未知、缺失和未运行状态没有被转换成通过。

### 7.3 页面加载校验

启动任意本地静态服务器后打开：

~~~text
http://localhost:8080/overview/
~~~

检查：

- 页面能显示当前阶段、目标、任务状态、风险和最近变化。
- 页面能显示实现进度与验收进度。
- implemented 不显示为验收通过。
- 阻塞、暂缓和未知状态有文字原因。
- 工作区或快照不一致时出现重新测绘提示。
- 浏览器控制台没有未捕获异常。
- HTML、CSS 和 JS 没有被当作项目状态源。

### 7.4 Git 交付校验

~~~powershell
git diff --check
git status --short
~~~

确认差异只包含本次地图更新相关文件。有效更新完成后创建本地 Conventional Commit；不推送远程仓库，除非工程师明确同意。

## 8. 禁止事项

- 直接把 HTML 当数据库编辑。
- 只更新页面，不更新 .overview/*.json。
- 用猜测填充测试结果、现场验收或架构关系。
- 没有证据就把任务标记为 accepted。
- 把旧提交上的测试结果直接用于新代码。
- 覆盖工程师已有未提交改动。
- 删除历史任务、风险、变更摘要或架构决策。
- 为了让页面显示绿色而降低风险等级或删除未知项。
- 在一次更新中混用不同快照的 JSON。
- 更新失败后提交半更新地图。
- 修改远程仓库、推送或发布而没有工程师授权。

## 9. 每次更新的交付说明

Agent 完成地图更新后，必须报告：

1. 本次观测的提交、分支和工作区状态。
2. 更新了哪些 JSON 文件以及原因。
3. 项目阶段、任务、风险和完成结论发生了什么变化。
4. 哪些结论有证据，哪些仍然未知或未验收。
5. 实际运行的校验命令及结果。
6. 是否创建了本地提交，以及提交信息。
7. 未解决风险和下一步行动。

报告必须与地图数据一致，不能把计划执行、静态推断或未运行的命令写成已完成验证。
