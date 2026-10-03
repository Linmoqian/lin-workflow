/**
 * test-pilot 扩展入口
 *
 * 工作流：修改代码 -> 后台启动测试（任务队列）-> Pi 继续检查其他代码
 *        -> 测试完成自动注入结果 -> 失败则定位错误
 *
 * 对外提供：
 * - 命令 /test [task...|cancel]、/tests
 * - 工具 test_pilot（start/status/cancel，供 LLM 主动把测试丢到后台）
 * - footer 状态摘要 + 编辑器上方 Tests 面板（进度条 + 任务状态）
 *
 * 项目配置：根目录 .test-pilot.json（tasks / injectOnSuccess / defaultTimeoutMinutes），
 * 未配置时自动检测 pytest / npm test / go test / cargo test / make test。
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_TIMEOUT_MINUTES,
	resolveProjectTasks,
	loadFileConfig,
} from "./config.ts";
import { TestQueue } from "./queue.ts";
import { deliverBatchResult, TEST_PILOT_MESSAGE_TYPE } from "./report.ts";
import { clearStatusUI, formatDuration, taskNames, updateStatusUI, type StatusUI } from "./statusbar.ts";
import type { CompletedTask, TestTaskConfig } from "./types.ts";

export default function testPilotExtension(pi: ExtensionAPI) {
	// 重要状态（主函数顶部）
	let uiCtx: ExtensionContext | null = null; // 最近一次 session 事件刷新的上下文
	let queue: TestQueue | null = null;
	let lastBatch: CompletedTask[] | null = null; // 最近一次完成批次的摘要，供 UI 停留显示
	let injectOnSuccess = false; // 全部通过时是否也注入简报
	let cachedTasks: TestTaskConfig[] = []; // 最近一次解析出的项目任务

	/** 从事件/命令上下文提取 UI 句柄（无 UI 模式返回 null） */
	const statusUI = (ctx: ExtensionContext | null): StatusUI | null => {
		if (!ctx || !ctx.hasUI) return null;
		return {
			setStatus: (k, t) => ctx.ui.setStatus(k, t),
			setWidget: (k, l, o) => ctx.ui.setWidget(k, l, o as { placement?: "belowEditor" } | undefined),
			theme: ctx.ui.theme,
		};
	};

	const refreshUI = (): void => {
		updateStatusUI(statusUI(uiCtx), queue?.getState() ?? emptyState(), lastBatch);
	};

	const emptyState = () => ({
		pending: [] as TestTaskConfig[],
		current: null,
		completed: [] as CompletedTask[],
		active: false,
	});

	/** 惰性创建队列：只在真正需要跑测试时启动后台资源 */
	const ensureQueue = (): TestQueue | null => {
		if (!uiCtx) return null;
		if (queue) return queue;
		queue = new TestQueue(uiCtx.cwd, DEFAULT_TIMEOUT_MINUTES, {
			onUpdate: () => refreshUI(),
			onBatchDone: (batch) => {
				lastBatch = batch;
				const ctx = uiCtx;
				if (ctx) deliverBatchResult(pi, ctx, batch, injectOnSuccess);
				refreshUI();
			},
			onError: (msg) => uiCtx?.ui.notify(`test-pilot: ${msg}`, "error"),
		});
		return queue;
	};

	/** 解析项目任务（带缓存）；失败时提示用户并返回 null */
	const loadTasks = (ctx: ExtensionContext): TestTaskConfig[] | null => {
		try {
			const { tasks, fileConfig } = resolveProjectTasks(ctx.cwd);
			cachedTasks = tasks;
			injectOnSuccess = fileConfig?.injectOnSuccess ?? false;
			return tasks;
		} catch (err) {
			ctx.ui.notify((err as Error).message, "error");
			return null;
		}
	};

	// ------------------------------------------------------------------
	// 生命周期
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		lastBatch = null;
		queue = null; // shutdown 已销毁旧队列；新会话从零开始
		// 预读配置（仅解析，不启动任何进程）
		try {
			const fileConfig = loadFileConfig(ctx.cwd);
			if (fileConfig) {
				cachedTasks = fileConfig.tasks;
				injectOnSuccess = fileConfig.injectOnSuccess ?? false;
			}
		} catch {
			/* 配置非法时等 /test 触发再提示 */
		}
		refreshUI();
	});

	pi.on("session_shutdown", async () => {
		queue?.destroy();
		queue = null;
		clearStatusUI(statusUI(uiCtx));
	});

	// ------------------------------------------------------------------
	// 自定义消息渲染（注入的报告在对话流中的样子）
	// ------------------------------------------------------------------

	pi.registerMessageRenderer(TEST_PILOT_MESSAGE_TYPE, (message, options, theme) => {
		const content = message.content ?? "";
		const firstLine = content.split("\n")[0] ?? "";
		const isFailure = /失败|未通过/.test(firstLine);
		const icon = isFailure ? theme.fg("error", "✗") : theme.fg("success", "✓");
		let text = `${icon} ${theme.fg("accent", "[test-pilot]")} ${theme.fg("muted", firstLine)}`;
		if (options.expanded) {
			const rest = content.split("\n").slice(1).join("\n");
			if (rest) text += `\n${theme.fg("dim", rest)}`;
		} else {
			const lines = content.split("\n").length;
			text += theme.fg("dim", ` (${lines} 行, 展开查看)`);
		}
		return new Text(text, options.outputPad, 0);
	});

	// ------------------------------------------------------------------
	// 命令：/test
	// ------------------------------------------------------------------

	pi.registerCommand("test", {
		description: "后台运行测试队列（/test、/test <task...>、/test cancel）",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "cancel", label: "cancel", description: "取消当前队列" },
				...taskNames(cachedTasks).map((n) => ({ value: n, label: n })),
			].filter((i) => i.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const q = ensureQueue();
			if (!q) return;

			const trimmed = args.trim();

			// /test cancel：取消队列与当前进程
			if (trimmed === "cancel") {
				const n = q.cancelAll();
				ctx.ui.notify(n > 0 ? `已取消 ${n} 个测试任务` : "当前没有运行中的测试", "info");
				return;
			}

			// /test <task...>：按名筛选；无参数则全部
			const tasks = loadTasks(ctx);
			if (!tasks) return;
			let selected: TestTaskConfig[];
			if (trimmed === "") {
				selected = tasks;
			} else {
				const names = trimmed.split(/\s+/);
				const missing = names.filter((n) => !tasks.some((t) => t.name === n));
				if (missing.length > 0) {
					ctx.ui.notify(
						`未找到任务: ${missing.join(", ")}。可用任务: ${taskNames(tasks).join(", ")}`,
						"warning",
					);
					return;
				}
				selected = tasks.filter((t) => names.includes(t.name));
			}

			lastBatch = null; // 新批次覆盖旧摘要
			q.enqueue(selected);
			ctx.ui.notify(`Tests 已入队: ${taskNames(selected).join(", ")}（后台运行，完成后自动注入结果）`, "info");
		},
	});

	// ------------------------------------------------------------------
	// 命令：/tests（查看状态）
	// ------------------------------------------------------------------

	pi.registerCommand("tests", {
		description: "查看测试队列状态与最近结果",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			const state = queue?.getState() ?? emptyState();

			if (state.current || state.pending.length > 0) {
				const running = state.current
					? `正在运行: ${state.current.config.name}${
							state.current.progressPercent !== null ? ` (${state.current.progressPercent}%)` : ""
						}`
					: "即将运行下一个任务";
				const waiting = state.pending.length > 0 ? `；待运行: ${taskNames(state.pending).join(", ")}` : "";
				ctx.ui.notify(`${running}${waiting}`, "info");
				return;
			}

			if (lastBatch && lastBatch.length > 0) {
				const passed = lastBatch.filter((c) => c.status === "passed").length;
				const totalMs = lastBatch.reduce((s, c) => s + (c.finishedAt - c.startedAt), 0);
				const detail = lastBatch
					.map((c) => `${c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "⊘"} ${c.config.name}`)
					.join("  ");
				ctx.ui.notify(
					`最近批次: ${passed}/${lastBatch.length} 通过 (${formatDuration(totalMs)}) — ${detail}`,
					passed === lastBatch.length ? "info" : "warning",
				);
				return;
			}

			ctx.ui.notify("当前没有测试任务。使用 /test 启动后台测试队列。", "info");
		},
	});

	// ------------------------------------------------------------------
	// 工具：test_pilot（LLM 主动把测试丢到后台，继续干别的活）
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "test_pilot",
		label: "Test Pilot",
		description:
			"在后台运行项目验证队列（编译门禁在前、测试在后），立即返回不阻塞。修改代码后调用它启动验证，然后继续其他工作；" +
			"队列完成后结果会自动注入对话：失败时附带输出尾部与完整日志路径，需要定位修复；" +
			"门禁任务（编译/类型检查）失败时后续测试自动跳过。" +
			"action=start 启动（可选 tasks 指定任务名子集），action=status 查询进度，action=cancel 取消队列。",
		promptSnippet: "在后台运行验证队列（编译+测试）并在完成后自动注入结果",
		promptGuidelines: [
			"修改代码后用 test_pilot 在后台启动验证队列（含编译门禁），而不是用 bash 同步等待测试跑完；继续做其他检查，结果会自动注入。",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "status", "cancel"] as const),
			tasks: Type.Optional(
				Type.Array(Type.String(), { description: "要运行的任务名子集；省略则运行全部" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const q = ensureQueue();
			if (!q) {
				return { content: [{ type: "text", text: "错误: 会话上下文不可用" }] };
			}

			if (params.action === "cancel") {
				const n = q.cancelAll();
				return { content: [{ type: "text", text: n > 0 ? `已取消 ${n} 个测试任务。` : "当前没有运行中的测试。" }] };
			}

			if (params.action === "status") {
				const state = q.getState();
				const lines: string[] = [];
				for (const c of state.completed) {
					lines.push(`${c.status === "passed" ? "PASS" : c.status.toUpperCase()} ${c.config.name} (exit ${c.exitCode ?? "?"})`);
				}
				if (state.current) {
					const pct = state.current.progressPercent !== null ? ` ${state.current.progressPercent}%` : "";
					lines.push(`RUNNING ${state.current.config.name}${pct}`);
				}
				for (const p of state.pending) lines.push(`QUEUED ${p.name}`);
				if (lines.length === 0) lines.push("队列为空（无运行中/排队任务）");
				return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
			}

			// action === "start"
			const tasks = loadTasks(ctx);
			if (!tasks) {
				return { content: [{ type: "text", text: "错误: 无法确定项目测试命令，请配置 .test-pilot.json" }] };
			}
			let selected = tasks;
			if (params.tasks && params.tasks.length > 0) {
				const missing = params.tasks.filter((n) => !tasks.some((t) => t.name === n));
				if (missing.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `未找到任务: ${missing.join(", ")}。可用任务: ${taskNames(tasks).join(", ")}`,
							},
						],
					};
				}
				selected = tasks.filter((t) => params.tasks!.includes(t.name));
			}

			lastBatch = null;
			q.enqueue(selected);
			return {
				content: [
					{
						type: "text",
						text:
							`已入队 ${selected.length} 个测试任务（${taskNames(selected).join(", ")}），后台顺序执行。\n` +
							`你现在可以继续其他工作；测试完成后结果会自动注入对话，失败时需要定位修复。` +
							`随时可用 test_pilot(action=status) 查询进度。`,
					},
				],
				details: { started: taskNames(selected) },
			};
		},
	});
}
