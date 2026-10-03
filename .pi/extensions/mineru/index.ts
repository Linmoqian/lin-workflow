/**
 * mineru 扩展 —— 入口
 *
 * 解决「模型读不动扫描件 / 复杂版面 PDF」的问题：把 MinerU 的文档解析能力接成两个工具，
 * 让模型把 PDF、图片、Office、HTML 直接转成 markdown 再读：
 *  - mineru_parse：提交解析（本地路径或远程 URL，可批量）→ 轮询 → 下载结果 → 落盘 markdown + 图片
 *  - mineru_query：按 task_id / batch_id 查状态与结果链接，可选下载落盘
 *
 * 接口按需选择：配了 MINERU_API_KEY 走 v4 标准接口（≤200MB/≤200 页/可批量），
 * 没配则退回 v1 Agent 轻量接口（免 Token，≤10MB/≤20 页且仅单文件）。
 *
 * 另有 /mineru 命令查看配置状态或手动解析 / 查询。
 *
 * 安装位置：~/.pi/agent/extensions/mineru/（全局自动发现，可 /reload 热加载）
 * 配置：同目录 .env（见 .env.example），也可用同名进程环境变量覆盖。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

import {
  AGENT_MAX_FILE_MB,
  AGENT_MAX_PAGES,
  ENV_FILE_CANDIDATES,
  loadConfig,
  normalizeModelVersion,
  resolveApiMode,
  STANDARD_MAX_FILE_MB,
  type MineruConfig,
} from "./config.ts";
import {
  agentCreateFileTask,
  agentCreateUrlTask,
  DATA_ID_PREFIX,
  downloadBinary,
  downloadText,
  extractDocument,
  isNotFoundError,
  MineruError,
  pollUntilSettled,
  standardCreateUrlTask,
  standardQueryBatch,
  standardQueryTask,
  standardRequestUploads,
  uploadToSignedUrl,
  agentQueryTask,
  type ParsedDocument,
  type ParseOptions,
  type PendingTarget,
  type TaskResult,
} from "./client.ts";
import { saveParsedDocument, type SaveOutcome } from "./output.ts";
import { getElapsedMs, renderCallLine, renderResultSummary } from "./render.ts";
import {
  parseParamsSchema,
  queryParamsSchema,
  type MineruFileSummary,
  type MineruParseDetails,
  type MineruQueryDetails,
  type ParseParams,
  type QueryParams,
} from "./types.ts";

/* ------------------------------ 常量 ------------------------------ */

/** 结果正文里预览的 markdown 行数 */
const PREVIEW_LINES = 40;

/** 预览单行最大字符数 */
const PREVIEW_LINE_CHARS = 300;

/** /mineru 命令输出给用户的行数上限 */
const COMMAND_MAX_LINES = 40;

/** 任务状态的中文标签 */
const STATE_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "解析中",
  converting: "后处理中",
  "waiting-file": "等待上传",
  uploading: "上传中",
  done: "完成",
  failed: "失败",
};

/* ------------------------------ 类型 ------------------------------ */

interface Job {
  /** 原始输入 */
  source: string;
  kind: "url" | "file";
  /** 用于落盘与展示的文件名 */
  fileName: string;
  localPath?: string;
  sizeBytes?: number;
  /** 批量任务里用于把结果对回文件的 data_id */
  dataId?: string;
  outputDir: string;
  target?: PendingTarget;
  result?: TaskResult;
  saved?: SaveOutcome;
  error?: string;
}

interface RunContext {
  cwd: string;
  signal?: AbortSignal;
  /** 进度回调（工具走 onUpdate，命令走 footer 状态） */
  progress?: (text: string) => void;
}

/* ------------------------------ 通用辅助 ------------------------------ */

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** 统一取错误文案 */
function messageOf(err: unknown): string {
  if (err instanceof MineruError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 文件后缀判定（用于 HTML 需要换模型） */
function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name);
}

/** 状态标签 */
function stateLabel(result: TaskResult | undefined): string {
  if (!result) return "未提交";
  return STATE_LABELS[result.state] ?? result.state;
}

/** 行数限制（命令输出用） */
function limitLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…（共 ${lines.length} 行，已省略 ${lines.length - maxLines} 行）`;
}

/* ------------------------------ 任务准备 ------------------------------ */

/**
 * 把用户给的 sources 解析成 Job：区分 URL / 本地文件，检查存在性、体积上限、HTML 走哪套接口。
 * 任一输入有问题就整体不提交，一次把问题说清楚。
 */
async function prepareJobs(
  rawSources: string[],
  outputDirRaw: string | undefined,
  cwd: string,
  api: "standard" | "agent",
): Promise<Job[]> {
  const jobs: Job[] = [];
  const problems: string[] = [];

  const outputDir = outputDirRaw?.trim() ? resolve(cwd, outputDirRaw.trim()) : undefined;
  const sizeLimitMb = api === "standard" ? STANDARD_MAX_FILE_MB : AGENT_MAX_FILE_MB;

  for (const raw of rawSources) {
    // 模型有时会给路径加 @ 前缀，这里统一去掉
    const source = raw.trim().replace(/^@/, "");
    if (!source) {
      problems.push("数组里有空字符串");
      continue;
    }

    if (isUrl(source)) {
      let fileName = "document";
      try {
        const parsed = new URL(source);
        fileName = basename(decodeURIComponent(parsed.pathname)) || "document";
      } catch {
        problems.push(`URL 无法解析：${source}`);
        continue;
      }
      if (api === "agent" && isHtmlFile(fileName)) {
        problems.push(`HTML 输入需要 v4 标准接口：${source}（请配置 MINERU_API_KEY）`);
        continue;
      }
      jobs.push({ source, kind: "url", fileName, outputDir: outputDir ?? cwd });
      continue;
    }

    const absolute = resolve(cwd, source);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch {
      problems.push(`本地文件不存在：${source}`);
      continue;
    }
    if (!info.isFile()) {
      problems.push(`不是文件（目录？）：${source}`);
      continue;
    }

    const fileName = basename(absolute);
    if (api === "agent" && isHtmlFile(fileName)) {
      problems.push(`HTML 输入需要 v4 标准接口：${source}（请配置 MINERU_API_KEY）`);
      continue;
    }
    if (info.size > sizeLimitMb * 1024 * 1024) {
      const hint =
        api === "standard"
          ? `标准接口单文件上限 ${STANDARD_MAX_FILE_MB}MB`
          : `轻量接口单文件上限 ${AGENT_MAX_FILE_MB}MB，配置 MINERU_API_KEY 后可用标准接口（≤${STANDARD_MAX_FILE_MB}MB）`;
      problems.push(`${fileName} 共 ${(info.size / 1024 / 1024).toFixed(1)}MB，超出上限（${hint}）`);
      continue;
    }

    jobs.push({
      source,
      kind: "file",
      fileName,
      localPath: absolute,
      sizeBytes: info.size,
      outputDir: outputDir ?? dirname(absolute),
    });
  }

  if (problems.length > 0) {
    throw new Error(`以下输入无法处理，未提交任何任务：\n· ${problems.join("\n· ")}`);
  }
  if (jobs.length === 0) throw new Error("没有可解析的输入：sources 至少要有 1 项");
  return jobs;
}

/* ------------------------------ 提交 ------------------------------ */

/** 提交远程 URL 与本地文件，填好每个 Job 的 target */
async function submitJobs(
  cfg: MineruConfig,
  jobs: Job[],
  opts: ParseOptions,
  api: "standard" | "agent",
  run: RunContext,
): Promise<void> {
  if (api === "agent") {
    for (const [index, job] of jobs.entries()) {
      run.progress?.(`提交轻量解析任务 ${index + 1}/${jobs.length}：${job.fileName}`);
      try {
        if (job.kind === "url") {
          const taskId = await agentCreateUrlTask(cfg, job.source, job.fileName, opts, run.signal);
          job.target = { api: "agent", kind: "agent", id: taskId };
        } else {
          const { taskId, uploadUrl } = await agentCreateFileTask(cfg, job.fileName, opts, run.signal);
          const data = await readFile(job.localPath!);
          await uploadToSignedUrl(uploadUrl, data, run.signal, `上传 ${job.fileName}`);
          job.target = { api: "agent", kind: "agent", id: taskId };
        }
      } catch (err) {
        job.error = messageOf(err);
      }
    }
    return;
  }

  // v4 标准接口：URL 逐个建任务；本地文件合成一个批量任务再逐个上传
  const urlJobs = jobs.filter((job) => job.kind === "url");
  const fileJobs = jobs.filter((job) => job.kind === "file");

  for (const [index, job] of urlJobs.entries()) {
    run.progress?.(`提交解析任务 ${index + 1}/${urlJobs.length}：${job.fileName}`);
    try {
      const taskId = await standardCreateUrlTask(cfg, job.source, opts, run.signal);
      job.target = { api: "standard", kind: "standard-task", id: taskId };
    } catch (err) {
      job.error = messageOf(err);
    }
  }

  if (fileJobs.length === 0) return;

  run.progress?.(`申请上传链接：${fileJobs.length} 个文件`);
  try {
    const files = fileJobs.map((job, index) => {
      const dataId = `${DATA_ID_PREFIX}${index}`;
      job.dataId = dataId;
      return { name: job.fileName, dataId, pageRanges: opts.pageRanges };
    });
    const { batchId, urls } = await standardRequestUploads(cfg, files, opts, run.signal);

    for (const [index, job] of fileJobs.entries()) {
      run.progress?.(`上传文件 ${index + 1}/${fileJobs.length}：${job.fileName}（${formatSize(job.sizeBytes ?? 0)}）`);
      const data = await readFile(job.localPath!);
      await uploadToSignedUrl(urls[index], data, run.signal, `上传 ${job.fileName}`);
      job.target = { api: "standard", kind: "standard-batch", id: batchId };
    }
  } catch (err) {
    // 建批次或上传失败：把还没拿到 target 的文件统一标记失败
    const reason = messageOf(err);
    for (const job of fileJobs) {
      if (!job.target && !job.error) job.error = reason;
    }
  }
}

/* ------------------------------ 结果绑定与落盘 ------------------------------ */

/** 把轮询结果按 target / data_id / 文件名 / 提交顺序对回 Job */
function bindResults(jobs: Job[], results: TaskResult[]): void {
  const batches = new Map<string, TaskResult[]>();
  for (const item of results) {
    if (item.kind !== "standard-batch") continue;
    const list = batches.get(item.id) ?? [];
    list.push(item);
    batches.set(item.id, list);
  }

  for (const job of jobs) {
    const target = job.target;
    if (!target || job.error) continue;

    let hit: TaskResult | undefined;
    if (target.kind === "standard-task") {
      hit = results.find((item) => item.kind === "standard-task" && item.taskId === target.id);
    } else if (target.kind === "standard-batch") {
      const list = batches.get(target.id) ?? [];
      hit = list.find((item) => job.dataId !== undefined && item.dataId === job.dataId) ?? list.find((item) => item.fileName === job.fileName);
      if (!hit) {
        // 兜底：接口没回显 data_id / file_name 时按提交顺序对应
        const siblings = jobs.filter((item) => item.target?.kind === "standard-batch" && item.target.id === target.id);
        hit = list[siblings.indexOf(job)];
      }
    } else {
      hit = results.find((item) => item.kind === "agent" && item.taskId === target.id);
    }

    if (!hit) continue;
    job.result = { ...hit, fileName: job.fileName };
    if (hit.settled === "failed") {
      job.error = `${hit.errMsg ?? "解析失败"}${hit.errCode ? `（code=${hit.errCode}）` : ""}`;
    }
  }
}

/** 下载已完成任务的内容（v4 是 zip，v1 是 markdown） */
async function fetchContent(cfg: MineruConfig, job: Job, signal?: AbortSignal): Promise<ParsedDocument> {
  const result = job.result!;

  if (result.api === "standard") {
    if (!result.zipUrl) throw new MineruError("任务已完成，但接口未返回结果包地址（full_zip_url）");
    const zip = await downloadBinary(result.zipUrl, signal, `下载结果包（${job.fileName}）`);
    return extractDocument(zip);
  }

  if (!result.markdownUrl) throw new MineruError("任务已完成，但接口未返回 markdown 地址");
  const markdown = await downloadText(result.markdownUrl, signal, `下载结果（${job.fileName}）`);
  return { markdown, assets: [] };
}

/* ------------------------------ 文本组装 ------------------------------ */

/** 单个文件的处理结果行 */
function formatJobLine(job: Job): string {
  if (job.error) return `❌ ${job.source}\n   ${job.error}`;
  if (!job.result && !job.saved) return `⏳ ${job.source}\n   已提交，等待解析`;

  if (job.saved) {
    const meta: string[] = [];
    if (job.result?.totalPages) meta.push(`${job.result.extractedPages ?? "?"}/${job.result.totalPages} 页`);
    meta.push(`${formatSize(job.saved.markdownBytes)} / ${job.saved.markdownLines} 行`);
    if (job.saved.assetCount > 0 && job.saved.assetDir) {
      meta.push(`图片 ${job.saved.assetCount} 张（${basename(job.saved.assetDir)}/）`);
    }
    if (job.saved.renamed) meta.push("同名已存在，已改写为新文件名");
    return [`✅ ${job.source}`, `   → ${job.saved.markdownPath}`, `   ${meta.join(" · ")}`].join("\n");
  }

  const progress = job.result?.totalPages
    ? ` ${job.result.extractedPages ?? 0}/${job.result.totalPages} 页`
    : "";
  return `⏳ ${job.source}\n   仍在解析（${stateLabel(job.result)}${progress}）`;
}

/** 拼接详情里的续查提示 */
function pendingHint(jobs: Job[]): string | undefined {
  const pending = jobs.filter((job) => job.target && job.result?.settled !== "done" && job.result?.settled !== "failed" && !job.error);
  if (pending.length === 0) return undefined;
  const ids = [...new Set(pending.map((job) => job.target!.id))];
  return `用 mineru_query 续查：id="${ids[0]}"${ids.length > 1 ? `（另有 ${ids.length - 1} 个任务 ID，共 ${pending.length} 个文件未完成）` : ""}`;
}

/** 截取预览行 */
function buildPreview(markdown: string): string[] {
  return markdown
    .split("\n")
    .slice(0, PREVIEW_LINES)
    .map((line) => (line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line));
}

/* ------------------------------ 解析主流程 ------------------------------ */

interface ParseOutcome {
  content: string;
  details: MineruParseDetails;
}

/** 供工具与命令共用的解析流程 */
async function runParse(cfg: MineruConfig, params: ParseParams, run: RunContext): Promise<ParseOutcome> {
  const api: "standard" | "agent" =
    params.api && params.api !== "auto" ? params.api : resolveApiMode(cfg);

  if (api === "standard" && !cfg.apiKey) {
    throw new Error(
      "v4 标准接口需要 Token：请在扩展目录 .env 里配置 MINERU_API_KEY（见 .env.example），或把 api 设为 agent 走免 Token 的轻量接口",
    );
  }

  const jobs = await prepareJobs(params.sources, params.output_dir, run.cwd, api);

  // HTML 输入必须用 MinerU-HTML 模型
  let modelVersion = normalizeModelVersion(params.model_version, cfg.modelVersion);
  if (jobs.some((job) => isHtmlFile(job.fileName)) && modelVersion !== "MinerU-HTML") modelVersion = "MinerU-HTML";

  const opts: ParseOptions = {
    modelVersion,
    language: params.language?.trim() || cfg.language,
    enableFormula: params.enable_formula ?? true,
    enableTable: params.enable_table ?? true,
    isOcr: params.is_ocr ?? false,
    pageRanges: params.page_ranges?.trim() || undefined,
  };

  await submitJobs(cfg, jobs, opts, api, run);

  const targets = jobs.filter((job) => job.target).map((job) => job.target!);
  const wantsWait = params.wait !== false;

  let timedOut = false;
  let elapsedMs = 0;

  if (wantsWait && targets.length > 0) {
    const outcome = await pollUntilSettled(cfg, targets, run.signal, {
      onProgress: (results, elapsed) => {
        const settled = results.filter((item) => item.settled !== "pending").length;
        const lines = results.map((item) => {
          const progress = item.totalPages ? ` ${item.extractedPages ?? 0}/${item.totalPages} 页` : "";
          return `· ${item.fileName}：${stateLabel(item)}${progress}`;
        });
        run.progress?.(
          [`MinerU 解析中（${settled}/${results.length} 已完成，已用 ${(elapsed / 1000).toFixed(0)}s）`, ...lines].join("\n"),
        );
      },
    });
    timedOut = outcome.timedOut;
    elapsedMs = outcome.elapsedMs;
    bindResults(jobs, outcome.results);
  }

  // 下载 + 落盘
  let previewSource: { path: string; lines: string[] } | undefined;
  for (const job of jobs) {
    if (job.error || job.result?.settled !== "done") continue;
    try {
      run.progress?.(`下载并落盘：${job.fileName}`);
      const document = await fetchContent(cfg, job, run.signal);
      job.saved = await saveParsedDocument({
        markdown: document.markdown,
        assets: document.assets,
        sourceName: job.fileName,
        outputDir: job.outputDir,
      });
      previewSource ??= { path: job.saved.markdownPath, lines: buildPreview(document.markdown) };
    } catch (err) {
      job.error = messageOf(err);
    }
  }

  /* ----- 组装给模型的文本 ----- */

  const succeeded = jobs.filter((job) => job.saved).length;
  const failed = jobs.filter((job) => job.error).length;
  const unfinished = jobs.length - succeeded - failed;

  const header = [
    `MinerU 解析｜${api === "standard" ? "v4 标准接口" : "v1 轻量接口"}${cfg.apiKey ? "" : "（免 Token）"}｜模型 ${opts.modelVersion}`,
    `｜${jobs.length} 个文件：成功 ${succeeded} · 失败 ${failed}${unfinished > 0 ? ` · 未完成 ${unfinished}` : ""}`,
    elapsedMs > 0 ? `｜用时 ${(elapsedMs / 1000).toFixed(1)}s` : "",
    params.wait === false ? "｜仅提交未等待" : "",
  ]
    .filter(Boolean)
    .join("");

  const blocks = [header, ...jobs.map(formatJobLine)];

  const notes: string[] = [];
  if (timedOut) {
    notes.push(
      `超过 MINERU_MAX_WAIT_MS（${cfg.maxWaitMs} ms）仍在解析，任务在服务端继续跑，稍后用 mineru_query 续查即可`,
    );
  }
  if (unfinished > 0) notes.push(pendingHint(jobs) ?? "");
  if (jobs.some((job) => isHtmlFile(job.fileName))) notes.push("含 HTML 输入，模型已自动使用 MinerU-HTML");
  if (api === "agent") {
    notes.push(
      `当前走轻量接口（免 Token）：单文件 ≤${AGENT_MAX_FILE_MB}MB、≤${AGENT_MAX_PAGES} 页；配置 MINERU_API_KEY 可解锁标准接口`,
    );
  }
  if (succeeded > 0) notes.push("markdown 已落盘，正文较长时用 read 工具分段读取路径中的文件");

  const footer = notes.filter(Boolean).length > 0 ? `\n\n注意：\n${notes.filter(Boolean).map((note) => `· ${note}`).join("\n")}` : "";

  const preview = previewSource
    ? `\n\n—— ${previewSource.path} 预览（前 ${Math.min(previewSource.lines.length, PREVIEW_LINES)} 行）——\n${previewSource.lines.join("\n")}`
    : "";

  const full = `${blocks.join("\n\n")}${preview}${footer}`;
  const truncation = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

  const details: MineruParseDetails = {
    api,
    modelVersion: opts.modelVersion,
    fileCount: jobs.length,
    files: jobs.map(
      (job): MineruFileSummary => ({
        source: job.source,
        fileName: job.fileName,
        status: job.saved ? "done" : job.error ? "failed" : "pending",
        state: job.result?.state,
        pages: job.result?.totalPages ? `${job.result.extractedPages ?? 0}/${job.result.totalPages}` : undefined,
        taskId: job.target?.kind === "standard-task" || job.target?.kind === "agent" ? job.target.id : undefined,
        batchId: job.target?.kind === "standard-batch" ? job.target.id : undefined,
        markdownPath: job.saved?.markdownPath,
        markdownBytes: job.saved?.markdownBytes,
        markdownLines: job.saved?.markdownLines,
        assetCount: job.saved?.assetCount,
        assetDir: job.saved?.assetDir,
        error: job.error,
      }),
    ),
    elapsedMs,
    timedOut,
    submittedOnly: params.wait === false,
    forcedHtmlModel: jobs.some((job) => isHtmlFile(job.fileName)) && opts.modelVersion === "MinerU-HTML",
  };
  if (truncation.truncated) details.truncation = truncation;

  const content = truncation.truncated
    ? `${truncation.content}\n\n[结果文本已截断：完整 markdown 见上方落盘路径]`
    : truncation.content;

  return { content, details };
}

/* ------------------------------ 查询主流程 ------------------------------ */

/** 自动探测 id 属于哪套接口 */
async function probeTarget(cfg: MineruConfig, id: string, signal?: AbortSignal): Promise<{ target: PendingTarget; results: TaskResult[] } | undefined> {
  // 1) v4 单任务
  try {
    return { target: { api: "standard", kind: "standard-task", id }, results: [await standardQueryTask(cfg, id, signal)] };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  // 2) v4 批量
  try {
    const results = await standardQueryBatch(cfg, id, signal);
    if (results.length > 0) return { target: { api: "standard", kind: "standard-batch", id }, results };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  // 3) v1 轻量任务
  try {
    return { target: { api: "agent", kind: "agent", id }, results: [await agentQueryTask(cfg, id, signal)] };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  return undefined;
}

interface QueryOutcome {
  content: string;
  details: MineruQueryDetails;
}

/** 供工具与命令共用的查询流程 */
async function runQuery(cfg: MineruConfig, params: QueryParams, run: RunContext): Promise<QueryOutcome> {
  const id = params.id.trim();
  if (!id) throw new Error("id 不能为空：请填 mineru_parse 返回的 task_id 或 batch_id");

  const probe = await probeTarget(cfg, id, run.signal);
  if (!probe) {
    const text = `MinerU 查询｜id=${id}\n\n未找到该任务：任务 ID 可能有误，或结果已过期（需重新解析）。`;
    return { content: text, details: { id, found: false, files: [] } };
  }

  const files: MineruFileSummary[] = probe.results.map((item) => ({
    source: item.fileName,
    fileName: item.fileName,
    status: item.settled === "done" ? "done" : item.settled === "failed" ? "failed" : "pending",
    state: item.state,
    pages: item.totalPages ? `${item.extractedPages ?? 0}/${item.totalPages}` : undefined,
    taskId: item.taskId,
    batchId: item.kind === "standard-batch" ? id : undefined,
  }));

  const header = `MinerU 查询｜id=${id}（${probe.target.kind === "standard-batch" ? "v4 批量" : probe.target.api === "standard" ? "v4 单任务" : "v1 轻量"}）`;
  // 每个结果一段文本，下载落盘的补充说明追加到对应段落里
  const blocks = probe.results.map((item) => {
    const progress = item.totalPages ? ` ${item.extractedPages ?? 0}/${item.totalPages} 页` : "";
    const state = item.settled === "done" ? "完成" : item.settled === "failed" ? "失败" : stateLabel(item);
    const parts = [`· ${item.fileName}：${state}${progress}`];
    if (item.errMsg) parts.push(`  错误：${item.errMsg}${item.errCode ? `（code=${item.errCode}）` : ""}`);
    if (item.zipUrl) parts.push(`  结果包：${item.zipUrl}`);
    if (item.markdownUrl) parts.push(`  markdown：${item.markdownUrl}`);
    return parts;
  });

  // 需要下载时把完成的文件落盘
  const wantDownload = params.download === true;
  if (wantDownload) {
    const outputDir = params.output_dir?.trim() ? resolve(run.cwd, params.output_dir.trim()) : run.cwd;
    const jobs: Job[] = probe.results.map((item) => ({
      source: item.fileName,
      kind: "url",
      fileName: item.fileName,
      dataId: item.dataId,
      outputDir,
      target: probe.target,
      result: item,
      error: item.settled === "failed" ? item.errMsg ?? "解析失败" : undefined,
    }));

    for (const [index, job] of jobs.entries()) {
      if (job.error || job.result?.settled !== "done") continue;
      try {
        run.progress?.(`下载并落盘：${job.fileName}`);
        const document = await fetchContent(cfg, job, run.signal);
        job.saved = await saveParsedDocument({
          markdown: document.markdown,
          assets: document.assets,
          sourceName: job.fileName,
          outputDir,
        });
        files[index].markdownPath = job.saved.markdownPath;
        files[index].markdownBytes = job.saved.markdownBytes;
        files[index].markdownLines = job.saved.markdownLines;
        files[index].assetCount = job.saved.assetCount;
        files[index].assetDir = job.saved.assetDir;
        blocks[index].push(`  → 已落盘：${job.saved.markdownPath}（${formatSize(job.saved.markdownBytes)} / ${job.saved.markdownLines} 行）`);
      } catch (err) {
        const reason = messageOf(err);
        files[index].error = reason;
        blocks[index].push(`  → 落盘失败：${reason}`);
      }
    }
  } else if (probe.results.some((item) => item.settled === "done")) {
    blocks.push(["（要下载并落盘 markdown，请带 download=true 再查一次）"]);
  }

  const body = blocks.map((parts) => parts.join("\n"));
  return { content: [header, ...body].join("\n"), details: { id, api: probe.target.api, found: true, files } };
}

/* ------------------------------ 工具定义 ------------------------------ */

/**
 * 流式进度用的占位结果：onUpdate 的类型要求 details 必填，
 * 但 isPartial 渲染只读正文文字，不看 details（最终结果才是完整 details）。
 */
function progressResult(text: string): AgentToolResult<MineruParseDetails> {
  return {
    content: [{ type: "text", text }],
    details: {
      api: "standard",
      modelVersion: "",
      fileCount: 0,
      files: [],
      elapsedMs: 0,
      timedOut: false,
      submittedOnly: false,
      forcedHtmlModel: false,
    },
  };
}

function createParseTool() {
  return defineTool<typeof parseParamsSchema, MineruParseDetails>({
    name: "mineru_parse",
    label: "mineru_parse",
    description:
      "用 MinerU 解析文档（PDF、图片、doc/docx、ppt/pptx、xls/xlsx、html）并转成 markdown 落盘，扫描件与复杂版面也能读。支持本地文件与远程 URL，可批量；内部会轮询到解析完成再下载结果。配了 MINERU_API_KEY 走 v4 标准接口（≤200MB/≤200 页/单次 ≤50 个），否则退回免 Token 的 v1 轻量接口（≤10MB/≤20 页且仅单文件）。",
    promptSnippet: "Parse PDF/Office/image/HTML documents into markdown via MinerU",
    promptGuidelines: [
      "当需要读 PDF、扫描件、图片、docx/pptx/xlsx 或 HTML 文档内容时，用 mineru_parse 先把文件转成 markdown，再用 read 工具读落盘后的 .md 路径，不要试图直接 read 二进制文档。",
      "mineru_parse 默认等解析完成并落盘 markdown（本地文件写在源文件同目录的同名 .md，远程 URL 写在当前工作目录），结果里的路径可直接交给 read；正文很长时优先分段 read 而不是整篇塞进上下文。",
      "mineru_parse 的 sources 数组一次可传多个文件（v4 标准接口上限 50）；只解析部分页码时用 page_ranges（如 \"1-10\"），扫描件没有文字层时加 is_ocr=true。",
      "mineru_parse 返回 pending 或用 wait=false 提前返回时，用 mineru_query 按返回的 task_id / batch_id 续查并下载结果。",
    ],
    parameters: parseParamsSchema,

    async execute(_toolCallId, params: ParseParams, signal, onUpdate, ctx: ExtensionContext) {
      const cfg = loadConfig();
      onUpdate?.(progressResult(`提交 MinerU 解析：${params.sources.length} 个文件 …`));

      const { content, details } = await runParse(cfg, params, {
        cwd: ctx.cwd,
        signal,
        progress: (text) => onUpdate?.(progressResult(text)),
      });

      return { content: [{ type: "text", text: content }], details };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      const count = args.sources?.length ?? 0;
      const first = args.sources?.[0] ?? "";
      const suffix = count > 1 ? ` 等 ${count} 个文件` : "";
      return renderCallLine(`MinerU 解析 ${first}${suffix}`, theme);
    },

    renderResult(
      result: AgentToolResult<MineruParseDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const files = result.details?.files ?? [];
      const ok = files.filter((file) => file.status === "done").length;
      const bad = files.filter((file) => file.status === "failed").length;
      const pending = files.length - ok - bad;
      const header = `成功 ${ok}${bad > 0 ? ` · 失败 ${bad}` : ""}${pending > 0 ? ` · 进行中 ${pending}` : ""}`;
      return renderResultSummary(result, options, theme, header, getElapsedMs(context), 12);
    },
  });
}

function createQueryTool() {
  return defineTool<typeof queryParamsSchema, MineruQueryDetails>({
    name: "mineru_query",
    label: "mineru_query",
    description:
      "按 task_id 或 batch_id 查询 MinerU 解析任务的状态与结果链接（接口类型自动探测）。任务已完成时可带 download=true 直接下载并落盘 markdown。",
    promptSnippet: "Query MinerU parse task status by task_id / batch_id",
    promptGuidelines: [
      "mineru_query 用于 mineru_parse 返回「未完成 / 仅提交」后查询进度，id 填返回的 task_id 或 batch_id；要拿到 markdown 落盘就带 download=true。",
    ],
    parameters: queryParamsSchema,

    async execute(_toolCallId, params: QueryParams, signal, _onUpdate, ctx: ExtensionContext) {
      const cfg = loadConfig();
      const { content, details } = await runQuery(cfg, params, { cwd: ctx.cwd, signal });
      return { content: [{ type: "text", text: content }], details };
    },

    renderCall(args, theme, context) {
      context.state.startedAt = Date.now();
      return renderCallLine(`MinerU 查询 ${args.id}${args.download ? "（下载）" : ""}`, theme);
    },

    renderResult(
      result: AgentToolResult<MineruQueryDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const details = result.details;
      const header = details?.found
        ? `状态：${details.files.map((file) => `${file.fileName} ${file.state ?? "?"}`).join(" · ")}`
        : "未找到任务";
      return renderResultSummary(result, options, theme, header, getElapsedMs(context), 20);
    },
  });
}

/* ------------------------------ /mineru 命令 ------------------------------ */

/** 配置状态文本 */
function buildStatusText(): string {
  const cfg = loadConfig();
  const mode = resolveApiMode(cfg);
  const keyLine = cfg.apiKey ? `已配置（来源：${cfg.apiKeySource}）` : "未配置 —— 只能用 v1 轻量接口（免 Token，≤10MB/≤20 页）";
  const envHint = cfg.envFilePath ?? ENV_FILE_CANDIDATES[ENV_FILE_CANDIDATES.length - 1] ?? "~/.pi/agent/extensions/mineru/.env";

  return [
    "MinerU 状态",
    `· 接口地址：${cfg.baseUrl}`,
    `· API Key：${keyLine}`,
    `· 接口选择：MINERU_API=${cfg.apiMode} → 当前用 ${mode === "standard" ? "v4 标准接口" : "v1 轻量接口"}`,
    `· 默认模型：${cfg.modelVersion}（vlm / pipeline / MinerU-HTML）`,
    `· 默认语言：${cfg.language}`,
    `· 轮询间隔：${cfg.pollIntervalMs} ms ｜ 最长等待：${cfg.maxWaitMs} ms ｜ 请求超时：${cfg.timeoutMs} ms`,
    `· 落盘规则：本地文件 → 源文件同目录同名 .md（+ .assets/ 图片）；远程 URL → 当前工作目录`,
    `· 配置文件：${envHint}`,
    "",
    "用法：",
    "  /mineru                            查看状态",
    "  /mineru parse <路径或URL> [更多…]   手动解析（等待完成并落盘）",
    "  /mineru task <task_id|batch_id>    查询任务状态（加 --download 落盘）",
  ].join("\n");
}

/* ------------------------------ 扩展入口 ------------------------------ */

export default function mineruExtension(pi: ExtensionAPI): void {
  /* 会话开始：没配 Key 时提示一次当前能力边界 */
  pi.on("session_start", (_event, ctx) => {
    const cfg = loadConfig();
    if (!cfg.apiKey && ctx.hasUI) {
      const envPath = cfg.envFilePath ?? ENV_FILE_CANDIDATES[ENV_FILE_CANDIDATES.length - 1];
      ctx.ui.notify(
        `mineru 未配置 MINERU_API_KEY：当前只能用 v1 轻量接口（≤${AGENT_MAX_FILE_MB}MB / ≤${AGENT_MAX_PAGES} 页 / 单文件），可在 ${envPath} 写入 MINERU_API_KEY=sk-… 解锁 v4 标准接口。`,
        "warning",
      );
    }
  });

  pi.registerTool(createParseTool());
  pi.registerTool(createQueryTool());

  pi.registerCommand("mineru", {
    description: "查看 MinerU 配置状态，或手动解析文档 / 查询任务",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      // 无参数：打印配置状态
      if (!sub) {
        ctx.ui.notify(buildStatusText(), "info");
        return;
      }

      const cfg = loadConfig();

      if (sub === "parse") {
        const sources = parts.slice(1).filter((part) => !part.startsWith("--"));
        if (sources.length === 0) {
          ctx.ui.notify("用法：/mineru parse <文件路径或URL> [更多文件…]", "error");
          return;
        }
        try {
          const { content } = await runParse(
            cfg,
            { sources },
            {
              cwd: ctx.cwd,
              signal: ctx.signal,
              progress: (text) => ctx.ui.setStatus("mineru", text.split("\n")[0]),
            },
          );
          ctx.ui.notify(limitLines(content, COMMAND_MAX_LINES), "info");
        } finally {
          ctx.ui.setStatus("mineru", undefined);
        }
        return;
      }

      if (sub === "task" || sub === "query") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("用法：/mineru task <task_id 或 batch_id> [--download]", "error");
          return;
        }
        const { content } = await runQuery(cfg, { id, download: parts.includes("--download") }, {
          cwd: ctx.cwd,
          signal: ctx.signal,
        });
        ctx.ui.notify(limitLines(content, COMMAND_MAX_LINES), "info");
        return;
      }

      ctx.ui.notify(
        `未知子命令「${sub}」。可用：/mineru、/mineru parse <路径或URL>、/mineru task <task_id|batch_id>`,
        "error",
      );
    },
  });
}
