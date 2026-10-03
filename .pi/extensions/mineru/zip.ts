/**
 * mineru 扩展 —— 最小 ZIP 读取器
 *
 * MinerU 的解析结果是一个 zip（内含 full.md、content_list.json、layout.json、images/…），
 * 这里只用 node:zlib 实现「按需读取指定条目」，不引入第三方解压依赖：
 *   1. 从尾部回扫定位 EOCD（含 Zip64 分支），拿到中央目录偏移与条目数
 *   2. 逐条读中央目录条目，按 filter 决定是否需要解压，避免把 layout.json 这类大文件全读进内存
 *   3. 用条目里的压缩大小 + 本地文件头长度定位数据区，stored 直取、deflate 走 inflateRawSync
 *   4. 解压后校验 CRC32，防止 CDN 传输被截断却静默产出半截 markdown
 *
 * 消费方：client.ts（下载 zip 后取 full.md 与 images/）。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { crc32, inflateRawSync } from "node:zlib";

/* ------------------------------ 常量 ------------------------------ */

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** EOCD 固定长度（不含注释） */
const EOCD_MIN_SIZE = 22;

/** EOCD 注释最大长度（回扫窗口） */
const MAX_COMMENT_SIZE = 0xffff;

/** 单个条目的解压上限（防 zip 炸弹 / 异常大文件吃满内存） */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** 压缩方式 */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/* ------------------------------ 类型 ------------------------------ */

export interface ZipEntry {
  /** 条目路径，如 full.md、images/xxx.jpg */
  name: string;
  /** 解压后的内容 */
  data: Buffer;
}

/* ------------------------------ EOCD 定位 ------------------------------ */

interface DirectoryInfo {
  entryCount: number;
  centralOffset: number;
}

/** 从文件尾部回扫 EOCD；必要时跟进 Zip64 EOCD 定位器 */
function locateDirectory(buffer: Buffer): DirectoryInfo {
  const minOffset = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);

  let eocd = -1;
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) !== EOCD_SIG) continue;
    // 校验注释长度与实际剩余字节一致，避免把正文里碰巧出现的签名当成 EOCD
    const commentLength = buffer.readUInt16LE(i + 20);
    if (i + EOCD_MIN_SIZE + commentLength === buffer.length) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) throw new Error("不是有效的 zip：未找到 EOCD 结束记录");

  let entryCount = buffer.readUInt16LE(eocd + 10);
  let centralOffset = buffer.readUInt32LE(eocd + 16);
  const needsZip64 = entryCount === 0xffff || centralOffset === 0xffffffff;

  if (needsZip64) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) {
      throw new Error("zip 需要 Zip64 记录，但未找到定位器；请反馈给扩展作者");
    }
    const zip64Eocd = Number(buffer.readBigUInt64LE(locator + 8));
    if (zip64Eocd < 0 || zip64Eocd + 56 > buffer.length || buffer.readUInt32LE(zip64Eocd) !== ZIP64_EOCD_SIG) {
      throw new Error("zip 的 Zip64 EOCD 记录不可读；请反馈给扩展作者");
    }
    entryCount = Number(buffer.readBigUInt64LE(zip64Eocd + 32));
    centralOffset = Number(buffer.readBigUInt64LE(zip64Eocd + 48));
  }

  if (centralOffset >= buffer.length) throw new Error("zip 中央目录偏移越界：文件可能已被截断");
  return { entryCount, centralOffset };
}

/* ------------------------------ 单条解压 ------------------------------ */

/** 按压缩方式还原条目内容，并校验 CRC32 */
function readEntryData(
  buffer: Buffer,
  name: string,
  method: number,
  flags: number,
  expectedCrc: number,
  compressed: Buffer,
  uncompressedSize: number,
): Buffer {
  if ((flags & 0x1) !== 0) throw new Error(`zip 条目 ${name} 已加密，无法解析`);
  if (uncompressedSize > MAX_ENTRY_BYTES) {
    throw new Error(`zip 条目 ${name} 解压后 ${Math.round(uncompressedSize / 1024 / 1024)}MB，超出单条上限`);
  }

  let data: Buffer;
  if (method === METHOD_STORED) {
    data = Buffer.from(compressed);
  } else if (method === METHOD_DEFLATE) {
    // maxOutputLength 兜底：声明大小不可信时立刻抛错，而不是无限扩容
    data = inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) + 1024 });
  } else {
    throw new Error(`zip 条目 ${name} 使用了不支持的压缩方式（method=${method}）`);
  }

  if (expectedCrc !== 0 && crc32(data) !== expectedCrc) {
    throw new Error(`zip 条目 ${name} CRC 校验失败：文件下载不完整，请重试`);
  }
  return data;
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * 读取 zip 中满足 filter 的条目。
 * filter 省略时返回全部条目；大 zip 建议传 filter 只取需要的文件。
 */
export function readZipEntries(buffer: Buffer, filter?: (name: string) => boolean): ZipEntry[] {
  const { entryCount, centralOffset } = locateDirectory(buffer);

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`zip 中央目录第 ${index + 1} 条记录损坏：文件可能已被截断`);
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    cursor += 46 + nameLength + extraLength + commentLength;

    // 目录条目跳过；大小或偏移写在 extra 字段的 Zip64 条目暂不支持（MinerU 结果包不会出现）
    if (name.endsWith("/")) continue;
    if (filter && !filter(name)) continue;

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip 条目 ${name} 使用 Zip64 扩展字段，暂不支持解析`);
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip 条目 ${name} 的本地文件头损坏：文件可能已被截断`);
    }
    // 本地头的名称 / 扩展字段长度可能与中央目录不同，必须以本地头为准
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    if (dataStart + compressedSize > buffer.length) {
      throw new Error(`zip 条目 ${name} 数据越界：文件下载不完整，请重试`);
    }

    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.push({
      name,
      data: readEntryData(buffer, name, method, flags, expectedCrc, compressed, uncompressedSize),
    });
  }

  return entries;
}
