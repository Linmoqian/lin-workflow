/**
 * test-pilot 状态栏渲染
 *
 * 职责：把队列状态渲染为
 * 1. footer 单行摘要（ctx.ui.setStatus）
 * 2. 编辑器上方多行面板（ctx.ui.setWidget）：进度条 + 每任务状态图标
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CompletedTask, QueueState, TestTaskConfig } from "./types.ts";

const WIDGET_KEY = "test-pilot";
const STATUS_KEY = "test-pilot";

/** 进度条总格数 */
const BAR_WIDTH = 20;

/** 毫秒 -> 可读时长 */
export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${s % 60}s`;
}

/** 计算整体进度百分比：完成任务数 + 当前任务内部进度加权 */
function overallPercent(state: QueueState): number | null {
	const total = state.pending.length + (state.current ? 1 : 0) + state.completed.length;
	if (total === 0) return null;
	const done =
		state.completed.length + (state.current?.progressPercent !== null && state.current ? state.current.progressPercent! / 100 : 0);
	return Math.min(100, Math.round((done / total) * 100));
}

/** 进度条字符串，如 "████████████░░░░░░░░" */
function progressBar(percent: number): string {
	const filled = Math.round((percent / 100) * BAR_WIDTH);
	return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

/** 任务状态图标（pending ○ / running ⟳ / passed ✓ / failed ✗ / 终止 ⊘ / 跳过 ▸） */
function statusIcon(status: CompletedTask["status"] | "pending" | "running", theme: Theme): string {
	switch (status) {
		case "passed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "cancelled":
		case "timeout":
			return theme.fg("warning", "⊘");
		case "skipped":
			return theme.fg("dim", "▸");
		case "running":
			return theme.fg("accent", "⟳");
		default:
			return theme.fg("dim", "○");
	}
}

/** footer 单行摘要 */
export function renderFooter(state: QueueState, lastBatch: CompletedTask[] | null, theme: Theme): string {
	const label = theme.fg("muted", "Tests ");

	if (state.current || state.pending.length > 0) {
		const pct = overallPercent(state);
		const bar = pct !== null ? ` ${progressBar(pct)} ${String(pct).padStart(3)}%` : "";
		const parts: string[] = [];
		if (state.completed.length > 0) parts.push(theme.fg("success", `✓${state.completed.filter((c) => c.status === "passed").length}`));
		const failed = state.completed.filter((c) => c.status === "failed").length;
		if (failed > 0) parts.push(theme.fg("error", `✗${failed}`));
		const skipped = state.completed.filter((c) => c.status === "skipped").length;
		if (skipped > 0) parts.push(theme.fg("dim", `▸${skipped}`));
		if (state.current) parts.push(theme.fg("accent", `⟳ ${state.current.config.name}`));
		if (state.pending.length > 0) parts.push(theme.fg("dim", `○${state.pending.length}`));
		return label + bar + (parts.length ? " " + parts.join(" ") : "");
	}

	// 无活跃批次：显示最近一次批次结果
	if (lastBatch && lastBatch.length > 0) {
		const passed = lastBatch.filter((c) => c.status === "passed").length;
		const totalMs = lastBatch.reduce((s, c) => s + (c.finishedAt - c.startedAt), 0);
		if (passed === lastBatch.length) {
			return label + theme.fg("success", `✓ ${passed}/${lastBatch.length}`) + theme.fg("dim", ` (${formatDuration(totalMs)})`);
		}
		return label + theme.fg("error", `✗ ${passed}/${lastBatch.length} 通过`);
	}

	return "";
}

/** 编辑器上方多行面板 */
export function renderWidget(state: QueueState, lastBatch: CompletedTask[] | null, theme: Theme): string[] {
	const lines: string[] = [];

	if (state.current || state.pending.length > 0) {
		const pct = overallPercent(state);
		lines.push(theme.fg("muted", "Tests"));
		if (pct !== null) {
			lines.push(
				theme.fg("accent", progressBar(pct)) +
					theme.fg("dim", ` ${String(pct).padStart(3)}%`),
			);
		}
		lines.push("");

		for (const c of state.completed) {
			const icon = statusIcon(c.status, theme);
			const meta =
				c.status === "timeout"
					? ` 超时`
					: c.status === "cancelled"
						? ` 已取消`
						: c.status === "skipped"
							? ` 已跳过（门禁未通过）`
							: ` (${formatDuration(c.finishedAt - c.startedAt)})`;
			lines.push(`${icon} ${theme.fg("muted", c.config.name)}${theme.fg("dim", meta)}`);
		}
		if (state.current) {
			const pctText =
				state.current.progressPercent !== null ? ` ${state.current.progressPercent}%` : "";
			lines.push(
				`${statusIcon("running", theme)} ${theme.fg("muted", state.current.config.name)}${theme.fg("accent", pctText)}`,
			);
		}
		for (const p of state.pending) {
			lines.push(`${statusIcon("pending", theme)} ${theme.fg("dim", p.name)}`);
		}
		return lines;
	}

	// 空闲：显示最近批次摘要（保持可见，直到下一次 /test 覆盖）
	if (lastBatch && lastBatch.length > 0) {
		lines.push(theme.fg("muted", "Tests"));
		for (const c of lastBatch) {
			const icon = statusIcon(c.status, theme);
			const meta =
				c.status === "timeout"
					? " 超时"
					: c.status === "cancelled"
						? " 已取消"
						: c.status === "skipped"
							? " 已跳过（门禁未通过）"
							: ` (${formatDuration(c.finishedAt - c.startedAt)})`;
			lines.push(`${icon} ${theme.fg("muted", c.config.name)}${theme.fg("dim", meta)}`);
		}
		return lines;
	}

	return [];
}

/** UI 上下文接口：避免直接依赖完整 ExtensionContext，便于测试 */
export interface StatusUI {
	setStatus: (key: string, text: string | undefined) => void;
	setWidget: (key: string, lines: string[] | undefined, options?: { placement?: string }) => void;
	theme: Theme;
}

/** 统一刷新入口：footer + widget 同步更新 */
export function updateStatusUI(
	ui: StatusUI | null,
	state: QueueState,
	lastBatch: CompletedTask[] | null,
): void {
	if (!ui) return;
	const theme = ui.theme;

	const footer = renderFooter(state, lastBatch, theme);
	if (footer) ui.setStatus(STATUS_KEY, footer);
	else ui.setStatus(STATUS_KEY, undefined);

	const widgetLines = renderWidget(state, lastBatch, theme);
	if (widgetLines.length > 0) ui.setWidget(WIDGET_KEY, widgetLines);
	else ui.setWidget(WIDGET_KEY, undefined);
}

/** 清空本扩展的全部 UI 痕迹 */
export function clearStatusUI(ui: StatusUI | null): void {
	if (!ui) return;
	ui.setStatus(STATUS_KEY, undefined);
	ui.setWidget(WIDGET_KEY, undefined);
}

/** 供命令补全使用：列出任务配置名 */
export function taskNames(tasks: TestTaskConfig[]): string[] {
	return tasks.map((t) => t.name);
}
