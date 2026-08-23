# 项目 Overview 示例

这是一个只读渲染器示例。项目状态来自根目录的 `.overview/*.json`，页面代码不保存项目状态。

示例快照故意将工作区标记为 `dirty`，用于演示“地图需要重新测绘”提示；它不是当前仓库实际业务代码的扫描结果。

## 本地查看

在项目根目录启动静态服务器：

```powershell
py -m http.server 8080
```

然后打开：

```text
http://localhost:8080/overview/
```

直接双击 `index.html` 时，浏览器会阻止页面读取相邻的 JSON 文件，这是浏览器的本地文件安全限制。

## 后续 Agent 更新约束

Agent 应重新读取代码、Git、测试、构建和文档后更新 `.overview/*.json`，并记录 `snapshot.json` 的观测提交、工作区状态、来源覆盖度和未知项。页面只负责展示，不应被当作数据库直接编辑。

完整维护流程见 [项目地图维护规范](../docs/development/project-overview-maintenance.md)。
