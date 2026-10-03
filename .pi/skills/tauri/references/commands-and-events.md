# Tauri 命令、IPC 与事件（tauri references）

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
