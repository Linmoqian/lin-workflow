/**
 * test-pilot 任务队列
 *
 * 职责：把测试当作后台任务队列顺序执行——入队后立即返回，Pi 继续干活；
 * 单个任务完成立即推进下一个，批次全部结束时通过 onBatchDone 通知上层注入结果。
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import { spawnTestProcess, OUTPUT_TAIL_BYTES, type RunningProcess } from "./runner.ts";
import type { CompletedTask, QueueState, RunningTaskInfo, TestTaskConfig } from "./types.ts";

export interface QueueHooks {
	/** 状态发生变化（入队/进度/完成），上层据此刷新 UI */
	onUpdate: (state: QueueState) => void;
	/** 一个批次全部结束时回调（含本批全部结果，含成功） */
	onBatchDone: (batch: CompletedTask[]) => void;
	/** 内部错误（spawn 层面之外的异常） */
	onError: (message: string) => void;
}

/** 进度回调的最小刷新间隔（毫秒），避免高频输出打爆 UI */
const PROGRESS_THROTTLE_MS = 500;

export class TestQueue {
	private pending: TestTaskConfig[] = [];
	private current: RunningTaskInfo | null = null;
	private currentProcess: RunningProcess | null = null;
	private completed: CompletedTask[] = [];
	private batchActive = false;
	private destroyed = false;
	private lastProgressEmit = 0;

	private readonly cwd: string;
	private readonly defaultTimeoutMinutes: number;
	private readonly hooks: QueueHooks;

	constructor(cwd: string, defaultTimeoutMinutes: number, hooks: QueueHooks) {
		this.cwd = cwd;
		this.defaultTimeoutMinutes = defaultTimeoutMinutes;
		this.hooks = hooks;
	}

	/** 追加任务；若当前空闲则立即开跑（同一批次内继续追加也允许） */
	enqueue(configs: TestTaskConfig[]): void {
		if (this.destroyed || configs.length === 0) return;
		this.pending.push(...configs);
		this.batchActive = true;
		this.emitUpdate();
		this.pump();
	}

	/** 取消整个批次：清空待跑任务并终止当前进程，返回受影响的任务数 */
	cancelAll(): number {
		const n = this.pending.length + (this.current ? 1 : 0);
		this.pending = [];
		if (this.currentProcess) this.currentProcess.cancel();
		// current 由 close 回调收尾；若无活跃进程直接结束批次
		if (!this.current) this.finishBatchIfIdle();
		this.emitUpdate();
		return n;
	}

	getState(): QueueState {
		return {
			pending: [...this.pending],
			current: this.current ? { ...this.current } : null,
			completed: [...this.completed],
			active: this.batchActive,
		};
	}

	/** 销毁队列（session_shutdown 时调用）：杀进程、清定时、不再回调 */
	destroy(): void {
		this.destroyed = true;
		this.pending = [];
		if (this.currentProcess) this.currentProcess.cancel();
		this.current = null;
		this.currentProcess = null;
	}

	private pump(): void {
		if (this.destroyed || this.current) return;
		const config = this.pending.shift();
		if (!config) {
			this.finishBatchIfIdle();
			return;
		}

		this.current = { config, startedAt: Date.now(), progressPercent: null };
		this.emitUpdate();

		const timeoutMinutes = config.timeoutMinutes ?? this.defaultTimeoutMinutes;
		try {
			this.currentProcess = spawnTestProcess(config, this.cwd, timeoutMinutes, {
				onProgress: (percent) => {
					if (!this.current || percent === null) return;
					this.current.progressPercent = percent;
					const now = Date.now();
					if (now - this.lastProgressEmit >= PROGRESS_THROTTLE_MS) {
						this.lastProgressEmit = now;
						this.emitUpdate();
					}
				},
				onDone: (result) => {
					if (this.destroyed) return;
					const started = this.current?.startedAt ?? Date.now();
					const entry: CompletedTask = {
						config,
						startedAt: started,
						finishedAt: Date.now(),
						status: result.cancelled
							? "cancelled"
							: result.timedOut
								? "timeout"
								: result.exitCode === 0
									? "passed"
									: "failed",
						exitCode: result.exitCode,
						outputTail: result.output.slice(-OUTPUT_TAIL_BYTES),
						fullLogPath: result.fullLogPath,
					};
					this.current = null;
					this.currentProcess = null;
					this.completed.push(entry);

					// 编译门禁失败：后续测试无意义，短路为 skipped
					if (entry.config.gate && entry.status !== "passed" && this.pending.length > 0) {
						const now = Date.now();
						for (const cfg of this.pending) {
							this.completed.push({
								config: cfg,
								startedAt: now,
								finishedAt: now,
								status: "skipped",
								exitCode: null,
								outputTail: `已跳过：门禁任务 ${config.name} 未通过（${entry.status === "timeout" ? "超时" : "失败"}）`,
								fullLogPath: "",
							});
						}
						this.pending = [];
					}

					this.emitUpdate();
					this.pump();
				},
			});
		} catch (err) {
			// spawn 同步抛错（如命令为空）时记录并继续跑后续任务
			this.current = null;
			this.currentProcess = null;
			this.hooks.onError(`任务 ${config.name} 启动失败: ${(err as Error).message}`);
			this.pump();
		}
	}

	private finishBatchIfIdle(): void {
		if (this.destroyed || !this.batchActive) return;
		if (this.current || this.pending.length > 0) return;
		this.batchActive = false;
		const batch = this.completed;
		this.completed = [];
		this.hooks.onBatchDone(batch);
	}

	private emitUpdate(): void {
		this.hooks.onUpdate(this.getState());
	}
}
