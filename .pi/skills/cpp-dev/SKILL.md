---
name: cpp-dev
description: >-
  C++ 工程规范：语言版本与工具链、目录模块与依赖方向、命名格式、类型初始化与所有权、类与接口设计、错误处理、API/ABI 与跨语言边界、并发日志安全、构建依赖、静态检查 Sanitizer 与测试。修改 .cpp/.hpp 等C++代码或搭建 C++ 模块时加载。
---

# C++ 工程规范

## 1. 适用范围与规范读取

本规范适用于项目中的 C++ 源码、静态库、动态库、命令行工具、桌面模块和跨语言边界。

涉及 C++ 文件时，必须先读取本规范以及直接相关的 CMake、并发、日志、验证、安全和代码 Review 规范。嵌入式 C++ 任务必须同时读取 [嵌入式开发](../embedded-dev/SKILL.md)；冲突时以更具体的嵌入式约束为准。

## 2. 基本原则

- 优先使用值语义、RAII、类型安全和编译期检查。
- 默认选择最简单、可验证的同步实现；只有测量证明需要时才引入并发、模板元编程或复杂抽象。
- 禁止依赖未定义行为、实现细节、编译器偶然行为或未记录的平台扩展。
- 每个内存、文件、锁、线程、句柄、回调和异步任务都必须有明确所有者和生命周期。
- 代码行为、错误处理和边界条件必须能够被测试或静态检查验证。

## 3. 语言版本与工具链

- 由项目构建配置明确声明 C++ 标准；新项目优先 C++20，使用 C++23 前确认工具链、目标平台和依赖支持。
- CMake 使用 `target_compile_features` 或目标级 `CXX_STANDARD`，不混用不同标准或私有扩展。
- 源文件使用 UTF-8；项目自有目标启用 `-Wall -Wextra -Wpedantic` 或 MSVC `/W4`。
- CI 对项目自有目标启用 `-Werror` 或 `/WX`；第三方目标不得继承警告和 warnings-as-errors。
- `NOLINT`、`#pragma warning(disable: ...)` 和编译器禁用参数必须限定到最小范围并说明原因。

## 4. 目录、模块与依赖方向

推荐按职责组织：

```text
app/cpp/
├── include/<project>/
│   ├── domain/
│   ├── services/
│   └── public/
├── src/
│   ├── domain/
│   ├── services/
│   └── platform/
└── tests/
```

- 领域层不得直接依赖 UI、操作系统、网络库或具体日志实现。
- 平台能力通过接口或适配器隔离；应用入口只负责启动和模块组装。
- 公共头文件只暴露稳定且必要的 API；内部实现不得通过公共头文件泄露。
- 使用 include-what-you-use，不能依赖传递包含；不在公共头文件中使用 `using namespace`。
- 依赖方向保持单向：公共接口与领域模型 → 服务与平台适配 → 应用入口和外部系统。

## 5. 命名与格式

- 命名空间使用 `snake_case`。
- 类型、类、结构体、枚举和概念使用 `PascalCase`。
- 函数、方法、局部变量和参数使用 `camelCase`。
- 文件名使用小写 `snake_case`；宏仅用于必要的平台适配，使用项目名前缀和 `SCREAMING_SNAKE_CASE`。
- 格式由项目 `.clang-format` 统一管理，提交前运行项目已有格式检查或 `clang-format --dry-run --Werror`。


## 6. 设计与质量细则按需细读

- 类型所有权、类与接口、错误处理、API/ABI 与跨语言边界：[design-and-interop.md](references/design-and-interop.md)。
- 并发日志安全、构建依赖、Sanitizer 与 Review 检查项：[quality-and-build.md](references/quality-and-build.md)。
