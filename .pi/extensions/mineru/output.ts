/**
 * mineru 扩展 —— 解析结果落盘
 *
 * 把 MinerU 的 markdown 正文与 zip 里的图片写成磁盘上可直接阅读的一套文件：
 *   <目录>/<源文件名>.md          正文（同名已存在时退让为 <源名>.mineru.md、<源名>.mineru-2.md …）
 *   <目录>/<源文件名>.assets/     图片（内容哈希命名，重跑不会写坏别的文档的图）
 * 正文里的图片引用会从 images/xxx.jpg 改写成 <源名>.assets/xxx.jpg，保证 .md 单独打开也能显示图。
 *
 * 落盘全程走 pi 的 withFileMutationQueue，与内置 write/edit 工具排队，避免同轮并行写同一文件互相覆盖。
 *
 * 消费方：index.ts 的 mineru_parse / mineru_query。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { ZipEntry } from "./zip.ts";

/* ------------------------------ 常量 ------------------------------ */

/** zip 里图片所在的目录前缀 */
const IMAGE_PREFIX = "images/";

/** 同名时的重命名尝试次数 */
const MAX_RENAME_ATTEMPTS = 20;

/** 图片目录后缀 */
const ASSETS_SUFFIX = ".assets";

/* ------------------------------ 类型 ------------------------------ */

export interface SaveInput {
  /** markdown 正文 */
  markdown: string;
  /** 需要一并写出的图片（name 形如 images/xxx.jpg） */
  assets: ZipEntry[];
  /** 源文件名，用于推导输出名（如 demo.pdf → demo.md） */
  sourceName: string;
  /** 输出目录（调用方已解析成绝对路径） */
  outputDir: string;
}

export interface SaveOutcome {
  markdownPath: string;
  markdownBytes: number;
  markdownLines: number;
  /** 实际写入磁盘的正文（图片引用已改写过），供调用方做预览，避免预览与文件不一致 */
  markdown: string;
  /** 写出的图片张数 */
  assetCount: number;
  /** 图片目录（无图片时 undefined） */
  assetDir?: string;
  /** 因同名而改名写入 */
  renamed: boolean;
}

/* ------------------------------ 工具 ------------------------------ */

/** 清掉 Windows 文件名非法字符，保证能落盘 */
function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned || "mineru";
}

/** 由源文件名推导输出用的主名（demo.pdf → demo） */
export function stemOf(sourceName: string): string {
  const base = sanitizeName(basename(sourceName));
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return sanitizeName(stem);
}

/** 按顺序给出候选 markdown 路径：xx.md → xx.mineru.md → xx.mineru-2.md → … */
function buildCandidates(outputDir: string, stem: string): string[] {
  const candidates = [join(outputDir, `${stem}.md`)];
  for (let i = 1; i < MAX_RENAME_ATTEMPTS; i += 1) {
    const suffix = i === 1 ? "mineru" : `mineru-${i}`;
    candidates.push(join(outputDir, `${stem}.${suffix}.md`));
  }
  return candidates;
}

/** 独占写：目标已存在时返回 false，由调用方换下一个候选名 */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** markdown 链接目标里必须转义的字符（空格/括号会截断链接，?#% 会被当查询串） */
const LINK_ESCAPES: Record<string, string> = {
  " ": "%20",
  "%": "%25",
  "?": "%3F",
  "#": "%23",
  "(": "%28",
  ")": "%29",
  "<": "%3C",
  ">": "%3E",
  '"': "%22",
  "`": "%60",
  "\\": "%5C",
};

/** 图片目录名转成可安全放进 markdown 链接的形式（中文等非 ASCII 字符保留，保持可读性） */
function encodeLinkPath(path: string): string {
  return path.replace(/[ %?#()<>"`\\]/g, (char) => LINK_ESCAPES[char] ?? char);
}

/** 把正文里的 images/ 引用改写到新的图片目录 */
function rewriteAssetLinks(markdown: string, assetDirName: string): string {
  const encoded = encodeLinkPath(assetDirName);
  return markdown
    .replace(/(\]\(\/?)(images\/)/g, `$1${encoded}/`)
    .replace(/(src=["']\/?)images\//g, `$1${encoded}/`);
}

/* ------------------------------ 主入口 ------------------------------ */

/** 写出 markdown 与图片；落盘路径按同名避让规则确定 */
export async function saveParsedDocument(input: SaveInput): Promise<SaveOutcome> {
  const stem = stemOf(input.sourceName);
  const queueKey = join(input.outputDir, `${stem}.md`);

  return withFileMutationQueue(queueKey, async () => {
    await mkdir(input.outputDir, { recursive: true });

    // 图片目录按内容哈希命名，重跑直接复用，不需要避让
    let assetDir: string | undefined;
    let assetDirName: string | undefined;
    if (input.assets.length > 0) {
      assetDirName = `${stem}${ASSETS_SUFFIX}`;
      assetDir = join(input.outputDir, assetDirName);
      await mkdir(assetDir, { recursive: true });
      for (const asset of input.assets) {
        const fileName = sanitizeName(asset.name.slice(IMAGE_PREFIX.length));
        await writeFile(join(assetDir, fileName), asset.data);
      }
    }

    const body = assetDirName ? rewriteAssetLinks(input.markdown, assetDirName) : input.markdown;

    let markdownPath: string | undefined;
    let renamed = false;
    const candidates = buildCandidates(input.outputDir, stem);
    for (const [index, candidate] of candidates.entries()) {
      if (await writeIfAbsent(candidate, body)) {
        markdownPath = candidate;
        renamed = index > 0;
        break;
      }
    }
    if (!markdownPath) {
      throw new Error(`输出目录下同名文件过多（已尝试 ${candidates.length} 个名字）：${input.outputDir}`);
    }

    return {
      markdownPath,
      markdownBytes: Buffer.byteLength(body, "utf8"),
      markdownLines: body.split("\n").length,
      markdown: body,
      assetCount: input.assets.length,
      assetDir,
      renamed,
    };
  });
}

/** 目标目录已存在同名 markdown 时用于提示 */
export function markdownExists(outputDir: string, sourceName: string): boolean {
  return existsSync(join(outputDir, `${stemOf(sourceName)}.md`));
}
