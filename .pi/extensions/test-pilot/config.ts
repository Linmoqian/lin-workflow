/**
 * test-pilot 项目配置与验证任务检测
 *
 * 职责：
 * 1. 读取项目根目录的 .test-pilot.json（显式配置，优先级最高）
 * 2. 无配置文件时，根据项目特征自动检测验证队列：编译门禁在前（gate，失败短路）、测试在后
 *    （typecheck / mypy / go build / cargo check + npm test / pytest / go test / cargo test / make test）
 *
 * 作者: 云枫
 * 创建时间: 2026-09-07
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestPilotFileConfig, TestTaskConfig } from "./types.ts";

/** 项目配置文件名（放在项目根目录） */
export const CONFIG_FILE_NAME = ".test-pilot.json";

/** 默认任务超时（分钟） */
export const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * 读取并校验 .test-pilot.json
 * 返回 null 表示文件不存在；格式非法时抛出错误（由调用方转为用户提示）。
 */
export function loadFileConfig(cwd: string): TestPilotFileConfig | null {
	const configPath = join(cwd, CONFIG_FILE_NAME);
	if (!existsSync(configPath)) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (err) {
		throw new Error(`${CONFIG_FILE_NAME} 不是合法 JSON: ${(err as Error).message}`);
	}

	const cfg = raw as Partial<TestPilotFileConfig>;
	if (!Array.isArray(cfg.tasks) || cfg.tasks.length === 0) {
		throw new Error(`${CONFIG_FILE_NAME} 缺少非空 tasks 数组`);
	}
	for (const t of cfg.tasks) {
		if (!t || typeof t.name !== "string" || typeof t.command !== "string" || !t.name || !t.command) {
			throw new Error(`${CONFIG_FILE_NAME} 中存在非法任务项（需要 name 与 command 字段）`);
		}
	}

	return {
		tasks: cfg.tasks,
		injectOnSuccess: cfg.injectOnSuccess ?? false,
		defaultTimeoutMinutes: cfg.defaultTimeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
	};
}

/** 安全读取项目根下指定文本文件；不存在或读失败时返回 null */
function safeReadText(cwd: string, rel: string): string | null {
	try {
		return readFileSync(join(cwd, rel), "utf8");
	} catch {
		return null;
	}
}

/** 读取 package.json；非法或不存在时返回 null */
function readPackageJson(cwd: string): Record<string, unknown> | null {
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return null;
	try {
		return JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** 读取 pyproject.toml 文本；不存在时返回 null */
function readPyProject(cwd: string): string | null {
	return safeReadText(cwd, "pyproject.toml");
}

/**
 * 自动检测项目的验证任务队列（编译门禁在前、测试在后）
 * 返回 null 表示无法识别，调用方应提示用户配置。
 */
export function detectTestTasks(cwd: string): TestTaskConfig[] | null {
	// 1. Node 项目：typecheck（脚本或 tsc）+ test
	const pkg = readPackageJson(cwd);
	if (pkg) {
		const scripts = (pkg.scripts ?? {}) as Record<string, string>;
		const deps = {
			...((pkg.dependencies ?? {}) as Record<string, string>),
			...((pkg.devDependencies ?? {}) as Record<string, string>),
		};

		const tasks: TestTaskConfig[] = [];

		// 编译验证：typecheck 脚本优先；否则有 tsconfig + typescript 依赖时直接调 tsc
		if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
			tasks.push({ name: "typecheck", command: "npm run typecheck", gate: true });
		} else if (existsSync(join(cwd, "tsconfig.json")) && deps.typescript) {
			tasks.push({ name: "typecheck", command: "npx tsc --noEmit", gate: true });
		}

		if (typeof scripts.test === "string" && scripts.test.trim()) {
			tasks.push({ name: "test", command: "npm test" });
		}

		if (tasks.length > 0) return tasks;
		// 无 typecheck/test 脚本时继续尝试其他检测
	}

	// 2. Python 项目：mypy 类型检查（显式配置才加）+ pytest
	const pyproject = readPyProject(cwd);
	const setupCfg = safeReadText(cwd, "setup.cfg");
	const hasMypyConfig =
		(pyproject?.includes("[tool.mypy]") ?? false) ||
		existsSync(join(cwd, "mypy.ini")) ||
		(setupCfg?.includes("[mypy]") ?? false);
	const hasPytest =
		(pyproject?.includes("[tool.pytest") ?? false) ||
		existsSync(join(cwd, "pytest.ini")) ||
		existsSync(join(cwd, "tests", "conftest.py")) ||
		existsSync(join(cwd, "test", "conftest.py"));

	const pyTasks: TestTaskConfig[] = [];
	if (hasMypyConfig) {
		pyTasks.push({ name: "mypy", command: "python -m mypy .", gate: true });
	}
	if (hasPytest) {
		pyTasks.push({ name: "pytest", command: "python -m pytest" });
	}
	if (pyTasks.length > 0) return pyTasks;

	// 3. Go：编译门禁 + 测试
	if (existsSync(join(cwd, "go.mod"))) {
		return [
			{ name: "go build", command: "go build ./...", gate: true },
			{ name: "go test", command: "go test ./..." },
		];
	}

	// 4. Rust：cargo check（比 build 快且等价验证）+ 测试
	if (existsSync(join(cwd, "Cargo.toml"))) {
		return [
			{ name: "cargo check", command: "cargo check", gate: true },
			{ name: "cargo test", command: "cargo test" },
		];
	}

	// 5. C++（CMake）：configure+build 门禁 + ctest；已配置过则增量编译
	if (existsSync(join(cwd, "CMakeLists.txt"))) {
		const configured = existsSync(join(cwd, "build", "CMakeCache.txt"));
		const gateCmd = configured
			? "cmake --build build"
			: "cmake -B build && cmake --build build";
		return [
			{ name: "cmake build", command: gateCmd, gate: true },
			{ name: "ctest", command: "ctest --test-dir build" },
		];
	}

	// 6. C++（Meson）：setup+ninja 门禁 + meson test；已配置过则直接 ninja
	if (existsSync(join(cwd, "meson.build"))) {
		const configured = existsSync(join(cwd, "build", "build.ninja"));
		const gateCmd = configured ? "ninja -C build" : "meson setup build && ninja -C build";
		return [
			{ name: "meson build", command: gateCmd, gate: true },
			{ name: "meson test", command: "meson test -C build" },
		];
	}

	// 7. Makefile：编译验证目标（typecheck/build/check）为门禁 + test
	const makefilePath = join(cwd, "Makefile");
	if (existsSync(makefilePath)) {
		const content = readFileSync(makefilePath, "utf8");
		const gateTarget = content.match(/^(typecheck|build|check)\s*:/m)?.[1];
		const makeTasks: TestTaskConfig[] = [];
		if (gateTarget) {
			makeTasks.push({ name: `make ${gateTarget}`, command: `make ${gateTarget}`, gate: true });
		}
		if (/^test\s*:/m.test(content)) {
			makeTasks.push({ name: "make test", command: "make test" });
		}
		if (makeTasks.length > 0) return makeTasks;
	}

	return null;
}

/**
 * 解析项目任务列表：配置文件 > 自动检测
 * 返回任务数组；无法确定时抛出带指引的错误。
 */
export function resolveProjectTasks(cwd: string): {
	tasks: TestTaskConfig[];
	fileConfig: TestPilotFileConfig | null;
} {
	const fileConfig = loadFileConfig(cwd);
	if (fileConfig) return { tasks: fileConfig.tasks, fileConfig };

	const detected = detectTestTasks(cwd);
	if (detected) return { tasks: detected, fileConfig: null };

	throw new Error(
		`未识别到验证命令。请在项目根目录创建 ${CONFIG_FILE_NAME}，例如：\n` +
			JSON.stringify(
				{
					tasks: [
						{ name: "typecheck", command: "npx tsc --noEmit", gate: true },
						{ name: "lint", command: "npm run lint" },
						{ name: "unit", command: "npm test" },
						{ name: "e2e", command: "npm run e2e" },
					],
				},
				null,
				2,
			),
	);
}
