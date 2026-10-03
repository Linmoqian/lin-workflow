/**
 * context7 扩展 —— 配置读取
 *
 * 配置来源优先级：进程环境变量 > 扩展目录下的 .env 文件 > 内置默认值。
 * .env 查找顺序：CONTEXT7_ENV_FILE 指定路径 > 扩展自身目录/.env > ~/.pi/agent/extensions/context7/.env。
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

/** 默认 Context7 接口地址 */
const DEFAULT_BASE_URL = "https://context7.com";

/** context7_get_docs 默认 token 预算 */
const DEFAULT_DOCS_TOKENS = 5000;

/** 单次请求默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;

/** token 预算下界：低于此值几乎取不到可用片段 */
export const MIN_DOCS_TOKENS = 500;

/** token 预算上界：过高会挤占上下文预算 */
export const MAX_DOCS_TOKENS = 50_000;

/* ------------------------------ 配置类型 ------------------------------ */

export interface Context7Config {
  /** 接口地址（已去掉末尾斜杠） */
  baseUrl: string;
  /** API Key，未配置时为 undefined（匿名访问，限额更低） */
  apiKey?: string;
  /** API Key 的来源描述，用于 /context7 状态展示 */
  apiKeySource?: string;
  /** context7_get_docs 默认 token 预算 */
  defaultDocsTokens: number;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 实际读取到的 .env 路径（未找到则 undefined） */
  envFilePath?: string;
}

/* ------------------------------ .env 查找与解析 ------------------------------ */

/** 计算 .env 候选路径：模块目录（若可解析）优先，其次固定全局扩展目录 */
function buildEnvFileCandidates(): string[] {
  const candidates: string[] = [];

  const fromFlag = process.env.CONTEXT7_ENV_FILE?.trim();
  if (fromFlag) candidates.push(fromFlag);

  try {
    // jiti 以 ESM 语义加载扩展，import.meta.url 可用；不可用时忽略该项
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), ".env"));
  } catch {
    /* 无 import.meta.url 的加载环境下跳过 */
  }

  candidates.push(join(getAgentDir(), "extensions", "context7", ".env"));
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

/** 去掉末尾斜杠，便于与 /api/v2/... 拼接 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/* ------------------------------ 主入口 ------------------------------ */

/** 读取当前配置（每次调用都重新读盘，改 .env 立即生效） */
export function loadConfig(): Context7Config {
  const envFile = readEnvFile();

  // 进程环境变量优先于 .env
  const fromProcess = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
  };
  const fromFile = (name: string): string | undefined => envFile?.values[name]?.trim() || undefined;

  const apiKeyFromProcess = fromProcess("CONTEXT7_API_KEY");
  const apiKey = apiKeyFromProcess ?? fromFile("CONTEXT7_API_KEY");
  const apiKeySource = apiKeyFromProcess
    ? "环境变量 CONTEXT7_API_KEY"
    : apiKey
      ? `.env（${envFile?.path}）`
      : undefined;

  const baseUrlRaw = fromProcess("CONTEXT7_BASE_URL") ?? fromFile("CONTEXT7_BASE_URL");

  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw || DEFAULT_BASE_URL),
    apiKey,
    apiKeySource,
    defaultDocsTokens: readInt(
      fromProcess("CONTEXT7_DEFAULT_TOKENS") ?? fromFile("CONTEXT7_DEFAULT_TOKENS"),
      DEFAULT_DOCS_TOKENS,
      MIN_DOCS_TOKENS,
      MAX_DOCS_TOKENS,
    ),
    timeoutMs: readInt(fromProcess("CONTEXT7_TIMEOUT_MS") ?? fromFile("CONTEXT7_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, 1000, 300_000),
    envFilePath: envFile?.path,
  };
}

/** 把用户传入的 token 预算夹到合法区间 */
export function clampDocsTokens(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DOCS_TOKENS, Math.max(MIN_DOCS_TOKENS, Math.round(value)));
}
