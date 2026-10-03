/**
 * pwsh_read —— 读取文本文件
 *
 * 基于 Get-Content，支持 offset / limit 行号区间读取；
 * 先统计总行数便于 LLM 判断文件规模，结果保留开头（head 方向截断）。
 *
 * 作者：云枫
 * 创建时间：2026-09-07
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";

import { getElapsedMs, makeToolUpdate, psQuote, renderCallCommon, renderResultCommon, runPowerShell } from "../core.js";
import { readParamsSchema, type PwshReadDetails, type ReadParams } from "../types.js";

/** 生成读取命令：统计行数后按 offset / limit 切片输出 */
function buildReadCommand(path: string, offset: number, limit: number | undefined): string {
  const parts = [
    `$lines = @(Get-Content -LiteralPath ${psQuote(path)})`,
    `"共 $($lines.Count) 行"`,
  ];

  let pipeline = "$lines";
  if (offset > 1) {
    pipeline += ` | Select-Object -Skip ${offset - 1}`;
  }
  if (limit !== undefined && limit > 0) {
    pipeline += ` | Select-Object -First ${limit}`;
  }
  parts.push(pipeline, `if (-not $?) { exit 1 }`);
  return parts.join("\n");
}

export function createPwshReadTool(): ToolDefinition {
  return {
    name: "pwsh_read",
    label: "pwsh_read",
    description:
      "读取文本文件（PowerShell Get-Content），支持 offset（起始行号，从 1 开始）与 limit（最多行数）读取指定区间；输出显示文件总行数并截断至开头部分。",
    promptSnippet: "Read a text file (PowerShell Get-Content)",
    promptGuidelines: [
      "在读取 Windows / PowerShell 环境的文件时使用 pwsh_read；超大文件请用 pwsh_exec 配合 Get-Content 分块读取。",
    ],
    parameters: readParamsSchema,

    async execute(_toolCallId, params: ReadParams, signal, onUpdate, ctx: ExtensionContext) {
      const path = params.path;
      const offset = Math.max(1, Math.floor(params.offset ?? 1));
      const limit = params.limit !== undefined ? Math.max(0, Math.floor(params.limit)) : undefined;
      // limit 为 0 视为不限制，避免 Select-Object -First 0 返回空
      const effectiveLimit = limit === 0 ? undefined : limit;

      const result = await runPowerShell(buildReadCommand(path, offset, effectiveLimit), ctx, {
        signal,
        truncateMode: "head",
        onUpdate: makeToolUpdate(onUpdate),
      });

      const totalLines = parseTotalLines(result.content);
      const details: PwshReadDetails = {
        exitCode: result.exitCode,
        path,
        offset,
        limit: effectiveLimit,
        totalLines,
        truncation: result.details.truncation,
        fullOutputPath: result.details.fullOutputPath,
      };
      return { content: [{ type: "text", text: result.content }], details };
    },

    renderCall(args: ReadParams, theme: Theme, context: { state: Record<string, unknown> }) {
      context.state.startedAt = Date.now();
      let suffix = "";
      if (args.offset !== undefined) suffix += ` ${args.offset}`;
      if (args.limit !== undefined) suffix += ` -${args.limit}`;
      return renderCallCommon(`read ${args.path}${suffix}`, theme);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: PwshReadDetails },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const header = `${result.details?.totalLines ?? "?"} 行：${result.details?.path ?? ""}`;
      return renderResultCommon(result, options, theme, header, getElapsedMs(context));
    },
  };
}

/** 从输出中解析「共 N 行」计数 */
function parseTotalLines(content: string): number {
  const match = content.match(/共 (\d+) 行/);
  return match ? Number(match[1]) : 0;
}