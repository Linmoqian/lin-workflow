# test-pilot

pi 全局扩展：把测试从"同步等待"变成"后台任务队列"。Agent 修改代码后在后台煮测试，
自己继续检查其他代码；测试完成自动注入结果，失败时附带输出尾部与完整日志路径，
驱动 Agent 定位修复。

## 工作流

```
修改代码
    |
    +-- 后台启动验证队列 (/test 或 test_pilot 工具)
    |     [编译门禁在前: typecheck / mypy / go build / cargo check]
    |     [测试在后: npm test / pytest / go test / cargo test]
    |
    +-- Pi 继续检查其他代码
    |
    +-- 验证完成 -> 自动注入结果
                    |
              失败则定位错误（门禁失败时后续任务已短路跳过）
```

## 命令

| 命令 | 作用 |
|------|------|
| `/test` | 入队全部配置的任务，后台顺序执行 |
| `/test <task...>` | 只跑指定任务，如 `/test lint unit` |
| `/test cancel` | 取消队列中待跑任务并终止当前进程 |
| `/tests` | 查看队列进度与最近一次批次结果 |

## LLM 工具

| `test_pilot`（action: `start` / `status` / `cancel`，可选 `tasks` 子集）。
系统提示会引导模型：修改代码后用 test_pilot 后台启动验证队列，
不要用 bash 同步等测试跑完；结果会自动注入。

## 注入策略

- **有失败（failed / timeout / cancelled）**：总是注入完整报告（followUp，不打断当前工作），
  包含每个失败任务的输出尾部与完整日志路径，并触发 Agent 定位修复。
- **全部通过**：Agent 忙碌时注入一行简报保持上下文连续；空闲时仅通知，不消耗 token。
  可在配置中设 `"injectOnSuccess": true` 强制注入。

## UI

- footer 单行摘要：`Tests ████░░░░ 61% ✓2 ⟳unit ○1`
- 编辑器上方 Tests 面板：进度条 + 每任务状态（○ pending / ⟳ running / ✓ passed / ✗ failed / ⊘ 终止 / ▸ 跳过）
- 进度百分比优先解析测试框架输出（pytest `[ 74%]`、jest/vitest 百分比等），
  解析不到时按完成任务数计算。

## 编译门禁（gate）

任务可标记 `"gate": true`（编译/类型检查）：失败或超时时，队列剩余任务直接短路为
「已跳过」（状态 ▸ skipped），注入报告会引导先修复编译错误再重跑。
自动检测结果：

| 项目 | 门禁 | 测试 |
|------|------|------|
| Node（typecheck 脚本或 tsconfig+typescript） | `npm run typecheck` / `npx tsc --noEmit` | `npm test` |
| Python（显式 mypy 配置 + pytest 标志） | `python -m mypy .` | `python -m pytest` |
| Go | `go build ./...` | `go test ./...` |
| Rust | `cargo check` | `cargo test` |
| C++（CMakeLists.txt） | `cmake -B build && cmake --build build`（已配置则增量） | `ctest --test-dir build` |
| C++（meson.build） | `meson setup build && ninja -C build`（已配置则增量） | `meson test -C build` |
| Makefile（typecheck/build/check 目标） | `make <target>` | `make test` |

## 项目配置（可选）

项目根目录 `.test-pilot.json`：

```json
{
  "tasks": [
    { "name": "typecheck", "command": "npx tsc --noEmit", "gate": true },
    { "name": "lint", "command": "npm run lint" },
    { "name": "unit", "command": "npm test" },
    { "name": "e2e", "command": "npm run e2e", "timeoutMinutes": 20 }
  ],
  "injectOnSuccess": false,
  "defaultTimeoutMinutes": 30
}
```

未配置时自动检测（编译门禁 + 测试，见上表）。

## 文件结构

| 文件 | 职责 |
|------|------|
| `index.ts` | 入口：装配命令、工具、事件、消息渲染 |
| `types.ts` | 数据结构定义（任务配置 / 运行状态 / 完成结果） |
| `config.ts` | `.test-pilot.json` 加载 + 测试框架自动检测 |
| `queue.ts` | 任务队列：顺序执行、取消、批次完成回调 |
| `runner.ts` | 进程管理：spawn、输出采集、进度解析、超时、跨平台杀进程树 |
| `statusbar.ts` | footer 摘要 + Tests 面板渲染 |
| `report.ts` | 批次结果格式化与注入（敲肩膀） |

## 已知边界

- 串行队列（避免 lint/unit/e2e 并发争抢资源）；需要并行时可拆成多次 `/test` 批次。
- print / json 单次模式（`pi -p`）下进程随会话退出而终止，后台完成注入只在
  长驻会话（TUI / RPC）中生效。
- Windows 下终止进程树使用 `taskkill /T /F`；类 Unix 使用进程组 SIGTERM。
