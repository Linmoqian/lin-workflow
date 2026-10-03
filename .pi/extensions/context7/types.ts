/**
 * context7 扩展 —— 类型与参数 Schema
 *
 * 集中定义两个工具的：
 *  - 参数 Schema（TypeBox，供 LLM 调用校验）
 *  - 结果详情类型（供渲染组件与分支状态恢复使用）
 *  - Context7 接口返回的数据结构
 *
 * 消费方：client.ts（HTTP 客户端）、index.ts（工具注册与渲染）。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { Type, type Static } from "typebox";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

/* ------------------------------ Context7 接口数据结构 ------------------------------ */

/** /api/v2/libs/search 返回的单个库条目 */
export interface Context7Library {
  id: string;
  title: string;
  description?: string;
  branch?: string;
  lastUpdateDate?: string;
  state?: string;
  totalTokens?: number;
  totalSnippets?: number;
  stars?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
}

/* ------------------------------ context7_search_library ------------------------------ */

export const searchParamsSchema = Type.Object({
  libraryName: Type.String({
    description: "要查找的库 / 框架 / 产品名称，如 next.js、react、fastapi、tauri",
  }),
  query: Type.Optional(
    Type.String({
      description: "用户的具体问题，用于提升结果排序相关性，如 setup ssr、window drag region",
    }),
  ),
});
export type SearchParams = Static<typeof searchParamsSchema>;

/** context7_search_library 结果详情 */
export interface Context7SearchDetails {
  libraryName: string;
  query?: string;
  /** 接口返回的候选总数 */
  count: number;
  /** 原始候选列表（供渲染与后续分支恢复） */
  results: Context7Library[];
}

/* ------------------------------ context7_get_docs ------------------------------ */

export const docsParamsSchema = Type.Object({
  libraryId: Type.String({
    description:
      "Context7 库 ID，取自 context7_search_library 的 id 字段，形如 /vercel/next.js；需要特定版本时可加版本号，如 /vercel/next.js/v15.1.8",
  }),
  query: Type.String({
    description: "要在该库文档中检索的具体内容，越具体命中越准，如 app router middleware matcher",
  }),
  tokens: Type.Optional(
    Type.Number({
      description: "本次返回文档的 token 预算（默认取扩展配置，可调范围 500-50000）",
    }),
  ),
});
export type DocsParams = Static<typeof docsParamsSchema>;

/** context7_get_docs 结果详情 */
export interface Context7DocsDetails {
  libraryId: string;
  query: string;
  /** 实际使用的 token 预算 */
  tokens: number;
  /** 文档正文字符数（截断前） */
  chars: number;
  /** 是否命中本次会话内的文档缓存 */
  fromCache: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}
