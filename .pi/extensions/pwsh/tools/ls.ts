/**
 * pwsh_ls —— 列出目录内容
 *
 * 基于 Get-ChildItem，输出 Mode / 长度 / 修改时间 / 名称 表格，
 * 支持递归与包含隐藏项；结果保留开头（head 方向截断）。
 *
 * 作者：云枫
 * 创建时间：2026-09-07
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";

import { getElapsedMs, makeToolUpdate, psQuote, renderCallCommon, renderResultCommon, runPowerShell } from "../core.js";
import { lsParamsSchema, type LsParams, type PwshLsDetails } from "../types.js";

/** 生成列表命令：先统计项数，再输出排序后的表格 */
function buildLsCommand(path: string, recursive: boolean): string {
  const pathArg = psQuote(path);
  const recurseArg = recursive ? " -Recurse" : "";
  return [
    `$items = @(Get-ChildItem -LiteralPath ${pathArg}${recurseArg} -Force)`,
    `"共 $($items.Count) 项"`,
    `$items | Sort-Object PSIsContainer, LastWriteTime -Descending | Format-Table Mode, Length, LastWriteTime, Name -AutoSize | Out-String -Width 300`,
    `if (-not $?) { exit 1 }`,
  ].join("\n");
}

export function createPwshLsTool(): ToolDefinition {
  return {
    name: "pwsh_ls",
    label: "pwsh_ls",
    description:
      "列出目录内容（PowerShell Get-ChildItem），默认列出当前工作目录；recursive 递归子目录，包含隐藏项。输出为表格且截断至开头部分，完整输出在截断时给出临时文件路径。",
    promptSnippet: "List directory contents (PowerShell Get-ChildItem)",
    promptGuidelines: [
      "在 Windows / PowerShell 环境列目录、确认文件是否存在、查看目录结构时使用 pwsh_ls 代替 ls。",
    ],
    parameters: lsParamsSchema,

    async execute(_toolCallId, params: LsParams, signal, onUpdate, ctx: ExtensionContext) {
      const path = params.path || ".";
      const recursive = params.recursive ?? false;

      // 目标不存在时 Get-ChildItem 会报错，由 pwsh 自身给出错误信息
      const result = await runPowerShell(buildLsCommand(path, recursive), ctx, {
        signal,
        truncateMode: "head",
        onUpdate: makeToolUpdate(onUpdate),
      });

      const itemCount = parseItemCount(result.content);
      const details: PwshLsDetails = {
        exitCode: result.exitCode,
        path,
        recursive,
        itemCount,
        truncation: result.details.truncation,
        fullOutputPath: result.details.fullOutputPath,
      };
      return { content: [{ type: "text", text: result.content }], details };
    },

    renderCall(args: LsParams, theme: Theme, context: { state: Record<string, unknown> }) {
      context.state.startedAt = Date.now();
      const path = args.path || ".";
      const suffix = args.recursive ? " -r" : "";
      return renderCallCommon(`ls ${path}${suffix}`, theme);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: PwshLsDetails },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const header = `${result.details?.itemCount ?? "?"} 项：${result.details?.path ?? "."}`;
      return renderResultCommon(result, options, theme, header, getElapsedMs(context));
    },
  };
}

/** 从输出中解析「共 N 项」计数 */
function parseItemCount(content: string): number {
  const match = content.match(/共 (\d+) 项/);
  return match ? Number(match[1]) : 0;
}