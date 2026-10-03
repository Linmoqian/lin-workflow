# pi 插件市场

lin-workflow 的 pi Skill 浏览与安装入口。本目录是零依赖静态交付物，可直接托管到 GitHub Pages 或任意静态服务器。

## 内容

| 文件 | 用途 |
| --- | --- |
| `generate.ps1` | 扫描 `.pi/skills/*/SKILL.md` 的 frontmatter，叠加手工分类映射，生成 `skills.json` |
| `skills.json` | 市场索引（生成产物，随 skill 变化重新生成后提交） |
| `index.html` | 市场页面：搜索、分类浏览、整包安装命令与单 Skill 启用配置复制 |

## 使用

1. Skill 增删或描述变更后重新生成索引：`pwsh marketplace/generate.ps1`，随改动一并提交 `skills.json`。
2. 本地预览：`python -m http.server` 后访问 `http://localhost:8000/marketplace/`（`file://` 协议无法 fetch 索引）。
3. 安装（用户侧）：`pi install git:github.com/Linmoqian/lin-workflow`；单 Skill 启用配置见页面卡片按钮。

## 分类映射

`generate.ps1` 内的 `$categoryMap` 手工维护 skill 到分类的归属；新增 skill 未列入映射时归入「其他」。
