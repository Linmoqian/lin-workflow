
- 从官网采用模板构建：

```powershell
npm create tauri-app@latest
```

- 使用生成器选择 React + TypeScript + Vite 模板，采用 TypeScript + Rust 技术路线
- React 前端按需安装成熟依赖，不重复造车轮；动画库使用 Motion，路由库使用 React Router，图标库使用 Lucide React，UI 组件库使用 Ant Design：

    - motion
    - React Router
    - Lucide React
    - Ant Design

- 样式使用 Ant Design Design Token + CSS Modules，不引入 Ant Design Icons 和 Tailwind CSS
- 自定义标题栏等桌面专属组件自行封装
- 状态管理和测试方案需与工程师确认后选型

- 禁用浏览器默认右键菜单，采用自定义菜单栏
- 隐藏视觉滚动条，但保留鼠标滚轮、触控板和键盘滚动能力
- 采用无边框自定义标题栏，至少提供拖拽、双击最大化或还原、最小化、最大化或还原、关闭功能
- 窗口控制按钮必须支持键盘访问，且不得置于拖拽区
