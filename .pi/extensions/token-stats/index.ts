/**
 * token-stats 扩展入口
 *
 * 在编辑器下方常驻显示一行「累计消耗 N tokens」：
 * - 每条 assistant 消息结算后把 usage.totalTokens 累加进全局统计并写盘
 * - 统计跨会话持久化（~/.pi/agent/token-stats.json）
 * - 首次运行自动继承旧摸鱼扩展（moyu-token-stats.json）的历史累计
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import { getAgentDir, type ExtensionAPI, type MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	formatTokens,
	loadTokenStats,
	saveTokenStats,
	type TokenStats,
} from "./store.ts";

/** token 常驻 widget 的 key（编辑器下方） */
const TOKEN_WIDGET_KEY = "token-stats";

export default function tokenStatsExtension(pi: ExtensionAPI): void {
	// 重要状态（主函数顶部）
	const statsFile = join(getAgentDir(), "token-stats.json");
	const legacyFile = join(getAgentDir(), "moyu-token-stats.json"); // 旧摸鱼扩展的数据文件
	let stats: TokenStats = { tokens: 0, updatedAt: 0 };

	/** 刷新常驻 widget */
	const refreshWidget = (hasUI: boolean, setWidget: (lines: string[]) => void): void => {
		if (!hasUI) return;
		setWidget([`⬢ 累计消耗 ${formatTokens(stats.tokens)} tokens`]);
	};

	/* 会话开始：加载累计并显示 */
	pi.on("session_start", async (_event, ctx) => {
		stats = await loadTokenStats(statsFile, legacyFile);
		refreshWidget(
			ctx.hasUI,
			(lines) => ctx.ui.setWidget(TOKEN_WIDGET_KEY, lines, { placement: "belowEditor" }),
		);
	});

	/* assistant 消息结算：累加 usage 并写盘 */
	pi.on("message_end", async (event: MessageEndEvent, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const tokens = message.usage?.totalTokens;
		if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;

		stats.tokens += tokens;
		stats.updatedAt = Date.now();
		try {
			await saveTokenStats(statsFile, stats);
		} catch {
			/* 写盘失败不阻断会话 */
		}
		refreshWidget(
			ctx.hasUI,
			(lines) => ctx.ui.setWidget(TOKEN_WIDGET_KEY, lines, { placement: "belowEditor" }),
		);
	});
}
