/**
 * pwsh 扩展 —— 入口
 *
 * 注册四个基于 PowerShell 的工具（四大件），写法参照 pi 内置 bash 工具：
 *  - pwsh_exec：执行任意 PowerShell 命令（流式输出 / 超时 / 截断）
 *  - pwsh_ls：  列出目录内容（Get-ChildItem）
 *  - pwsh_read：读取文本文件（Get-Content）
 *  - pwsh_grep：按正则搜索文件内容（Select-String）
 *
 * 安装位置：~/.pi/agent/extensions/pwsh/（全局自动发现，可 /reload 热加载）
 *
 * 作者：云枫
 * 创建时间：2026-09-07
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPwshExecTool } from "./tools/exec.js";
import { createPwshLsTool } from "./tools/ls.js";
import { createPwshReadTool } from "./tools/read.js";
import { createPwshGrepTool } from "./tools/grep.js";

export default function pwshExtension(pi: ExtensionAPI): void {
  pi.registerTool(createPwshExecTool());
  pi.registerTool(createPwshLsTool());
  pi.registerTool(createPwshReadTool());
  pi.registerTool(createPwshGrepTool());
}