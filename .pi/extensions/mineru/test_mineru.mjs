/**
 * mineru 扩展 —— 端到端探针
 *
 * 用 jiti 复刻 pi 的扩展加载方式（createJiti + 同名 alias），加载本目录 index.ts，
 * 用一个假的 ExtensionAPI 捕获注册结果，再真刀真枪跑一遍 MinerU 接口：
 *   1. 注册结果（工具 / 命令 / 事件）
 *   2. 渲染函数（renderCall / renderResult）不抛异常
 *   3. 准备本地样本（下载官方示例 PDF）
 *   4. v4 标准接口：远程 URL 解析（extract/task + 轮询 + 解压 + 落盘）
 *   5. v4 标准接口：本地文件解析（file-urls/batch + 上传 + 批量查询）
 *   6. mineru_query：按 batch_id 续查并下载落盘
 *   7. v1 轻量接口：本地文件解析（parse/file + markdown_url）
 *   8. wait=false：仅提交，之后用返回的 ID 续查
 *   9. 错误路径：文件不存在 / HTML 走轻量接口 / 空 id / 查不到的任务
 *  10. /mineru 命令：状态文本与未知子命令
 *  11. zip 读取器：自造 stored + deflate 双方法压缩包校验，含截断包
 *  12. 结果落盘：自造 zip → extractDocument → saveParsedDocument（图片、链接转义、同名避让）
 *
 * 运行：node test_mineru.mjs              需要网络与扩展目录 .env 里的 MINERU_API_KEY
 *       node test_mineru.mjs --offline    只跑本地用例（1、2、10、11、12），不碰接口
 * 注意：会真实消耗 MinerU 额度，全部远端用例都限制 page_ranges=1-1。
 *
 * 作者：云枫
 * 创建时间：2026-09-10
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

/* ------------------------------ 环境与断言 ------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_PACKAGE = "C:/Users/30470/miniforge3/node_modules/@earendil-works/pi-coding-agent";
const JITI_STATIC = join(PI_PACKAGE, "node_modules/jiti/lib/jiti-static.mjs");
const AS_FILE_URL = (path) => `file://${path.replace(/\\/g, "/")}`;

const WORK_DIR = join(tmpdir(), `pi-mineru-probe-${Date.now()}`);
const DEMO_PDF_URL = "https://cdn-mineru.openxlab.org.cn/demo/example.pdf";
const OFFLINE = process.argv.includes("--offline");

let passed = 0;
const failures = [];

/** 记录一次断言 */
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
    return true;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  return false;
}

/** 记录一次「预期抛错」的断言 */
async function expectThrow(name, fn, matcher) {
  try {
    await fn();
    check(name, false, "预期抛错但没有抛");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(name, matcher ? matcher.test(message) : true, message.slice(0, 160));
  }
}

/* ------------------------------ jiti 加载 ------------------------------ */

/** 复刻 pi 的 alias 表（dist/core/extensions/loader.js 的 getAliases） */
function buildAliases() {
  const root = join(PI_PACKAGE, "node_modules/@earendil-works");
  return {
    "@earendil-works/pi-coding-agent": join(PI_PACKAGE, "dist/index.js"),
    "@earendil-works/pi-agent-core": join(root, "pi-agent-core/dist/index.js"),
    "@earendil-works/pi-tui": join(root, "pi-tui/dist/index.js"),
    "@earendil-works/pi-ai": join(root, "pi-ai/dist/compat.js"),
    typebox: join(PI_PACKAGE, "node_modules/typebox/build/index.mjs"),
  };
}

async function createLoader() {
  const { createJiti } = await import(AS_FILE_URL(JITI_STATIC));
  return createJiti(import.meta.url, { moduleCache: false, alias: buildAliases() });
}

/* ------------------------------ 假的 pi 宿主 ------------------------------ */

function createFakePi() {
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  return {
    tools,
    commands,
    events,
    on(event, handler) {
      events.set(event, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerShortcut() {},
    registerFlag() {},
    registerEntryRenderer() {},
    getFlag() {
      return undefined;
    },
  };
}

/** 捕捉 notify / setStatus 的最小 UI */
function createUi() {
  const notifications = [];
  const statuses = [];
  return {
    notifications,
    statuses,
    notify(text, level) {
      notifications.push({ text, level });
    },
    setStatus(name, text) {
      statuses.push({ name, text });
    },
    setWidget() {},
    setTitle() {},
    setEditorText() {},
    async select() {
      return undefined;
    },
    async confirm() {
      return true;
    },
    async input() {
      return undefined;
    },
    async editor() {
      return undefined;
    },
  };
}

function createCtx(ui, cwd) {
  return { cwd, hasUI: true, mode: "tui", ui, signal: undefined, isIdle: () => true };
}

/** 极简 theme：只保证渲染函数用到的 fg / bg / bold 可用 */
const FAKE_THEME = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  dim: (text) => text,
};

/** 调用工具并返回结果 */
async function callTool(tool, params, ctx) {
  const updates = [];
  const result = await tool.execute("probe-call", params, undefined, (partial) => updates.push(partial), ctx);
  return { result, updates };
}

/* ------------------------------ 测试用 zip 构造 ------------------------------ */

/** 手搓一个最小 zip（覆盖 stored / deflate 两种压缩方式），用于验证 zip.ts 与落盘 */
function buildTestZip(stored = false) {
  const files = [
    { name: "full.md", content: "hello full.md\n".repeat(50) },
    { name: "images/a.jpg", content: "fake-jpeg-bytes" },
    { name: "layout.json", content: '{"big":true}' },
  ];

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf8");
    const method = stored ? 0 : 8;
    const body = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  await mkdir(WORK_DIR, { recursive: true });
  console.log(`工作目录：${WORK_DIR}`);
  console.log(`模式：${OFFLINE ? "offline（跳过真实接口）" : "full（会真实调用 MinerU）"}\n`);

  const jiti = await createLoader();
  const factory = await jiti.import(join(HERE, "index.ts"), { default: true });
  check("index.ts 默认导出的是工厂函数", typeof factory === "function");
  if (typeof factory !== "function") process.exit(1);

  const pi = createFakePi();
  factory(pi);

  /* ----- 1. 注册结果 ----- */
  console.log("\n[1] 注册结果");
  check("注册了 mineru_parse 工具", pi.tools.has("mineru_parse"));
  check("注册了 mineru_query 工具", pi.tools.has("mineru_query"));
  check("注册了 /mineru 命令", pi.commands.has("mineru"));
  check("订阅了 session_start", pi.events.has("session_start"));

  const parseTool = pi.tools.get("mineru_parse");
  const queryTool = pi.tools.get("mineru_query");
  const ui = createUi();
  const ctx = createCtx(ui, WORK_DIR);

  await pi.events.get("session_start")({ reason: "startup" }, ctx);
  check(
    "已配置 Key 时 session_start 不告警",
    ui.notifications.filter((item) => item.level === "warning").length === 0,
    JSON.stringify(ui.notifications)
  );

  /* ----- 2. 渲染函数 ----- */
  console.log("\n[2] 渲染函数");
  const callComponent = parseTool.renderCall({ sources: ["a.pdf", "b.pdf"] }, FAKE_THEME, { state: {} });
  check("renderCall 返回组件", callComponent !== undefined && callComponent !== null);
  const renderComponent = parseTool.renderResult(
    { content: [{ type: "text", text: "第一行\n第二行" }], details: { fileCount: 2, files: [] } },
    { expanded: true, isPartial: false },
    FAKE_THEME,
    { state: { startedAt: Date.now() - 1234 } }
  );
  check("renderResult 返回组件", renderComponent !== undefined);
  const partialComponent = queryTool.renderResult(
    { content: [{ type: "text", text: "MinerU 查询｜id=x（v4 批量）" }], details: { found: true, files: [] } },
    { expanded: false, isPartial: true },
    FAKE_THEME,
    { state: {} }
  );
  check("renderResult 流式分支返回组件", partialComponent !== undefined);

  /* ----- 3~9. 真实接口用例 ----- */
  if (!OFFLINE) {
    /* ----- 3. 下载一份真实 PDF 作为本地样本 ----- */
    console.log("\n[3] 准备本地样本");
    const pdfPath = join(WORK_DIR, "demo.pdf");
    const pdfResponse = await fetch(DEMO_PDF_URL);
    const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
    await writeFile(pdfPath, pdfBytes);
    check("示例 PDF 下载成功", pdfBytes.length > 10_000, `字节数 ${pdfBytes.length}`);

    /* ----- 4. v4 标准接口：远程 URL ----- */
    console.log("\n[4] v4 标准接口 · 远程 URL（page_ranges=1-1）");
    const urlRun = await callTool(parseTool, { sources: [DEMO_PDF_URL], page_ranges: "1-1" }, ctx);
    const urlFile = urlRun.result.details.files[0];
    check("URL 解析成功落盘", urlFile?.status === "done", urlFile?.error ?? "");
    check("URL 解析走的是 standard 接口", urlRun.result.details.api === "standard");
    check(
      "URL 结果按 URL 推导文件名",
      (urlFile?.markdownPath ?? "").endsWith("example.md") && existsSync(urlFile?.markdownPath ?? ""),
      urlFile?.markdownPath ?? ""
    );
    check("URL 解析统计到 markdown 字节数", (urlFile?.markdownBytes ?? 0) > 100);
    check("工具输出里带预览", urlRun.result.content[0].text.includes("预览"));

    /* ----- 5. v4 标准接口：本地文件（批量上传） ----- */
    console.log("\n[5] v4 标准接口 · 本地文件上传");
    const fileRun = await callTool(parseTool, { sources: [pdfPath], page_ranges: "1-1" }, ctx);
    const fileJob = fileRun.result.details.files[0];
    check("本地文件解析成功落盘", fileJob?.status === "done", fileJob?.error ?? "");
    check("本地文件解析拿到 batch_id", typeof fileJob?.batchId === "string" && (fileJob.batchId ?? "").length > 10);
    const markdownPath = fileJob?.markdownPath ?? "";
    check("markdown 写在源文件同目录", markdownPath.startsWith(WORK_DIR), markdownPath);
    const markdownBody = markdownPath && existsSync(markdownPath) ? readFileSync(markdownPath, "utf8") : "";
    check("markdown 正文非空", markdownBody.length > 100, `${markdownBody.length} 字符`);
    if ((fileJob?.assetCount ?? 0) > 0) {
      const assetFiles = existsSync(fileJob.assetDir ?? "") ? await readdir(fileJob.assetDir) : [];
      check("图片已解出且数量一致", assetFiles.length === fileJob.assetCount, `${assetFiles.length} / ${fileJob.assetCount}`);
      check("正文里的图片引用已改写到 .assets/", !markdownBody.includes("](images/"));
    } else {
      check("本页无图片（真实包的图片路径由第 12 节覆盖）", true);
    }

    /* ----- 6. mineru_query：按 batch_id 续查并下载 ----- */
    console.log("\n[6] mineru_query · 批量 ID + 下载");
    const againDir = join(WORK_DIR, "again");
    const queryRun = await callTool(queryTool, { id: fileJob.batchId, download: true, output_dir: againDir }, ctx);
    const queryFile = queryRun.result.details.files[0];
    check("查询命中批量任务", queryRun.result.details.found && queryRun.result.details.api === "standard");
    check("查询能拿到完成状态", queryFile?.state === "done", queryFile?.state ?? "");
    check(
      "download=true 时二次落盘",
      typeof queryFile?.markdownPath === "string" && existsSync(queryFile.markdownPath ?? ""),
      queryFile?.error ?? queryFile?.markdownPath ?? ""
    );
    check("输出目录被尊重", (queryFile?.markdownPath ?? "").startsWith(againDir), queryFile?.markdownPath ?? "");

    /* ----- 7. v1 轻量接口 ----- */
    console.log("\n[7] v1 轻量接口 · 本地文件");
    const agentDir = join(WORK_DIR, "agent");
    const agentRun = await callTool(
      parseTool,
      { sources: [pdfPath], api: "agent", page_ranges: "1-1", output_dir: agentDir },
      ctx
    );
    const agentFile = agentRun.result.details.files[0];
    check("轻量接口解析成功", agentFile?.status === "done", agentFile?.error ?? "");
    check("轻量接口确实被选用", agentRun.result.details.api === "agent");
    check(
      "轻量接口结果落盘",
      typeof agentFile?.markdownPath === "string" && existsSync(agentFile.markdownPath ?? ""),
      agentFile?.markdownPath ?? ""
    );
    check("输出里带轻量接口额度提示", agentRun.result.content[0].text.includes("轻量接口"));

    /* ----- 8. wait=false 只提交 ----- */
    console.log("\n[8] wait=false 仅提交");
    const submitOnly = await callTool(parseTool, { sources: [DEMO_PDF_URL], page_ranges: "1-1", wait: false }, ctx);
    const submitFile = submitOnly.result.details.files[0];
    check("标记为仅提交", submitOnly.result.details.submittedOnly === true);
    check("未落盘且给出 task_id", !submitFile?.markdownPath && Boolean(submitFile?.taskId), JSON.stringify(submitFile));
    if (submitFile?.taskId) {
      const laterQuery = await callTool(queryTool, { id: submitFile.taskId }, ctx);
      check("提交得到的 task_id 可被查询", laterQuery.result.details.found === true);
    }

    /* ----- 9. 错误路径 ----- */
    console.log("\n[9] 错误路径");
    await expectThrow(
      "不存在的文件报错",
      () => callTool(parseTool, { sources: [join(WORK_DIR, "nope.pdf")] }, ctx),
      /本地文件不存在/
    );
    await expectThrow(
      "HTML 走轻量接口被拦截",
      async () => {
        const htmlPath = join(WORK_DIR, "page.html");
        await writeFile(htmlPath, "<html><body>hi</body></html>");
        await callTool(parseTool, { sources: [htmlPath], api: "agent" }, ctx);
      },
      /HTML 输入需要 v4 标准接口/
    );
    await expectThrow("空 id 查询报错", () => callTool(queryTool, { id: "   " }, ctx), /id 不能为空/);
    const missing = await callTool(queryTool, { id: "00000000-0000-0000-0000-000000000000" }, ctx);
    check("查不到的任务返回未找到", missing.result.details.found === false);
  } else {
    console.log("\n[3~9] --offline：跳过真实接口用例");
  }

  /* ----- 10. /mineru 命令 ----- */
  console.log("\n[10] /mineru 命令");
  const commandUi = createUi();
  await pi.commands.get("mineru").handler("", createCtx(commandUi, WORK_DIR));
  const statusText = commandUi.notifications[0]?.text ?? "";
  check("无参数时输出状态", statusText.includes("MinerU 状态"), statusText.slice(0, 80));
  check("状态里包含接口选择说明", statusText.includes("接口选择"));
  check("状态里包含落盘规则", statusText.includes("落盘规则"));
  const badSubUi = createUi();
  await pi.commands.get("mineru").handler("什么鬼", createCtx(badSubUi, WORK_DIR));
  check("未知子命令给出提示", (badSubUi.notifications[0]?.text ?? "").includes("未知子命令"));

  /* ----- 11. zip 读取器 ----- */
  console.log("\n[11] zip 读取器单测");
  const { readZipEntries } = await jiti.import(join(HERE, "zip.ts"));
  const zipBuffer = buildTestZip(false);
  const entries = readZipEntries(zipBuffer, (name) => name === "full.md" || name.startsWith("images/"));
  const markdownEntry = entries.find((entry) => entry.name === "full.md");
  check("能从 deflate 包里挑出 full.md", markdownEntry !== undefined);
  check("能挑出 images/ 条目", entries.some((entry) => entry.name === "images/a.jpg"));
  check("filter 生效（layout.json 被跳过）", !entries.some((entry) => entry.name === "layout.json"));
  check("deflate 内容解压正确", markdownEntry?.data.toString("utf8") === "hello full.md\n".repeat(50));
  const storedEntries = readZipEntries(buildTestZip(true));
  check("stored 内容解压正确", storedEntries[0]?.data.toString("utf8").startsWith("hello full.md\n"));
  await expectThrow("截断的 zip 报错", () => readZipEntries(zipBuffer.subarray(0, zipBuffer.length - 5)), /zip/);

  /* ----- 12. 结果落盘（extractDocument + saveParsedDocument） ----- */
  console.log("\n[12] 结果落盘");
  const { extractDocument } = await jiti.import(join(HERE, "client.ts"));
  const { saveParsedDocument } = await jiti.import(join(HERE, "output.ts"));
  const saveDir = join(WORK_DIR, "save");

  const parsed = extractDocument(buildTestZip(false));
  check("extractDocument 取出 full.md", parsed.markdown.startsWith("hello full.md\n"));
  check("extractDocument 取出图片", parsed.assets.length === 1 && parsed.assets[0].name === "images/a.jpg");

  const saved = await saveParsedDocument({
    markdown: `${parsed.markdown}\n![](images/a.jpg)\n`,
    assets: parsed.assets,
    // 故意用带空格和括号的源文件名，锁定链接转义行为
    sourceName: "论文 (2024) v2.pdf",
    outputDir: saveDir,
  });
  const written = readFileSync(saved.markdownPath, "utf8");
  check("markdown 按源文件名落盘", saved.markdownPath.endsWith("论文 (2024) v2.md"), saved.markdownPath);
  check("图片写到 .assets/ 目录", existsSync(join(saved.assetDir, "a.jpg")));
  check(
    "图片引用已改写并转义",
    written.includes("论文%20%282024%29%20v2.assets/a.jpg"),
    written.match(/\]\([^)]*\)/)?.[0] ?? ""
  );
  check("无残留 images/ 引用", !written.includes("](images/"));
  check("返回的 markdown 与磁盘一致（预览不再显示旧引用）", saved.markdown === written);

  const savedAgain = await saveParsedDocument({
    markdown: parsed.markdown,
    assets: parsed.assets,
    sourceName: "论文 (2024) v2.pdf",
    outputDir: saveDir,
  });
  check(
    "同名时避让到 .mineru.md",
    savedAgain.markdownPath.endsWith("论文 (2024) v2.mineru.md") && savedAgain.renamed,
    savedAgain.markdownPath
  );

  /* ----- 汇总 ----- */
  console.log(`\n${"=".repeat(60)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${passed} 项`);
  } else {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const failure of failures) console.log(`  · ${failure}`);
  }
  console.log(`临时目录：${WORK_DIR}${process.argv.includes("--keep") ? "（已保留）" : ""}`);
  if (!process.argv.includes("--keep")) await rm(WORK_DIR, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
