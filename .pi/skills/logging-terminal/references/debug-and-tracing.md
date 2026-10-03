# 日志系统深度规范（logging-terminal references）

## 8. Debug 事件模型

日志不是普通输出，而是记录“哪个组件在什么时间，针对哪个操作，发生了什么事件以及产生了什么结果”的可检索事件流。

每个可回溯操作至少记录以下生命周期：

```text
started → running / queued → retrying（可选）→ succeeded / failed / cancelled / timed_out
```

要求：

- 长任务至少记录开始、关键阶段、结束结果以及取消或失败原因。
- 只记录状态变化、阶段切换、外部调用、关键指标和异常；不得逐行记录循环过程。
- 结束事件必须包含最终 `status` 和 `duration_ms`。
- 重试必须记录次数、原因、等待时间和最终结果。
- 取消、超时、资源受限和实际失败必须使用不同状态或事件，不得统一写成 `error`。
- 日志丢弃时记录 `log.dropped` 或等价汇总事件，并包含丢弃数量和原因。

## 10. 关联 ID 与跨层回溯

```text
用户操作 trace_id
  ├── 前端 operation_id
  ├── Tauri IPC operation_id
  ├── Rust 服务 operation_id
  └── 文件或网络操作 operation_id
```

- 一次用户操作、请求或任务链路使用一个 `trace_id`。
- 每个独立可观察操作生成新的 `operation_id`；子操作携带 `parent_operation_id`。
- 同一操作的开始、进度、重试、成功、失败、取消和超时事件使用同一 `operation_id`。
- 前端调试信息总线、Tauri IPC、Rust 后端和异步任务应尽可能传递同一 `trace_id`。
- 关联 ID 必须随机、不可预测且不包含用户名、手机号、路径或其他业务隐私。
- 线程 ID、任务 ID 和进程 ID只能作为辅助字段，不能替代 `trace_id` 或 `operation_id`。

## 12. 错误来源链

错误事件必须能回溯到原始原因，至少包含稳定 `error_code`、错误类型、安全消息、所属操作和 `retryable` 属性。

- 保留错误来源链，不能只记录最后一层包装错误。
- 同一异常链只记录一次完整堆栈，调用层使用 `operation_id` 关联，避免重复刷屏。
- 本地 Debug 模式可记录堆栈；生产日志只保留安全摘要或受控错误引用。
- Rust 使用错误 `source` 链保留底层原因；IPC 返回稳定错误结构，不将内部堆栈直接返回前端。
- 未捕获异常、任务崩溃、`panic` 和进程退出使用独立事件。
- 捕获异常后不得只记录“失败”，还应记录操作、阶段、输入摘要、错误码和结果。
