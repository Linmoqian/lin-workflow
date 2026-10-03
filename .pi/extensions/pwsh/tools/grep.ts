/**
 * pwsh_grep —— 按正则搜索文件内容
 *
 * 基于 Get-ChildItem + Select-String，输出「路径:行号:内容」格式，
 * 支持文件通配过滤与目录递归；结果保留开头（head 方向截断）。
 *
 * 作者：云枫
 * 创建时间：2026-09-07
 */

import { stat } from "node:fs/promises";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";

import { getElapsedMs, makeToolUpdate, psQuote, renderCallCommon, renderResultCommon, runPowerShell } from "../core.js";
import { grepParamsSchema, type GrepParams, type PwshGrepDetails } from "../types.js";

/** 生成搜索命令：先统计命中数，再按「路径:行号:内容」逐行输出 */
function buildGrepCommand(pattern: string, path: string, glob: string | undefined, recursive: boolean): string {
  const pathArg = psQuote(path);
  const recurseArg = recursive ? " -Recurse" : "";
  const globFilter = glob ? ` | Where-Object { $_.Name -like ${psQuote(glob)} }` : "";

  return [
    `$files = @(Get-ChildItem -LiteralPath ${pathArg}${recurseArg} -File -ErrorAction SilentlyContinue)${globFilter}`,
    `$hits = $files | Select-String -Pattern ${psQuote(pattern)}`,
    `"匹配 $($hits.Count) 处"`,
    `$hits | ForEach-Object { '{0}:{1}:{2}' -f $_.Path, $_.LineNumber, $_.Line }`,
    `if (-not $?) { exit 1 }`,
  ].join("\n");
}

export function createPwshGrepTool(): ToolDefinition {
  return {
    name: "pwsh_grep",
    label: "pwsh_grep",
    description:
      "在文件内容中按正则搜索（PowerShell Get-ChildItem + Select-String），输出「路径:行号:内容」。path 可以是文件或目录（目录默认不递归，recursive 开启递归），glob 按文件名通配过滤（如 *.ts）。",
    promptSnippet: "Search file contents with a regex (PowerShell Select-String)",
    promptGuidelines: [
      "在 Windows / PowerShell 环境的文件中搜索文本、定位引用位置时使用 pwsh_grep 代替 grep。",
    ],
    parameters: grepParamsSchema,

    async execute(_toolCallId, params: GrepParams, signal, onUpdate, ctx: ExtensionContext) {
      const pattern = params.pattern;
      const path = params.path || ".";
      const glob = params.glob;

      // 递归仅在目标是目录时生效；目标是文件时 -Recurse 会报错，需自动关闭
      let recursive = params.recursive ?? false;
      if (recursive) {
        const resolved = await stat(resolveWithinCwd(path, ctx.cwd)).catch(() => undefined);
        if (!resolved?.isDirectory()) {
          recursive = false;
        }
      }

      const result = await runPowerShell(buildGrepCommand(pattern, path, glob, recursive), ctx, {
        signal,
        truncateMode: "head",
        onUpdate: makeToolUpdate(onUpdate),
      });

      const matchCount = parseMatchCount(result.content);
      const details: PwshGrepDetails = {
        exitCode: result.exitCode,
        pattern,
        path,
        matchCount,
        truncation: result.details.truncation,
        fullOutputPath: result.details.fullOutputPath,
      };
      return { content: [{ type: "text", text: result.content }], details };
    },

    renderCall(args: GrepParams, theme: Theme, context: { state: Record<string, unknown> }) {
      context.state.startedAt = Date.now();
      let suffix = ` "${args.pattern}"${args.path ? ` ${args.path}` : ""}`;
      if (args.recursive) suffix += " -r";
      return renderCallCommon(`grep${suffix}`, theme);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: PwshGrepDetails },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const header = `${result.details?.matchCount ?? "?"} 处匹配：${result.details?.pattern ?? ""}`;
      return renderResultCommon(result, options, theme, header, getElapsedMs(context));
    },
  };
}

/** 将相对路径解析为可 stat 的绝对路径 */
function resolveWithinCwd(path: string, cwd: string): string {
  return path.startsWith(".") ? `${cwd}/${path}` : path;
}

/** 从输出中解析「匹配 N 处」计数 */
function parseMatchCount(content: string): number {
  const match = content.match(/匹配 (\d+) 处/);
  return match ? Number(match[1]) : 0;
}