/**
 * mineru 扩展 —— TUI 渲染辅助
 *
 *  - 默认一行摘要（文件数 / 成功数 / 耗时）
 *  - 流式阶段直接展示最新一行进度（轮询可能持续几分钟，需要看得见页码进度）
 *  - 展开时预览正文前若干行
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

/** 渲染工具调用标题行 */
export function renderCallLine(line: string, theme: Theme): Component {
  return new Text(theme.fg("toolTitle", theme.bold(line)), 0, 0);
}

/** 结果详情中渲染需要的字段 */
interface RenderDetails {
  truncation?: { truncated: boolean };
  timedOut?: boolean;
}

/** 从渲染状态中计算已耗时（renderCall 记录 startedAt 之后） */
export function getElapsedMs(context: { state: Record<string, unknown> }): number | undefined {
  const startedAt = context.state.startedAt as number | undefined;
  return startedAt === undefined ? undefined : Date.now() - startedAt;
}

/** 取结果正文（content 里混有图片内容块，这里只挑文本） */
function firstText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

/** 渲染结果摘要：标题 + 状态标记；展开时附正文预览 */
export function renderResultSummary(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  header: string,
  elapsedMs?: number,
  previewLines = 20,
): Component {
  const body = firstText(result);

  if (options.isPartial) {
    // 流式阶段展示最新一行进度，让长轮询可观测
    const line = body.split("\n").find((item) => item.trim()) ?? "等待 MinerU 解析 …";
    return new Text(theme.fg("dim", line), 0, 0);
  }

  const details = result.details as RenderDetails | undefined;

  let text = header;
  if (details?.timedOut) text += theme.fg("warning", "（仍在解析）");
  if (details?.truncation?.truncated) text += theme.fg("warning", "（预览已截断）");
  if (elapsedMs !== undefined) text += theme.fg("muted", ` · ${(elapsedMs / 1000).toFixed(1)}s`);

  if (options.expanded && body) {
    const lines = body.split("\n");
    for (const line of lines.slice(0, previewLines)) {
      text += `\n${theme.fg("dim", line || " ")}`;
    }
    if (lines.length > previewLines) {
      text += `\n${theme.fg("muted", `…（共 ${lines.length} 行）`)}`;
    }
  }

  return new Text(text, 0, 0);
}
