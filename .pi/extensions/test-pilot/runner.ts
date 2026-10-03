/**
 * test-pilot 后台进程管理
 *
 * 职责：spawn 测试进程、采集输出、解析内部进度百分比、超时控制、跨平台终止进程树。
 * 只负责单个进程，队列调度由 queue.ts 完成。
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestTaskConfig } from "./types.ts";

/** 内存中保留的最大输出字节数（超出后丢弃头部，保留尾部——失败摘要通常在尾部） */
const MAX_BUFFER_BYTES = 512 * 1024;

/** 注入消息中携带的输出尾部长度 */
export const OUTPUT_TAIL_BYTES = 3 * 1024;

/** 单个进程的最终结果 */
export interface RunnerResult {
	exitCode: number | null;
	timedOut: boolean;
	cancelled: boolean;
	/** 完整输出（内存上限内） */
	output: string;
	fullLogPath: string;
	durationMs: number;
}

/** 对外暴露的运行句柄 */
export interface RunningProcess {
	pid: number | undefined;
	/** 请求取消：杀进程树，最终仍会触发一次 onDone */
	cancel: () => void;
}

export interface RunnerCallbacks {
	/** 输出中解析到进度百分比时回调（节流由上层负责） */
	onProgress: (percent: number | null) => void;
	/** 进程结束后回调，保证只触发一次 */
	onDone: (result: RunnerResult) => void;
}

/** 从一行输出中提取最后一个合法的百分比数值（pytest `[ 74%]`、jest `50%` 等） */
function parseProgress(chunk: string): number | null {
	const matches = chunk.matchAll(/(\d{1,3})\s*%/g);
	let last: number | null = null;
	for (const m of matches) {
		const v = Number.parseInt(m[1], 10);
		if (Number.isFinite(v) && v >= 0 && v <= 100) last = v;
	}
	return last;
}

/** 跨平台终止进程树：Windows 用 taskkill /T，类 Unix 用进程组信号 */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		}).on("error", () => {
			/* 进程可能已退出，忽略 */
		});
	} else {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				/* 已退出 */
			}
		}
	}
}

/** 输出采集器：限制内存占用，超出上限丢弃最旧数据并记录省略标记 */
class OutputCollector {
	private parts: string[] = [];
	private size = 0;
	private dropped = false;

	append(text: string): void {
		this.parts.push(text);
		this.size += text.length;
		if (this.size > MAX_BUFFER_BYTES) {
			// 丢弃头部一半，保留尾部
			const keep = Math.floor(MAX_BUFFER_BYTES / 2);
			let acc = 0;
			let cut = this.parts.length;
			for (let i = this.parts.length - 1; i >= 0; i--) {
				acc += this.parts[i].length;
				if (acc > keep) {
					cut = i + 1;
					break;
				}
			}
			this.parts = this.parts.slice(cut);
			this.size = this.parts.reduce((s, p) => s + p.length, 0);
			this.dropped = true;
		}
	}

	text(): string {
		return (this.dropped ? "...\n[输出过长，头部已截断]\n" : "") + this.parts.join("");
	}
}

/**
 * 启动一个后台测试进程
 *
 * 注意：由命令/工具处理器调用（不在扩展 factory 中直接调用），
 * 以符合 pi 扩展“延迟启动后台资源”的约束。
 */
export function spawnTestProcess(
	config: TestTaskConfig,
	cwd: string,
	timeoutMinutes: number,
	callbacks: RunnerCallbacks,
): RunningProcess {
	const startedAt = Date.now();
	const stdout = new OutputCollector();
	const stderr = new OutputCollector();
	let cancelled = false;
	let timedOut = false;
	let settled = false;

	const child = spawn(config.command, [], {
		cwd,
		shell: true,
		windowsHide: true,
		// 类 Unix 下独立进程组，便于整组终止
		detached: process.platform !== "win32",
		env: { ...process.env },
	});

	// 超时钳制到秒级下限：分钟粒度配置，同时支持短周期验证
	const timeoutMs = Math.max(1_000, Math.round(timeoutMinutes * 60_000));
	const timer = setTimeout(() => {
		timedOut = true;
		killTree(child);
	}, timeoutMs);

	const finish = (exitCode: number | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);

		const output = stdout.text() + (stderr.parts.length ? "\n-- stderr --\n" + stderr.text() : "");
		const logName = `test-pilot-${config.name.replace(/[^\w.-]+/g, "_")}-${startedAt}.log`;
		const fullLogPath = join(tmpdir(), logName);
		try {
			writeFileSync(fullLogPath, output, "utf8");
		} catch {
			/* 写日志失败不阻塞结果交付 */
		}

		callbacks.onDone({
			exitCode,
			timedOut,
			cancelled,
			output,
			fullLogPath,
			durationMs: Date.now() - startedAt,
		});
	};

	child.stdout?.on("data", (buf: Buffer) => {
		const text = buf.toString("utf8");
		stdout.append(text);
		const p = parseProgress(text);
		if (p !== null) callbacks.onProgress(p);
	});

	child.stderr?.on("data", (buf: Buffer) => {
		const text = buf.toString("utf8");
		stderr.append(text);
		const p = parseProgress(text);
		if (p !== null) callbacks.onProgress(p);
	});

	child.on("error", (err) => {
		stderr.append(`\n[进程启动失败] ${err.message}\n`);
		finish(null);
	});

	child.on("close", (code) => finish(code));

	return {
		pid: child.pid,
		cancel: () => {
			if (settled) return;
			cancelled = true;
			killTree(child);
		},
	};
}
