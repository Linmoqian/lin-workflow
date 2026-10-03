# mineru

pi 全局扩展：把**读不动的文档**（扫描件 PDF、复杂版面、图片、Office、HTML）交给 [MinerU](https://mineru.net) 解析成 markdown 落盘，模型只读结果，不再硬啃二进制。

注册两个工具 + 一个命令：

| 能力 | 作用 |
|------|------|
| `mineru_parse` | 提交解析（本地路径或远程 URL，可批量）→ 轮询进度 → 下载结果 → 落盘 markdown + 图片 |
| `mineru_query` | 按 `task_id` / `batch_id` 查状态与结果链接，`download=true` 时下载落盘 |
| `/mineru` | 查看配置状态；`/mineru parse <路径或URL>` 手动解析；`/mineru task <id>` 查任务 |

系统提示会引导模型：需要读 PDF / 扫描件 / docx / 图片时先 `mineru_parse` 转 markdown，再用 `read` 读落盘文件；解析没跑完就 `mineru_query` 续查。

## 安装位置

```
~/.pi/agent/extensions/mineru/
├── index.ts        # 入口：注册工具与 /mineru 命令，编排「提交 → 轮询 → 落盘」
├── config.ts       # .env 解析与配置（模型 / 语言 / 轮询 / 超时 / 接口选择）
├── client.ts       # MinerU v4 标准接口 + v1 轻量接口客户端、轮询、下载、解包
├── zip.ts          # 最小 ZIP 读取器（node:zlib，按需解压 + CRC 校验，零第三方依赖）
├── output.ts       # 结果落盘：markdown 同名避让、图片目录、图片引用改写
├── types.ts        # 参数 Schema（TypeBox）与结果详情类型
├── render.ts       # TUI 渲染（摘要 / 流式进度 / 展开预览）
├── test_mineru.mjs # 端到端探针（jiti 复刻 pi 加载方式 + 真实接口用例）
├── tsconfig.check.json # 仅供 tsc 类型检查（jiti 只认 tsconfig.json，不会误读）
├── .env            # 实际配置（不入库）
├── .env.example    # 配置模板
└── .gitignore
```

改动后 `/reload` 即可热加载，无需重启 pi。

## 配置

配置优先级：**进程环境变量 > 同目录 `.env` > 默认值**。
`.env` 查找顺序：`MINERU_ENV_FILE` 指定路径 → 扩展自身目录 → `~/.pi/agent/extensions/mineru/.env`。
每次调用都重新读盘，改完 `.env` 立即生效。

| 变量 | 默认 | 说明 |
|------|------|------|
| `MINERU_API_KEY` | 空 | `sk-…`；不填只能走 v1 轻量接口 |
| `MINERU_BASE_URL` | `https://mineru.net` | 接口地址，走自建代理时才需要改 |
| `MINERU_API` | `auto` | `auto` / `standard`（v4）/ `agent`（v1） |
| `MINERU_MODEL_VERSION` | `vlm` | `vlm` / `pipeline` / `MinerU-HTML`（HTML 输入自动切换） |
| `MINERU_LANGUAGE` | `ch` | 文档语言，影响 OCR |
| `MINERU_POLL_INTERVAL_MS` | `3000` | 轮询间隔（1000-60000） |
| `MINERU_MAX_WAIT_MS` | `600000` | 最长等待，超时后返回任务 ID 由 `mineru_query` 续查 |
| `MINERU_TIMEOUT_MS` | `60000` | 单次 HTTP 请求超时 |

## 两套接口怎么选

| | v4 标准接口（`standard`） | v1 Agent 轻量接口（`agent`） |
|---|---|---|
| 鉴权 | 需要 `MINERU_API_KEY` | 免 Token，按 IP 限流 |
| 单文件 | ≤200MB / ≤200 页 | ≤10MB / ≤20 页 |
| 批量 | 单次 ≤50 个 | 不支持，仅单文件 |
| 格式 | PDF、图片、doc/docx、ppt/pptx、xls/xlsx、html | PDF、图片、doc/docx、ppt/pptx、xlsx（不含 html） |
| 结果 | zip（`full.md` + `images/` + `content_list.json` + `layout.json`） | 单个 `markdown_url` |

`MINERU_API=auto`（默认）时：配了 Key 走 v4，没配走 v1。工具参数 `api` 可按次覆盖。
工具参数 `model_version` / `language` / `page_ranges` / `enable_formula` / `enable_table` / `is_ocr` 直通接口；HTML 输入会自动切到 `MinerU-HTML`。

## 落盘规则

- **本地文件** → markdown 写在**源文件同目录**，文件名取源文件主名（`demo.pdf` → `demo.md`）。
- **远程 URL** → 写在**当前工作目录**，文件名从 URL 末段推导（`.../example.pdf` → `example.md`）。
- 同名已存在时按 `demo.md` → `demo.mineru.md` → `demo.mineru-2.md` 依次避让，**绝不覆盖**已有文件。
- zip 里的图片解到 `<主名>.assets/`（内容哈希命名，重跑复用），正文里的 `images/xxx.jpg` 会被改写成 `<主名>.assets/xxx.jpg` 并做 URL 转义（空格、括号等），保证 `.md` 单独打开也能显示图。
- 工具结果里给的是「路径 + 统计 + 前 40 行预览」；正文很长时用 `read` 工具分段读，不要指望整篇进上下文。
- `output_dir` 可指定输出目录；`mineru_query` 的 `download=true` 也支持 `output_dir`。

## 行为细节

- **轮询**：提交后按 `MINERU_POLL_INTERVAL_MS` 查进度，`onUpdate` 推「已完成 n/N + 每个文件的页码进度」；`Esc` 取消会同时中止 HTTP 与轮询。
- **续查**：超过 `MINERU_MAX_WAIT_MS` 不会判失败，结果里给出 `task_id` / `batch_id`，用 `mineru_query` 继续查（服务端任务仍在跑）。
- **接口探测**：`mineru_query` 依次试 v4 单任务 → v4 批量 → v1 轻量，靠错误码（`-60012` / `-10002` / 404）判断「不是这类任务」，认证与网络错误直接抛出。
- **上传**：批量接口拿到的 OSS 签名链接用 `PUT` 上传，**不能带 `Content-Type`**（带上会被 403 拒绝，实测确认）。
- **解压**：只解 `full.md` 与 `images/`，`layout.json` 这类大文件直接跳过；deflate 走 `node:zlib`，解压后校验 CRC32，下载截断会明确报错。单条目解压上限 256MB，结果包下载上限 512MB。
- **错误提示**：401/`A0202`/`A0211`（Token 无效 / 过期）、限流 429、超页数 `-30003`、超体积 `-30001`、文件类型不支持 `-30002`、任务过期 `-60012` 都转成中文可执行提示。
- **并发安全**：写 markdown 走 pi 的 `withFileMutationQueue`，与内置 `write` / `edit` 同队列，避免同轮并行写同一文件互相覆盖。

## 命令

| 命令 | 作用 |
|------|------|
| `/mineru` | 查看状态（接口地址、Key 来源、当前接口、模型、轮询与超时、落盘规则） |
| `/mineru parse <路径或URL> [更多…]` | 手动解析（等待完成并落盘，输出限 40 行） |
| `/mineru task <task_id\|batch_id> [--download]` | 查询任务状态，`--download` 顺手落盘 |

## 验证

```bash
cd ~/.pi/agent/extensions/mineru
node test_mineru.mjs --offline   # 只跑本地用例（注册 / 渲染 / 命令 / zip / 落盘），不碰接口
node test_mineru.mjs             # 全量：会真实调用 MinerU（限 page_ranges=1-1，约 4 次解析）

# 类型检查（对齐 pi 0.84.4 的 ToolDefinition / AgentToolResult / Theme 类型）
npx --yes --package typescript@5.9 -- tsc -p tsconfig.check.json
```

探针用 jiti 复刻 pi 的加载方式（`createJiti` + 与 pi 相同的 alias 表），断言注册结果、真实接口链路与错误路径。

## 已验收路径

- **本地用例（26 项）**：注册结果、渲染函数三分支、`/mineru` 状态与未知子命令、zip 读取器（deflate / stored / filter / 截断包报错）、`extractDocument` + `saveParsedDocument`（图片解出、链接转义、同名避让）。
- **真实接口用例（共 52 项）**：
  1. v4 标准接口 · 远程 URL：`extract/task` → 轮询 → 下载 zip → 解压 → 落盘，文件名按 URL 推导
  2. v4 标准接口 · 本地文件：`file-urls/batch` → OSS 签名 PUT 上传 → 批量查询 → 落盘在同目录
  3. `mineru_query` 按 `batch_id` 续查 + `download=true` 二次落盘到指定目录
  4. v1 轻量接口 · 本地文件：`parse/file` → 上传 → `markdown_url` 下载落盘，输出带额度提示
  5. `wait=false` 仅提交：返回 `task_id`，随后可被 `mineru_query` 查到
  6. 错误路径：文件不存在、HTML 走轻量接口被拦截、空 id、查不到的任务
- **真实结果包**：官方 96 页论文（20 张图）→ 20 张图全部解出到 `.assets/`，正文 0 处残留 `](images/`，带空格与括号的中文文件名转义正确（`论文%20%282024%29%20v2.assets/…`），同名重跑避让到 `.mineru.md`。
- **真实 pi 进程冒烟**：`pi -p --model deepseek/deepseek-v4-flash "用 mineru_parse 解析 demo.pdf（只要第 1 页）…"` → 工具被正确调用，6.8s 完成，落盘 `demo.md` 并回传正文首行。
- **类型检查**：`tsc -p tsconfig.check.json`（strict + 对齐 pi 0.84.4 的 `defineTool` / `AgentToolResult` / `Theme` 类型）无错误。
