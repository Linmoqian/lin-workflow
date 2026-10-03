# sciverse

pi 全局扩展：让 Agent 真正读懂科学世界 —— 先查文献、读原文，再基于原文作答，而不是靠记忆编造论文与数据。

接的是 [Sciverse](https://sciverse.space)（OpenDataLab 学术检索服务）的官方接口，注册六个工具：

| 工具 | 作用 | 对应接口 |
|------|------|----------|
| `sciverse_search_papers` | 结构化元数据检索：关键词 / 作者 / 年份 / 期刊 / 学科 / DOI，支持作者、期刊实体检索与深翻页 | `POST /meta-search` |
| `sciverse_semantic_search` | 自然语言语义检索，返回原文片段（chunk + doc_id + offset），RAG 式问答入口 | `POST /agentic-search` |
| `sciverse_read_content` | 按字节区间读原文（Markdown），可一次调用自动续读到 48KB | `GET /content` |
| `sciverse_paper_relations` | 引用 / 被引 / 相关工作列表分页 | `POST /meta-paper-relations` |
| `sciverse_catalog` | 字段目录：字段名、能否过滤 / 排序、中文说明、枚举取值样本 | `GET /meta-catalog` |
| `sciverse_get_resource` | 取原文中的 Figure / Table 图片，直接以多模态方式给模型看 | `GET /resource` |

系统提示会引导模型：涉及科学结论的问题先 `sciverse_semantic_search` 找片段 → `sciverse_read_content` 读上下文 →
基于原文作答并给出标题与 DOI；结构化筛选走 `sciverse_search_papers`；字段不确定先 `sciverse_catalog`。

## 安装位置

```
~/.pi/agent/extensions/sciverse/
├── index.ts        # 入口：注册六个工具与 /sciverse 命令
├── config.ts       # .env / 环境变量 / 官方 CLI 凭据读取
├── client.ts       # 六个接口的 HTTP 客户端 + 客户端限流 + 会话缓存
├── types.ts        # 参数 Schema 与接口数据结构
├── format.ts       # 结果 → 模型可读文本
├── render.ts       # TUI 渲染辅助
├── .env            # 实际配置（不入库）
├── .env.example    # 配置模板
└── .gitignore
```

改动后 `/reload` 即可热加载，无需重启 pi。

## 配置

配置优先级：**进程环境变量 > 同目录 `.env` > `~/.sciverse/credentials.json`（官方 CLI 凭据） > 默认值**。
`.env` 查找顺序：`SCIVERSE_ENV_FILE` 指定路径 → 扩展自身目录 → `~/.pi/agent/extensions/sciverse/.env`。
每次调用都重新读盘，改完 `.env` 立即生效。

| 变量 | 默认 | 说明 |
|------|------|------|
| `SCIVERSE_API_TOKEN` | 空 | 形如 `sci_…`，在 https://sciverse.space 获取；未配置时工具会给出明确报错 |
| `SCIVERSE_BASE_URL` | `https://api.sciverse.space` | 接口地址，走自建代理时才需要改 |
| `SCIVERSE_PAGE_SIZE` | `10` | `sciverse_search_papers` 默认每页条数（1-50） |
| `SCIVERSE_CONTENT_LIMIT` | `8192` | `sciverse_read_content` 单次请求字节数（1-16384，服务端上限） |
| `SCIVERSE_MAX_CONTENT_BYTES` | `8192` | 单次调用累计字节上限（<= 49152）；想一次多读就在工具入参里传 `max_bytes` |
| `SCIVERSE_TIMEOUT_MS` | `60000` | 单次请求超时（毫秒）；`quality` 语义检索会先做 LLM 改写，慢是正常的 |
| `SCIVERSE_RATE_LIMIT_PER_MIN` | `30` | 客户端侧每接口每分钟配额，与服务端 30/min 对齐 |
| `SCIVERSE_MAX_WAIT_MS` | `20000` | 配额已满时最多等待多久再发请求（0 = 立即报错） |

## 命令

| 命令 | 作用 |
|------|------|
| `/sciverse` | 查看配置、配额、会话缓存状态 |
| `/sciverse search <检索词>` | 手动结构化检索（按新鲜度软加权，输出限 40 行） |
| `/sciverse ask <自然语言问题>` | 手动语义检索，返回原文片段 |
| `/sciverse catalog [papers\|authors\|sources]` | 查看字段目录 |
| `/sciverse content <doc_id> [偏移]` | 读原文片段 |

## 行为细节

- **客户端限流**：每个接口独立滑窗计数（默认 30 次/分钟），配额满了先等待（工具会实时回报「等待 N 秒」），
  超过 `SCIVERSE_MAX_WAIT_MS` 才报错，避免把服务端配额打爆成 429。
- **会话缓存**：检索结果、原文片段、字段目录在会话内缓存（LRU，切换会话清空），重复调用零配额消耗；
  二次调用会在结果头部标出「会话缓存命中」。
- **结果裁剪**：摘要截 600 字、语义片段截 2400 字，避免一次调用吃掉整个上下文；
  整体超过 pi 的 50KB / 2000 行上限时保留开头，完整内容落盘并在末尾给出路径（`pi-sciverse-*`）。
- **原文续读**：`sciverse_read_content` 返回末尾给出 `next_offset` 与现成的续读调用示例；
  `max_bytes` 可在一次调用内连读多段（每 16KB 消耗一次接口配额）；服务端按内容块边界续读，`next_offset` 可能略大于上一段末尾，差值会在末尾标注。
- **图片**：`sciverse_get_resource` 默认内联为多模态图片；超过 4MB 时落盘为 base64 并给路径。
- **错误提示**：401/403（Token 无效）、404（无全文 / 无权限）、429（限流）、400（字段名或参数不合法）、
  5xx 与超时都转成中文可执行提示；网络抖动与 `FETCH_FAILED` 会自动重试一次。

## 已验收路径

按 pi 的加载方式（jiti + 同名 alias）复刻探针，跑真实接口逐项验证：

1. **注册结果**：六个 `sciverse_*` 工具、`/sciverse` 命令、`session_start` 事件
2. **结构化检索**：`graphene battery cycle stability` + `year_from=2022` → 3 条命中，`unique_id` / `doc_id` /
   `is_content_accessible` 均正确渲染；同参数二次调用 `fromCache=true`
3. **DOI 精确查找**：`10.1039/d5gc02211h` → 命中 1 条，正确标注「无 doc_id，只有元数据」
4. **语义检索**：cross-attention 问题 `mode=fast` → 3 个片段，含 doc_id / offset / 页码
5. **读原文**：按片段 offset 读 5342 字节，`more=false`、到文末提示正确；二次调用 `requests=0`（缓存命中）
6. **引用关系**：`RELATED_WORKS` 分页返回 3/10 条
7. **字段目录**：papers 65 个字段、sources 45 个字段，FilterOperator 与默认返回字段清单正确
8. **图片**：从原文提取 `![](dt=…/….jpg)` → 返回 58KB JPEG，`images=1`（多模态内容块）
9. **错误路径**：未知字段 → 400「未知字段: 'no_such_field'」；无效 doc_id → 404「原文不存在」并给出排查建议；
   非法 `file_name` → 本地校验拦截，不消耗配额
10. **配置**：Token 来源、`.env` 路径、限流/分页/字节参数读取正确；缺 Token 时给出三种配置方式的提示
11. **类型检查**：`tsc --noEmit`（strict + 真实 pi 类型定义，含 `noUnusedLocals/Parameters`）零错误
12. **定点验收（Attention Is All You Need）**：`title_contains` 命中 7 个版本（6 个无 doc_id，arXiv 版有）；
    按 DOI 取元数据 + `read_content` 读出 24576 字节正文（5 次请求，`more=true`）；
    `pi -p` 端到端让模型据此回答 BLEU / 硬件 / 长度上限三问，模型读到 §5.2、§6.1、Table 2 的具体数字，
    并主动指出论文原文 41.8 与 41.0 的矛盾、以及「训练目标句长度上限」原文未披露

## 实测发现（与官方文档不一致的地方）

- **`is_content_accessible=false` 不等于读不到全文**：官方文档说该标记为 true 才能调 `read_content`，但实测
  `Attention Is All You Need`（`paper:10.48550/arxiv.1706.03762`）该字段为 false，`read_content` 仍返回了完整正文。
  因此结果里标注为「元数据标记不可读，可试读」，不阻断模型尝试。
- **引文图可能挂不到某些记录上**：上述 arXiv 版 `unique_id` 的 CITATIONS / REFERENCES 均为 0 条，
  引文关系可能关联在同一论文的其它 `unique_id`（如期刊版 DOI）下，需换个版本再查。
