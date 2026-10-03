/**
 * token-stats 数据结构与持久化
 *
 * 跨会话累计 assistant tokens 消耗，落盘到 agent 全局目录。
 * 首次运行自动从旧摸鱼扩展的数据文件（moyu-token-stats.json）迁移历史累计，
 * 旧文件保留不删。
 *
 * 本文件只定义结构与读写，不含 pi 运行时依赖；由 index.ts 消费。
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/* ------------------------------ 类型 ------------------------------ */

/** 全局 token 累计记录 */
export interface TokenStats {
	/** 累计 assistant tokens */
	tokens: number;
	/** 最近一次更新（Unix 毫秒） */
	updatedAt: number;
}

/* ------------------------------ 读写 ------------------------------ */

/** 一份空统计 */
export function freshTokenStats(): TokenStats {
	return { tokens: 0, updatedAt: Date.now() };
}

/** 解析已读取的 JSON 文本，非法时返回 null */
function parseStats(raw: string): TokenStats | null {
	try {
		const data = JSON.parse(raw) as Partial<TokenStats>;
		if (typeof data.tokens !== "number" || !Number.isFinite(data.tokens) || data.tokens < 0) {
			return null;
		}
		return {
			tokens: data.tokens,
			updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
		};
	} catch {
		return null;
	}
}

/**
 * 加载累计统计：
 * 1. 读 statsPath；存在且合法则直接使用
 * 2. 否则尝试从 legacyPath（摸鱼扩展旧文件）迁移历史累计并写回 statsPath
 * 3. 都没有则返回空统计
 */
export async function loadTokenStats(statsPath: string, legacyPath: string): Promise<TokenStats> {
	try {
		const parsed = parseStats(await readFile(statsPath, "utf8"));
		if (parsed) return parsed;
	} catch {
		/* 文件不存在等情况继续走迁移 */
	}

	try {
		const legacy = parseStats(await readFile(legacyPath, "utf8"));
		if (legacy) {
			await saveTokenStats(statsPath, legacy);
			return legacy;
		}
	} catch {
		/* 旧文件不存在：全新开始 */
	}

	return freshTokenStats();
}

/** 原子写回（临时文件 + rename；Windows rename 不覆盖已存在文件，失败时先删目标再试） */
export async function saveTokenStats(filePath: string, stats: TokenStats): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmp = join(dirname(filePath), `.${process.pid}.token-stats.tmp`);
	await writeFile(tmp, JSON.stringify(stats), "utf8");
	try {
		await rename(tmp, filePath);
	} catch {
		try {
			await rm(filePath, { force: true });
			await rename(tmp, filePath);
		} catch (error) {
			await rm(tmp, { force: true });
			throw error;
		}
	}
}

/* ------------------------------ 格式化 ------------------------------ */

/** token 数量格式化：千 / 百万 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}
