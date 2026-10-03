/**
 * test-pilot 数据结构定义
 *
 * 定义后台测试任务的全部类型：任务配置、运行中状态、完成结果。
 * 本文件只定义结构，不包含任何业务逻辑；由 queue.ts / runner.ts / report.ts 消费。
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

/** 任务状态机: pending -> running -> (passed | failed | cancelled | timeout)；
 *  另有 skipped：门禁任务失败后被短路跳过（未运行） */
export type TestTaskStatus =
	| "pending"
	| "running"
	| "passed"
	| "failed"
	| "cancelled"
	| "timeout"
	| "skipped";

/** 任务配置（来源: .test-pilot.json 或框架自动检测） */
export interface TestTaskConfig {
	/** 任务短名，用于状态栏显示与 /test 参数匹配 */
	name: string;
	/** 完整 shell 命令（经 shell 解释执行） */
	command: string;
	/** 超时分钟数，缺省用队列默认值 */
	timeoutMinutes?: number;
	/** 编译门禁：失败时短路跳过后续任务（测试无意义） */
	gate?: boolean;
}

/** 运行中任务的实时状态 */
export interface RunningTaskInfo {
	config: TestTaskConfig;
	startedAt: number;
	/** 从测试输出解析出的内部进度百分比（如 pytest 的 [ 74%]），解析不到为 null */
	progressPercent: number | null;
}

/** 已完成任务的结果 */
export interface CompletedTask {
	config: TestTaskConfig;
	startedAt: number;
	finishedAt: number;
	status: Exclude<TestTaskStatus, "pending" | "running">;
	/** 进程退出码；被杀时可能为 null */
	exitCode: number | null;
	/** 输出尾部（已截断），用于注入消息 */
	outputTail: string;
	/** 完整输出日志文件路径 */
	fullLogPath: string;
}

/** 队列整体状态快照，供 UI 渲染 */
export interface QueueState {
	pending: TestTaskConfig[];
	current: RunningTaskInfo | null;
	/** 当前批次累计完成的结果 */
	completed: CompletedTask[];
	/** 是否存在活跃批次（pending/current 非空） */
	active: boolean;
}

/** 项目级配置文件 .test-pilot.json 的结构 */
export interface TestPilotFileConfig {
	tasks: TestTaskConfig[];
	/** 测试全部通过时是否也向 agent 注入简报（默认 false，仅失败注入） */
	injectOnSuccess?: boolean;
	/** 默认超时分钟数 */
	defaultTimeoutMinutes?: number;
}
