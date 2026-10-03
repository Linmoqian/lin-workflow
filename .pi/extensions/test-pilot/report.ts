/**
 * test-pilot 结果注入
 *
 * 职责：批次结束后"敲 agent 的肩膀"——
 * - 有失败：通过 pi.sendMessage 注入完整失败报告（followUp 不打断当前工作），触发 agent 定位修复
 * - 全部通过：agent 忙碌时注入一行简报（保持上下文连续）；空闲时仅 notify，不消耗 token
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./statusbar.ts";
import type { CompletedTask } from "./types.ts";

/** 消息 customType，与 index.ts 中 registerMessageRenderer 对应 */
export const TEST_PILOT_MESSAGE_TYPE = "test-pilot";

/** 单个任务的结果行 */
function resultLine(c: CompletedTask): string {
	const base = `${c.config.name} (${formatDuration(c.finishedAt - c.startedAt)})`;
	switch (c.status) {
		case "passed":
			return `✓ ${base}`;
		case "failed":
			return `✗ ${base} — 退出码 ${c.exitCode ?? "unknown"}`;
		case "timeout":
			return `⊘ ${base} — 超时`;
		case "cancelled":
			return `⊘ ${base} — 已取消`;
		case "skipped":
			return `▸ ${base} — 已跳过（门禁未通过）`;
	}
}

/** 失败任务的完整报告（输出尾部 + 完整日志路径） */
function failureReport(c: CompletedTask): string {
	return [
		`✗ ${c.config.name} — 退出码 ${c.exitCode ?? "unknown"}，耗时 ${formatDuration(c.finishedAt - c.startedAt)}`,
		`──── 输出尾部 ────`,
		c.outputTail.trimEnd(),
		`──── 完整日志: ${c.fullLogPath} ────`,
	].join("\n");
}

/** 构建失败批次注入消息 */
function buildFailureMessage(batch: CompletedTask[]): string {
	const failed = batch.filter((c) => c.status !== "passed");
	const passed = batch.filter((c) => c.status === "passed");
	const parts: string[] = [
		`test-pilot 后台验证完成：${passed.length}/${batch.length} 通过，${failed.length} 个任务未通过。`,
		"",
	];
	for (const c of batch) parts.push(resultLine(c));
	// 门禁失败时说明短路原因，引导优先修复编译/类型错误
	const gateFailed = batch.find((c) => c.config.gate && (c.status === "failed" || c.status === "timeout"));
	const skippedCount = batch.filter((c) => c.status === "skipped").length;
	if (gateFailed && skippedCount > 0) {
		parts.push(
			"",
			`注意：门禁任务「${gateFailed.config.name}」未通过，后续 ${skippedCount} 个任务已跳过。请先修复编译/类型错误，再重新运行 /test。`,
		);
	}
	for (const c of failed) {
		if (c.status !== "failed" && c.status !== "timeout") continue; // 跳过/取消的任务无报告可展开
		parts.push("", "────────────────────", failureReport(c));
	}
	parts.push("", "请定位上述失败原因并修复代码；修复后可再次运行 /test 验证。");
	return parts.join("\n");
}

/** 构建成功批次简报 */
function buildSuccessMessage(batch: CompletedTask[]): string {
	const summary = batch.map((c) => `${c.config.name} ${formatDuration(c.finishedAt - c.startedAt)}`).join(", ");
	return `test-pilot 后台测试完成：${batch.length}/${batch.length} 全部通过（${summary}）。可以继续后续工作。`;
}

/**
 * 交付批次结果。
 *
 * 注入策略：
 * - 存在失败（failed/timeout）：总是注入并触发 turn（agent 忙碌时作为 followUp 排队）
 * - 全部通过：agent 忙碌时注入一行简报保持上下文；空闲时只 notify（除非 injectOnSuccess）
 */
export function deliverBatchResult(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	batch: CompletedTask[],
	injectOnSuccess: boolean,
): void {
	if (batch.length === 0) return;

	const hasFailure = batch.some((c) => c.status !== "passed");

	if (hasFailure) {
		const content = buildFailureMessage(batch);
		pi.sendMessage(
			{
				customType: TEST_PILOT_MESSAGE_TYPE,
				content,
				display: true,
				details: { batch: batch.map((c) => ({ name: c.config.name, status: c.status, exitCode: c.exitCode })) },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		ctx.ui.notify(`Tests: ${batch.filter((c) => c.status === "passed").length}/${batch.length} 通过，失败报告已注入`, "error");
		return;
	}

	// 全部通过
	if (!ctx.isIdle() || injectOnSuccess) {
		pi.sendMessage(
			{
				customType: TEST_PILOT_MESSAGE_TYPE,
				content: buildSuccessMessage(batch),
				display: true,
				details: { batch: batch.map((c) => ({ name: c.config.name, status: c.status, exitCode: c.exitCode })) },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	} else {
		const totalMs = batch.reduce((s, c) => s + (c.finishedAt - c.startedAt), 0);
		ctx.ui.notify(`Tests: ${batch.length}/${batch.length} 通过 (${formatDuration(totalMs)})`, "info");
	}
}
