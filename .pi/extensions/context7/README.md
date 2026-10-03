# context7

pi 全局扩展：让模型在写代码前先查**最新文档**，而不是凭记忆猜 API。

接的是 [Context7](https://context7.com) 的 v2 接口，注册两个工具：

| 工具 | 作用 |
|------|------|
| `context7_search_library` | 按库名 / 问题搜索候选库，返回精确的 `libraryId`、更新时间、文档规模、可用版本 |
| `context7_get_docs` | 按 `libraryId` + 具体问题拉取实时文档片段（代码示例 + 来源链接），直接进上下文 |

系统提示会引导模型：涉及第三方库的最新用法 / 配置 / 版本差异时，先 `context7_search_library` 解析库 ID，
再 `context7_get_docs` 拉文档，依据文档作答。

## 安装位置

```
~/.pi/agent/extensions/context7/
├── index.ts        # 入口：注册工具与 /context7 命令
├── config.ts       # .env 解析与配置
├── client.ts       # Context7 HTTP 客户端 + 会话级文档缓存
├── types.ts        # 参数 Schema 与结果详情类型
├── render.ts       # TUI 渲染辅助
├── .env            # 实际配置（不入库）
├── .env.example    # 配置模板
└── .gitignore
```

改动后 `/reload` 即可热加载，无需重启 pi。

## 配置

配置优先级：**进程环境变量 > 同目录 `.env` > 默认值**。
`.env` 查找顺序：`CONTEXT7_ENV_FILE` 指定路径 → 扩展自身目录 → `~/.pi/agent/extensions/context7/.env`。
每次调用都重新读盘，改完 `.env` 立即生效。

| 变量 | 默认 | 说明 |
|------|------|------|
| `CONTEXT7_API_KEY` | 空 | 形如 `ctx7sk-…`；留空为匿名访问（约 200 次/小时），配置后约 1000 次/小时 |
| `CONTEXT7_BASE_URL` | `https://context7.com` | 接口地址，走自建代理时才需要改 |
| `CONTEXT7_DEFAULT_TOKENS` | `5000` | `context7_get_docs` 默认 token 预算（500-50000），工具入参可逐个覆盖 |
| `CONTEXT7_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） |

## 命令

| 命令 | 作用 |
|------|------|
| `/context7` | 查看配置状态（密钥来源、限额提示、缓存条数） |
| `/context7 search <库名> [查询词]` | 手动搜索候选库 |
| `/context7 docs <libraryId> <查询词>` | 手动拉取文档片段（输出限 40 行） |

## 行为细节

- **缓存**：相同 `(libraryId, query, tokens)` 的文档在会话内只请求一次，省 token 也省配额；`session_start` 时清空，上限 64 条。
- **截断**：文档超过 50KB / 2000 行时保留开头，完整内容写入临时文件并在结果末尾给出路径（`pi-context7-*`）。
- **错误提示**：401（密钥无效）、404（库不存在，提示先 search）、429（限流）、超时都转成中文可执行提示。
- **取消**：请求同时受 `ctx.signal`（Esc 取消）与超时信号控制。

## 已验收路径

在 jiti 复刻 pi 加载方式（`jiti/static` + 同名 alias）的探针里逐项跑通：

1. 注册结果：工具 `context7_search_library` / `context7_get_docs`、命令 `/context7`、事件 `session_start`
2. 真实接口搜索：`next.js + middleware matcher` 返回 5 个候选，首个 `/vercel/next.js`
3. 真实接口文档：`/vercel/next.js` + `middleware matcher` 返回 6001 字符；二次调用 `fromCache = true`
4. 错误路径：`/nope/nope` → 404 中文提示并引导先 search
5. 截断路径：本地 mock 返回 156KB 正文 → `truncated = true`，完整内容落盘 `%TEMP%/pi-context7-*/docs.txt`
6. 缺 Key：临时移走 `.env` 后 `session_start` 弹出配额告警，随后 `.env` 已还原
7. `/context7`、`/context7 docs`（缺参）、未知子命令三种命令输出
8. 真实 pi 进程冒烟（新进程加载扩展，`pi -p --model deepseek/deepseek-v4-flash`）：
   - 「搜索 tauri」→ 正常调用 `context7_search_library` 并回传 5 个 libraryId
   - 「搜索 + 拉取 window drag region 文档」→ 两个工具链式调用成功并给出结论
