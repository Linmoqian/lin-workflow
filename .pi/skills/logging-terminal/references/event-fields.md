# 结构化事件字段、注入防护与存储（logging-terminal references）

## 9. 结构化事件字段

结构化日志建议使用 JSON Lines；每条事件至少包含：

```json
{
  "timestamp": "2026-08-24T10:20:30.123Z",
  "level": "info",
  "event": "document.export.completed",
  "message": "文档导出完成",
  "component": "export-service",
  "trace_id": "trace_01...",
  "operation_id": "op_01...",
  "parent_operation_id": "op_00...",
  "event_id": "evt_01...",
  "sequence": 12,
  "status": "succeeded",
  "duration_ms": 842,
  "error_code": null,
  "attributes": {"format": "pdf", "page_count": 8}
}
```

字段约束：

- `timestamp` 使用 UTC RFC 3339；耗时使用单调时钟测量，避免系统时间回拨影响结果。
- `level` 使用 `trace`、`debug`、`info`、`warn`、`error`、`critical`。
- `event` 使用稳定、可检索的 `domain.action.result` 格式；不得只依赖自然语言 `message` 检索。
- `message` 是给人看的简短说明；`attributes` 保存结构化上下文，不塞入无界大段文本。
- `component` 或 `module` 标识产生事件的模块、服务、页面或进程。
- `event_id` 用于单条事件的唯一引用和去重；`sequence` 用于同一操作内的相对顺序。
- `status` 使用 `started`、`queued`、`running`、`retrying`、`succeeded`、`failed`、`cancelled`、`timed_out` 或 `resource_limited`。
- 字段名统一使用 `snake_case`，不混用 `requestId`、`request_id` 和 `req_id`。

## 13. 敏感信息与日志注入

日志入口必须统一执行脱敏，不能依赖每个调用者自觉处理。除已有敏感信息约束外，还必须：

- 对 `Secret`、`Token`、`Authorization`、`Cookie`、密码和私钥等字段默认拒绝输出或使用固定掩码 `***`。
- 用户输入只记录长度、类型、安全摘要或稳定匿名 ID；不记录全文。
- 多行输入、换行符和控制字符必须转义，防止伪造日志行。
- 不记录完整请求体、响应体、环境变量、数据库连接串、截图、剪贴板内容或未经授权的文件内容。
- 日志、终端、CI 输出、异常堆栈和 Review 报告使用同一套脱敏规则。

## 14. 存储与生命周期

- 结构化日志默认按 JSON Lines 逐行写入；日志不得写入仓库目录，也不得提交 Git。
- Windows 使用应用数据目录，不固定写入项目根目录或用户桌面。
- 日志写入应异步、有界，不能阻塞 UI、IPC 或核心业务线程。
- 队列满时优先丢弃 `trace` 和 `debug`；不得静默丢弃 `error` 和 `critical`，丢弃行为必须可统计。
- 文件按日期或大小轮转；轮转失败必须产生告警。
- 生产环境的保留周期、单文件上限、总空间上限、访问权限和导出范围必须有明确配置与安全默认值。
- 发布环境不默认远程上传；远程采集必须经过授权、脱敏和安全传输设计。
- 用户主动导出日志时，先脱敏并明确导出范围。
