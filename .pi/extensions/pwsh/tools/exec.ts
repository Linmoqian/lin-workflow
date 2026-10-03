/**
 * pwsh_exec —— 执行任意 PowerShell 命令
 *
 * 参照内置 bash 工具的写法：流式输出、超时、中止、输出截断、非零退出码报错。
 * 适合需要完整 shell 能力的场景（脚本、管道、调用外部程序）。
 *
 * 作者：云枫
 * 创建时间：2026-09-07
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";

import { getElapsedMs, makeToolUpdate, renderCallCommon, renderResultCommon, runPowerShell } from "../core.js";
import { execParamsSchema, type ExecParams, type PwshExecDetails } from "../types.js";

/** 执行核心的截断上限文案 */
const TRUNCATION_NOTE = `输出会被截断为末尾 ${DEFAULT_MAX_LINES} 行或 ${DEFAULT_MAX_BYTES / 1024}KB（先到先截）；截断时完整输出会保存到临时文件并在结果中给出路径。`;

export function createPwshExecTool(): ToolDefinition {
  return {
    name: "pwsh_exec",
    label: "pwsh_exec",
    description: `在当前工作目录下执行一条 PowerShell 命令，返回 stdout 与 stderr。可选 timeout 秒数控制超时。${TRUNCATION_NOTE}`,
    promptSnippet: "Execute PowerShell commands in the current working directory",
    promptGuidelines: [
      "pwsh_exec 是辅助：默认情况优先用内置 bash 工具；仅在任务涉及 Windows 特有语义（注册表、服务管理、NTFS 权限、.NET 对象、PowerShell 模块）或用户明确要求 PowerShell 环境时使用 pwsh_exec。",
      "pwsh_exec 输出遵循 50KB/2000 行截断规则；子进程可通过 $env:PI_* 环境变量读取当前模型与会话信息。",
    ],
    parameters: execParamsSchema,

    async execute(_toolCallId, params: ExecParams, signal, onUpdate, ctx: ExtensionContext) {
      const result = await runPowerShell(params.command, ctx, {
        timeout: params.timeout,
        signal,
        truncateMode: "tail",
        onUpdate: makeToolUpdate(onUpdate),
      });

      const details: PwshExecDetails = {
        exitCode: result.exitCode,
        truncation: result.details.truncation,
        fullOutputPath: result.details.fullOutputPath,
      };
      return { content: [{ type: "text", text: result.content }], details };
    },

    renderCall(args: ExecParams, theme: Theme, context: { state: Record<string, unknown> }) {
      context.state.startedAt = Date.now();
      return renderCallCommon(args.command, theme, args.timeout);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: PwshExecDetails },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: Record<string, unknown> },
    ) {
      const header = `退出码 ${result.details?.exitCode ?? "?"}`;
      return renderResultCommon(result, options, theme, header, getElapsedMs(context));
    },
  };
}