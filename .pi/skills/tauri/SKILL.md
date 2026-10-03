---
name: tauri
description: >-
  Tauri v2 官方开发文档沉淀：tauri.conf.json 配置结构、命令与 IPC invoke、事件系统、窗口菜单托盘、官方插件体系、capabilities 权限与安全、构建分发与自动更新、CLI 命令。开发或调试 Tauri 桌面/移动应用、查 Tauri API 用法时加载；Rust 语言约束见 rust-dev，开发热加载见 hot-reload，前端栈选型见 frontend-dev。
---

# Tauri v2 官方开发文档

本 Skill 沉淀自 Tauri 官方文档（https://tauri.app/，以 v2 为主），供开发与调试时快速查阅；实现前以官方文档与实际构建验证为准。

## 1. 权威入口

- 官方文档与教程：https://tauri.app/
- 配置参考：https://tauri.app/reference/config
- CLI 参考：https://tauri.app/reference/cli
- JavaScript API 参考：https://tauri.app/reference/javascript
- 官方插件仓库：https://github.com/tauri-apps/plugins-workspace
- v2 配置重构要点：`tauri` 对象改名为 `app`；`distDir` 改名 `frontendDist`、`devPath` 改名 `devUrl`；产品与 bundle 标识移至顶层。从 v1 迁移见 https://tauri.app/start/migrate/from-tauri-1
- 需要未覆盖的细节时，用 Context7 实时查询：`ctx7 library tauri "<问题>"` 解析库 ID 后 `ctx7 docs <库 ID> "<问题>"`，可选 `/websites/tauri_app` 或 `/tauri-apps/plugins-workspace`。

## 2. 项目结构与配置

Rust 侧位于 `src-tauri/`（含 `tauri.conf.json`、`Cargo.toml`、`src/lib.rs`、`capabilities/`），前端位于项目根。标准配置结构（来源 /reference/config）：

```json
{
  "productName": "tauri-app",
  "version": "0.1.0",
  "build": {
    "beforeBuildCommand": "",
    "beforeDevCommand": "",
    "devUrl": "http://localhost:3000",
    "frontendDist": "../dist"
  },
  "app": {
    "security": { "csp": null },
    "windows": [
      {
        "fullscreen": false,
        "height": 600,
        "resizable": true,
        "title": "Tauri App",
        "width": 800
      }
    ]
  },
  "bundle": {},
  "plugins": {}
}
```

`build` 字段与前端框架对接：`beforeDevCommand` 启动前端开发服务器（如 `pnpm dev`），`beforeBuildCommand` 构建前端（如 `pnpm build`），`devUrl` 必须与前端开发地址端口一致（Vite 默认 5173），`frontendDist` 指向前端产物目录（如 `../dist`、`../build`、`../out`，随框架而定）。

## 3. 官方插件体系

添加插件优先用 CLI（自动写入 Cargo.toml、package.json、capabilities 与注册代码）：`pnpm tauri add <plugin>`（如 `pnpm tauri add updater`）。手动方式三步：Cargo.toml 加 `tauri-plugin-<name>`、`pnpm add @tauri-apps/plugin-<name>`、Builder 注册 `.plugin(tauri_plugin_<name>::init())`。

官方插件清单（来源 plugins-workspace，桌面三平台均支持除特别标注）：

| 插件 | 用途 |
| --- | --- |
| dialog | 原生文件选择、保存与消息对话框 |
| fs | 文件系统访问（移动端支持有限） |
| http | Rust 实现的 HTTP 客户端 |
| opener | 用默认应用打开文件与 URL |
| log | 可配置日志 |
| updater | 自动更新 |
| process | 退出与重启应用 |
| clipboard-manager | 系统剪贴板读写 |
| global-shortcut | 全局快捷键（桌面） |
| notification | 系统通知 |
| deep-link | 注册为 URL 默认处理器 |
| autostart | 开机自启（桌面） |
| os | 读取操作系统信息 |
| cli | 解析命令行参数（桌面） |
| localhost | 生产环境内嵌 localhost 服务器（桌面） |
| sql | SQL 数据库访问（sql 插件，官方仓库） |
| barcode-scanner / biometric / geolocation / haptics / nfc | 移动端专属（iOS/Android） |

dialog 示例（来源 /plugin/dialog）：

```javascript
import { open } from '@tauri-apps/plugin-dialog';

const file = await open({ multiple: false, directory: false });
```

## 4. 构建与 CLI 速查

| 命令 | 用途 |
| --- | --- |
| `pnpm tauri dev` | 开发模式（细节见 hot-reload Skill） |
| `pnpm tauri build` | Release 构建并生成安装包；`--debug` 调试构建；`--target <triple>` 交叉目标；`--bundles deb,rpm,appimage` 指定包类型；`--no-bundle` 只编译不打包；`-c` 合并配置；`--no-sign` 跳过签名 |
| `pnpm tauri bundle` | 对已构建应用生成安装包 |
| `pnpm tauri add <plugin>` | 添加插件 |

`tauri build` 使用 `build.frontendDist` 与配置的构建命令，runner 默认 `cargo`。签名与公证相关选项（`--skip-stapling` 等）用于 macOS 发布流程。


安装包统一收集到专门目录并按 product_version_os_arch 命名，收集脚本与规则见 [build-artifacts.md](references/build-artifacts.md)，构建安装包时读。

## 5. 能力地图与按需细读

- 命令定义、invoke 调用、State 管理与事件系统：[commands-and-events.md](references/commands-and-events.md)，写 IPC 或前后端通信时读。
- 程序化多窗口、菜单、托盘：[window-menu-tray.md](references/window-menu-tray.md)，做窗口管理时读。
- capabilities 权限配置与 updater：[capabilities-and-updater.md](references/capabilities-and-updater.md)，配权限或做自动更新时读。

## 6. 与项目其他 Skill 的分工

- `rust-dev`：Rust 语言与项目架构约束（Tauri 仅承担桌面边界，领域逻辑不依赖 Tauri）。
- `hot-reload`：`pnpm tauri dev` 统一入口、Vite HMR 与 Rust 自动重建。
- `frontend-dev`：前端技术栈选型、状态管理与测试。
