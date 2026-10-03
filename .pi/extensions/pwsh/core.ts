/**
 * pwsh 扩展 —— 共享执行核心
 *
 * 参照 pi 内置 bash 工具的写法，封装 PowerShell 命令执行的核心能力：
 *  - 复用 pi 官方本地 PowerShell 执行后端（含 UTF-8 编码前缀与进程树清理）
 *  - 流式输出 + 100ms 节流推送（onUpdate）
 *  - 大输出内存有界：超过阈值后仅保留尾部滚动窗口，完整输出流式落盘
 *  - 输出截断（50KB / 2000 行）与截断提示、临时文件路径
 *  - AbortSignal 中止、超时处理
 *  - 向子进程注入 PI_* 会话环境变量
 *  - 统一渲染辅助：工具调用标题、结果摘要（耗时 / 截断 / 内容预览）
 *
 * 消费方：tools/ 下四个工具（pwsh_exec / pwsh_ls / pwsh_read / pwsh_grep）。
 *
 * 作者：云枫
 * 创建时间：2026-09-07
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalPowerShellOperations,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
  type ExtensionContext,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type Theme } from "@earendil-works/pi-tui";

import { TEMP_FILE_PREFIX } from "./types.js";

/* ------------------------------ 常量 ------------------------------ */

/** 命令前缀：禁用 ANSI 颜色渲染，避免转义序列污染 LLM 可见输出 */
const PWSH_PROLOGUE = "$PSStyle.OutputRendering = 'PlainText'\n";

/** 内存中保留完整输出的上限：超过后切换为滚动尾部窗口 + 流式写盘（10MB） */
const MAX_IN_MEMORY_BYTES = 10 * 1024 * 1024;

/** 滚动尾部窗口大小：约 200KB，覆盖截断后的可见范围 */
const MAX_WINDOW_BYTES = DEFAULT_MAX_BYTES * 4;

/** 流式输出节流间隔（毫秒）：与内置 bash 工具一致 */
const UPDATE_THROTTLE_MS = 100;

/** pi 官方本地 PowerShell 执行后端（单例，含 UTF-8 编码前缀与进程树清理） */
const powershellOps = createLocalPowerShellOperations();

/* ------------------------------ 有界输出收集器 ------------------------------ */

/**
 * 收集子进程输出，保持内存有界：
 *  - 10MB 以内：完整保留于内存，供精确截断与落盘
 *  - 超过之后：仅保留尾部滚动窗口，完整输出转流式写入临时文件
 */
class BoundedOutput {
  private decoder = new TextDecoder();
  /** 未溢出时保留的完整输出文本 */
  private fullText: string | null = "";
  /** 溢出后保留的尾部滚动窗口 */
  private window = "";
  private windowBytes = 0;
  private totalRawBytes = 0;
  private tempFileStream: WriteStream | undefined;
  private tempFilePath: string | undefined;

  /** 是否已启用临时文件（完整输出落盘） */
  get hasTempFile(): boolean {
    return this.tempFilePath !== undefined;
  }

  append(raw: Buffer): void {
    this.totalRawBytes += raw.length;
    const text = this.decoder.decode(raw, { stream: true });

    if (this.fullText !== null) {
      this.fullText += text;
      if (this.totalRawBytes > MAX_IN_MEMORY_BYTES) {
        // 超限：先补写已累积全文，再切换为滚动窗口模式
        this.ensureTempFile();
        this.tempFileStream!.write(this.fullText);
        this.window = takeLineWindow(this.fullText, MAX_WINDOW_BYTES);
        this.windowBytes = Buffer.byteLength(this.window, "utf8");
        this.fullText = null;
      }
    } else {
      this.window += text;
      this.windowBytes += Buffer.byteLength(text, "utf8");
      this.trimWindow();
    }

    this.tempFileStream?.write(raw);
  }

  /** 结束输入：flush 解码器残余并关闭临时文件流 */
  async close(): Promise<void> {
    const rest = this.decoder.decode();
    if (this.fullText !== null) {
      this.fullText += rest;
    } else if (rest) {
      this.window += rest;
      this.trimWindow();
    }

    if (this.tempFileStream) {
      const stream = this.tempFileStream;
      this.tempFileStream = undefined;
      await new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(() => resolve());
      });
    }
  }

  /** 获取当前可见文本（未溢出时为完整输出，溢出后为尾部窗口） */
  getText(): string {
    return this.fullText !== null ? this.fullText : this.window;
  }

  /** 返回临时文件路径（若已启用） */
  get tempPath(): string | undefined {
    return this.tempFilePath;
  }

  /** 滚动窗口超过上限时，裁掉行首之前的部分 */
  private trimWindow(): void {
    if (this.windowBytes <= MAX_WINDOW_BYTES) return;
    const start = lineAwareStart(this.window, MAX_WINDOW_BYTES);
    this.window = this.window.slice(start);
    this.windowBytes = Buffer.byteLength(this.window, "utf8");
  }

  private ensureTempFile(): void {
    if (this.tempFileStream) return;
    this.tempFilePath = join(tmpdir(), `${TEMP_FILE_PREFIX}-${randomId()}.log`);
    this.tempFileStream = createWriteStream(this.tempFilePath);
  }
}

/** 从文本中截取「末尾 bytes 字节、且以完整行起始」的窗口 */
function takeLineWindow(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  const start = lineAwareStart(text, bytes);
  return buf.subarray(start).toString("utf8");
}

/** 计算行感知的起始字节偏移：尽量从换行之后开始裁剪 */
function lineAwareStart(text: string, keepBytes: number): number {
  const buf = Buffer.from(text, "utf8");
  let start = Math.max(0, buf.length - keepBytes);
  const firstNewline = buf.indexOf(0x0a, start); // '\n'
  if (firstNewline !== -1) start = firstNewline + 1;
  return start;
}

/** 生成临时文件唯一 ID */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/* ------------------------------ 工具辅助 ------------------------------ */

/**
 * 将字符串安全地引用为 PowerShell 单引号字面量（单引号翻倍转义），
 * 防止路径 / 模式 / 文件通配被二次解释或注入。
 */
export function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 将工具执行层收到的 onUpdate 包装为标准工具回调形态：
 * （text 文本）→ { content: [{ type: "text", text }], details: undefined }
 */
export function makeToolUpdate(
  onUpdate: ((message: { content: Array<{ type: string; text?: string }>; details?: unknown }) => void) | undefined,
): (text: string) => void {
  return (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
}

/** 向子进程注入 PI_* 会话环境变量（与内置 shell 工具一致） */
function buildSessionEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;

  const model = ctx.model;
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (model) {
    env.PI_PROVIDER = model.provider;
    env.PI_MODEL = model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}

/* ------------------------------ 主执行入口 ------------------------------ */

export interface PwshRunOptions {
  /** 超时秒数（可选，默认无超时限制） */
  timeout?: number;
  /** 中止信号（用户 Esc 取消等场景） */
  signal?: AbortSignal;
  /** 截断方向：tail 保留末尾（命令输出），head 保留开头（列表 / 搜索结果） */
  truncateMode?: "tail" | "head";
  /** 流式输出回调（节流后推送中间文本） */
  onUpdate?: (text: string) => void;
}

export interface PwshRunResult {
  exitCode: number | null;
  /** 截断后的可见文本（含截断提示） */
  content: string;
  details: {
    truncation?: TruncationResult;
    fullOutputPath?: string;
  };
}

/**
 * 执行一条 PowerShell 命令，返回截断后的文本与详情。
 * 非零退出码 / 中止 / 超时均以 Error 抛出，错误信息携带已有输出。
 */
export async function runPowerShell(
  command: string,
  ctx: ExtensionContext,
  options: PwshRunOptions = {},
): Promise<PwshRunResult> {
  const { timeout, signal, truncateMode = "tail", onUpdate } = options;

  if (signal?.aborted) {
    throw new Error("aborted");
  }

  const collector = new BoundedOutput();
  // 流式更新节流：最多每 100ms 推送一次
  let updateDirty = false;
  let updateTimer: NodeJS.Timeout | undefined;
  let lastUpdateAt = 0;
  const flushUpdate = () => {
    if (!updateDirty) return;
    updateDirty = false;
    lastUpdateAt = Date.now();
    onUpdate?.(collector.getText());
  };
  const scheduleUpdate = () => {
    if (!onUpdate) return;
    updateDirty = true;
    const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
    if (delay <= 0) {
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      }
      flushUpdate();
    } else if (!updateTimer) {
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        flushUpdate();
      }, delay);
    }
  };
  const clearUpdateTimer = () => {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = undefined;
    }
  };

  let exitCode: number | null = null;
  try {
    const result = await powershellOps.exec(`${PWSH_PROLOGUE}${command}`, ctx.cwd, {
      onData: (data: Buffer) => {
        collector.append(data);
        scheduleUpdate();
      },
      signal,
      timeout,
      env: buildSessionEnv(ctx),
    });
    exitCode = result.exitCode;
  } catch (err) {
    await collector.close();
    clearUpdateTimer();
    flushUpdate();
    if (err instanceof Error && err.message === "aborted") {
      throw new Error(appendStatus(collector.getText(), "命令已被中止"));
    }
    if (err instanceof Error && err.message.startsWith("timeout:")) {
      const seconds = err.message.split(":")[1];
      throw new Error(appendStatus(collector.getText(), `命令在 ${seconds} 秒后超时`));
    }
    throw err;
  }

  await collector.close();
  clearUpdateTimer();
  flushUpdate();

  // 截断：tail 保留末尾（命令执行的错误与最终结果），head 保留开头（列表 / 搜索）
  const fullOutput = collector.getText();
  const trunc =
    truncateMode === "head"
      ? truncateHead(fullOutput, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
      : truncateTail(fullOutput, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

  let content = trunc.content || "(无输出)";
  const details: PwshRunResult["details"] = {};

  if (trunc.truncated) {
    const fullOutputPath = await persistFullOutput(fullOutput, collector);
    details.truncation = trunc;
    details.fullOutputPath = fullOutputPath;
    content += buildTruncationFooter(trunc, truncateMode, fullOutputPath);
  }

  if (exitCode !== 0 && exitCode !== null) {
    throw new Error(appendStatus(content, `命令退出码 ${exitCode}`));
  }

  return { exitCode, content, details };
}

/** 将完整输出落盘：已流式写盘则复用其路径，否则新建临时文件 */
async function persistFullOutput(fullOutput: string, collector: BoundedOutput): Promise<string> {
  if (collector.hasTempFile) return collector.tempPath!;
  const dir = await mkdtemp(join(tmpdir(), `${TEMP_FILE_PREFIX}-`));
  const file = join(dir, "output.txt");
  await writeFile(file, fullOutput, "utf8");
  return file;
}

/** 生成截断提示文案（含完整输出路径，供 LLM 按需读取） */
function buildTruncationFooter(
  trunc: TruncationResult,
  mode: "tail" | "head",
  fullOutputPath: string,
): string {
  if (mode === "head") {
    return `\n\n[输出已截断：显示前 ${trunc.outputLines} 行（${formatSize(trunc.outputBytes)}）。完整输出：${fullOutputPath}]`;
  }
  const startLine = trunc.totalLines - trunc.outputLines + 1;
  return `\n\n[输出已截断：显示第 ${startLine}-${trunc.totalLines} 行，共 ${trunc.totalLines} 行。完整输出：${fullOutputPath}]`;
}

/** 将一段文本与附加状态信息拼接（状态置于末尾，供错误提示用） */
function appendStatus(text: string, status: string): string {
  return `${text ? `${text}\n\n` : ""}${status}`;
}

/* ------------------------------ 渲染辅助 ------------------------------ */

/** 渲染工具调用标题行：`PS> 参数描述（超时 Xs）` */
export function renderCallCommon(command: string, theme: Theme, timeout?: number): Component {
  let text = theme.fg("toolTitle", theme.bold(`PS> ${command}`));
  if (timeout !== undefined) {
    text += theme.fg("muted", `（超时 ${timeout}s）`);
  }
  return new Text(text, 0, 0);
}

/** 从渲染状态中计算已耗时（renderCall 记录 startedAt 之后） */
export function getElapsedMs(context: { state: Record<string, unknown> }): number | undefined {
  const startedAt = context.state.startedAt as number | undefined;
  return startedAt === undefined ? undefined : Date.now() - startedAt;
}

/**
 * 渲染工具结果摘要：
 *  - 标题行：调用方给出的摘要（如「退出码 0」「42 处匹配」）
 *  - 截断 / 耗时附加标记
 *  - 展开时：内容预览（前 previewLines 行）+ 完整输出路径
 */
export function renderResultCommon(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  header: string,
  elapsedMs?: number,
  previewLines = 25,
): Component {
  const details = result.details as { truncation?: TruncationResult; fullOutputPath?: string } | undefined;

  if (options.isPartial) {
    return new Text(theme.fg("dim", "执行中…"), 0, 0);
  }

  let text = header;
  if (details?.truncation?.truncated) {
    text += theme.fg("warning", "（输出已截断）");
  }
  if (elapsedMs !== undefined) {
    text += theme.fg("muted", ` · ${(elapsedMs / 1000).toFixed(1)}s`);
  }

  if (options.expanded) {
    const first = result.content[0];
    const body = first?.type === "text" && first.text ? first.text : "";
    if (body) {
      const lines = body.split("\n");
      const shown = lines.slice(0, previewLines);
      for (const line of shown) {
        text += `\n${theme.fg("dim", line || " ")}`;
      }
      if (lines.length > previewLines) {
        text += `\n${theme.fg("muted", `…（共 ${lines.length} 行，更多内容见完整输出）`)}`;
      }
    }
    if (details?.fullOutputPath) {
      text += `\n${theme.fg("muted", `完整输出：${details.fullOutputPath}`)}`;
    }
  }

  return new Text(text, 0, 0);
}