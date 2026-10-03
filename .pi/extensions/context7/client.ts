/**
 * context7 扩展 —— Context7 HTTP 客户端
 *
 * 封装两个只读接口（均需 Authorization: Bearer <API Key>，无 Key 时匿名访问、限额更低）：
 *  - GET /api/v2/libs/search?libraryName=&query=    搜索库，拿到精确 libraryId
 *  - GET /api/v2/context?libraryId=&query=&type=txt 拉取与该问题相关的文档片段
 *
 * 另含一个会话级文档缓存：同样的 (libraryId, query, tokens) 只请求一次，
 * 省 token 也省 Context7 配额；缓存随 session_start 清空。
 *
 * 消费方：index.ts 的两个工具与 /context7 命令。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import type { Context7Config } from "./config.ts";
import type { Context7Library } from "./types.ts";

/* ------------------------------ 常量 ------------------------------ */

/** 会话内文档缓存上限（超出后按插入顺序淘汰最旧条目） */
const CACHE_MAX_ENTRIES = 64;

/** 搜索接口路径 */
const SEARCH_PATH = "/api/v2/libs/search";

/** 文档接口路径 */
const CONTEXT_PATH = "/api/v2/context";

/* ------------------------------ 会话级文档缓存 ------------------------------ */

const docsCache = new Map<string, string>();

/** 清空文档缓存（会话切换 / 重载时调用） */
export function clearDocsCache(): void {
  docsCache.clear();
}

/** 当前缓存条目数 */
export function docsCacheSize(): number {
  return docsCache.size;
}

/** 读缓存并做 LRU 触达 */
function readDocsCache(key: string): string | undefined {
  const hit = docsCache.get(key);
  if (hit === undefined) return undefined;
  docsCache.delete(key);
  docsCache.set(key, hit);
  return hit;
}

/** 写缓存并按上限淘汰最旧条目 */
function writeDocsCache(key: string, text: string): void {
  docsCache.set(key, text);
  while (docsCache.size > CACHE_MAX_ENTRIES) {
    const oldest = docsCache.keys().next().value;
    if (oldest === undefined) break;
    docsCache.delete(oldest);
  }
}

/* ------------------------------ 请求底座 ------------------------------ */

/**
 * 发起一次 GET 请求。
 * 超时与外层 AbortSignal 合并；非 2xx 统一转成可读的中文错误。
 */
async function request(
  cfg: Context7Config,
  path: string,
  query: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const url = new URL(`${cfg.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { accept: "*/*" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw new Error("Context7 请求已被取消");
    if (timeoutSignal.aborted) {
      throw new Error(`Context7 请求超时（${cfg.timeoutMs} ms），可用 CONTEXT7_TIMEOUT_MS 调大上限`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`无法访问 Context7（${cfg.baseUrl}）：${reason}`);
  }

  if (!response.ok) throw await toApiError(response, cfg);
  return response;
}

/** 把非 2xx 响应转成带处理建议的错误 */
async function toApiError(response: Response, cfg: Context7Config): Promise<Error> {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    detail = parsed.message ?? parsed.error ?? detail;
  } catch {
    /* 非 JSON 响应体，直接用原文 */
  }
  detail = detail.trim() || "(无响应体)";

  if (response.status === 401) {
    return new Error(`Context7 认证失败（401）：${detail} 请检查 CONTEXT7_API_KEY 是否为有效的 ctx7sk-… 密钥`);
  }
  if (response.status === 404) {
    return new Error(`Context7 找不到该库（404）：${detail} 请先用 context7_search_library 解析准确的 libraryId`);
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const suffix = retryAfter ? `建议 ${retryAfter} 秒后重试` : "请稍后重试";
    return new Error(`Context7 请求过于频繁（429）：${suffix}，也可配置 API Key 提升配额`);
  }
  if (response.status === 400) {
    return new Error(`Context7 参数不合法（400）：${detail}`);
  }
  return new Error(`Context7 返回 ${response.status}（${cfg.baseUrl}）：${detail}`);
}

/* ------------------------------ 搜索库 ------------------------------ */

export interface SearchLibrariesResult {
  results: Context7Library[];
}

/** 按库名 / 问题检索候选库，返回按相关性排序的列表 */
export async function searchLibraries(
  cfg: Context7Config,
  params: { libraryName: string; query?: string },
  signal: AbortSignal | undefined,
): Promise<SearchLibrariesResult> {
  const query: Record<string, string> = { libraryName: params.libraryName };
  if (params.query) query.query = params.query;

  const response = await request(cfg, SEARCH_PATH, query, signal);
  const payload = (await response.json()) as { results?: Context7Library[] } | Context7Library[];

  // 兼容两种返回形态：{ results: [...] } 与裸数组
  const results = Array.isArray(payload) ? payload : (payload.results ?? []);
  return { results: results.filter((item) => typeof item?.id === "string" && item.id.length > 0) };
}

/* ------------------------------ 拉取文档 ------------------------------ */

export interface FetchDocsResult {
  text: string;
  fromCache: boolean;
}

/** 拉取与 query 相关的文档片段（txt 形态，直接喂给模型） */
export async function fetchDocs(
  cfg: Context7Config,
  params: { libraryId: string; query: string; tokens: number },
  signal: AbortSignal | undefined,
): Promise<FetchDocsResult> {
  const cacheKey = `${params.libraryId}\u0000${params.query}\u0000${params.tokens}`;
  const cached = readDocsCache(cacheKey);
  if (cached !== undefined) return { text: cached, fromCache: true };

  const response = await request(
    cfg,
    CONTEXT_PATH,
    {
      libraryId: params.libraryId,
      query: params.query,
      type: "txt",
      tokens: String(params.tokens),
    },
    signal,
  );

  const text = await response.text();
  writeDocsCache(cacheKey, text);
  return { text, fromCache: false };
}
