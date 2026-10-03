---
name: logging-terminal
description: >-
  日志与终端输出规范：终端语义提示与颜色规则、结构化日志分层、敏感信息处理、调试与异常、Debug 事件模型、结构化事件字段、关联 ID 与跨层回溯、日志级别与错误来源链。设计日志系统、添加程序运行日志或实现 CLI 终端输出时加载；开发过程日志记录见 dev-log。
---

# 日志与终端输出规范

## 1. 适用范围与边界

- 本规范同时约束面向人的终端输出和面向诊断、CI、文件或远程采集的结构化日志。
- 终端语义输出与结构化日志分层实现；终端颜色、符号和装饰格式不得作为机器解析的日志协议。
- 参考 [lin-term](https://github.com/Linmoqian/lin-term) 的终端语义设计，但不因该参考 clone、复制源码或自动新增依赖。

## 2. 终端语义

业务代码表达事件，终端层赋予事件视觉语义；业务代码不得直接写 ANSI 颜色名或颜色控制码。

| 动作 | 语义 |
| --- | --- |
| `stage` | 大阶段开始 |
| `step` | 阶段内操作步骤 |
| `progress` | 进行中的进度 |
| `info` | 普通次要信息 |
| `metric` | 中间指标 |
| `result` | 核心结果 |
| `success` | 成功完成 |
| `warn` | 可继续的异常或风险 |
| `error` | 已发生失败，不自动等同于抛出异常 |
| `debug` | 诊断信息，默认关闭 |
| `input` | 等待自由文本输入 |
| `select` | 等待选项选择 |
| `exception` | 在异常处理块输出错误上下文和堆栈 |

`stage`、`step`、`metric` 和 `result` 是事件语义，不等同于传统日志级别；`info`、`warn`、`error` 和 `debug` 承担主要严重性表达。

## 3. 颜色与输出

颜色只在支持颜色的交互式 TTY 中启用，且不能作为唯一语义：

- 绿色：成功。
- 黄色：警告。
- 红色：错误。
- 青色：交互提示。
- 蓝色：阶段、步骤、进度和核心结果等高亮。
- 灰色：普通信息、指标和调试信息。

输出要求：

- 使用语义标签、符号和缩进表达状态与层级；去除颜色后仍可读、可复制、可搜索和可日志化。
- 禁止在业务代码中直接控制颜色，禁止使用 `*`、`-`、`=` 堆叠装饰性分隔线。
- CI、管道、重定向和非 TTY 环境输出稳定纯文本。
- `progress` 在 TTY 下可以原地刷新；非 TTY、CI、管道和重定向只输出最终状态，不闪烁。
- `input`、`select` 在非交互环境不得阻塞；使用显式默认值，缺少默认值时返回可处理的失败结果。
- 进度、指标和循环内诊断必须限频、采样或汇总，避免日志本身成为性能瓶颈。

## 4. 结构化日志

结构化日志与终端展示分开维护。适用时至少保留以下字段：

`timestamp`、`level`、`event`、`message`、`component` 或 `module`、`operation_id` 或 `request_id`、`duration_ms`、`status` 或 `result`、`error_code`。

长任务应关联任务标识、阶段、耗时、结果和取消原因。异常应保留可定位的错误上下文；生产环境不得直接暴露内部堆栈。

## 5. 敏感信息

禁止写入终端、结构化日志、CI 日志或异常上下文：

- 密钥、Token、密码、私钥、Cookie 和 `Authorization` 头。
- 用户隐私和未脱敏业务数据。
- 未脱敏的文件路径、内部地址和数据库连接信息。
- 完整请求体、完整响应体或可能包含凭据的环境变量。

必须记录请求或任务信息时，使用脱敏值、摘要、稳定 ID 或错误编号。

## 6. 调试与异常

- `debug` 默认关闭，仅通过明确配置或命令行参数开启。
- 发布构建不得保留临时 `print`、`console.log` 或无控制的调试输出。
- `exception` 记录异常类型、错误消息、操作上下文和堆栈；局部变量只允许在本地显式调试模式输出，并继续执行敏感信息过滤。
- `error` 只表达失败事实；是否抛出异常、重试或终止由业务调用方决定。

## 7. 日志级别
## 11. 日志级别

结构化日志级别与 `lin-term` 终端动作分开：

| 级别 | 用途 |
| --- | --- |
| `trace` | 极细粒度执行细节，仅用于短期本地诊断 |
| `debug` | 调试上下文、中间状态，默认关闭 |
| `info` | 正常生命周期、重要状态和关键结果 |
| `warn` | 可继续的异常、降级、重试和配置问题 |
| `error` | 当前操作失败，但进程仍可继续 |
| `critical` | 进程级故障、数据损坏、不可恢复状态或安全事件 |

默认策略：

- 开发环境默认 `info`，需要时显式开启 `debug`。
- 测试和 CI 默认输出 `info` 以上；失败时允许临时提升相关上下文。
- 发布环境默认保留 `info`、`warn`、`error` 和 `critical`，不常驻开启 `trace`、`debug`。
- `error` 不自动等同于抛出异常；是否重试、回滚或终止由业务逻辑决定。

## 8. 深度细则与实现
以下细则按需读取，不在主文件展开：

- 事件模型、关联 ID 与错误来源链：[debug-and-tracing.md](references/debug-and-tracing.md)，设计 Debug 链路或跨层定位问题时读。
- 结构化事件字段、日志注入防护、存储与轮转生命周期：[event-fields.md](references/event-fields.md)，定义事件 schema 或治理日志体积时读。
- Review 检查项、前后端并发约束、验证要求：[review-and-concurrency.md](references/review-and-concurrency.md)，做日志专项审查或验证日志系统时读。
- 终端颜色与 Python logging 起步实现：[implementation.md](references/implementation.md)，写 CLI 输出或配置日志系统时读。

## 9. 相关规范
- [前端开发](../frontend-dev/SKILL.md)：调试信息总线与发布关闭策略。
- [Rust 开发](../rust-dev/SKILL.md)：错误上下文、IPC 错误和敏感信息。
- [并发与线程](../concurrency/SKILL.md)：任务标识、取消、超时和高频日志。
- [HarmonyOS 开发](../harmonyos-dev/SKILL.md)：`devecocli log` 与设备日志。
- [GitHub 规范](../github-workflow/SKILL.md)：CI、发行日志和 Secret 脱敏。
- [代码 Review](../code-review/SKILL.md)：日志专项审查与风险报告。
- [验证](../verification/SKILL.md)：日志验证和未覆盖范围记录。
