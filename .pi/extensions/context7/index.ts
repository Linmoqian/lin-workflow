/**
 * context7 扩展 —— 入口
 *
 * 解决「模型不了解最新技术文档」的问题：把 Context7 的库文档检索能力接成两个工具，
 * 让模型在写代码前先拉取目标库的实时文档片段，而不是凭记忆猜 API：
 *  - context7_search_library：按库名 / 问题搜索候选库，拿到精确的 libraryId
 *  - context7_get_docs：      按 libraryId + 具体问题拉取相关文档片段（txt，直接进上下文）
 *
 * 另有 /context7 命令查看配置状态或手动检索；文档结果在会话内缓存，切换会话即清空。
 *
 * 安装位置：~/.pi/agent/extensions/context7/（全局自动发现，可 /reload 热加载）
 * 配置：同目录 .env（见 .env.example），也可用同名进程环境变量覆盖。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";

import { clampDocsTokens, ENV_FILE_CANDIDATES, loadConfig } from "./config.ts";
import { clearDocsCache, docsCacheSize, fetchDocs, searchLibraries } from "./client.ts";
import { getElapsedMs, renderCallLine, renderResultSummary } from "./render.ts";
import {
  docsParamsSchema,
  searchParamsSchema,
  type Context7DocsDetails,
  type Context7Library,
  type Context7SearchDetails,
  type DocsParams,
  type SearchParams,
} from "./types.ts";

/* ------------------------------ 常量 ------------------------------ */

/** 搜索候选的展示条数上限 */
const MAX_SHOWN_CANDIDATES = 8;

/** 候选描述的展示字数上限 */
const DESCRIPTION_MAX_CHARS = 220;

/** 生成截断后完整文档的临时文件前缀 */
const TEMP_FILE_PREFIX = "pi-context7-";

/** /context7 命令输出给用户的行数上限 */
const COMMAND_MAX_LINES = 40;

/* ------------------------------ 格式化 ------------------------------ */

/** 裁剪超长文本并补省略号 */
function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}

/** 把候选库列表格式化给模型看（含元信息，帮助判断该选哪个） */
function formatSearchResults(results: Context7Library[], libraryName: string): string {
  if (results.length === 0) {
    return [
      `Context7 未找到与「${libraryName}」相关的候选。`,
      "换用更通用的名称重试（如 react、next.js、fastapi、tauri），或在 libraryName 里带上厂商名。",
    ].join("\n");
  }

  const shown = results.slice(0, MAX_SHOWN_CANDIDATES);
  const items = shown.map((item, index) => {
    const meta: string[] = [];
    if (typeof item.totalSnippets === "number") meta.push(`片段 ${item.totalSnippets}`);
    if (typeof item.totalTokens === "number") meta.push(`文档约 ${Math.round(item.totalTokens / 1000)}k tokens`);
    if (typeof item.trustScore === "number") meta.push(`信任分 ${item.trustScore}`);
    if (typeof item.stars === "number" && item.stars >= 0) meta.push(`★${item.stars}`);
    if (item.lastUpdateDate) meta.push(`更新 ${item.lastUpdateDate.slice(0, 10)}`);

    let block = `${index + 1}. ${item.id} — ${item.title}`;
    if (item.description) block += `\n   ${clip(item.description, DESCRIPTION_MAX_CHARS)}`;
    if (meta.length > 0) block += `\n   ${meta.join(" · ")}`;
    if (Array.isArray(item.versions) && item.versions.length > 0) {
      const versions = item.versions.slice(0, 6).join(", ");
      const more = item.versions.length > 6 ? " …" : "";
      block += `\n   可用版本: ${versions}${more}`;
    }
    return block;
  });

  const header = [
    `找到 ${results.length} 个候选（显示前 ${shown.length} 个）。`,
    "下一步用 context7_get_docs，libraryId 填上面的路径（需要固定版本时追加 /版本号，如 /vercel/next.js/v15.1.8），query 填具体问题。",
  ].join("\n");

  return `${header}\n\n${items.join("\n\n")}`;
}

/** 截断提示文案：给出完整文档的落盘路径 */
function buildDocsTruncationFooter(truncation: { outputLines: number; outputBytes: number; totalLines: number }, fullOutputPath: string): string {
  return (
    `\n\n[文档已截断：显示前 ${truncation.outputLines} 行（${formatSize(truncation.outputBytes)}），` +
    `共 ${truncation.totalLines} 行。完整内容：${fullOutputPath}]`
  );
}

/** 把完整文档写入临时文件，返回路径 */
async function persistFullText(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_FILE_PREFIX));
  const file = join(dir, "docs.txt");
  await writeFile(file, text, "utf8");
  return file;
}

/** 命令输出限行，避免刷屏（超出时提示剩余行数） */
function limitLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…（共 ${lines.length} 行，已省略 ${lines.length - maxLines} 行）`;
}

/* ------------------------------ 工具：搜索库 ------------------------------ */

function createSearchTool(): ToolDefinition {
  return {
    name: "context7_search_library",
    label: "context7_search_library",
    description:
      "通过 Context7 按名称 / 问题搜索第三方库，返回候选列表（含精确 libraryId、更新时间、文档规模、可用版本）。在拉取文档前先用它解析 libraryId。",
    promptSnippet: "Search Context7 for a library by name and get its exact libraryId",
    promptGuidelines: [
      "当任务涉及第三方库 / 框架 / 服务的最新用法、配置或版本差异时，先用 context7_search_library 解析库 ID，再用 context7_get_docs 拉取文档，并依据文档内容作答，不要凭记忆猜测 API。",
      "context7_search_library 的 libraryName 用库的通用名（如 next.js、react、fastapi），query 写用户的具体问题以获得更好的排序。",
    ],
    parameters: searchParamsSchema,

    async execute(_toolCallId, params: SearchParams, signal, onUpdate, _ctx: ExtensionContext) {
      onUpdate?.({ content: [{ type: "text", text: `检索 Context7：${params.libraryName} …` }], details: undefined });

      const cfg = loadConfig();
      const { results } = await searchLibraries(
        cfg,
        { libraryName: params.libraryName, query: params.query },
        signal,
      );

      const details: Context7SearchDetails = {
        libraryName: params.libraryName,
        query: params.query,
        count: results.length,
        results,
      };
      return { content: [{ type: "text", text: formatSearchResults(results, params.libraryName) }], details };
    },

    renderCall(args: SearchParams, theme: Theme, context: { state: Record<string, unknown> }) {
      context.state.startedAt = Date.now();
      const suffix = args.query ? ` "${args.query}"` : "";
      return renderCallLine(`context7 搜索 ${args.libraryName}${suffix}`, theme);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: Context7SearchDetails },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const count = result.details?.count ?? 0;
      return renderResultSummary(
        result,
        options,
        theme,
        `候选库 ${count} 个`,
        getElapsedMs(context),
      );
    },
  };
}

/* ------------------------------ 工具：拉取文档 ------------------------------ */

function createDocsTool(): ToolDefinition {
  return {
    name: "context7_get_docs",
    label: "context7_get_docs",
    description:
      "从 Context7 拉取指定库中与 query 相关的实时文档片段（代码示例 + 来源链接）。结果较长时保留开头并给出完整内容路径，token 预算可调。",
    promptSnippet: "Fetch up-to-date documentation snippets for a library from Context7",
    promptGuidelines: [
      "context7_get_docs 需要精确的 libraryId（形如 /vercel/next.js，可带版本 /vercel/next.js/v15.1.8），不确定时先用 context7_search_library 解析。",
      "context7_get_docs 的 query 写具体问题（如 app router middleware matcher），不要只写库名；一个问题是拉不到内容时，换个更具体的说法再试。",
    ],
    parameters: docsParamsSchema,

    async execute(_toolCallId, params: DocsParams, signal, onUpdate, _ctx: ExtensionContext) {
      const cfg = loadConfig();
      const tokens = clampDocsTokens(params.tokens, cfg.defaultDocsTokens);

      onUpdate?.({
        content: [{ type: "text", text: `拉取 Context7 文档：${params.libraryId} …` }],
        details: undefined,
      });

      const { text, fromCache } = await fetchDocs(
        cfg,
        { libraryId: params.libraryId, query: params.query, tokens },
        signal,
      );

      const body = text.trim() || "(Context7 未返回匹配内容：请换更具体的 query，或确认 libraryId 是否正确)";
      const headerLine = `Context7 文档｜${params.libraryId}｜query: ${params.query}｜预算 ${tokens} tokens${
        fromCache ? "｜会话缓存命中" : ""
      }`;
      const fullText = `${headerLine}\n\n${body}`;

      const truncation = truncateHead(fullText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      let content = truncation.content;

      const details: Context7DocsDetails = {
        libraryId: params.libraryId,
        query: params.query,
        tokens,
        chars: body.length,
        fromCache,
      };

      if (truncation.truncated) {
        const fullOutputPath = await persistFullText(fullText);
        details.truncation = truncation;
        details.fullOutputPath = fullOutputPath;
        content += buildDocsTruncationFooter(truncation, fullOutputPath);
      }

      return { content: [{ type: "text", text: content }], details };
    },

    renderCall(args: DocsParams, theme: Theme, context: { state: Record<string, unknown> }) {
      context.state.startedAt = Date.now();
      return renderCallLine(`context7 文档 ${args.libraryId} "${args.query}"`, theme);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: Context7DocsDetails },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const details = result.details;
      let header = `${details?.chars ?? 0} 字符`;
      if (details?.tokens !== undefined) header += ` · 预算 ${details.tokens} tokens`;
      if (details?.fromCache) header += " · 缓存命中";
      return renderResultSummary(result, options, theme, header, getElapsedMs(context), 30);
    },
  };
}

/* ------------------------------ /context7 命令 ------------------------------ */

/** 配置状态文本 */
function buildStatusText(): string {
  const cfg = loadConfig();

  const keyLine = cfg.apiKey
    ? `已配置（来源：${cfg.apiKeySource}）`
    : "未配置 —— 匿名限额约 200 次/小时，配置密钥后约 1000 次/小时";

  const envHint = cfg.envFilePath ?? ENV_FILE_CANDIDATES[ENV_FILE_CANDIDATES.length - 1] ?? "~/.pi/agent/extensions/context7/.env";

  return [
    "Context7 状态",
    `· 接口地址：${cfg.baseUrl}`,
    `· API Key：${keyLine}`,
    `· 默认文档预算：${cfg.defaultDocsTokens} tokens（CONTEXT7_DEFAULT_TOKENS）`,
    `· 请求超时：${cfg.timeoutMs} ms（CONTEXT7_TIMEOUT_MS）`,
    `· 文档缓存：${docsCacheSize()} 条（会话内有效，切换会话即清空）`,
    `· 配置文件：${envHint}`,
    "",
    "用法：",
    "  /context7                                   查看状态",
    "  /context7 search <库名> [查询词]            搜索候选库",
    "  /context7 docs <libraryId> <查询词>         拉取文档片段",
  ].join("\n");
}

/* ------------------------------ 扩展入口 ------------------------------ */

export default function context7Extension(pi: ExtensionAPI): void {
  /* 会话开始：清空文档缓存；未配置密钥时给一次提示 */
  pi.on("session_start", (_event, ctx) => {
    clearDocsCache();

    const cfg = loadConfig();
    if (!cfg.apiKey && ctx.hasUI) {
      const envPath = cfg.envFilePath ?? ENV_FILE_CANDIDATES[ENV_FILE_CANDIDATES.length - 1];
      ctx.ui.notify(
        `context7 未配置 API Key：当前为匿名访问（约 200 次/小时）。可在 ${envPath} 写入 CONTEXT7_API_KEY=ctx7sk-… 提升配额。`,
        "warning",
      );
    }
  });

  pi.registerTool(createSearchTool());
  pi.registerTool(createDocsTool());

  pi.registerCommand("context7", {
    description: "查看 Context7 配置状态，或手动搜索库 / 拉取文档",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      // 无参数：打印配置状态
      if (!sub) {
        ctx.ui.notify(buildStatusText(), "info");
        return;
      }

      const cfg = loadConfig();

      if (sub === "search") {
        const libraryName = parts[1];
        if (!libraryName) {
          ctx.ui.notify("用法：/context7 search <库名> [查询词]", "error");
          return;
        }
        const query = parts.slice(2).join(" ") || undefined;
        const { results } = await searchLibraries(cfg, { libraryName, query }, ctx.signal);
        ctx.ui.notify(limitLines(formatSearchResults(results, libraryName), COMMAND_MAX_LINES), "info");
        return;
      }

      if (sub === "docs") {
        const libraryId = parts[1];
        const query = parts.slice(2).join(" ");
        if (!libraryId || !query) {
          ctx.ui.notify("用法：/context7 docs <libraryId> <查询词>，例如 /context7 docs /vercel/next.js middleware matcher", "error");
          return;
        }
        const { text, fromCache } = await fetchDocs(
          cfg,
          { libraryId, query, tokens: cfg.defaultDocsTokens },
          ctx.signal,
        );
        const body = text.trim() || "(Context7 未返回匹配内容)";
        const title = `Context7 文档｜${libraryId}${fromCache ? "｜缓存命中" : ""}`;
        ctx.ui.notify(limitLines(`${title}\n\n${body}`, COMMAND_MAX_LINES), "info");
        return;
      }

      ctx.ui.notify(`未知子命令「${sub}」。可用：/context7、/context7 search <库名> [查询词]、/context7 docs <libraryId> <查询词>`, "error");
    },
  });
}
