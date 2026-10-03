# Tauri 权限（capabilities）与自动更新（tauri references）

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
