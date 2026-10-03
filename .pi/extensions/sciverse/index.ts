/**
 * sciverse 扩展 —— 入口
 *
 * 解决「模型靠记忆谈科学」的问题：把 Sciverse（https://sciverse.space）的学术检索能力
 * 接成六个工具，让模型先查文献、读原文、再作答：
 *  - sciverse_search_papers     结构化元数据检索（关键词 / 作者 / 年份 / 期刊 / 学科 / DOI）
 *  - sciverse_semantic_search   自然语言语义检索，返回原文片段（RAG）
 *  - sciverse_read_content      按字节区间读原文（配合片段 offset 扩读上下文）
 *  - sciverse_paper_relations   引用 / 被引 / 相关工作列表
 *  - sciverse_catalog           字段目录（字段名、能否过滤排序、枚举样本）
 *  - sciverse_get_resource      取原文里的 Figure / Table 图片（多模态）
 *
 * 另有 /sciverse 命令查看配置与配额状态，或手动检索。
 * 检索结果在会话内缓存，切换会话即清空；客户端侧按「每接口每分钟」滑窗限流，避免打出 429。
 *
 * 安装位置：~/.pi/agent/extensions/sciverse/（全局自动发现，可 /reload 热加载）
 * 配置：同目录 .env（见 .env.example），也可用同名进程环境变量覆盖，或复用官方 CLI 的 ~/.sciverse/credentials.json。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

import {
  cacheStats,
  clearSciverseCaches,
  getResource,
  listCatalog,
  listPaperRelations,
  readContentRange,
  searchPapers,
  semanticSearch,
} from "./client.ts";
import {
  clampContentLimit,
  clampMaxContentBytes,
  ENV_FILE_CANDIDATES,
  loadConfig,
  MAX_RESOURCE_BYTES,
} from "./config.ts";
import {
  formatCatalog,
  formatContent,
  formatRelations,
  formatSearchResults,
  formatSemanticHits,
} from "./format.ts";
import { getElapsedMs, renderCallLine, renderResultSummary } from "./render.ts";
import {
  catalogParamsSchema,
  contentParamsSchema,
  relationsParamsSchema,
  resourceParamsSchema,
  searchParamsSchema,
  semanticParamsSchema,
  type CatalogDetails,
  type CatalogParams,
  type ContentParams,
  type ReadContentDetails,
  type RelationsDetails,
  type RelationsParams,
  type ResourceDetails,
  type ResourceParams,
  type SearchPapersDetails,
  type SearchParams,
  type SemanticParams,
  type SemanticSearchDetails,
  type TruncatedDetails,
} from "./types.ts";

/* ------------------------------ 常量 ------------------------------ */

/** 完整结果落盘的临时目录前缀 */
const TEMP_FILE_PREFIX = "pi-sciverse-";

/** /sciverse 命令输出给用户的行数上限 */
const COMMAND_MAX_LINES = 40;

/* ------------------------------ 通用辅助 ------------------------------ */

/** 文本内容块 */
function textContent(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** 把完整文本写入临时文件，返回路径 */
async function persistFullText(text: string, fileName = "result.txt"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_FILE_PREFIX));
  const file = join(dir, fileName);
  await writeFile(file, text, "utf8");
  return file;
}

/** 结果超过 pi 的展示上限时截断，并把完整文本落盘（截断信息写入 details） */
async function applyTruncation(fullText: string, details: TruncatedDetails, fileName?: string): Promise<string> {
  const truncation = truncateHead(fullText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return truncation.content;

  details.truncation = truncation;
  details.fullOutputPath = await persistFullText(fullText, fileName);

  return (
    `${truncation.content}\n\n[结果已截断：显示前 ${truncation.outputLines} 行（${formatSize(truncation.outputBytes)}），` +
    `共 ${truncation.totalLines} 行。完整内容：${details.fullOutputPath}]`
  );
}

/** 命令输出限行，避免刷屏 */
function limitLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…（共 ${lines.length} 行，已省略 ${lines.length - maxLines} 行）`;
}

/** 工具进度回报的最小结构（与 AgentToolUpdateCallback 兼容） */
type ProgressReporter = (partial: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void;

/** 构造「配额已满、正在等待」的进度回报 */
function makeWaitReporter(onUpdate: ProgressReporter | undefined) {
  return (info: { endpoint: string; waitMs: number }): void => {
    onUpdate?.({
      content: [
        textContent(
          `Sciverse 接口 ${info.endpoint} 配额已满（限流 ${loadConfig().rateLimitPerMin} 次/分钟），等待 ${Math.ceil(info.waitMs / 1000)} 秒后重试 …`,
        ),
      ],
      details: undefined,
    });
  };
}

/* ------------------------------ 提示词（系统提示注入） ------------------------------ */

const SEARCH_GUIDELINES = [
  "当需要按结构化条件找文献（作者 / 年份 / 期刊 / 学科 / DOI / 被引情况）时用 sciverse_search_papers；查单篇用参数 doi，查某作者的产出用 authors，追最新进展用 freshness_boost 而不是用 query + sort_by_year=\"desc\"。",
  "sciverse_search_papers 的字段名或取值不确定时，先调一次 sciverse_catalog（必要时 include_sample_values=true）确认，不要凭猜测拼 filters_advanced 字段名。",
];

const SEMANTIC_GUIDELINES = [
  "当问题涉及科学文献、研究结论、机制、实验数据，或用户要求「查文献 / 有没有研究支持」时，先 sciverse_semantic_search 检索原文片段，再用 sciverse_read_content 读上下文，最后基于检索到的原文作答。",
  "永远不要凭记忆编造论文标题、作者、DOI、年份或数据；答案中的每条关键结论都要能对应到检索结果里的文献，并把标题与 DOI 一并给出（DOI 缺失时说明「未返回 DOI」）。",
  "Sciverse 每个接口限流 30 次/分钟，且相同检索在会话内会命中缓存；不要用同一 query 反复调用，需要更多结果优先翻页或放宽条件。",
];

const CONTENT_GUIDELINES = [
  "sciverse_read_content 只在已知 doc_id 时使用（来自 sciverse_search_papers 或 sciverse_semantic_search）；返回末尾若 more=true，用 next_offset 继续读，不要跳过中间内容直接下结论。",
  "引用原文时只摘取与问题直接相关的短句，并注明来自哪篇文献，不要把整段原文大段复制进回答。",
];

const RELATIONS_GUIDELINES = [
  "当问题涉及「谁引用了这篇 / 这篇引用了谁 / 有哪些相关工作 / 影响力如何」时用 sciverse_paper_relations；注意 CITATIONS 是别人引用它（被引），REFERENCES 是它引用的文献，方向相反。",
];

const CATALOG_GUIDELINES = [
  "sciverse_catalog 用于第一次接触 Sciverse 或字段需求模糊时确认字段名、可过滤性与枚举取值（include_sample_values=true 返回取值样本），不要用它来检索文献。",
  "当 sciverse_get_resource 返回图片后，可直接依据图片内容回答关于 Figure / Table / 图表趋势的问题，不要只描述「收到一张图」。",
];

const RESOURCE_GUIDELINES = [
  "sciverse_get_resource 只在 sciverse_read_content 返回的 Markdown 里出现 `![alt](file_name)` 图片占位、且问题需要看图时才调用。",
];

/* ------------------------------ 工具：结构化检索 ------------------------------ */

function createSearchTool(): ToolDefinition<typeof searchParamsSchema, SearchPapersDetails | undefined> {
  return {
    name: "sciverse_search_papers",
    label: "sciverse_search_papers",
    description:
      "按结构化条件检索学术文献元数据（标题、作者、期刊、年份、摘要、被引等），并支持作者 / 期刊 / 学科实体检索。\n" +
      "适用：「找 Hinton 2020-2023 年的论文」「Nature 上关于 CRISPR 的近期文献」「这篇 DOI 的元数据」。\n" +
      "不适用：自然语言问题检索 → sciverse_semantic_search；读原文 → sciverse_read_content。\n" +
      "返回：命中列表，每条含 unique_id（始终存在）、doc_id（仅当有全文）、title、author、abstract、publication_venue_name_unified、publication_published_year、citation_count 等。",
    promptSnippet: "Search scientific literature metadata (title/author/year/venue/DOI) via Sciverse",
    promptGuidelines: SEARCH_GUIDELINES,
    parameters: searchParamsSchema,

    async execute(_toolCallId, params: SearchParams, signal, onUpdate, _ctx: ExtensionContext) {
      const cfg = loadConfig();
      onUpdate?.({
        content: [textContent(params.query ? `Sciverse 检索「${params.query}」…` : "Sciverse 结构化检索 …")],
        details: undefined,
      });

      const { payload, fromCache } = await searchPapers(cfg, params, signal, makeWaitReporter(onUpdate));
      const collection = params.collection ?? "papers";
      const results = payload.results ?? [];

      const details: SearchPapersDetails = {
        collection,
        count: results.length,
        totalCount: payload.total_count,
        page: payload.page,
        pageSize: payload.page_size,
        nextCursor: payload.next_cursor,
        fromCache,
        requestTokens: payload.request_tokens,
        responseTokens: payload.response_tokens,
      };

      const text = await applyTruncation(formatSearchResults(payload, collection, fromCache), details, "search.md");
      return { content: [textContent(text)], details };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      const bits: string[] = [];
      if (args.query) bits.push(`「${args.query}」`);
      if (args.authors?.length) bits.push(`作者 ${args.authors.join("/")}`);
      if (args.year_from !== undefined || args.year_to !== undefined) {
        bits.push(`${args.year_from ?? "…"}-${args.year_to ?? "…"}`);
      }
      if (args.doi) bits.push(`DOI ${args.doi}`);
      if (args.journals?.length) bits.push(args.journals.join("/"));
      const suffix = bits.length > 0 ? ` ${bits.join(" · ")}` : "";
      return renderCallLine(`sciverse 检索${suffix}`, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details;
      let header = `命中 ${details?.count ?? 0} 条`;
      if (details?.totalCount !== undefined) header += ` / 共 ${details.totalCount}`;
      if (details?.fromCache) header += " · 缓存命中";
      return renderResultSummary(result, options, theme, header, getElapsedMs(context));
    },
  };
}

/* ------------------------------ 工具：语义检索 ------------------------------ */

function createSemanticSearchTool(): ToolDefinition<typeof semanticParamsSchema, SemanticSearchDetails | undefined> {
  return {
    name: "sciverse_semantic_search",
    label: "sciverse_semantic_search",
    description:
      "自然语言语义检索，返回相关文献原文片段（chunk）用于 RAG 式回答；这是「问科学问题」的首选入口。\n" +
      "适用：「Transformer 注意力机制如何工作？」「最新的蛋白质折叠预测方法有哪些？」\n" +
      "不适用：精确字段过滤 → sciverse_search_papers；取完整原文 → sciverse_read_content。\n" +
      "返回：片段列表，每条含 doc_id、chunk（原文片段）、score、title、offset；offset 可直接交给 sciverse_read_content 扩读上下文。",
    promptSnippet: "Semantic search over scientific papers; returns original-text chunks for grounded answers",
    promptGuidelines: SEMANTIC_GUIDELINES,
    parameters: semanticParamsSchema,

    async execute(_toolCallId, params: SemanticParams, signal, onUpdate, _ctx: ExtensionContext) {
      const cfg = loadConfig();
      onUpdate?.({
        content: [textContent(`Sciverse 语义检索「${params.query}」（mode=${params.mode ?? "balanced"}）…`)],
        details: undefined,
      });

      const { payload, fromCache, mode } = await semanticSearch(cfg, params, signal, makeWaitReporter(onUpdate));
      const hits = payload.hits ?? [];

      const details: SemanticSearchDetails = {
        count: hits.length,
        mode,
        fromCache,
        docIds: [...new Set(hits.map((hit) => hit.doc_id).filter(Boolean))],
      };

      const text = await applyTruncation(formatSemanticHits(payload, mode, fromCache), details, "semantic-hits.md");
      return { content: [textContent(text)], details };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      const mode = args.mode && args.mode !== "balanced" ? ` [${args.mode}]` : "";
      return renderCallLine(`sciverse 语义检索${mode} 「${args.query}」`, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details;
      let header = `命中 ${details?.count ?? 0} 个片段 · ${details?.docIds.length ?? 0} 篇`;
      if (details?.mode) header += ` · ${details.mode}`;
      if (details?.fromCache) header += " · 缓存命中";
      return renderResultSummary(result, options, theme, header, getElapsedMs(context));
    },
  };
}

/* ------------------------------ 工具：读原文 ------------------------------ */

function createReadContentTool(): ToolDefinition<typeof contentParamsSchema, ReadContentDetails | undefined> {
  return {
    name: "sciverse_read_content",
    label: "sciverse_read_content",
    description:
      "按字节区间读取文献原文（Markdown），用于查看片段上下文或通读全文。\n" +
      "用法：doc_id 来自 sciverse_search_papers / sciverse_semantic_search；offset 用上一次返回的 next_offset（或片段命中的 offset）。\n" +
      "单次请求上限 16KB，max_bytes 可在一次调用内自动续读（默认取扩展配置，最大 48KB）。\n" +
      "返回：原文片段 + 实际字节区间 + 是否还有后续（more / next_offset）。",
    promptSnippet: "Read the original full text of a paper by doc_id and byte offset",
    promptGuidelines: CONTENT_GUIDELINES,
    parameters: contentParamsSchema,

    async execute(_toolCallId, params: ContentParams, signal, onUpdate, _ctx: ExtensionContext) {
      const cfg = loadConfig();
      const limit = clampContentLimit(params.limit, cfg.defaultContentLimit);
      const maxBytes = clampMaxContentBytes(params.max_bytes, limit);

      onUpdate?.({
        content: [textContent(`读取原文 doc_id ${params.doc_id.slice(0, 12)}… @${params.offset ?? 0} …`)],
        details: undefined,
      });

      const result = await readContentRange(
        cfg,
        { doc_id: params.doc_id, offset: params.offset, limit, max_bytes: maxBytes },
        signal,
        makeWaitReporter(onUpdate),
      );

      const details: ReadContentDetails = {
        docId: params.doc_id,
        startOffset: result.startOffset,
        endOffset: result.endOffset,
        bytes: result.bytes,
        more: result.more,
        nextOffset: result.nextOffset,
        requests: result.requests,
      };

      return { content: [textContent(formatContent(result, params.doc_id))], details };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      return renderCallLine(`sciverse 读原文 ${args.doc_id.slice(0, 12)}… @${args.offset ?? 0}`, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details;
      let header = `${details?.bytes ?? 0} 字节 ｜ [${details?.startOffset ?? 0}, ${details?.endOffset ?? 0})`;
      if (details?.requests !== undefined) header += ` · ${details.requests} 次请求`;
      if (details?.more) header += " · 还有后续";
      return renderResultSummary(result, options, theme, header, getElapsedMs(context), 30);
    },
  };
}

/* ------------------------------ 工具：引用关系 ------------------------------ */

function createRelationsTool(): ToolDefinition<typeof relationsParamsSchema, RelationsDetails | undefined> {
  return {
    name: "sciverse_paper_relations",
    label: "sciverse_paper_relations",
    description:
      "分页获取某篇论文的引用关系列表：CITATIONS（被引：谁引用了它）/ REFERENCES（参考文献：它引用了谁）/ RELATED_WORKS（相关工作）。\n" +
      "适用：「这篇论文被谁引用了」「它的参考文献有哪些」「有哪些相关工作」。\n" +
      "输入 unique_id 来自 sciverse_search_papers / sciverse_semantic_search，勿传 doc_id。\n" +
      "限制：关系数超过 10000 或 page×page_size 超过 10000 会失败，此时改用 sciverse_search_papers 的 filters_advanced 字段 references_unique_id 反查。",
    promptSnippet: "List a paper's citations, references, or related works by unique_id",
    promptGuidelines: RELATIONS_GUIDELINES,
    parameters: relationsParamsSchema,

    async execute(_toolCallId, params: RelationsParams, signal, onUpdate, _ctx: ExtensionContext) {
      const cfg = loadConfig();
      onUpdate?.({
        content: [textContent(`查询引用关系 ${params.relation} ｜ ${params.unique_id} …`)],
        details: undefined,
      });

      const { payload, fromCache } = await listPaperRelations(cfg, params, signal, makeWaitReporter(onUpdate));
      const items = payload.items ?? [];

      const details: RelationsDetails = {
        uniqueId: params.unique_id,
        relation: params.relation,
        count: items.length,
        totalCount: payload.total_count,
        page: payload.page,
        pageSize: payload.page_size,
        fromCache,
      };

      const text = await applyTruncation(
        formatRelations(payload, params.unique_id, params.relation, fromCache),
        details,
        "relations.md",
      );
      return { content: [textContent(text)], details };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      return renderCallLine(`sciverse ${args.relation} ｜ ${args.unique_id}`, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details;
      let header = `${details?.relation ?? ""} ${details?.count ?? 0} 条`;
      if (details?.totalCount !== undefined) header += ` / 共 ${details.totalCount}`;
      if (details?.fromCache) header += " · 缓存命中";
      return renderResultSummary(result, options, theme, header, getElapsedMs(context));
    },
  };
}

/* ------------------------------ 工具：字段目录 ------------------------------ */

function createCatalogTool(): ToolDefinition<typeof catalogParamsSchema, CatalogDetails | undefined> {
  return {
    name: "sciverse_catalog",
    label: "sciverse_catalog",
    description:
      "返回 Sciverse 检索可用字段的目录：字段名、类型、能否过滤 / 排序 / 全文检索、是否默认返回、中文说明、枚举取值样本、FilterOperator 清单。\n" +
      "适用：「按 DOI 过滤该用哪个字段」「metadata_type 有哪些取值」「authors 集合有哪些字段」。\n" +
      "不适用：实际检索文献（用 sciverse_search_papers / sciverse_semantic_search）。\n" +
      "用法：不确定字段名或枚举值时先调它一次，把 schema 装进上下文，再精确构造过滤条件。",
    promptSnippet: "Get the Sciverse field catalog: filterable/sortable fields and enum values",
    promptGuidelines: CATALOG_GUIDELINES,
    parameters: catalogParamsSchema,

    async execute(_toolCallId, params: CatalogParams, signal, onUpdate, _ctx: ExtensionContext) {
      const cfg = loadConfig();
      const collection = params.collection ?? "papers";
      onUpdate?.({
        content: [textContent(`获取 Sciverse ${collection} 字段目录 …`)],
        details: undefined,
      });

      const { payload, fromCache } = await listCatalog(cfg, { ...params, collection }, signal, makeWaitReporter(onUpdate));
      const fields = payload.fields ?? [];

      const details: CatalogDetails = {
        collection,
        fieldCount: fields.length,
        fromCache,
      };

      const text = await applyTruncation(formatCatalog(payload, collection, fromCache), details, "catalog.md");
      return { content: [textContent(text)], details };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      const extra = args.include_sample_values ? " · 含取值样本" : "";
      return renderCallLine(`sciverse 字段目录 ${args.collection ?? "papers"}${extra}`, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details;
      let header = `${details?.collection ?? ""} ${details?.fieldCount ?? 0} 个字段`;
      if (details?.fromCache) header += " · 缓存命中";
      return renderResultSummary(result, options, theme, header, getElapsedMs(context));
    },
  };
}

/* ------------------------------ 工具：取图片 ------------------------------ */

function createResourceTool(): ToolDefinition<typeof resourceParamsSchema, ResourceDetails | undefined> {
  return {
    name: "sciverse_get_resource",
    label: "sciverse_get_resource",
    description:
      "取文献里的图片（Figure / Table），用于回答图表相关问题或把图给用户看。\n" +
      "输入 file_name 来自 sciverse_read_content 返回的 Markdown 中 `![alt](file_name)` 的 url 段（相对路径，禁止 `\\` 与 `..`）。\n" +
      "返回：图片本身（多模态直接可见）；图片过大时改为落盘并给路径。",
    promptSnippet: "Fetch a figure/table image referenced in a paper's full text",
    promptGuidelines: RESOURCE_GUIDELINES,
    parameters: resourceParamsSchema,

    async execute(_toolCallId, params: ResourceParams, signal, onUpdate, _ctx: ExtensionContext) {
      const cfg = loadConfig();
      onUpdate?.({ content: [textContent(`取图片 ${params.file_name} …`)], details: undefined });

      const { bytes, mimeType } = await getResource(cfg, params.file_name, signal, makeWaitReporter(onUpdate));

      const details: ResourceDetails = {
        fileName: params.file_name,
        mimeType,
        bytes: bytes.byteLength,
      };

      // 过大图片不塞进上下文，落盘给路径，由模型的 read 工具按需读取
      if (bytes.byteLength > MAX_RESOURCE_BYTES) {
        const savedPath = await persistFullText(Buffer.from(bytes).toString("base64"), basename(params.file_name) || "figure.b64");
        details.savedPath = savedPath;
        return {
          content: [
            textContent(
              `图片 ${params.file_name}（${mimeType}，${formatSize(bytes.byteLength)}）超过内联上限 ${formatSize(
                MAX_RESOURCE_BYTES,
              )}，已按 base64 落盘：${savedPath}`,
            ),
          ],
          details,
        };
      }

      const image: ImageContent = {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      };

      return {
        content: [textContent(`图片 ${params.file_name}（${mimeType}，${formatSize(bytes.byteLength)}）`), image],
        details,
      };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      return renderCallLine(`sciverse 取图片 ${args.file_name}`, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details;
      let header = `${details?.mimeType ?? ""} ${formatSize(details?.bytes ?? 0)}`;
      if (details?.savedPath) header += ` · 已落盘 ${details.savedPath}`;
      return renderResultSummary(result, options, theme, header, getElapsedMs(context), 10);
    },
  };
}

/* ------------------------------ /sciverse 命令 ------------------------------ */

/** 配置与配额状态文本 */
function buildStatusText(): string {
  const cfg = loadConfig();
  const caches = cacheStats();

  const tokenLine = cfg.token ? `已配置（来源：${cfg.tokenSource}）` : "未配置 —— 调用任何工具都会失败，需先写入 Token";
  const envHint = cfg.envFilePath ?? ENV_FILE_CANDIDATES[ENV_FILE_CANDIDATES.length - 1] ?? "~/.pi/agent/extensions/sciverse/.env";

  return [
    "Sciverse 状态",
    `· 接口地址：${cfg.baseUrl}`,
    `· API Token：${tokenLine}`,
    `· 客户端限流：每接口 ${cfg.rateLimitPerMin} 次/分钟（配额满时最多等 ${Math.round(cfg.maxWaitMs / 1000)}s，可用 SCIVERSE_MAX_WAIT_MS 调整）`,
    `· 默认每页：${cfg.defaultPageSize} 条；默认读原文：${cfg.defaultContentLimit} 字节/请求，累计 ${cfg.defaultMaxContentBytes} 字节`,
    `· 请求超时：${cfg.timeoutMs} ms`,
    `· 会话缓存：检索 ${caches.search} 条、原文 ${caches.content} 段、字段目录 ${caches.catalog} 份`,
    `· 配置文件：${envHint}`,
    cfg.credentialsPath ? `· 官方 CLI 凭据：${cfg.credentialsPath}` : "· 官方 CLI 凭据：未发现 ~/.sciverse/credentials.json",
    "",
    "用法：",
    "  /sciverse                      查看状态",
    "  /sciverse search <检索词>      手动结构化检索（关键词）",
    "  /sciverse ask <自然语言问题>   手动语义检索，返回原文片段",
    "  /sciverse catalog [集合]       查看字段目录（papers / authors / sources）",
    "  /sciverse content <doc_id> [偏移]  读原文片段",
  ].join("\n");
}

/* ------------------------------ 扩展入口 ------------------------------ */

export default function sciverseExtension(pi: ExtensionAPI): void {
  /* 会话开始：清空缓存；未配置 Token 时提示一次 */
  pi.on("session_start", (_event, ctx) => {
    clearSciverseCaches();

    const cfg = loadConfig();
    if (!cfg.token && ctx.hasUI) {
      const envPath = cfg.envFilePath ?? ENV_FILE_CANDIDATES[ENV_FILE_CANDIDATES.length - 1];
      ctx.ui.notify(
        `sciverse 未配置 API Token：六个 sciverse_* 工具调用都会失败。请在 ${envPath} 写入 SCIVERSE_API_TOKEN=sci_…（或设同名环境变量）。`,
        "warning",
      );
    }
  });

  pi.registerTool(createSearchTool());
  pi.registerTool(createSemanticSearchTool());
  pi.registerTool(createReadContentTool());
  pi.registerTool(createRelationsTool());
  pi.registerTool(createCatalogTool());
  pi.registerTool(createResourceTool());

  pi.registerCommand("sciverse", {
    description: "查看 Sciverse 配置/配额状态，或手动检索文献、读原文、看字段目录",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      // 无参数：打印配置与配额状态
      if (!sub) {
        ctx.ui.notify(buildStatusText(), "info");
        return;
      }

      const cfg = loadConfig();

      if (sub === "search") {
        const query = parts.slice(1).join(" ");
        if (!query) {
          ctx.ui.notify("用法：/sciverse search <检索词>，例如 /sciverse search graphene battery cycle stability", "error");
          return;
        }
        const { payload, fromCache } = await searchPapers(
          cfg,
          { query, page_size: Math.min(5, cfg.defaultPageSize), freshness_boost: "MILD" },
          ctx.signal,
          makeWaitReporter(undefined),
        );
        const body = formatSearchResults(payload, "papers", fromCache);
        ctx.ui.notify(limitLines(`Sciverse 检索「${query}」\n\n${body}`, COMMAND_MAX_LINES), "info");
        return;
      }

      if (sub === "ask") {
        const query = parts.slice(1).join(" ");
        if (!query) {
          ctx.ui.notify("用法：/sciverse ask <自然语言问题>", "error");
          return;
        }
        const { payload, fromCache, mode } = await semanticSearch(cfg, { query }, ctx.signal, makeWaitReporter(undefined));
        const body = formatSemanticHits(payload, mode, fromCache);
        ctx.ui.notify(limitLines(`Sciverse 语义检索「${query}」\n\n${body}`, COMMAND_MAX_LINES), "info");
        return;
      }

      if (sub === "catalog") {
        const collection = parts[1] ?? "papers";
        if (!["papers", "authors", "sources"].includes(collection)) {
          ctx.ui.notify("用法：/sciverse catalog [papers|authors|sources]", "error");
          return;
        }
        const { payload, fromCache } = await listCatalog(cfg, { collection }, ctx.signal, makeWaitReporter(undefined));
        const body = formatCatalog(payload, collection, fromCache);
        ctx.ui.notify(limitLines(body, COMMAND_MAX_LINES), "info");
        return;
      }

      if (sub === "content") {
        const docId = parts[1];
        if (!docId) {
          ctx.ui.notify("用法：/sciverse content <doc_id> [offset]（doc_id 来自检索结果的 doc_id 字段）", "error");
          return;
        }
        const offset = Number(parts[2] ?? 0);
        const result = await readContentRange(
          cfg,
          { doc_id: docId, offset: Number.isFinite(offset) ? Math.max(0, Math.round(offset)) : 0 },
          ctx.signal,
          makeWaitReporter(undefined),
        );
        const body = formatContent(result, docId);
        ctx.ui.notify(limitLines(body, COMMAND_MAX_LINES), "info");
        return;
      }

      ctx.ui.notify(
        `未知子命令「${sub}」。可用：/sciverse、/sciverse search <检索词>、/sciverse ask <问题>、/sciverse catalog [集合]、/sciverse content <doc_id> [偏移]`,
        "error",
      );
    },
  });
}
