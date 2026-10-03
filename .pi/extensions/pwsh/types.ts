/**
 * pwsh 扩展 —— 数据类型定义
 *
 * 集中定义四个 pwsh 工具的：
 *  - 参数 Schema（TypeBox，供 LLM 调用校验）
 *  - 结果详情类型（供渲染组件与分支状态恢复使用）
 *  - 公共常量（输出截断限制、临时文件前缀）
 *
 * 消费方：core.ts（执行核心）、tools/ 下各工具实现。
 *
 * 作者：云枫
 * 创建时间：2026-09-07
 */

import { Type, type Static } from "typebox";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

/* ------------------------------ 公共常量 ------------------------------ */

/** 临时文件前缀：截断后完整输出落盘的名字前缀 */
export const TEMP_FILE_PREFIX = "pi-pwsh";

/* ------------------------------ pwsh_exec ------------------------------ */

export const execParamsSchema = Type.Object({
  command: Type.String({ description: "要执行的 PowerShell 命令" }),
  timeout: Type.Optional(Type.Number({ description: "超时秒数（可选，默认无超时限制）" })),
});
export type ExecParams = Static<typeof execParamsSchema>;

/** pwsh_exec 结果详情 */
export interface PwshExecDetails {
  exitCode: number | null;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/* ------------------------------ pwsh_ls ------------------------------ */

export const lsParamsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "要列出的目录路径（默认当前工作目录）" })),
  recursive: Type.Optional(Type.Boolean({ description: "是否递归列出子目录（默认 false）" })),
});
export type LsParams = Static<typeof lsParamsSchema>;

/** pwsh_ls 结果详情 */
export interface PwshLsDetails {
  exitCode: number | null;
  path: string;
  recursive: boolean;
  itemCount: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/* ------------------------------ pwsh_read ------------------------------ */

export const readParamsSchema = Type.Object({
  path: Type.String({ description: "要读取的文件路径" }),
  offset: Type.Optional(Type.Number({ description: "起始行号（从 1 开始，默认 1）" })),
  limit: Type.Optional(Type.Number({ description: "最多读取的行数（默认全部）" })),
});
export type ReadParams = Static<typeof readParamsSchema>;

/** pwsh_read 结果详情 */
export interface PwshReadDetails {
  exitCode: number | null;
  path: string;
  offset: number;
  limit?: number;
  totalLines: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/* ------------------------------ pwsh_grep ------------------------------ */

export const grepParamsSchema = Type.Object({
  pattern: Type.String({ description: "要搜索的正则模式" }),
  path: Type.Optional(Type.String({ description: "要搜索的文件或目录（默认当前工作目录）" })),
  glob: Type.Optional(Type.String({ description: "文件通配过滤，例如 *.ts" })),
  recursive: Type.Optional(Type.Boolean({ description: "目录递归搜索（默认 false，仅在目标是目录时生效）" })),
});
export type GrepParams = Static<typeof grepParamsSchema>;

/** pwsh_grep 结果详情 */
export interface PwshGrepDetails {
  exitCode: number | null;
  pattern: string;
  path: string;
  matchCount: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}