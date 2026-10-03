/**
 * sciverse 扩展 —— 配置读取
 *
 * 配置来源优先级：进程环境变量 > 扩展目录下的 .env 文件 > ~/.sciverse/credentials.json > 内置默认值。
 * .env 查找顺序：SCIVERSE_ENV_FILE 指定路径 > 扩展自身目录/.env > ~/.pi/agent/extensions/sciverse/.env。
 * 不引入 dotenv 依赖，自行解析最简 KEY=VALUE 语法（支持 # 注释、export 前缀、成对引号）。
 *
 * ~/.sciverse/credentials.json 是官方 CLI（pip install sciverse && sciverse auth login）写入的凭据文件，
 * 这里只读不写，装了官方 CLI 就能免配置 token。
 *
 * 每次调用都重新读取，改完 .env 立即生效，无需重启 pi。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/* ------------------------------ 默认值 ------------------------------ */

/** 官方接口地址 */
export const DEFAULT_BASE_URL = "https://api.sciverse.space";

/** 单次请求默认超时（毫秒）：quality 语义检索要跑 LLM 改写，给足时间 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** sciverse_search_papers 默认每页条数 */
const DEFAULT_PAGE_SIZE = 10;

/** sciverse_read_content 单次请求默认字节数 */
const DEFAULT_CONTENT_LIMIT = 8_192;

/** 服务端单次 read_content 的字节上限 */
export const MAX_CONTENT_LIMIT = 16_384;

/** 单次 read_content 调用允许自动续读的总字节上限（保持在这些字节内，避免超出 pi 的 50KB 结果截断线） */
export const MAX_CONTENT_BYTES = 49_152;

/** 接口默认限流：每个接口 30 次/分钟（未配置配额时） */
const DEFAULT_RATE_LIMIT_PER_MIN = 30;

/** 配额不足时最多等待多久再发请求（毫秒），超过则该次调用直接报错 */
const DEFAULT_MAX_WAIT_MS = 20_000;

/** 图片字节上限，超过则落盘并在结果里给路径 */
export const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;

/* ------------------------------ 配置类型 ------------------------------ */

export interface SciverseConfig {
  /** 接口地址（已去掉末尾斜杠） */
  baseUrl: string;
  /** API Token，未配置时为 undefined（调用接口会 401） */
  token?: string;
  /** Token 来源描述，用于 /sciverse 状态展示 */
  tokenSource?: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** sciverse_search_papers 默认每页条数 */
  defaultPageSize: number;
  /** sciverse_read_content 单次请求默认字节数 */
  defaultContentLimit: number;
  /** 单次 read_content 调用默认总字节上限 */
  defaultMaxContentBytes: number;
  /** 客户端侧每接口每分钟配额（与服务端 30/min 对齐，避免打出 429） */
  rateLimitPerMin: number;
  /** 配额不足时允许的最长等待（毫秒） */
  maxWaitMs: number;
  /** 实际读取到的 .env 路径（未找到则 undefined） */
  envFilePath?: string;
  /** 实际读取到的凭据文件路径（存在时） */
  credentialsPath?: string;
}

/* ------------------------------ .env 查找与解析 ------------------------------ */

/** 计算 .env 候选路径：模块目录（若可解析）优先，其次固定全局扩展目录 */
function buildEnvFileCandidates(): string[] {
  const candidates: string[] = [];

  const fromFlag = process.env.SCIVERSE_ENV_FILE?.trim();
  if (fromFlag) candidates.push(fromFlag);

  try {
    // jiti 以 ESM 语义加载扩展，import.meta.url 可用；不可用时忽略该项
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), ".env"));
  } catch {
    /* 无 import.meta.url 的加载环境下跳过 */
  }

  candidates.push(join(getAgentDir(), "extensions", "sciverse", ".env"));
  return candidates;
}

/** .env 候选路径（模块加载时解析一次） */
export const ENV_FILE_CANDIDATES = buildEnvFileCandidates();

/** 官方 CLI 凭据文件路径（HOME / USERPROFILE 优先，便于测试 override） */
export function credentialsFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, ".sciverse", "credentials.json");
}

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

/** 读取官方 CLI 凭据文件（只读，失败视为不存在） */
function readCredentialsFile(): { path: string; token?: string; endpoint?: string } | undefined {
  const path = credentialsFilePath();
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown; endpoint?: unknown };
    return {
      path,
      token: typeof data?.token === "string" && data.token.trim() ? data.token.trim() : undefined,
      endpoint: typeof data?.endpoint === "string" && data.endpoint.trim() ? data.endpoint.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

/* ------------------------------ 取值辅助 ------------------------------ */

/** 取整并夹到 [min, max]；非法输入回退默认值 */
function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** 去掉末尾斜杠，便于与 /meta-search 拼接 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/* ------------------------------ 主入口 ------------------------------ */

/** 读取当前配置（每次调用都重新读盘，改 .env 立即生效） */
export function loadConfig(): SciverseConfig {
  const envFile = readEnvFile();
  const credentials = readCredentialsFile();

  // 进程环境变量优先于 .env
  const fromProcess = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
  };
  const fromFile = (name: string): string | undefined => envFile?.values[name]?.trim() || undefined;

  const tokenFromProcess = fromProcess("SCIVERSE_API_TOKEN");
  const tokenFromEnvFile = fromFile("SCIVERSE_API_TOKEN");
  const token = tokenFromProcess ?? tokenFromEnvFile ?? credentials?.token;
  const tokenSource = tokenFromProcess
    ? "环境变量 SCIVERSE_API_TOKEN"
    : tokenFromEnvFile
      ? `.env（${envFile?.path}）`
      : credentials?.token
        ? `官方 CLI 凭据（${credentials.path}）`
        : undefined;

  const baseUrlRaw =
    fromProcess("SCIVERSE_BASE_URL") ?? fromFile("SCIVERSE_BASE_URL") ?? credentials?.endpoint;

  const defaultContentLimit = readInt(
    fromProcess("SCIVERSE_CONTENT_LIMIT") ?? fromFile("SCIVERSE_CONTENT_LIMIT"),
    DEFAULT_CONTENT_LIMIT,
    1,
    MAX_CONTENT_LIMIT
  );

  const defaultMaxContentBytes = readInt(
    fromProcess("SCIVERSE_MAX_CONTENT_BYTES") ?? fromFile("SCIVERSE_MAX_CONTENT_BYTES"),
    Math.max(defaultContentLimit, DEFAULT_CONTENT_LIMIT),
    defaultContentLimit,
    MAX_CONTENT_BYTES
  );

  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw || DEFAULT_BASE_URL),
    token,
    tokenSource,
    timeoutMs: readInt(fromProcess("SCIVERSE_TIMEOUT_MS") ?? fromFile("SCIVERSE_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, 1000, 300_000),
    defaultPageSize: readInt(fromProcess("SCIVERSE_PAGE_SIZE") ?? fromFile("SCIVERSE_PAGE_SIZE"), DEFAULT_PAGE_SIZE, 1, 50),
    defaultContentLimit,
    defaultMaxContentBytes,
    rateLimitPerMin: readInt(
      fromProcess("SCIVERSE_RATE_LIMIT_PER_MIN") ?? fromFile("SCIVERSE_RATE_LIMIT_PER_MIN"),
      DEFAULT_RATE_LIMIT_PER_MIN,
      1,
      10_000
    ),
    maxWaitMs: readInt(fromProcess("SCIVERSE_MAX_WAIT_MS") ?? fromFile("SCIVERSE_MAX_WAIT_MS"), DEFAULT_MAX_WAIT_MS, 0, 120_000),
    envFilePath: envFile?.path,
    credentialsPath: credentials?.path,
  };
}

/** 取 token，未配置时抛出可执行的中文错误 */
export function requireToken(cfg: SciverseConfig): string {
  if (cfg.token) return cfg.token;

  const envPath = cfg.envFilePath ?? ENV_FILE_CANDIDATES[ENV_FILE_CANDIDATES.length - 1] ?? "~/.pi/agent/extensions/sciverse/.env";
  throw new Error(
    `未配置 Sciverse API Token：请在 ${envPath} 写入 SCIVERSE_API_TOKEN=sci_…（Token 见 https://sciverse.space），` +
      "或设置同名环境变量 SCIVERSE_API_TOKEN，或运行官方 CLI `pip install sciverse && sciverse auth login` 写入 ~/.sciverse/credentials.json",
  );
}

/** 把用户传入的字节数夹到合法区间 */
export function clampContentLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_CONTENT_LIMIT, Math.max(1, Math.round(value)));
}

/** 把用户传入的总字节预算夹到合法区间（不低于单次 limit） */
export function clampMaxContentBytes(value: number | undefined, limit: number): number {
  if (value === undefined || !Number.isFinite(value)) return limit;
  return Math.min(MAX_CONTENT_BYTES, Math.max(limit, Math.round(value)));
}
