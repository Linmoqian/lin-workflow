/**
 * mineru 扩展 —— 配置读取
 *
 * 配置来源优先级：进程环境变量 > 扩展目录下的 .env 文件 > 内置默认值。
 * .env 查找顺序：MINERU_ENV_FILE 指定路径 > 扩展自身目录/.env > ~/.pi/agent/extensions/mineru/.env。
 * 不引入 dotenv 依赖，自行解析最简 KEY=VALUE 语法（支持 # 注释、export 前缀、成对引号）。
 *
 * 每次调用都重新读取，改完 .env 立即生效，无需重启 pi。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/* ------------------------------ 默认值 ------------------------------ */

/** 默认 MinerU 接口地址 */
const DEFAULT_BASE_URL = "https://mineru.net";

/** 默认模型版本（pipeline 更省额度，vlm 对公式 / 复杂版面更准） */
const DEFAULT_MODEL_VERSION = "vlm";

/** 默认文档语言 */
const DEFAULT_LANGUAGE = "ch";

/** 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 3000;

/** 默认最长等待时间（毫秒），超过后返回任务 ID 由 mineru_query 续查 */
const DEFAULT_MAX_WAIT_MS = 600_000;

/** 单次 HTTP 请求默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 支持的 model_version 取值 */
export const MODEL_VERSIONS = ["pipeline", "vlm", "MinerU-HTML"] as const;

/** 支持的接口选择模式 */
export const API_MODES = ["auto", "standard", "agent"] as const;

/** v4 标准接口单文件大小上限（MB） */
export const STANDARD_MAX_FILE_MB = 200;

/** v1 Agent 轻量接口单文件大小上限（MB） */
export const AGENT_MAX_FILE_MB = 10;

/** v1 Agent 轻量接口单文件页数上限 */
export const AGENT_MAX_PAGES = 20;

/* ------------------------------ 配置类型 ------------------------------ */

/** 接口选择：auto = 有 Key 走 v4 标准接口，无 Key 退回 v1 轻量接口 */
export type MineruApiMode = (typeof API_MODES)[number];

export interface MineruConfig {
  /** 接口地址（已去掉末尾斜杠） */
  baseUrl: string;
  /** API Key，未配置时为 undefined（只能用 v1 轻量接口） */
  apiKey?: string;
  /** API Key 的来源描述，用于 /mineru 状态展示 */
  apiKeySource?: string;
  /** 接口选择模式 */
  apiMode: MineruApiMode;
  /** 默认模型版本 */
  modelVersion: string;
  /** 默认文档语言 */
  language: string;
  /** 轮询间隔（毫秒） */
  pollIntervalMs: number;
  /** 最长等待时间（毫秒） */
  maxWaitMs: number;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 实际读取到的 .env 路径（未找到则 undefined） */
  envFilePath?: string;
}

/* ------------------------------ .env 查找与解析 ------------------------------ */

/** 计算 .env 候选路径：模块目录（若可解析）优先，其次固定全局扩展目录 */
function buildEnvFileCandidates(): string[] {
  const candidates: string[] = [];

  const fromFlag = process.env.MINERU_ENV_FILE?.trim();
  if (fromFlag) candidates.push(fromFlag);

  try {
    // jiti 以 ESM 语义加载扩展，import.meta.url 可用；不可用时忽略该项
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), ".env"));
  } catch {
    /* 无 import.meta.url 的加载环境下跳过 */
  }

  candidates.push(join(getAgentDir(), "extensions", "mineru", ".env"));
  return candidates;
}

/** .env 候选路径（模块加载时解析一次） */
export const ENV_FILE_CANDIDATES = buildEnvFileCandidates();

/** 解析 .env 文本为键值对（最简语法，不处理变量展开） */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);

    if (key) values[key] = value;
  }

  return values;
}

/** 读取第一个存在的 .env 文件 */
function readEnvFile(): { path: string; values: Record<string, string> } | undefined {
  for (const path of ENV_FILE_CANDIDATES) {
    if (!path || !existsSync(path)) continue;
    try {
      return { path, values: parseEnvFile(readFileSync(path, "utf8")) };
    } catch {
      /* 单个候选读取失败时继续尝试下一个 */
    }
  }
  return undefined;
}

/* ------------------------------ 取值辅助 ------------------------------ */

/** 取整并夹到 [min, max]；非法输入回退默认值 */
function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** 去掉末尾斜杠，便于与 /api/v4/... 拼接 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/** 校验并归一化 model_version，非法值回退默认 */
export function normalizeModelVersion(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const hit = MODEL_VERSIONS.find((item) => item.toLowerCase() === normalized.toLowerCase());
  return hit ?? fallback;
}

/** 校验并归一化接口模式，非法值回退 auto */
export function normalizeApiMode(value: string | undefined): MineruApiMode {
  const normalized = value?.trim().toLowerCase();
  return (API_MODES as readonly string[]).includes(normalized ?? "")
    ? (normalized as MineruApiMode)
    : "auto";
}

/** 按当前配置解析实际使用的接口：auto 时看有没有 Key */
export function resolveApiMode(cfg: MineruConfig): "standard" | "agent" {
  if (cfg.apiMode === "standard") return "standard";
  if (cfg.apiMode === "agent") return "agent";
  return cfg.apiKey ? "standard" : "agent";
}

/* ------------------------------ 主入口 ------------------------------ */

/** 读取当前配置（每次调用都重新读盘，改 .env 立即生效） */
export function loadConfig(): MineruConfig {
  const envFile = readEnvFile();

  // 进程环境变量优先于 .env
  const fromProcess = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
  };
  const fromFile = (name: string): string | undefined => envFile?.values[name]?.trim() || undefined;

  const apiKeyFromProcess = fromProcess("MINERU_API_KEY");
  const apiKey = apiKeyFromProcess ?? fromFile("MINERU_API_KEY");
  const apiKeySource = apiKeyFromProcess
    ? "环境变量 MINERU_API_KEY"
    : apiKey
      ? `.env（${envFile?.path}）`
      : undefined;

  const baseUrlRaw = fromProcess("MINERU_BASE_URL") ?? fromFile("MINERU_BASE_URL");

  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw || DEFAULT_BASE_URL),
    apiKey,
    apiKeySource,
    apiMode: normalizeApiMode(fromProcess("MINERU_API") ?? fromFile("MINERU_API")),
    modelVersion: normalizeModelVersion(
      fromProcess("MINERU_MODEL_VERSION") ?? fromFile("MINERU_MODEL_VERSION"),
      DEFAULT_MODEL_VERSION,
    ),
    language: (fromProcess("MINERU_LANGUAGE") ?? fromFile("MINERU_LANGUAGE")) || DEFAULT_LANGUAGE,
    pollIntervalMs: readInt(
      fromProcess("MINERU_POLL_INTERVAL_MS") ?? fromFile("MINERU_POLL_INTERVAL_MS"),
      DEFAULT_POLL_INTERVAL_MS,
      1000,
      60_000,
    ),
    maxWaitMs: readInt(
      fromProcess("MINERU_MAX_WAIT_MS") ?? fromFile("MINERU_MAX_WAIT_MS"),
      DEFAULT_MAX_WAIT_MS,
      10_000,
      3_600_000,
    ),
    timeoutMs: readInt(
      fromProcess("MINERU_TIMEOUT_MS") ?? fromFile("MINERU_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
      1000,
      600_000,
    ),
    envFilePath: envFile?.path,
  };
}
