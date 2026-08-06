
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
- 状态管理使用 Redux Toolkit：

    - 组件或页面局部状态优先使用 React `useState` 或 `useReducer`
    - 仅跨页面、跨组件的工作流状态进入 Redux Toolkit
    - Rust 后端是业务数据的事实来源，前端不维护与其冲突的副本
    - 暂不引入 RTK Query，仅在接入远程 HTTP API 后评估
    - 禁止使用传统手写 Redux、Redux Saga 和 Redux Observable

- 前端模块化遵循 [详细规范](docs/development/frontend.md)：

    - 页面只负责组装；UI、业务逻辑、异步调用与状态管理按职责拆分
    - 仅跨两个以上功能稳定复用的组件进入共用组件；通用层不得反向依赖 feature
    - 全局样式仅包含重置、字体、主题和应用级规则；组件样式使用 CSS Modules
    - 组件文件目标不超过 200 行；超过 250 行须拆分或说明原因；超过 400 行原则上禁止，生成文件、静态数据和类型声明除外
    - 单个组件或函数目标不超过 100 行
    - 后续 ESLint 的 `max-lines` 与 `max-lines-per-function` 设为 warning

- 测试方案需与工程师确认后选型

- 禁用浏览器默认右键菜单，采用自定义菜单栏
- 隐藏视觉滚动条，但保留鼠标滚轮、触控板和键盘滚动能力
- 采用无边框自定义标题栏，至少提供拖拽、双击最大化或还原、最小化、最大化或还原、关闭功能
- 窗口控制按钮必须支持键盘访问，且不得置于拖拽区
