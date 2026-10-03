/**
 * sciverse 扩展 —— TUI 渲染辅助
 *
 * 提供工具调用标题与结果摘要的统一渲染：
 *  - 默认一行摘要（命中数 / 字数 / 字节数 / 缓存命中 / 耗时）
 *  - 展开时预览正文前若干行，并给出截断后完整内容的落盘路径
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

/** 渲染工具调用标题行 */
export function renderCallLine(line: string, theme: Theme): Component {
  return new Text(theme.fg("toolTitle", theme.bold(line)), 0, 0);
}

/** 结果详情中渲染需要的字段 */
interface RenderDetails {
  truncation?: { truncated: boolean };
  fullOutputPath?: string;
}

/** 从渲染状态中计算已耗时（renderCall 记录 startedAt 之后） */
export function getElapsedMs(context: { state: Record<string, unknown> }): number | undefined {
  const startedAt = context.state.startedAt as number | undefined;
  return startedAt === undefined ? undefined : Date.now() - startedAt;
}

/** 渲染结果摘要：标题 + 截断/耗时标记；展开时附正文预览 */
export function renderResultSummary(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  header: string,
  elapsedMs?: number,
  previewLines = 20,
  partialLabel = "查询 Sciverse …",
): Component {
  if (options.isPartial) {
    return new Text(theme.fg("dim", partialLabel), 0, 0);
  }

  const details = result.details as RenderDetails | undefined;

  let text = header;
  if (details?.truncation?.truncated) text += theme.fg("warning", "（已截断）");
  if (elapsedMs !== undefined) text += theme.fg("muted", ` · ${(elapsedMs / 1000).toFixed(1)}s`);

  if (options.expanded) {
    const first = result.content[0];
    const body = first?.type === "text" && first.text ? first.text : "";
    if (body) {
      const lines = body.split("\n");
      for (const line of lines.slice(0, previewLines)) {
        text += `\n${theme.fg("dim", line || " ")}`;
      }
      if (lines.length > previewLines) {
        const hint = details?.fullOutputPath ? `，完整内容见 ${details.fullOutputPath}` : "";
        text += `\n${theme.fg("muted", `…（共 ${lines.length} 行${hint}）`)}`;
      }
    }
  }

  return new Text(text, 0, 0);
}
