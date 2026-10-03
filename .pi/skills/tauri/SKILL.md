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

## 3. 命令与 IPC

Rust 侧定义命令并在 Builder 注册（来源 /develop/calling-rust）：

```rust
struct Database;

#[derive(serde::Serialize)]
struct CustomResponse {
  message: String,
  other_val: usize,
}

#[tauri::command]
async fn my_custom_command(
  window: tauri::WebviewWindow,
  number: usize,
  database: tauri::State<'_, Database>,
) -> Result<CustomResponse, String> {
  println!("Called from {}", window.label());
  // ... 异步逻辑
  Ok(CustomResponse { message: "response".into(), other_val: 42 + number })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Database {})
    .invoke_handler(tauri::generate_handler![my_custom_command])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

前端调用（`@tauri-apps/api/core`）：

```javascript
import { invoke } from '@tauri-apps/api/core';

invoke('my_custom_command', { number: 42 })
  .then((res) => console.log(`Message: ${res.message}, Other Val: ${res.other_val}`))
  .catch((e) => console.error(e));
```

状态管理（来源 /develop/state-management）：用 `.manage()` 注入状态，命令中以 `State<'_, T>` 取用；异步命令内访问共享状态使用异步 `Mutex` 并返回 `Result`：

```rust
#[tauri::command]
async fn increase_counter(state: State<'_, Mutex<AppState>>) -> Result<u32, ()> {
  let mut state = state.lock().await;
  state.counter += 1;
  Ok(state.counter)
}
```

命令可注入的特殊参数：`window: tauri::WebviewWindow`、`app: tauri::AppHandle`、`state: tauri::State<'_, T>`。

## 4. 事件系统

Rust 向前端发送事件（来源 /develop/calling-frontend，需 `use tauri::Emitter`）：

```rust
use tauri::{AppHandle, Emitter};

#[tauri::command]
fn download(app: AppHandle, url: String) {
  app.emit("download-started", &url).unwrap();
  for progress in [1, 15, 50, 80, 100] {
    app.emit("download-progress", progress).unwrap();
  }
  app.emit("download-finished", &url).unwrap();
}
```

Rust 侧监听（需 `use tauri::Listener`）：全局 `app.listen("download-started", |event| ...)`；针对特定窗口 `webview.listen("logged-in", |event| ...)`。前端使用 `@tauri-apps/api/event` 的 `listen`/`emit`；设置 `withGlobalTauri: true` 时也可通过 `window.__TAURI__` 访问 API。

## 5. 窗口、菜单与托盘

Rust 在 setup 中程序化创建多窗口（来源 /learn/security/capabilities-for-windows-and-platforms）：

```rust
tauri::Builder::default()
  .setup(|app| {
    let webview_url = tauri::WebviewUrl::App("index.html".into());
    tauri::WebviewWindowBuilder::new(app, "first", webview_url.clone())
      .title("First").build()?;
    tauri::WebviewWindowBuilder::new(app, "second", webview_url)
      .title("Second").build()?;
    Ok(())
  })
  .run(context)
```

前端创建窗口（来源 /learn/mobile-multiwindow）：

```javascript
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const webview = new WebviewWindow(`detail-${id}`, { url: `detail/${id}` });
webview.once('tauri://created', () => console.log('window created'));
webview.once('tauri://error', (e) => console.error(e));
```

菜单：Rust 用 `tauri::menu::MenuBuilder`（`.text()`、`.check()`、`.separator()` 后 `app.set_menu(menu)`）；JS 用 `@tauri-apps/api/menu` 的 `Menu.new({ items: [...] })` 与 `menu.setAsAppMenu()`，可 `menu.get(id)` 后 `setText` 更新（来源 /learn/window-menu）。

托盘（来源 /learn/system-tray）：

```rust
use tauri::{Manager, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}};

TrayIconBuilder::new()
  .on_tray_icon_event(|tray, event| match event {
    TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
      let app = tray.app_handle();
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }
    _ => {}
  })
```

## 6. 官方插件体系

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

## 7. 权限与安全（capabilities）

v2 用 `src-tauri/capabilities/` 下的 capability 文件声明窗口可用的权限集合，`permissions` 数组引用 ACL 权限标识。核心权限有 `core:` 前缀体系：`core:default` 是全部核心默认权限的简写，等价于 `core:path:default`、`core:event:default`、`core:window:default`、`core:app:default`、`core:image:default`、`core:resources:default`、`core:menu:default`、`core:tray:default` 等的组合（来源 /reference/acl/capability）。

capability 的 `windows` 数组指定生效窗口；`local` 默认 `true` 表示本地 URL 生效；`remote` 可配置允许使用该权限的远程 URL（如 `"urls": ["https://*.mydomain.dev"]`），仅在完全可信域名时开启。CSP 在 `app.security.csp` 配置。

插件权限形如 `<plugin>:default` 或 `<plugin>:allow-<command>`，例如 shell 插件默认集包含 `allow-open`，预配置允许 `http(s)://`、`tel:`、`mailto:` 链接。

## 8. 自动更新（updater 插件）

配置（来源 /plugin/updater）：

```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLICKEY.PEM",
      "endpoints": [
        "https://releases.myapp.com/{{target}}/{{arch}}/{{current_version}}",
        "https://github.com/user/repo/releases/latest/download/latest.json"
      ]
    }
  }
}
```

前端检查并安装（重启依赖 process 插件）：

```javascript
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const update = await check();
if (update?.available) {
  await update.downloadAndInstall();
  await relaunch();
}
```

`check()` 支持自定义 `target`（如 `macos-universal`）、`proxy`、`timeout`、`headers`；Rust 侧用 `UpdaterExt` 的 `updater_builder()` 等价配置。安装行为按平台不同：Windows 安装器启动后应用退出；macOS/Linux 需 relaunch 运行新版本。

## 9. 构建与 CLI 速查（来源 /reference/cli）

| 命令 | 用途 |
| --- | --- |
| `pnpm tauri dev` | 开发模式（细节见 hot-reload Skill） |
| `pnpm tauri build` | Release 构建并生成安装包；`--debug` 调试构建；`--target <triple>` 交叉目标；`--bundles deb,rpm,appimage` 指定包类型；`--no-bundle` 只编译不打包；`-c` 合并配置；`--no-sign` 跳过签名 |
| `pnpm tauri bundle` | 对已构建应用生成安装包 |
| `pnpm tauri add <plugin>` | 添加插件 |

`tauri build` 使用 `build.frontendDist` 与配置的构建命令，runner 默认 `cargo`。签名与公证相关选项（`--skip-stapling` 等）用于 macOS 发布流程。

### 安装包收集与命名

`tauri build` 的产物默认散落在 `src-tauri/target/release/bundle/<类型>/` 下，不直接从该目录分发。构建完成后统一收集到与前端产物同级的专门目录（如 `app/dist/installers/`），并按下表重命名：

```text
{product}_{version}_{os}_{arch}.{ext}
```

| 平台 | 示例 |
| --- | --- |
| Windows NSIS | `linapp_0.1.0_windows_x64.exe` |
| Windows MSI | `linapp_0.1.0_windows_x64.msi` |
| Linux deb | `linapp_0.1.0_linux_amd64.deb` |
| macOS dmg | `linapp_0.1.0_macos_aarch64.dmg` |

规则：全小写、下划线分隔；`product` 取 `productName`（kebab 或小写无空格）；`os` 用 `windows`/`linux`/`macos`；arch 用 `x64`/`arm64`（Linux 包惯例 `amd64`）；updater 的 `latest.json` 与 `.sig` 签名文件随同平台安装包一并收集。同版本同平台多类型（exe 与 msi）共存时保留两者，命名仅扩展名不同。

收集脚本加入构建收尾（PowerShell 示例，参数按项目实际 product 与版本调整）：

```powershell
$bundle = "app/src-tauri/target/release/bundle"
$dest = "app/dist/installers"
New-Item -ItemType Directory -Force $dest | Out-Null
$product = "linapp"; $version = "0.1.0"
$map = @{ msi = "windows_x64"; nsis = "windows_x64"; deb = "linux_amd64"; appimage = "linux_amd64"; app = "macos_aarch64"; dmg = "macos_aarch64" }
Get-ChildItem $bundle -Recurse -File | Where-Object {
  $_.Extension -in ".msi", ".exe", ".deb", ".AppImage", ".dmg", ".app", ".sig", ".json"
} | ForEach-Object {
  $kind = $_.Directory.Name
  $tag = $map[$kind]
  if ($tag) { Copy-Item $_.FullName "$dest/${product}_${version}_$tag$($_.Extension)" -Force }
}
```

`app/dist/installers/` 属构建产物，纳入项目 `.gitignore`，不入库；GitHub Release 与 updater 上传直接取该目录。

## 10. 与项目其他 Skill 的分工

- `rust-dev`：Rust 语言与项目架构约束（Tauri 仅承担桌面边界，领域逻辑不依赖 Tauri）。
- `hot-reload`：`pnpm tauri dev` 统一入口、Vite HMR 与 Rust 自动重建。
- `frontend-dev`：前端技术栈选型、状态管理与测试。
