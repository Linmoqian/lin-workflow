/**
 * mineru 扩展 —— MinerU HTTP 客户端
 *
 * 覆盖官方两套接口，按配置自动选择：
 *  - v4 标准接口（需 Token，单文件 ≤200MB / ≤200 页，批量单次 ≤50 个）
 *      POST /api/v4/extract/task                    远程 URL 建任务 → data.task_id
 *      POST /api/v4/file-urls/batch                 本地文件批量申请上传链接 → batch_id + file_urls
 *      PUT  <file_urls[i]>                          上传文件（注意：不能带 Content-Type，否则 OSS 签名校验 403）
 *      GET  /api/v4/extract/task/{task_id}          查单任务
 *      GET  /api/v4/extract-results/batch/{batch_id} 查批量任务
 *  - v1 Agent 轻量接口（免 Token，受 IP 限流，单文件 ≤10MB / ≤20 页，仅单文件）
 *      POST /api/v1/agent/parse/url                 远程 URL
 *      POST /api/v1/agent/parse/file                本地文件（返回 task_id + 签名上传链接）
 *      GET  /api/v1/agent/parse/{task_id}           查任务，完成时直接给 markdown_url
 *
 * v4 的结果是 zip（full.md + images/…），v1 的结果是单文件 markdown，两条路径在这里统一成
 * TaskResult / ParsedDocument，上层只管落盘与展示。
 *
 * 消费方：index.ts 的两个工具与 /mineru 命令。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import type { MineruConfig } from "./config.ts";
import { readZipEntries, type ZipEntry } from "./zip.ts";

/* ------------------------------ 常量 ------------------------------ */

/** 结果包下载上限（超出直接报错，避免把内存吃满） */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** zip 中 markdown 正文的固定名 */
const MARKDOWN_ENTRY = "full.md";

/** zip 中图片目录前缀 */
const IMAGE_PREFIX = "images/";

/** 建任务时附带 data_id 的前缀，用于把批量结果对回原文件 */
export const DATA_ID_PREFIX = "pi-mineru-";

/* ------------------------------ 类型 ------------------------------ */

/** 建任务 / 上传时要传的解析参数（与接口字段一一对应） */
export interface ParseOptions {
  modelVersion: string;
  language: string;
  enableFormula: boolean;
  enableTable: boolean;
  isOcr: boolean;
  pageRanges?: string;
}

/** 提交后的待查询目标 */
export interface PendingTarget {
  api: "standard" | "agent";
  /** "standard-task" 单个远程任务；"standard-batch" 批量；"agent" 轻量接口单任务 */
  kind: "standard-task" | "standard-batch" | "agent";
  id: string;
}

/** 归一化后的任务结果（v4 与 v1 统一形态） */
export interface TaskResult {
  api: "standard" | "agent";
  kind: PendingTarget["kind"];
  /** 查询用的 id（任务 id 或 batch_id） */
  id: string;
  taskId?: string;
  dataId?: string;
  fileName: string;
  /** 接口原始 state，如 pending / running / converting / waiting-file / uploading / done / failed */
  state: string;
  settled: "pending" | "done" | "failed";
  errMsg?: string;
  errCode?: number;
  /** v4 结果包地址 */
  zipUrl?: string;
  /** v1 直接给的 markdown 地址 */
  markdownUrl?: string;
  extractedPages?: number;
  totalPages?: number;
  startTime?: string;
}

/** 落盘所需的一份解析结果内容 */
export interface ParsedDocument {
  markdown: string;
  /** zip 中解出的图片（v1 路径为空数组） */
  assets: ZipEntry[];
}

export class MineruError extends Error {
  readonly httpStatus?: number;
  readonly code?: number | string;

  constructor(message: string, options?: { httpStatus?: number; code?: number | string }) {
    super(message);
    this.name = "MineruError";
    this.httpStatus = options?.httpStatus;
    this.code = options?.code;
  }
}

/** 是否为「任务不存在 / 已过期」，用于 mineru_query 的接口自动探测 */
export function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof MineruError)) return false;
  return err.code === "-60012" || err.code === "-10002" || err.code === -60012 || err.code === -10002 || err.httpStatus === 404;
}

/* ------------------------------ 错误映射 ------------------------------ */

/** 接口错误码 → 可执行的中文提示 */
function describeCode(code: number | string | undefined, msg: string): string {
  const table: Record<string, string> = {
    A0201: "Token 缺失，请在 .env 里配置 MINERU_API_KEY",
    A0202: "Token 无效：请确认 .env 里的 MINERU_API_KEY 与官网「API 管理」页一致",
    A0211: "Token 已过期：请到 mineru.net 重新生成后更新 .env",
    "-60012": "任务不存在或已过期（解析结果一般保留一段时间，过期需重新发起解析）",
    "-10002": "task_id 无效：轻量接口不认识该 ID，任务可能尚未入库或已过期",
    "-30001": "文件超过轻量接口 10MB 限制：请改用 v4 标准接口（配置 MINERU_API_KEY）",
    "-30002": "轻量接口不支持该文件类型：仅支持 PDF / 图片 / Doc / PPT / Excel；HTML 请走标准接口",
    "-30003": "文件页数超过轻量接口 20 页限制：请改用 v4 标准接口或指定 page_range",
    "-30004": "请求参数不合法：请检查文件路径、页码范围等参数",
  };
  const key = code === undefined ? "" : String(code);
  const hint = table[key];
  return hint ? `${msg}（${key}：${hint}）` : `${msg}${code === undefined ? "" : `（code=${code}）`}`;
}

/** 把响应体解析成错误对象 */
function toApiError(status: number, body: string, action: string): MineruError {
  let detail = body.slice(0, 300).trim();
  let code: number | string | undefined;

  try {
    const parsed = JSON.parse(body) as { code?: number; msg?: string; message?: string; msgCode?: string };
    code = parsed.msgCode ?? parsed.code;
    detail = parsed.msg ?? parsed.message ?? detail;
  } catch {
    /* 非 JSON 响应体，直接用原文 */
  }
  detail = detail.trim() || "(无响应体)";

  if (status === 401 || code === "A0201" || code === "A0202" || code === "A0211") {
    return new MineruError(`${action}失败：${describeCode(code, detail)}`, { httpStatus: status, code });
  }
  if (status === 429) {
    return new MineruError(`${action}失败：请求过于频繁（429），请稍后重试；轻量接口按 IP 限流`, {
      httpStatus: status,
      code,
    });
  }
  if (status === 413) {
    return new MineruError(`${action}失败：文件过大（413），v4 标准接口上限 200MB，轻量接口上限 10MB`, {
      httpStatus: status,
      code,
    });
  }
  if (status >= 500) {
    return new MineruError(`${action}失败：MinerU 服务端错误（${status}）：${detail}`, { httpStatus: status, code });
  }
  return new MineruError(`${action}失败：HTTP ${status}：${detail}`, { httpStatus: status, code });
}

/* ------------------------------ 请求底座 ------------------------------ */

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** 出错时的动作描述，如「创建解析任务」 */
  action: string;
  signal?: AbortSignal;
  /** 允许返回 code !== 0 而不抛错（用于 mineru_query 的自动探测） */
  tolerateApiError?: boolean;
}

interface ApiEnvelope<T> {
  code: number | string;
  msg?: string;
  traceId?: string;
  data?: T;
}

/**
 * 发起一次接口请求并解包 { code, msg, data }。
 * 超时信号与上层 AbortSignal 合并，取消 / 超时 / 错误码都转成中文提示。
 */
async function apiRequest<T>(cfg: MineruConfig, options: RequestOptions): Promise<ApiEnvelope<T>> {
  const url = `${cfg.baseUrl}${options.path}`;
  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const combined = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { accept: "*/*" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: combined,
    });
  } catch (err) {
    if (options.signal?.aborted) throw new MineruError(`${options.action}已取消`);
    if (timeoutSignal.aborted) {
      throw new MineruError(`${options.action}超时（${cfg.timeoutMs} ms）：可用 MINERU_TIMEOUT_MS 调大上限`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new MineruError(`无法访问 MinerU（${cfg.baseUrl}）：${reason}`);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) throw toApiError(response.status, text, options.action);

  let payload: ApiEnvelope<T>;
  try {
    payload = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new MineruError(`${options.action}失败：接口未返回 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }

  // 业务错误码：接口 HTTP 200 但 code !== 0
  if (payload.code !== 0 && payload.code !== "0") {
    const error = new MineruError(
      `${options.action}失败：${describeCode(payload.code, payload.msg ?? "接口返回非 0 状态码")}`,
      { httpStatus: response.status, code: payload.code },
    );
    if (!options.tolerateApiError) throw error;
    (payload as ApiEnvelope<T> & { __error?: MineruError }).__error = error;
  }

  return payload;
}

/* ------------------------------ v4 标准接口 ------------------------------ */

/** 组装建任务请求体的公共字段 */
function buildStandardBody(opts: ParseOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model_version: opts.modelVersion,
    language: opts.language,
    enable_formula: opts.enableFormula,
    enable_table: opts.enableTable,
  };
  if (opts.isOcr) body.is_ocr = true;
  if (opts.pageRanges) body.page_ranges = opts.pageRanges;
  return body;
}

/** 远程 URL 建单文件解析任务，返回 task_id */
export async function standardCreateUrlTask(
  cfg: MineruConfig,
  url: string,
  opts: ParseOptions,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await apiRequest<{ task_id?: string }>(cfg, {
    method: "POST",
    path: "/api/v4/extract/task",
    body: { url, ...buildStandardBody(opts) },
    action: "创建解析任务",
    signal,
  });

  const taskId = payload.data?.task_id;
  if (!taskId) throw new MineruError("创建解析任务失败：接口未返回 task_id");
  return taskId;
}

/** 【批量】为本地文件申请签名上传链接 */
export async function standardRequestUploads(
  cfg: MineruConfig,
  files: Array<{ name: string; dataId: string; pageRanges?: string }>,
  opts: ParseOptions,
  signal?: AbortSignal,
): Promise<{ batchId: string; urls: string[] }> {
  const payload = await apiRequest<{ batch_id?: string; file_urls?: string[] }>(cfg, {
    method: "POST",
    path: "/api/v4/file-urls/batch",
    body: {
      ...buildStandardBody(opts),
      files: files.map((file) => ({
        name: file.name,
        data_id: file.dataId,
        ...(file.pageRanges ? { page_ranges: file.pageRanges } : {}),
      })),
    },
    action: "申请文件上传链接",
    signal,
  });

  const batchId = payload.data?.batch_id;
  const urls = payload.data?.file_urls ?? [];
  if (!batchId || urls.length !== files.length) {
    throw new MineruError(
      `申请文件上传链接失败：返回 ${urls.length} 个链接、提交了 ${files.length} 个文件${batchId ? "" : "，且缺少 batch_id"}`,
    );
  }
  return { batchId, urls };
}

/** 上传文件到签名链接（不设置 Content-Type：OSS 签名不含该头，带上会被 403 拒绝） */
export async function uploadToSignedUrl(
  signedUrl: string,
  data: Buffer,
  signal?: AbortSignal,
  label = "上传文件",
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(signedUrl, { method: "PUT", body: new Uint8Array(data), signal });
  } catch (err) {
    if (signal?.aborted) throw new MineruError(`${label}已取消`);
    const reason = err instanceof Error ? err.message : String(err);
    throw new MineruError(`${label}失败：${reason}`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new MineruError(`${label}失败：HTTP ${response.status}${detail ? `：${detail}` : ""}`);
  }
}

/* ------------------------------ v1 Agent 轻量接口 ------------------------------ */

/** 组装轻量接口的公共字段（注意页码参数名是 page_range，且只支持 from-to / 单页） */
function buildAgentBody(opts: ParseOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    language: opts.language,
    enable_formula: opts.enableFormula,
    enable_table: opts.enableTable,
  };
  if (opts.isOcr) body.is_ocr = true;
  if (opts.pageRanges) body.page_range = opts.pageRanges;
  return body;
}

/** 轻量接口建远程 URL 任务 */
export async function agentCreateUrlTask(
  cfg: MineruConfig,
  url: string,
  fileName: string | undefined,
  opts: ParseOptions,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await apiRequest<{ task_id?: string }>(cfg, {
    method: "POST",
    path: "/api/v1/agent/parse/url",
    body: { url, ...(fileName ? { file_name: fileName } : {}), ...buildAgentBody(opts) },
    action: "创建轻量解析任务",
    signal,
  });

  const taskId = payload.data?.task_id;
  if (!taskId) throw new MineruError("创建轻量解析任务失败：接口未返回 task_id");
  return taskId;
}

/** 轻量接口建本地文件任务，返回任务 id 与签名上传链接 */
export async function agentCreateFileTask(
  cfg: MineruConfig,
  fileName: string,
  opts: ParseOptions,
  signal?: AbortSignal,
): Promise<{ taskId: string; uploadUrl: string }> {
  const payload = await apiRequest<{ task_id?: string; file_url?: string }>(cfg, {
    method: "POST",
    path: "/api/v1/agent/parse/file",
    body: { file_name: fileName, ...buildAgentBody(opts) },
    action: "创建轻量解析任务",
    signal,
  });

  const taskId = payload.data?.task_id;
  const uploadUrl = payload.data?.file_url;
  if (!taskId || !uploadUrl) throw new MineruError("创建轻量解析任务失败：接口未返回 task_id / file_url");
  return { taskId, uploadUrl };
}

/* ------------------------------ 结果归一化 ------------------------------ */

/** 把接口 state 归一到 pending / done / failed */
function settleState(state: string | undefined): TaskResult["settled"] {
  if (state === "done") return "done";
  if (state === "failed") return "failed";
  return "pending";
}

interface RawV4Task {
  task_id?: string;
  data_id?: string;
  file_name?: string;
  state?: string;
  err_msg?: string;
  full_zip_url?: string;
  extract_progress?: { extracted_pages?: number; total_pages?: number; start_time?: string };
}

/** v4 单任务 → TaskResult */
function toStandardTaskResult(raw: RawV4Task, taskId: string): TaskResult {
  const state = raw.state ?? "pending";
  return {
    api: "standard",
    kind: "standard-task",
    id: taskId,
    taskId,
    dataId: raw.data_id,
    fileName: raw.file_name ?? "task",
    state,
    settled: settleState(state),
    errMsg: raw.err_msg?.trim() || undefined,
    zipUrl: raw.full_zip_url,
    extractedPages: raw.extract_progress?.extracted_pages,
    totalPages: raw.extract_progress?.total_pages,
    startTime: raw.extract_progress?.start_time,
  };
}

/** 查询 v4 单任务 */
export async function standardQueryTask(
  cfg: MineruConfig,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskResult> {
  const payload = await apiRequest<RawV4Task>(cfg, {
    method: "GET",
    path: `/api/v4/extract/task/${encodeURIComponent(taskId)}`,
    action: "查询解析任务",
    signal,
  });
  const data = payload.data;
  if (!data) throw new MineruError("查询解析任务失败：接口未返回 data");
  return toStandardTaskResult(data, taskId);
}

/** 查询 v4 批量任务，返回该批次下每个文件的结果 */
export async function standardQueryBatch(
  cfg: MineruConfig,
  batchId: string,
  signal?: AbortSignal,
): Promise<TaskResult[]> {
  const payload = await apiRequest<{ batch_id?: string; extract_result?: RawV4Task[] }>(cfg, {
    method: "GET",
    path: `/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
    action: "查询批量解析任务",
    signal,
  });

  const items = payload.data?.extract_result ?? [];
  return items.map((raw) => {
    const state = raw.state ?? "pending";
    return {
      api: "standard" as const,
      kind: "standard-batch" as const,
      id: batchId,
      taskId: raw.task_id,
      dataId: raw.data_id,
      fileName: raw.file_name ?? "task",
      state,
      settled: settleState(state),
      errMsg: raw.err_msg?.trim() || undefined,
      zipUrl: raw.full_zip_url,
      extractedPages: raw.extract_progress?.extracted_pages,
      totalPages: raw.extract_progress?.total_pages,
      startTime: raw.extract_progress?.start_time,
    };
  });
}

/** 查询 v1 轻量任务 */
export async function agentQueryTask(
  cfg: MineruConfig,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskResult> {
  const payload = await apiRequest<{
    task_id?: string;
    state?: string;
    markdown_url?: string;
    err_msg?: string;
    err_code?: number;
  }>(cfg, {
    method: "GET",
    path: `/api/v1/agent/parse/${encodeURIComponent(taskId)}`,
    action: "查询轻量解析任务",
    signal,
  });

  const data = payload.data;
  if (!data) throw new MineruError("查询轻量解析任务失败：接口未返回 data");

  const state = data.state ?? "pending";
  return {
    api: "agent",
    kind: "agent",
    id: taskId,
    taskId,
    fileName: "task",
    state,
    settled: settleState(state),
    errMsg: data.err_msg?.trim() || undefined,
    errCode: data.err_code,
    markdownUrl: data.markdown_url,
  };
}

/* ------------------------------ 轮询 ------------------------------ */

/** 可取消的等待 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MineruError("等待解析结果已取消"));
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new MineruError("等待解析结果已取消"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 查询一个目标当前的结果列表 */
async function queryTarget(cfg: MineruConfig, target: PendingTarget, signal?: AbortSignal): Promise<TaskResult[]> {
  if (target.kind === "standard-batch") return standardQueryBatch(cfg, target.id, signal);
  if (target.kind === "standard-task") return [await standardQueryTask(cfg, target.id, signal)];
  return [await agentQueryTask(cfg, target.id, signal)];
}

export interface PollOptions {
  /** 每轮轮询后回调（用于把进度推给 TUI） */
  onProgress?: (results: TaskResult[], elapsedMs: number) => void;
}

export interface PollOutcome {
  results: TaskResult[];
  /** 是否因超过 maxWaitMs 而提前返回（任务仍在服务端跑） */
  timedOut: boolean;
  elapsedMs: number;
}

/** 连续查询失败多少次就放弃（防网络抖动直接判死） */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 轮询到所有任务 settled 或超时。
 * 单个目标的偶发查询失败会重试，连续失败 3 次才抛错。
 */
export async function pollUntilSettled(
  cfg: MineruConfig,
  targets: PendingTarget[],
  signal: AbortSignal | undefined,
  options: PollOptions = {},
): Promise<PollOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + cfg.maxWaitMs;
  const failures = new Map<string, number>();
  let latest: TaskResult[] = [];

  for (;;) {
    const round: TaskResult[] = [];

    for (const target of targets) {
      try {
        round.push(...(await queryTarget(cfg, target, signal)));
        failures.delete(target.id);
      } catch (err) {
        // 取消 / 认证类错误直接抛出，网络抖动则累计重试
        if (err instanceof MineruError && (signal?.aborted || err.code === "A0202" || err.code === "A0211")) throw err;

        const count = (failures.get(target.id) ?? 0) + 1;
        failures.set(target.id, count);
        if (count >= MAX_CONSECUTIVE_FAILURES) throw err;

        // 保留上一轮该目标的结果，避免进度展示抖动
        round.push(...latest.filter((item) => item.id === target.id));
      }
    }

    latest = round;
    options.onProgress?.(latest, Date.now() - startedAt);

    const allSettled = latest.length > 0 && latest.every((item) => item.settled !== "pending");
    if (allSettled) return { results: latest, timedOut: false, elapsedMs: Date.now() - startedAt };
    if (Date.now() + cfg.pollIntervalMs > deadline) {
      return { results: latest, timedOut: true, elapsedMs: Date.now() - startedAt };
    }

    await sleep(cfg.pollIntervalMs, signal);
  }
}

/* ------------------------------ 结果下载 ------------------------------ */

/** 下载二进制内容（用于 v4 结果包），超出上限直接报错 */
export async function downloadBinary(
  url: string,
  signal: AbortSignal | undefined,
  label: string,
  maxBytes = MAX_DOWNLOAD_BYTES,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw new MineruError(`${label}已取消`);
    const reason = err instanceof Error ? err.message : String(err);
    throw new MineruError(`${label}失败：${reason}`);
  }

  if (!response.ok) throw new MineruError(`${label}失败：HTTP ${response.status}（结果链接可能已过期）`);

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MineruError(`${label}失败：结果包 ${Math.round(declared / 1024 / 1024)}MB 超出下载上限`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new MineruError(`${label}失败：结果包超出 ${Math.round(maxBytes / 1024 / 1024)}MB 下载上限`);
  return buffer;
}

/** 下载文本内容（用于 v1 的 markdown_url） */
export async function downloadText(url: string, signal: AbortSignal | undefined, label: string): Promise<string> {
  const buffer = await downloadBinary(url, signal, label, 64 * 1024 * 1024);
  return buffer.toString("utf8");
}

/** 从 v4 结果包中取出 markdown 正文与图片 */
export function extractDocument(zipBuffer: Buffer): ParsedDocument {
  const entries = readZipEntries(zipBuffer, (name) => name === MARKDOWN_ENTRY || name.startsWith(IMAGE_PREFIX));

  const markdownEntry = entries.find((entry) => entry.name === MARKDOWN_ENTRY);
  if (!markdownEntry) {
    throw new MineruError(`结果包中未找到 ${MARKDOWN_ENTRY}（实际条目：${entries.map((e) => e.name).join(", ") || "空"}）`);
  }

  return {
    markdown: markdownEntry.data.toString("utf8"),
    assets: entries.filter((entry) => entry.name.startsWith(IMAGE_PREFIX)),
  };
}
