/**
 * sciverse 扩展 —— Sciverse HTTP 客户端
 *
 * 封装六个只读接口（均需 Authorization: Bearer <Token>）：
 *  - POST /meta-search            结构化元数据检索（BM25 + 过滤 + 排序）
 *  - POST /agentic-search         自然语言语义检索，返回原文片段（RAG）
 *  - POST /meta-paper-relations   引用 / 被引 / 相关工作列表
 *  - GET  /meta-catalog           字段目录（可过滤 / 可排序 / 枚举样本）
 *  - GET  /content                按字节区间读原文
 *  - GET  /resource               取原文中的图片（Figure / Table）
 *
 * 三件事在这里统一处理：
 *  1. 客户端限流：服务端每接口 30 次/分钟，本地滑窗计数，超额先等（可配置上限）再发，
 *     避免把配额打爆成 429；
 *  2. 会话级缓存：catalog / content / 检索结果在会话内缓存，重复调用不再消耗配额；
 *  3. 错误翻译：401 / 404 / 429 / 5xx 与 biz_code 统一转成中文可执行提示。
 *
 * 消费方：index.ts 的六个工具与 /sciverse 命令。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import type { SciverseConfig } from "./config.ts";
import { clampContentLimit, requireToken } from "./config.ts";
import type {
  ApiErrorBody,
  CatalogResponse,
  PaperRelationsResponse,
  ReadContentResponse,
  SearchParams,
  SearchPapersResponse,
  SemanticParams,
  SemanticSearchResponse,
} from "./types.ts";

/* ------------------------------ 常量 ------------------------------ */

/** 限流窗口 */
const RATE_WINDOW_MS = 60_000;

/** 网络抖动 / 5xx / FETCH_FAILED 的重试次数 */
const RETRY_TIMES = 1;

/** 重试间隔（毫秒） */
const RETRY_DELAY_MS = 800;

/** 缓存容量 */
const CONTENT_CACHE_MAX = 64;
const CATALOG_CACHE_MAX = 8;
const SEARCH_CACHE_MAX = 48;

/** 与 SDK 对齐的来源标识，便于服务端归因 */
const CLIENT_SOURCE = `pi-extension-${process.platform}`;

/* ------------------------------ 错误类型 ------------------------------ */

/** 带 HTTP 状态与业务码的错误，便于上层区分处理 */
export class SciverseError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "SciverseError";
    this.status = options.status;
    this.code = options.code;
  }
}

/* ------------------------------ 会话级缓存 ------------------------------ */

/** 简单 LRU：取用即刷新，超出容量淘汰最旧 */
class LruCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly max: number) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: T): void {
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

const contentCache = new LruCache<ReadContentResponse>(CONTENT_CACHE_MAX);
const catalogCache = new LruCache<CatalogResponse>(CATALOG_CACHE_MAX);
const searchCache = new LruCache<unknown>(SEARCH_CACHE_MAX);

/** 清空所有会话级缓存（session_start / 重载时调用） */
export function clearSciverseCaches(): void {
  contentCache.clear();
  catalogCache.clear();
  searchCache.clear();
}

/** 当前缓存条目数，用于 /sciverse 状态展示 */
export function cacheStats(): { content: number; catalog: number; search: number } {
  return { content: contentCache.size, catalog: catalogCache.size, search: searchCache.size };
}

/* ------------------------------ 客户端限流 ------------------------------ */

/** 每个接口的请求时间戳（滑窗计数） */
const quotaLog = new Map<string, number[]>();

/** 可中断的 sleep */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new SciverseError("请求已被取消"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 领取一次接口配额。同步完成「计数 + 占位」保证并发安全；
 * 配额满时等待窗口滑动，超过 maxWaitMs 直接报错。
 */
async function acquireQuota(
  cfg: SciverseConfig,
  endpoint: string,
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();

    const now = Date.now();
    const stamps = (quotaLog.get(endpoint) ?? []).filter((at) => now - at < RATE_WINDOW_MS);

    if (stamps.length < cfg.rateLimitPerMin) {
      stamps.push(now);
      quotaLog.set(endpoint, stamps);
      return;
    }

    const waitMs = Math.max(50, stamps[0] + RATE_WINDOW_MS - now + 20);
    if (waitMs > cfg.maxWaitMs) {
      throw new SciverseError(
        `接口 ${endpoint} 已达本地配额上限（${cfg.rateLimitPerMin} 次/分钟），约 ${Math.ceil(waitMs / 1000)} 秒后可用。` +
          "可稍后重试，或调大 SCIVERSE_MAX_WAIT_MS / 申请更高配额",
      );
    }

    onWait?.({ endpoint, waitMs });
    await sleep(waitMs, signal);
  }
}

/* ------------------------------ 请求底座 ------------------------------ */

interface RequestOptions {
  method: "GET" | "POST";
  /** 接口路径，如 /meta-search */
  path: string;
  /** 限流键（接口名），如 meta-search */
  endpoint: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  onWait?: (info: { endpoint: string; waitMs: number }) => void;
}

/** 从错误响应体里抽出可读信息（兼容两种错误形态） */
function describeErrorBody(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object") return {};
  const parsed = body as ApiErrorBody;
  if (parsed.error && typeof parsed.error === "object") {
    return { code: parsed.error.code, message: parsed.error.message };
  }
  return { code: typeof parsed.code === "string" ? parsed.code : undefined, message: parsed.message };
}

/** 把 HTTP 状态 + 业务码翻译成中文提示 */
function toApiError(status: number, rawBody: string, cfg: SciverseConfig): SciverseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = undefined;
  }

  const { code, message } = describeErrorBody(parsed);
  const detail = (message ?? rawBody).trim().slice(0, 300) || "(无响应体)";

  if (status === 401 || status === 403) {
    return new SciverseError(
      `Sciverse 认证失败（${status}）：${detail}。请检查 SCIVERSE_API_TOKEN 是否为 https://sciverse.space 上申请的有效 Token`,
      { status, code },
    );
  }
  if (status === 404) {
    const hint =
      code === "CONTENT_NOT_FOUND"
        ? "该 doc_id 无全文或当前账号无权读取；用 sciverse_search_papers 确认 is_content_accessible 后再调用 sciverse_read_content"
        : "对象不存在，请确认参数";
    return new SciverseError(`Sciverse 未找到资源（404）：${detail}。${hint}`, { status, code });
  }
  if (status === 429) {
    return new SciverseError(
      `Sciverse 触发服务端限流（429）：${detail}。每接口 30 次/分钟（未配置时），稍后重试或减少调用`,
      { status, code },
    );
  }
  if (status === 400) {
    return new SciverseError(`Sciverse 参数不合法（400）：${detail}`, { status, code });
  }
  if (status === 502 || status === 503 || status >= 500) {
    return new SciverseError(`Sciverse 服务端暂时不可用（${status}）：${detail}。稍后重试`, { status, code });
  }
  return new SciverseError(`Sciverse 返回 ${status}（${cfg.baseUrl}）：${detail}`, { status, code });
}

/** 判断响应体是否携带业务错误（200 也可能带 error/biz_code） */
function detectBizError(parsed: unknown): { code?: string; message?: string } | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const body = parsed as ApiErrorBody & { biz_code?: number };
  if (body.error && typeof body.error === "object") {
    return { code: body.error.code, message: body.error.message };
  }
  if (typeof body.code === "string" && body.code !== "SUCCESS") {
    return { code: body.code, message: body.message };
  }
  if (typeof body.biz_code === "number" && body.biz_code !== 0) {
    return { code: body.code, message: body.message };
  }
  return undefined;
}

/** 网络类错误是否值得重试 */
function isRetryable(error: unknown): boolean {
  if (error instanceof SciverseError) {
    if (error.status !== undefined) return error.status >= 500;
    return error.code === "FETCH_FAILED" || error.code === "CONTENT_FETCH_FAILED";
  }
  // fetch 抛出的网络错误（DNS / 连接重置 / 超时）
  return error instanceof Error && !/取消|abort/i.test(error.message);
}

/** 发起一次 JSON 请求（含限流、重试与错误翻译） */
async function requestJson<T>(cfg: SciverseConfig, options: RequestOptions): Promise<T> {
  const token = requireToken(cfg);
  const url = new URL(`${cfg.baseUrl}${options.path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_TIMES; attempt += 1) {
    await acquireQuota(cfg, options.endpoint, options.signal, options.onWait);

    const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
    const combined = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          "x-sciverse-source": CLIENT_SOURCE,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combined,
      });

      const rawBody = await response.text();

      if (!response.ok) {
        const error = toApiError(response.status, rawBody, cfg);
        if (attempt < RETRY_TIMES && isRetryable(error)) {
          lastError = error;
          await sleep(RETRY_DELAY_MS, options.signal);
          continue;
        }
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        throw new SciverseError(`Sciverse 返回了非 JSON 响应（${options.path}）：${rawBody.slice(0, 200)}`, {
          status: response.status,
        });
      }

      // 200 也可能带业务错误（如 FETCH_FAILED）
      const bizError = detectBizError(parsed);
      if (bizError) {
        const error = new SciverseError(`Sciverse 业务错误${bizError.code ? `（${bizError.code}）` : ""}：${bizError.message ?? "未知原因"}`, {
          status: response.status,
          code: bizError.code,
        });
        if (attempt < RETRY_TIMES && isRetryable(error)) {
          lastError = error;
          await sleep(RETRY_DELAY_MS, options.signal);
          continue;
        }
        throw error;
      }

      return parsed as T;
    } catch (error) {
      if (options.signal?.aborted) throw new SciverseError("请求已被取消");
      if (timeoutSignal.aborted) {
        throw new SciverseError(`Sciverse 请求超时（${cfg.timeoutMs} ms），可用 SCIVERSE_TIMEOUT_MS 调大上限；quality 语义检索较慢`);
      }
      if (error instanceof SciverseError) {
        if (attempt < RETRY_TIMES && isRetryable(error)) {
          lastError = error;
          await sleep(RETRY_DELAY_MS, options.signal);
          continue;
        }
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      const networkError = new SciverseError(`无法访问 Sciverse（${cfg.baseUrl}）：${reason}`);
      if (attempt < RETRY_TIMES) {
        lastError = networkError;
        await sleep(RETRY_DELAY_MS, options.signal);
        continue;
      }
      throw networkError;
    }
  }

  throw lastError instanceof Error ? lastError : new SciverseError("Sciverse 请求失败");
}

/* ------------------------------ /meta-search ------------------------------ */

interface AdvancedFilter {
  field: string;
  operator?: string;
  value: unknown;
}

interface AdvancedSort {
  field: string;
  order?: string;
}

/**
 * 把工具的便捷参数翻译成后端 payload（与官方 SDK toBackendPayload 行为一致）：
 * 便捷过滤 → filters[]；sort_by_year=auto 在「有 query」时保持相关性排序。
 */
export function buildSearchPayload(params: SearchParams, cfg: SciverseConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  const passthrough: Array<keyof SearchParams> = [
    "query",
    "page",
    "page_size",
    "fields",
    "collection",
    "cursor",
    "freshness_boost",
    "impact_boost",
    "language_affinity",
  ];
  for (const key of passthrough) {
    const value = params[key];
    if (value !== undefined && value !== null) payload[key] = value;
  }

  const filters: AdvancedFilter[] = [];
  if (params.title_contains) filters.push({ field: "title", operator: "FILTER_OP_CONTAINS", value: params.title_contains });
  if (params.abstract_contains) filters.push({ field: "abstract", operator: "FILTER_OP_CONTAINS", value: params.abstract_contains });
  if (params.authors?.length) filters.push({ field: "author", operator: "FILTER_OP_IN", value: params.authors });
  if (params.year_from !== undefined) {
    filters.push({ field: "publication_published_year", operator: "FILTER_OP_GTE", value: params.year_from });
  }
  if (params.year_to !== undefined) {
    filters.push({ field: "publication_published_year", operator: "FILTER_OP_LTE", value: params.year_to });
  }
  if (params.journals?.length) {
    filters.push({ field: "publication_venue_name_unified", operator: "FILTER_OP_IN", value: params.journals });
  }
  if (params.subjects?.length) filters.push({ field: "subjects", operator: "FILTER_OP_IN", value: params.subjects });
  if (params.doi) filters.push({ field: "doi", operator: "FILTER_OP_EQ", value: params.doi });
  for (const item of params.filters_advanced ?? []) {
    filters.push({ field: item.field, operator: item.operator ?? "FILTER_OP_EQ", value: item.value });
  }
  if (filters.length > 0) payload.filters = filters;

  // sort_by_year 默认 auto：有 query / sort_advanced 时不加年份排序（保 BM25 相关性 + 软加权可用）
  let sortByYear = params.sort_by_year ?? "auto";
  if (sortByYear === "auto") {
    sortByYear = params.query || params.sort_advanced?.length ? "none" : "desc";
  }

  const sort: AdvancedSort[] = [];
  if (sortByYear !== "none") {
    sort.push({
      field: "publication_published_year",
      order: sortByYear === "asc" ? "SORT_ORDER_ASC" : "SORT_ORDER_DESC",
    });
  }
  for (const item of params.sort_advanced ?? []) {
    sort.push({ field: item.field, order: item.order ?? "SORT_ORDER_DESC" });
  }
  if (sort.length > 0) payload.sort = sort;

  // unique_id 是引用关系查询的钥匙，fields 投影时自动补上
  if (Array.isArray(params.fields) && params.fields.length > 0 && !params.fields.includes("unique_id")) {
    payload.fields = [...params.fields, "unique_id"];
  }

  payload.page = params.page ?? 1;
  payload.page_size = params.page_size ?? cfg.defaultPageSize;

  return payload;
}

export interface SearchPapersResult {
  payload: SearchPapersResponse;
  fromCache: boolean;
  /** 实际发给服务端的请求体，便于排查 */
  request: Record<string, unknown>;
}

/** 结构化元数据检索 */
export async function searchPapers(
  cfg: SciverseConfig,
  params: SearchParams,
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<SearchPapersResult> {
  const body = buildSearchPayload(params, cfg);
  const cacheKey = JSON.stringify(body);

  const cached = searchCache.get(cacheKey) as SearchPapersResponse | undefined;
  if (cached) return { payload: cached, fromCache: true, request: body };

  const payload = await requestJson<SearchPapersResponse>(cfg, {
    method: "POST",
    path: "/meta-search",
    endpoint: "meta-search",
    body,
    signal,
    onWait,
  });

  searchCache.set(cacheKey, payload);
  return { payload, fromCache: false, request: body };
}

/* ------------------------------ /agentic-search ------------------------------ */

/** 上游没有 mode 字段，需在客户端翻译成 retrieval / sub_queries */
const SEMANTIC_MODE_MAP: Record<string, Record<string, unknown>> = {
  fast: { retrieval: "es" },
  balanced: { retrieval: "hybrid" },
  quality: { retrieval: "hybrid", sub_queries: 3 },
};

export interface SemanticSearchResult {
  payload: SemanticSearchResponse;
  fromCache: boolean;
  mode: string;
}

/** 自然语言语义检索（RAG 片段） */
export async function semanticSearch(
  cfg: SciverseConfig,
  params: SemanticParams,
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<SemanticSearchResult> {
  const mode = params.mode ?? "balanced";

  const body: Record<string, unknown> = {
    query: params.query,
    top_k: params.top_k ?? cfg.defaultPageSize,
    ...SEMANTIC_MODE_MAP[mode],
  };
  if (params.source_types?.length) body.source_types = params.source_types;
  if (params.filters && Object.keys(params.filters).length > 0) body.filters = params.filters;

  const cacheKey = JSON.stringify(body);
  const cached = searchCache.get(cacheKey) as SemanticSearchResponse | undefined;
  if (cached) return { payload: cached, fromCache: true, mode };

  const payload = await requestJson<SemanticSearchResponse>(cfg, {
    method: "POST",
    path: "/agentic-search",
    endpoint: "agentic-search",
    body,
    signal,
    onWait,
  });

  searchCache.set(cacheKey, payload);
  return { payload, fromCache: false, mode };
}

/* ------------------------------ /meta-catalog ------------------------------ */

export interface CatalogResult {
  payload: CatalogResponse;
  fromCache: boolean;
}

/** 字段目录（字段名 / 能否过滤排序 / 枚举样本） */
export async function listCatalog(
  cfg: SciverseConfig,
  params: { collection?: string; include_sample_values?: boolean; include_field_stats?: boolean },
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<CatalogResult> {
  const collection = params.collection ?? "papers";
  const cacheKey = `${collection}|${Boolean(params.include_sample_values)}|${Boolean(params.include_field_stats)}`;

  const cached = catalogCache.get(cacheKey);
  if (cached) return { payload: cached, fromCache: true };

  const payload = await requestJson<CatalogResponse>(cfg, {
    method: "GET",
    path: "/meta-catalog",
    endpoint: "meta-catalog",
    query: {
      collection,
      include_sample_values: Boolean(params.include_sample_values),
      // 字段统计会触发聚合，仅在显式要求时才带上去
      ...(params.include_field_stats ? { include_field_stats: true } : {}),
    },
    signal,
    onWait,
  });

  // 字段统计是可选附注，缓存按「是否含统计」区分
  catalogCache.set(cacheKey, payload);
  return { payload, fromCache: false };
}

/* ------------------------------ /meta-paper-relations ------------------------------ */

export interface RelationsResult {
  payload: PaperRelationsResponse;
  fromCache: boolean;
}

/** 引用关系分页列表 */
export async function listPaperRelations(
  cfg: SciverseConfig,
  params: { unique_id: string; relation: string; page?: number; page_size?: number },
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<RelationsResult> {
  const body = {
    unique_id: params.unique_id,
    relation: params.relation,
    page: params.page ?? 1,
    page_size: params.page_size ?? 25,
  };
  const cacheKey = JSON.stringify(body);

  const cached = searchCache.get(cacheKey) as PaperRelationsResponse | undefined;
  if (cached) return { payload: cached, fromCache: true };

  const payload = await requestJson<PaperRelationsResponse>(cfg, {
    method: "POST",
    path: "/meta-paper-relations",
    endpoint: "meta-paper-relations",
    body,
    signal,
    onWait,
  });

  searchCache.set(cacheKey, payload);
  return { payload, fromCache: false };
}

/* ------------------------------ /content ------------------------------ */

/** 读取单段原文（带缓存），offset + limit 定位字节区间 */
async function readContentChunk(
  cfg: SciverseConfig,
  docId: string,
  offset: number,
  limit: number,
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<{ payload: ReadContentResponse; fromCache: boolean }> {
  const cacheKey = `${docId}|${offset}|${limit}`;
  const cached = contentCache.get(cacheKey);
  if (cached) return { payload: cached, fromCache: true };

  const payload = await requestJson<ReadContentResponse>(cfg, {
    method: "GET",
    path: "/content",
    endpoint: "content",
    query: { doc_id: docId, offset, limit },
    signal,
    onWait,
  });

  contentCache.set(cacheKey, payload);
  return { payload, fromCache: false };
}

export interface ReadContentRangeResult {
  text: string;
  startOffset: number;
  endOffset: number;
  bytes: number;
  more: boolean;
  nextOffset?: number;
  /** 实际发出的接口请求数（缓存命中不计入） */
  requests: number;
}

/**
 * 按字节预算连续读取原文：单次请求上限 16KB，超过则用 next_offset 续读，
 * 直到达到 maxBytes 或没有更多内容。
 */
export async function readContentRange(
  cfg: SciverseConfig,
  params: { doc_id: string; offset?: number; limit?: number; max_bytes?: number },
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<ReadContentRangeResult> {
  const limit = clampContentLimit(params.limit, cfg.defaultContentLimit);
  const maxBytes = Math.max(limit, Math.min(params.max_bytes ?? cfg.defaultMaxContentBytes, 49_152));

  let offset = Math.max(0, Math.round(params.offset ?? 0));
  const startOffset = offset;
  const parts: string[] = [];
  let bytes = 0;
  let requests = 0;
  let more = false;
  let nextOffset: number | undefined;

  for (;;) {
    signal?.throwIfAborted();

    const remaining = maxBytes - bytes;
    const requestLimit = Math.min(limit, Math.max(1, remaining));

    const { payload, fromCache } = await readContentChunk(cfg, params.doc_id, offset, requestLimit, signal, onWait);
    if (!fromCache) requests += 1;

    const text = payload.text ?? "";
    parts.push(text);
    bytes += Buffer.byteLength(text, "utf-8");

    more = Boolean(payload.more);
    nextOffset = typeof payload.next_offset === "number" ? payload.next_offset : undefined;

    // 服务端没给出下一个偏移、没有更多内容、已达预算，或返回空文本（避免死循环）时收尾
    if (!more || nextOffset === undefined || nextOffset <= offset || bytes >= maxBytes || text.length === 0) {
      if (!more) nextOffset = undefined;
      break;
    }
    offset = nextOffset;
  }

  return {
    text: parts.join(""),
    startOffset,
    endOffset: startOffset + bytes,
    bytes,
    more,
    nextOffset,
    requests,
  };
}

/* ------------------------------ /resource ------------------------------ */

export interface ResourceResult {
  bytes: Uint8Array;
  mimeType: string;
}

/** 取原文中的图片字节流 */
export async function getResource(
  cfg: SciverseConfig,
  fileName: string,
  signal: AbortSignal | undefined,
  onWait?: (info: { endpoint: string; waitMs: number }) => void,
): Promise<ResourceResult> {
  const token = requireToken(cfg);

  if (!fileName.trim() || fileName.startsWith("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw new SciverseError("file_name 必须是 read_content Markdown 里的相对路径，不能以 / 开头，也不能包含 \\ 或 ..");
  }

  await acquireQuota(cfg, "resource", signal, onWait);

  const url = new URL(`${cfg.baseUrl}/resource`);
  url.searchParams.set("file_name", fileName);

  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "image/*" },
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw new SciverseError("请求已被取消");
    if (timeoutSignal.aborted) throw new SciverseError(`Sciverse 图片请求超时（${cfg.timeoutMs} ms）`);
    const reason = error instanceof Error ? error.message : String(error);
    throw new SciverseError(`无法访问 Sciverse 图片接口（${cfg.baseUrl}）：${reason}`);
  }

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    throw toApiError(response.status, rawBody, cfg);
  }

  const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (!mimeType.startsWith("image/")) {
    throw new SciverseError(`file_name 指向的不是图片（Content-Type: ${mimeType}）：${fileName}`);
  }

  return { bytes, mimeType };
}
