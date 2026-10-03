/**
 * sciverse 扩展 —— 类型与参数 Schema
 *
 * 集中定义六个工具的：
 *  - 参数 Schema（TypeBox，供 LLM 调用校验）
 *  - Sciverse 接口返回的数据结构（与官方 openapi 一致，不做响应转换）
 *  - 结果详情类型（供 TUI 渲染与截断信息展示使用）
 *
 * 接口参考：https://sciverse.space/docs/sciverse/api/agentic-search
 * 官方 SDK：https://github.com/opendatalab/Sciverse-Agent-Tools
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/* ------------------------------ 接口返回数据结构 ------------------------------ */

/** 作者条目（OS object 数组，子字段 name / orcid） */
export interface PaperAuthor {
  name?: string;
  orcid?: string;
}

/** /meta-search 命中的单条文献元数据（含 fields 投影的任意字段） */
export interface PaperMetadata {
  /** 元数据记录全局唯一 ID（任何记录都有），用于引用关系查询 */
  unique_id?: string;
  /** 全文 artifact 内容哈希；仅当存在全文时返回，read_content 必须用它 */
  doc_id?: string;
  /** 正文是否对当前调用方可见（有全文且被授权） */
  is_content_accessible?: boolean;
  title?: string;
  author?: PaperAuthor[];
  abstract?: string;
  publication_venue_name_unified?: string;
  publication_published_year?: number;
  publication_venue_type?: string;
  publication_publisher?: string[];
  publication_venue_issn?: string[];
  subjects?: string[];
  keywords?: string[];
  doi?: string;
  type?: string[];
  metadata_type?: string;
  language?: string;
  citation_count?: number;
  influential_citation_count?: number;
  fwci?: number;
  reference_count?: number;
  cited_by_percentile_year?: Record<string, number>;
  access_is_oa?: string;
  access_oa_status?: string;
  access_license?: string;
  access_oa_url?: string[];
  locations?: Array<{ type?: string; is_oa?: string; license?: string; url?: string }>;
  relevance_score?: number;
  /** fields 投影时可能返回 catalog 里的任意字段 */
  [field: string]: unknown;
}

/** /meta-search 响应 */
export interface SearchPapersResponse {
  results?: PaperMetadata[];
  /** 命中总数，超过 10000 会被截断为 10000 */
  total_count?: number;
  page?: number;
  page_size?: number;
  total_pages?: number;
  /** 深翻页游标；为空表示无更多（page × page_size > 10000 时只能靠它翻页） */
  next_cursor?: string;
  search_time_ms?: number;
  request_tokens?: number;
  response_tokens?: number;
  facets?: unknown[];
}

/** /agentic-search 命中的单个片段 */
export interface SearchChunk {
  chunk_id: string;
  doc_id: string;
  title?: string;
  abstract?: string;
  chunk?: string;
  score?: number;
  /** chunk 在原文中的字节偏移，可直接传给 read_content */
  offset?: number;
  page_no?: number;
  source_type?: string;
}

/** /agentic-search 响应 */
export interface SemanticSearchResponse {
  hits?: SearchChunk[];
}

/** /content 响应 */
export interface ReadContentResponse {
  text?: string;
  bytes_returned?: number;
  next_offset?: number;
  /** true 表示可能还有后续字节，可用 next_offset 继续读 */
  more?: boolean;
}

/** /meta-catalog 的单个字段条目 */
export interface FieldCatalogEntry {
  name: string;
  type: string;
  filterable?: boolean;
  sortable?: boolean;
  searchable?: boolean;
  default_returned?: boolean;
  description?: string;
  sample_values?: string[];
  operators?: string[];
}

/** /meta-catalog 响应 */
export interface CatalogResponse {
  fields?: FieldCatalogEntry[];
  default_fields?: string[];
  filter_operators?: string[];
}

/** /meta-paper-relations 的单个条目 */
export interface RelationItem {
  id?: string;
  id_type?: string;
  title?: string;
}

/** /meta-paper-relations 响应 */
export interface PaperRelationsResponse {
  items?: RelationItem[];
  total_count?: number;
  page?: number;
  page_size?: number;
  total_pages?: number;
}

/** 服务端错误体（两种形态：{error:{code,message}} 与 {code,message,request_id}） */
export interface ApiErrorBody {
  error?: { biz_code?: number; code?: string; message?: string };
  code?: string;
  message?: string;
  request_id?: string;
}

/* ------------------------------ 结果详情类型 ------------------------------ */

/** 通用截断信息（写入 details，供渲染与分支恢复） */
export interface TruncatedDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/** sciverse_search_papers 结果详情 */
export interface SearchPapersDetails extends TruncatedDetails {
  collection: string;
  count: number;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  nextCursor?: string;
  fromCache: boolean;
  requestTokens?: number;
  responseTokens?: number;
}

/** sciverse_semantic_search 结果详情 */
export interface SemanticSearchDetails extends TruncatedDetails {
  count: number;
  mode: string;
  fromCache: boolean;
  /** 命中的 doc_id 去重列表，便于后续批量 read_content */
  docIds: string[];
}

/** sciverse_paper_relations 结果详情 */
export interface RelationsDetails extends TruncatedDetails {
  uniqueId: string;
  relation: string;
  count: number;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  fromCache: boolean;
}

/** sciverse_catalog 结果详情 */
export interface CatalogDetails extends TruncatedDetails {
  collection: string;
  fieldCount: number;
  fromCache: boolean;
}

/** sciverse_read_content 结果详情 */
export interface ReadContentDetails {
  docId: string;
  /** 实际返回的字节区间 [start, end) */
  startOffset: number;
  endOffset: number;
  bytes: number;
  more: boolean;
  nextOffset?: number;
  /** 本次调用实际发出的接口请求次数（每 16KB 一次） */
  requests: number;
}

/** sciverse_get_resource 结果详情 */
export interface ResourceDetails {
  fileName: string;
  mimeType: string;
  bytes: number;
  /** 图片过大落盘时的路径（此时不返回 base64） */
  savedPath?: string;
}

/* ------------------------------ sciverse_search_papers ------------------------------ */

/** 高级过滤条目（逃生舱：任意 catalog 字段 + FilterOperator） */
export const advancedFilterSchema = Type.Object({
  field: Type.String({
    description:
      "catalog 字段名，如 doi / access_is_oa / references_unique_id（引文反查）/ language / summary_stats.h_index",
  }),
  operator: Type.Optional(
    StringEnum(
      [
        "FILTER_OP_EQ",
        "FILTER_OP_NE",
        "FILTER_OP_GT",
        "FILTER_OP_GTE",
        "FILTER_OP_LT",
        "FILTER_OP_LTE",
        "FILTER_OP_IN",
        "FILTER_OP_NIN",
        "FILTER_OP_CONTAINS",
        "FILTER_OP_MATCH",
        "FILTER_OP_MATCH_PHRASE"
      ] as const,
      {
        description:
          "过滤操作符，默认 FILTER_OP_EQ。MATCH（分词模糊）适用于 author/keywords；MATCH_PHRASE（短语模糊）适用于期刊名；doi 用 EQ（服务端会归一化）；数值区间用 GTE+LTE 两条",
      }
    )
  ),
  value: Type.Unknown({ description: "过滤值；EQ/IN 传标量或数组，CONTAINS/MATCH 传字符串" }),
});

/** 高级排序条目 */
export const advancedSortSchema = Type.Object({
  field: Type.String({ description: "可排序字段名（catalog 中 sortable=true），如 cited_by_count / publication_published_year" }),
  order: StringEnum(["SORT_ORDER_DESC", "SORT_ORDER_ASC"] as const, { description: "排序方向，默认 SORT_ORDER_DESC" }),
});

export const searchParamsSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "BM25 关键词，匹配标题/摘要/期刊名/关键词。留空则纯靠结构化过滤（此时默认按年份降序）。支持中文",
    })
  ),
  collection: Type.Optional(
    StringEnum(["papers", "authors", "sources"] as const, {
      description:
        "检索实体，默认 papers。authors/sources 的字段集不同（先调 sciverse_catalog），且作者的便捷字段（authors/journals/year_from/subjects）只对 papers 生效，需改用 filters_advanced",
    })
  ),
  title_contains: Type.Optional(Type.String({ description: "标题必须包含的词（仅匹配 title 字段）" })),
  abstract_contains: Type.Optional(Type.String({ description: "摘要必须包含的词（仅匹配 abstract 字段）" })),
  authors: Type.Optional(Type.Array(Type.String(), { description: "作者名（任一命中即可），如 [\"Hinton\", \"LeCun\"]" })),
  year_from: Type.Optional(Type.Integer({ description: "起始发表年（含）" })),
  year_to: Type.Optional(Type.Integer({ description: "结束发表年（含）" })),
  journals: Type.Optional(Type.Array(Type.String(), { description: "期刊 / 会议名（规范化名，任一命中即可）" })),
  subjects: Type.Optional(Type.Array(Type.String(), { description: "学科分类（任一命中即可），如 [\"computer science\", \"biology\"]" })),
  doi: Type.Optional(Type.String({ description: "按 DOI 精确查找单篇文献（服务端自动归一化大小写与 doi.org 前缀）" })),
  filters_advanced: Type.Optional(
    Type.Array(advancedFilterSchema, {
      description:
        "高级过滤逃生舱，仅当上面的便捷字段不够用时使用。可叠加多条（AND）。常用：references_unique_id 引文反查（value 填目标论文 unique_id）、access_is_oa、language、fwci、citation_count",
    })
  ),
  sort_advanced: Type.Optional(Type.Array(advancedSortSchema, { description: "高级排序逃生舱（按任意可排序字段）；与 query 互斥，传了 query 就不要再排序" })),
  sort_by_year: Type.Optional(
    StringEnum(["auto", "desc", "asc", "none"] as const, {
      description:
        "按年份排序，默认 auto（有 query 时保持相关性排序，纯过滤时按年份降序）。⚠️ 不要用 query + desc 求「相关且最新」，那会让 query 退化为命中过滤并让三个 boost 失效，改用 freshness_boost",
    })
  ),
  freshness_boost: Type.Optional(
    StringEnum(["NONE", "MILD", "STRONG"] as const, {
      description: "新鲜度软加权（仅 query 非空且未显式排序时生效）：MILD≈近 10 年，STRONG≈近 3 年。查最新进展用它而不是排序",
    })
  ),
  impact_boost: Type.Optional(
    StringEnum(["NONE", "MILD", "STRONG"] as const, {
      description: "影响力软加权（同上条件）：高被引文献上浮但不丢相关性。想找领域奠基石用它",
    })
  ),
  language_affinity: Type.Optional(
    StringEnum(["NONE", "MILD", "STRONG"] as const, {
      description: "语言亲和软加权（同上条件）：非 query 语言的结果降序但不排除，中文 query 配 MILD 可提升中文文献排名",
    })
  ),
  fields: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "只返回指定字段（投影），如 [\"title\",\"doi\",\"publication_published_year\"]。unique_id 会被自动补上（引用关系查询需要它），doc_id 与 is_content_accessible 不受投影影响",
    })
  ),
  cursor: Type.Optional(
    Type.String({ description: "深翻页游标：把上一次返回的 next_cursor 原样传回。page × page_size 超过 10000 时只能用游标" })
  ),
  page: Type.Optional(Type.Integer({ minimum: 1, description: "页码，从 1 开始（与 cursor 二选一）" })),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "每页条数 1-50，默认取扩展配置（10）" })),
});
export type SearchParams = Static<typeof searchParamsSchema>;

/* ------------------------------ sciverse_semantic_search ------------------------------ */

/** 语义检索的结构化过滤（软约束：chunk 缺元数据不会被排除，不可当硬保证用） */
export const semanticFiltersSchema = Type.Object({
  lang: Type.Optional(Type.Unknown({ description: "语言代码，如 \"en\"、\"zh\"；别名 language" })),
  metadata_type: Type.Optional(Type.Unknown({ description: "资源类型，单值 \"paper\" 或 \"ebook\"" })),
  author: Type.Optional(Type.Unknown({ description: "作者名，字符串或字符串数组（数组=任一命中）" })),
  publication_venue_name_unified: Type.Optional(Type.Unknown({ description: "期刊 / 会议规范化名，适合精确匹配" })),
  publication_venue_type: Type.Optional(Type.Unknown({ description: "载体类型：journal / conference / repository / book series …" })),
  publication_published_year: Type.Optional(
    Type.Unknown({ description: "发表年份，单值或区间：{\"gte\":2020,\"lte\":2025} 或 [2020,2025]" })
  ),
  publication_published_date: Type.Optional(Type.Unknown({ description: "发表日期 \"YYYY[-MM[-DD]]\"，单值或区间" })),
  citation_count: Type.Optional(Type.Unknown({ description: "被引次数，单值或区间" })),
  influential_citation_count: Type.Optional(Type.Unknown({ description: "高影响力被引次数，单值或区间" })),
  title: Type.Optional(Type.Unknown({ description: "标题精确匹配（标题检索一般用 sciverse_search_papers 更合适）" })),
  topics: Type.Optional(
    Type.Unknown({
      description:
        "主题过滤：{\"logic\":\"and|or\",\"dimensions\":{\"primary_topic\":\"…\",\"primary_topic_domain\":\"Physical Sciences|Social Sciences|Health Sciences|Life Sciences\"}}",
    })
  ),
  doc_id: Type.Optional(
    Type.Unknown({
      description:
        "唯一的硬约束：只在给定 doc_id 集合内检索（最多 1000 个，来自 sciverse_search_papers）。典型用法：先圈定候选集合，再在集合内做受限语义检索",
    })
  ),
});

export const semanticParamsSchema = Type.Object({
  query: Type.String({ description: "自然语言问题，1-200 字最佳，如「Transformer 注意力机制如何工作？」" }),
  top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "返回片段条数上限 1-100，默认 10；同一篇论文最多给约 3 个片段" })),
  mode: Type.Optional(
    StringEnum(["fast", "balanced", "quality"] as const, {
      description: "fast=纯关键词召回(~200ms)；balanced=混合检索(~600ms，默认)；quality=LLM 改写+混合(~2-4s，适合探索性长问题)",
    })
  ),
  source_types: Type.Optional(Type.Array(StringEnum(["web", "pdf"] as const), { description: "限定原文来源类型，默认不限" })),
  filters: Type.Optional(semanticFiltersSchema),
});
export type SemanticParams = Static<typeof semanticParamsSchema>;

/* ------------------------------ sciverse_read_content ------------------------------ */

export const contentParamsSchema = Type.Object({
  doc_id: Type.String({
    description: "文献全文 ID（sha256），来自 sciverse_search_papers 或 sciverse_semantic_search 的 doc_id；没有 doc_id 的文献无全文",
  }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "起始字节偏移，来自上一次返回的 next_offset 或片段命中的 offset，默认 0" })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 16384, description: "单次请求字节数 1-16384（服务端上限），默认 8192" })
  ),
  max_bytes: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 49152,
      description: "本次工具调用累计读取的字节上限（自动连续请求，每 16KB 消耗一次接口配额），默认等于 limit",
    })
  ),
});
export type ContentParams = Static<typeof contentParamsSchema>;

/* ------------------------------ sciverse_paper_relations ------------------------------ */

export const relationsParamsSchema = Type.Object({
  unique_id: Type.String({ description: "目标论文 unique_id（如 paper:10.1038/xxx），来自 sciverse_search_papers / sciverse_semantic_search；勿传 doc_id" }),
  relation: StringEnum(["CITATIONS", "REFERENCES", "RELATED_WORKS"] as const, {
    description:
      "CITATIONS=被引（谁引用了我）；REFERENCES=参考文献（我引用了谁）；RELATED_WORKS=相关工作。注意 CITATIONS 与 REFERENCES 方向相反",
  }),
  page: Type.Optional(Type.Integer({ minimum: 1, description: "页码，从 1 开始，默认 1" })),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "每页条数 1-200，默认 25" })),
});
export type RelationsParams = Static<typeof relationsParamsSchema>;

/* ------------------------------ sciverse_catalog ------------------------------ */

export const catalogParamsSchema = Type.Object({
  collection: Type.Optional(
    StringEnum(["papers", "authors", "sources"] as const, { description: "字段目录所属集合，默认 papers" })
  ),
  include_sample_values: Type.Optional(
    Type.Boolean({ description: "是否返回枚举型字段的取值样本（top-20，服务端缓存 24h）。字段名不确定时建议打开" })
  ),
  include_field_stats: Type.Optional(
    Type.Boolean({ description: "是否返回字段统计（基数 + 数值 min/max/avg/p50/p95，服务端缓存 24h）" })
  ),
});
export type CatalogParams = Static<typeof catalogParamsSchema>;

/* ------------------------------ sciverse_get_resource ------------------------------ */

export const resourceParamsSchema = Type.Object({
  file_name: Type.String({
    description: "图片相对路径，取自 read_content 返回的 Markdown 中 `![alt](file_name)` 的 url 段，如 dt=xxx/p/f3.png；禁止 `\\` 与 `..`",
  }),
});
export type ResourceParams = Static<typeof resourceParamsSchema>;
