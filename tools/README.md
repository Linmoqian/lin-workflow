# 工具脚本

仓库自检与辅助脚本，经根目录 `package.json` 的 scripts 调用。

| 脚本 | 命令 | 用途 |
| --- | --- | --- |
| `check-skills.ps1` | `pnpm test` | skill frontmatter 校验、skill 间相对链接检查、子代理多平台转换冒烟 |

`pnpm dev` 启动本地静态服务器（市场预览访问 `/marketplace/`）；`pnpm build` 重新生成市场索引；`pnpm skills:install` / `pnpm agents:install` 呼应 marketplace 安装器。
