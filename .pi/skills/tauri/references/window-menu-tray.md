# Tauri 窗口、菜单与托盘（tauri references）

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
