/**
 * mineru 扩展 —— 类型与参数 Schema
 *
 * 集中定义两个工具的：
 *  - 参数 Schema（TypeBox，供 LLM 调用校验）
 *  - 结果详情类型（供渲染组件与分支状态恢复使用）
 *
 * 消费方：client.ts（HTTP 客户端）、output.ts（落盘）、index.ts（工具注册与渲染）。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

/* ------------------------------ 公共细节 ------------------------------ */

/** 单个文件的处理结果摘要（两个工具的 details 共用） */
export interface MineruFileSummary {
  /** 原始输入（URL 或本地路径） */
  source: string;
  /** 参与落盘的文件名 */
  fileName: string;
  status: "done" | "pending" | "failed";
  /** 接口原始 state */
  state?: string;
  /** "已解析/总页数" */
  pages?: string;
  taskId?: string;
  batchId?: string;
  markdownPath?: string;
  markdownBytes?: number;
  markdownLines?: number;
  assetCount?: number;
  assetDir?: string;
  error?: string;
}

/* ------------------------------ mineru_parse ------------------------------ */

export const parseParamsSchema = Type.Object({
  sources: Type.Array(
    Type.String({
      description: "本地文件路径或 http(s) 远程 URL；单个文件也写成只含一项的数组",
    }),
    {
      description:
        "要解析的文档，支持 PDF、图片（png/jpg/jpeg/jp2/webp/gif/bmp）、doc/docx、ppt/pptx、xls/xlsx、html；一次最多 50 个（v4 标准接口批量上限）",
      minItems: 1,
      maxItems: 50,
    },
  ),
  model_version: Type.Optional(
    StringEnum(["pipeline", "vlm", "MinerU-HTML"] as const, {
      description:
        "解析模型：vlm（默认，公式/复杂版面更准）、pipeline（更快更省额度）、MinerU-HTML（HTML 输入必须用它，会自动切换）",
    }),
  ),
  output_dir: Type.Optional(
    Type.String({
      description: "markdown 与图片的输出目录；本地文件默认写在源文件同目录，远程 URL 默认写在当前工作目录",
    }),
  ),
  language: Type.Optional(
    Type.String({
      description:
        "文档语言，默认 ch；常用值：ch、en、japan、korean、chinese_cht、latin、arabic、cyrillic、devanagari、east_slavic、ta、te、ka",
    }),
  ),
  page_ranges: Type.Optional(
    Type.String({
      description:
        '只解析指定页：v4 接口用逗号分隔（如 "2,4-6"，"2--2" 表示第 2 页到倒数第 2 页）；v1 轻量接口只支持 from-to 或单页（如 "1-10"）',
    }),
  ),
  enable_formula: Type.Optional(Type.Boolean({ description: "是否开启公式识别，默认 true" })),
  enable_table: Type.Optional(Type.Boolean({ description: "是否开启表格识别，默认 true" })),
  is_ocr: Type.Optional(Type.Boolean({ description: "是否强制走 OCR（扫描件/无文字层 PDF 建议开启），默认 false" })),
  api: Type.Optional(
    StringEnum(["auto", "standard", "agent"] as const, {
      description:
        "接口选择：auto（默认，有 MINERU_API_KEY 走 standard）、standard（v4 标准接口，≤200MB/≤200 页/可批量）、agent（v1 轻量接口，免 Token，≤10MB/≤20 页且仅单文件）",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description: "是否等待解析完成并落盘，默认 true；设为 false 则提交后立即返回任务 ID，之后用 mineru_query 查询",
    }),
  ),
});
export type ParseParams = Static<typeof parseParamsSchema>;

/** mineru_parse 结果详情 */
export interface MineruParseDetails {
  /** 实际使用的接口 */
  api: "standard" | "agent";
  modelVersion: string;
  /** 提交的文件数 */
  fileCount: number;
  files: MineruFileSummary[];
  elapsedMs: number;
  /** 是否因超过 MINERU_MAX_WAIT_MS 而提前返回 */
  timedOut: boolean;
  /** 是否只提交未等待（wait=false） */
  submittedOnly: boolean;
  /** 自动把模型切到 MinerU-HTML（HTML 输入） */
  forcedHtmlModel: boolean;
  truncation?: TruncationResult;
}

/* ------------------------------ mineru_query ------------------------------ */

export const queryParamsSchema = Type.Object({
  id: Type.String({
    description: "mineru_parse 返回的 task_id 或 batch_id（接口类型会自动探测，无需指定）",
  }),
  download: Type.Optional(
    Type.Boolean({
      description: "任务已完成时是否下载结果并落盘 markdown，默认 false（只报告状态与结果链接）",
    }),
  ),
  output_dir: Type.Optional(
    Type.String({ description: "download=true 时的输出目录，默认当前工作目录" }),
  ),
});
export type QueryParams = Static<typeof queryParamsSchema>;

/** mineru_query 结果详情 */
export interface MineruQueryDetails {
  id: string;
  /** 探测到的接口类型（未找到任务时 undefined） */
  api?: "standard" | "agent";
  found: boolean;
  files: MineruFileSummary[];
  error?: string;
}
