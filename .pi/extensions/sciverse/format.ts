/**
 * sciverse 扩展 —— 结果格式化
 *
 * 把接口返回的 JSON 转成模型直接可读的紧凑文本：论文列表、原文片段、引用关系、
 * 字段目录、原文片段文本。原则：
 *  - 每条记录都给出「下一步要用的 ID」（unique_id / doc_id / offset），减少模型猜参数；
 *  - 摘要、片段这类长文本做字数裁剪，避免一次调用吃掉整个上下文；
 *  - 命中数、翻页游标、配额消耗等信息放在头部，方便模型决定是否继续翻页。
 *
 * 消费方：index.ts 的六个工具。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import type {
  CatalogResponse,
  FieldCatalogEntry,
  PaperMetadata,
  PaperRelationsResponse,
  SearchPapersResponse,
  SemanticSearchResponse,
} from "./types.ts";

/* ------------------------------ 裁剪常量 ------------------------------ */

/** 单条摘要保留字数 */
const ABSTRACT_MAX_CHARS = 600;

/** 单个语义片段保留字数 */
const CHUNK_MAX_CHARS = 2400;

/** 作者最多列出人数 */
const AUTHORS_MAX_SHOWN = 5;

/** 关键词最多列出个数 */
const KEYWORDS_MAX_SHOWN = 6;

/** 通用记录最多列出字段数 */
const GENERIC_FIELDS_MAX = 12;

/** catalog 详细渲染的字段上限（可过滤字段） */
const CATALOG_DETAIL_MAX = 200;

/* ------------------------------ 基础工具 ------------------------------ */

/** 压缩空白并截断 */
export function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}

/** 作者列表 → 「A; B; C（共 N 人）」 */
function formatAuthors(author: unknown): string | undefined {
  if (!Array.isArray(author) || author.length === 0) return undefined;

  const names = author
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const name = (item as { name?: unknown }).name;
        if (typeof name === "string" && name.trim()) return name.trim();
      }
      return undefined;
    })
    .filter((name): name is string => Boolean(name));

  if (names.length === 0) return undefined;

  const shown = names.slice(0, AUTHORS_MAX_SHOWN).join("; ");
  const suffix = names.length > AUTHORS_MAX_SHOWN ? `（共 ${names.length} 人）` : "";
  return `${shown}${suffix}`;
}

/** 值 → 单行文本（数组用逗号串起，对象转 JSON） */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    const items = value.map((item) => formatScalar(item)).filter(Boolean);
    return items.slice(0, 8).join(", ") + (items.length > 8 ? " …" : "");
  }
  if (typeof value === "object") return clip(JSON.stringify(value), 160);
  return String(value);
}

/* ------------------------------ 检索结果 ------------------------------ */

/** OA 状态 → 短标记 */
function oaMark(paper: PaperMetadata): string | undefined {
  const status = paper.access_is_oa ?? paper.access_oa_status;
  if (status === "true" || status === "oa" || status === "gold" || status === "green" || status === "hybrid") return "OA";
  if (status === "false" || status === "closed") return undefined;
  return undefined;
}

/** 单篇论文 → 多行文本 */
function formatPaper(paper: PaperMetadata, index: number): string {
  const lines: string[] = [];

  const title = paper.title?.trim() || "(无标题)";
  lines.push(`[${index}] ${title}`);

  const meta: string[] = [];
  if (typeof paper.publication_published_year === "number") meta.push(String(Math.round(paper.publication_published_year)));
  if (paper.metadata_type) meta.push(paper.metadata_type);
  if (paper.type?.length) meta.push(paper.type.join("/"));
  if (paper.language) meta.push(paper.language);
  if (meta.length > 0) lines.push(`    ${meta.join(" · ")}`);

  const venue = paper.publication_venue_name_unified;
  if (venue) lines.push(`    载体: ${venue}`);

  const metrics: string[] = [];
  if (typeof paper.citation_count === "number") metrics.push(`被引 ${Math.round(paper.citation_count)}`);
  if (typeof paper.fwci === "number") metrics.push(`FWCI ${paper.fwci.toFixed(2)}`);
  if (typeof paper.reference_count === "number") metrics.push(`参考文献 ${Math.round(paper.reference_count)}`);
  const oa = oaMark(paper);
  if (oa) metrics.push(oa);
  if (paper.doi) metrics.push(`DOI ${paper.doi}`);
  if (metrics.length > 0) lines.push(`    ${metrics.join(" ｜ ")}`);

  const ids: string[] = [];
  if (paper.unique_id) ids.push(`unique_id: ${paper.unique_id}`);
  if (typeof paper.relevance_score === "number") ids.push(`相关度 ${paper.relevance_score.toFixed(1)}`);
  if (ids.length > 0) lines.push(`    ${ids.join(" ｜ ")}`);

  const authors = formatAuthors(paper.author);
  if (authors) lines.push(`    作者: ${authors}`);

  if (paper.doc_id) {
    // 实测：元数据标记 is_content_accessible=false 的 doc_id 也可能读到全文，所以不阻断，只标注
    const readable = paper.is_content_accessible === false ? "（元数据标记不可读，可试读）" : "（可读全文）";
    lines.push(`    doc_id: ${paper.doc_id}${readable}`);
  } else {
    lines.push("    全文: 无 doc_id，只有元数据");
  }

  const abstract = typeof paper.abstract === "string" ? paper.abstract.trim() : "";
  if (abstract) {
    lines.push(`    摘要: ${clip(abstract, ABSTRACT_MAX_CHARS)}`);
  } else if (paper.keywords?.length) {
    lines.push(`    关键词: ${paper.keywords.slice(0, KEYWORDS_MAX_SHOWN).join(", ")}`);
  }

  return lines.join("\n");
}

/** 非 papers 集合（authors / sources）→ 通用键值渲染 */
function formatGenericRecord(record: Record<string, unknown>, index: number): string {
  const lines: string[] = [];

  const label =
    (typeof record.display_name === "string" && record.display_name) ||
    (typeof record.title === "string" && record.title) ||
    (typeof record.name === "string" && record.name) ||
    (typeof record.id === "string" && record.id) ||
    "(无名称)";
  lines.push(`[${index}] ${label}`);

  const skip = new Set(["display_name", "id", "relevance_score", "locations"]);
  const entries = Object.entries(record).filter(([key, value]) => {
    if (skip.has(key)) return false;
    if (value === null || value === undefined) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === "string" && !value.trim()) return false;
    return true;
  });

  for (const [key, value] of entries.slice(0, GENERIC_FIELDS_MAX)) {
    const text = clip(formatScalar(value), 200);
    if (text) lines.push(`    ${key}: ${text}`);
  }
  if (entries.length > GENERIC_FIELDS_MAX) {
    lines.push(`    …（另有 ${entries.length - GENERIC_FIELDS_MAX} 个字段）`);
  }

  if (typeof record.relevance_score === "number") lines.push(`    相关度: ${record.relevance_score.toFixed(1)}`);
  return lines.join("\n");
}

/** 结构化检索结果 → 模型可读文本 */
export function formatSearchResults(
  payload: SearchPapersResponse,
  collection: string,
  fromCache: boolean,
): string {
  const results = (payload.results ?? []) as PaperMetadata[];

  if (results.length === 0) {
    return [
      `sciverse 检索无命中（collection=${collection}）。`,
      "建议：换关键词或放宽过滤条件（作者名用姓氏、期刊名用规范化全名、年份区间放大）；",
      "字段名不确定时先调 sciverse_catalog 确认可用字段与取值。",
    ].join("\n");
  }

  const header: string[] = [];
  const total = payload.total_count ?? results.length;
  const page = payload.page ?? 1;
  const pageSize = payload.page_size ?? results.length;
  const totalPages = payload.total_pages ?? (total ? Math.ceil(total / pageSize) : undefined);

  header.push(
    `命中 ${total}${total >= 10_000 ? "+" : ""} 条 ｜ 第 ${page}${totalPages ? `/${totalPages}` : ""} 页 ｜ 本页 ${
      results.length
    } 条${fromCache ? " ｜ 会话缓存命中" : ""}${total >= 10_000 ? "（服务端上限 10000，需精确值请缩小条件）" : ""}`,
  );
  if (typeof payload.search_time_ms === "number") header.push(`检索耗时 ${payload.search_time_ms.toFixed(0)}ms`);
  if (payload.response_tokens !== undefined) header.push(`输出约 ${payload.response_tokens} tokens`);
  if (payload.next_cursor) header.push(`下一页游标（传 cursor 参数）: ${payload.next_cursor}`);
  header.push("提示：unique_id 用于 sciverse_paper_relations；doc_id 非空表示可读全文，用 sciverse_read_content");

  const blocks = results.map((paper, index) =>
    collection === "papers" || paper.title ? formatPaper(paper, index + 1) : formatGenericRecord(paper, index + 1),
  );

  return `${header.join(" ｜ ")}\n\n${blocks.join("\n\n")}`;
}

/* ------------------------------ 语义检索片段 ------------------------------ */

/** 语义检索结果 → 模型可读文本 */
export function formatSemanticHits(payload: SemanticSearchResponse, mode: string, fromCache: boolean): string {
  const hits = payload.hits ?? [];

  if (hits.length === 0) {
    return [
      "sciverse 语义检索无命中。",
      "建议：把问题写得更具体（现象 + 方法 + 对象），或把 mode 换成 quality 让服务端先改写查询；",
      "若加了 filters，注意过滤是软约束且可能过窄，可先去掉再试。",
    ].join("\n");
  }

  const header = `命中 ${hits.length} 个原文片段 ｜ mode=${mode}${fromCache ? " ｜ 会话缓存命中" : ""}`;
  const tip = "下一步：用 sciverse_read_content 按 doc_id + offset 读该片段的上下文原文，再作答并附标题/DOI";

  const blocks = hits.map((hit, index) => {
    const lines: string[] = [];
    const score = typeof hit.score === "number" ? hit.score.toFixed(3) : "-";
    lines.push(`[${index + 1}] score ${score} ｜ doc_id ${hit.doc_id} ｜ offset ${hit.offset ?? 0}`);
    if (hit.title) lines.push(`    ${clip(hit.title, 200)}`);
    if (hit.source_type || hit.page_no !== undefined) {
      const meta = [hit.source_type, hit.page_no !== undefined ? `第 ${hit.page_no} 页` : undefined].filter(Boolean);
      if (meta.length) lines.push(`    ${meta.join(" ｜ ")}`);
    }
    const chunk = typeof hit.chunk === "string" ? hit.chunk.trim() : "";
    if (chunk) lines.push(`    片段: ${clip(chunk, CHUNK_MAX_CHARS)}`);
    else if (hit.abstract) lines.push(`    摘要: ${clip(hit.abstract, ABSTRACT_MAX_CHARS)}`);
    lines.push(`    完整 doc_id: ${hit.doc_id}`);
    return lines.join("\n");
  });

  return `${header}\n${tip}\n\n${blocks.join("\n\n")}`;
}

/* ------------------------------ 引用关系 ------------------------------ */

const RELATION_LABEL: Record<string, string> = {
  CITATIONS: "被引（谁引用了这篇）",
  REFERENCES: "参考文献（这篇引用了谁）",
  RELATED_WORKS: "相关工作",
};

/** 引用关系 → 模型可读文本 */
export function formatRelations(
  payload: PaperRelationsResponse,
  uniqueId: string,
  relation: string,
  fromCache: boolean,
): string {
  const items = payload.items ?? [];
  const label = RELATION_LABEL[relation] ?? relation;
  const total = payload.total_count ?? items.length;
  const page = payload.page ?? 1;
  const pageSize = payload.page_size ?? (items.length || 1);
  const totalPages = payload.total_pages ?? Math.ceil(total / pageSize);

  if (items.length === 0) {
    return `${label} ｜ ${uniqueId}：本页无条目（total_count=${total}）。若 total_count 为 0，说明库内没有该方向的记录。`;
  }

  const header = `${label} ｜ ${uniqueId} ｜ 共 ${total} 条 ｜ 第 ${page}/${totalPages} 页（每页 ${pageSize}）${
    fromCache ? " ｜ 会话缓存命中" : ""
  }`;
  const tip = "提示：想拿这些论文的摘要/全文，用 sciverse_search_papers 按 unique_id 或 DOI 反查；深翻页（>10000）改用 filters_advanced 的 references_unique_id";

  const blocks = items.map((item, index) => {
    const id = item.id ?? "(无 ID)";
    const kind = item.id_type ? ` [${item.id_type}]` : "";
    return `[${index + 1}] ${id}${kind}\n    ${clip(item.title ?? "(无标题)", 220)}`;
  });

  return `${header}\n${tip}\n\n${blocks.join("\n\n")}`;
}

/* ------------------------------ 字段目录 ------------------------------ */

/** 单个字段 → 紧凑一行 */
function formatFieldEntry(entry: FieldCatalogEntry): string {
  const flags: string[] = [];
  if (entry.filterable) flags.push("过滤");
  if (entry.sortable) flags.push("排序");
  if (entry.searchable) flags.push("全文");
  if (entry.default_returned) flags.push("默认返回");

  let line = `· ${entry.name} (${entry.type})${flags.length ? ` [${flags.join("/")}]` : ""}`;
  if (entry.description) line += ` — ${clip(entry.description, 160)}`;
  if (entry.sample_values?.length) {
    line += `\n    样本值: ${entry.sample_values.slice(0, 12).join(", ")}`;
  }
  if (entry.operators?.length) line += `\n    操作符: ${entry.operators.join(", ")}`;
  return line;
}

/** 字段目录 → 模型可读文本 */
export function formatCatalog(payload: CatalogResponse, collection: string, fromCache: boolean): string {
  const fields = payload.fields ?? [];

  if (fields.length === 0) {
    return `sciverse 字段目录为空（collection=${collection}）。可换 papers / authors / sources 再试。`;
  }

  const filterable = fields.filter((field) => field.filterable);
  const others = fields.filter((field) => !field.filterable);

  const header: string[] = [
    `${collection} 字段目录：共 ${fields.length} 个字段（可过滤 ${filterable.length}）${fromCache ? " ｜ 会话缓存命中" : ""}`,
  ];
  if (payload.filter_operators?.length) {
    const operators = payload.filter_operators.map((op) => (op.startsWith("FILTER_OP_") ? op : `FILTER_OP_${op}`));
    header.push(`FilterOperator: ${operators.join(", ")}`);
  }
  if (payload.default_fields?.length) {
    header.push(`默认返回字段（${payload.default_fields.length}）: ${payload.default_fields.join(", ")}`);
  }

  const detailed = filterable.slice(0, CATALOG_DETAIL_MAX).map(formatFieldEntry);
  const sections: string[] = [`## 可过滤 / 可排序字段\n${detailed.join("\n")}`];

  if (others.length > 0) {
    const names = others.map((field) => `${field.name}(${field.type})`);
    sections.push(`## 其余字段（不可过滤，仅供投影 fields）\n${names.join(", ")}`);
  }

  return `${header.join("\n")}\n\n${sections.join("\n\n")}`;
}

/* ------------------------------ 原文 ------------------------------ */

/** 原文片段 → 模型可读文本（正文 + 续读提示） */
export function formatContent(
  result: { text: string; startOffset: number; endOffset: number; bytes: number; more: boolean; nextOffset?: number },
  docId: string,
): string {
  const text = result.text;

  if (!text.trim()) {
    return `offset ${result.startOffset} 处没有返回文本（可能已到文末，或该区间为空白）。doc_id: ${docId}`;
  }

  const footer: string[] = [
    `[已返回 ${result.bytes} 字节 ｜ 字节区间 [${result.startOffset}, ${result.endOffset}) ｜ 还有后续: ${result.more}]`,
  ];
  if (result.more && result.nextOffset !== undefined) {
    // 服务端按内容块边界续读，next_offset 可能大于 end_offset（跳过少量字节）
    const gap = result.nextOffset - result.endOffset;
    if (gap > 0) footer.push(`（服务端按内容块续读，下一段从 ${result.nextOffset} 开始，中间跳过 ${gap} 字节）`);
    footer.push(`继续读下一段: sciverse_read_content(doc_id="${docId}", offset=${result.nextOffset}, limit=16384, max_bytes=49152)`);
    footer.push(`（正文中的 ![alt](file_name) 是图片占位，可用 sciverse_get_resource 取图）`);
  } else {
    footer.push("已到原文末尾。");
  }

  return `${text}\n\n---\n${footer.join("\n")}`;
}
