import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "publication-images-ui-")),
  data = join(work, "data");
const fixture = new NovelStore(join(data, "library"));
const book = await fixture.importBook("带图出版合成原稿", [
  { title: "旧信", body: "第一章𠮷🌊，原稿保持。" },
  { title: "渡口", body: "第二章结尾。" },
  { title: "未选章节", body: "UNSELECTED_CHAPTER_SENTINEL" },
]);
const source = await sharp({
  create: { width: 160, height: 100, channels: 3, background: "#126b83" },
})
  .composite([
    {
      input: Buffer.from(
        '<svg width="160" height="100"><rect x="10" y="10" width="70" height="80" fill="#d39e51"/><circle cx="125" cy="30" r="17" fill="#f1ead7"/></svg>',
      ),
    },
  ])
  .withMetadata({ orientation: 6 })
  .jpeg()
  .toBuffer();
const second = await sharp({
  create: {
    width: 140,
    height: 80,
    channels: 4,
    background: { r: 148, g: 54, b: 39, alpha: 0.6 },
  },
})
  .png()
  .toBuffer();
const unselected = await sharp({
  create: { width: 31, height: 17, channels: 3, background: "#123456" },
})
  .webp()
  .toBuffer();
const inputs = [source, second, unselected],
  assets = [];
for (let index = 0; index < inputs.length; index++)
  assets.push(
    await fixture.assets.import(book.id, inputs[index], {
      title: `合成出版图${index + 1}`,
      purpose: index ? "illustration" : "cover",
      source: "PRIVATE_IMAGE_SOURCE",
      rights: "PRIVATE_IMAGE_RIGHTS",
      notes: "PRIVATE_IMAGE_NOTES",
      linkedIds: [],
    }),
  );
const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${book.chapters[0].id}.md`,
  ),
  original = await readFile(manuscript);
const replacement = join(work, "replacement.png");
await writeFile(replacement, second);
const exports = join(work, "中文 图像导出目录");
await mkdir(exports);
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-007",
  "publication-resources",
);
await mkdir(out, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  scope:
    "Actual author UI and host transactions; folder/file picker results instrumented; standalone Chromium file reader is not an actual mobile device",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const panel = () =>
  page.getByRole("dialog", { name: "导出发布副本", exact: true });
const request = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    env,
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? work : root,
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(message.text());
  });
  page.on("request", (item) => {
    if (/^https?:/.test(item.url()))
      report.errors.push("Unexpected HTTP request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  owned = await captureOwnedProcesses(app.process().pid);
  assert.equal(await page.title(), "ZiNovel Studio");
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
async function open() {
  await page.getByRole("button", { name: "导出与发布", exact: true }).click();
  await panel().waitFor();
}
async function shot(name) {
  await page.screenshot({ path: join(out, name) });
  report.viewports.push({
    name,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }))),
  });
}
async function loadedImage(locator) {
  await locator.waitFor();
  await locator.evaluate((image) => image.decode());
  assert.ok(await locator.evaluate((image) => image.naturalWidth > 0));
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  await launch();
  report.version = await app.evaluate(({ app }) => app.getVersion());
  await page.evaluate(
    ({ bookId, ids }) =>
      localStorage.setItem(
        `zinovel.publication-form.${bookId}`,
        JSON.stringify({
          schemaVersion: 1,
          bookId,
          metadata: {
            title: "带图雾港",
            author: "合成作者",
            synopsis: "公开简介",
            rights: "合成",
            aiDisclosure: "测试",
          },
          ids,
        }),
      ),
    { bookId: book.id, ids: book.chapters.slice(0, 2).map((item) => item.id) },
  );
  await open();
  await panel().locator(".publication-resource-editor > summary").click();
  await panel()
    .getByLabel("本书出版图像")
    .locator(`option[value="${assets[0].id}"]`)
    .waitFor({ state: "attached" });
  await panel().getByLabel("本书出版图像").selectOption(assets[0].id);
  await panel()
    .getByRole("button", { name: "加入本次发布图像", exact: true })
    .click();
  await panel().getByLabel("图1替代文字").fill("封面𠮷🌊");
  await panel()
    .getByLabel("图1公开图注")
    .fill("公开图注<script>window.IMAGE_SCRIPT_RAN=true</script>");
  await panel().getByLabel("图1公开署名").fill("公开署名");
  await panel().getByLabel("本书出版图像").selectOption(assets[1].id);
  await panel()
    .getByRole("button", { name: "加入本次发布图像", exact: true })
    .click();
  await panel().getByLabel("图2所属章").selectOption(book.chapters[1].id);
  await panel().getByLabel("图2替代文字").fill("");
  assert.equal(
    await panel()
      .getByRole("button", { name: "创建发布副本", exact: true })
      .isDisabled(),
    true,
  );
  await panel().getByRole("button", { name: "保存表单", exact: true }).click();
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await open();
  await panel().locator(".publication-resource-editor > summary").click();
  assert.equal(await panel().getByLabel("图2替代文字").inputValue(), "");
  await panel().getByLabel("图2替代文字").fill("章尾插图𠮷🌊");
  await shot("author-desktop-selection.png");
  await panel()
    .getByRole("button", { name: "创建发布副本", exact: true })
    .click();
  await panel()
    .getByText("发布副本已保存在作品中，后续改稿不会更改它。", { exact: true })
    .waitFor();
  await loadedImage(
    panel().getByRole("img", { name: "封面𠮷🌊", exact: true }),
  );
  const history = await request("publication.list", { bookId: book.id });
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.snapshots[0].resourceCount, 2);
  const saved = history.snapshots[0],
    snapshot = await request("publication.preview", {
      bookId: book.id,
      id: saved.id,
      hash: saved.hash,
    });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.content.resources.length, 2);
  const before = await request("publication.image", {
    bookId: book.id,
    id: saved.id,
    hash: saved.hash,
    index: 0,
  });
  assert.deepEqual([before.width, before.height], [100, 160]);
  await assert.rejects(
    request("publication.image", {
      bookId: book.id,
      id: saved.id,
      hash: saved.hash,
      index: 2,
    }),
    /不属于/,
  );
  await panel()
    .getByLabel("副本章节", { exact: true })
    .selectOption(book.chapters[1].id);
  await loadedImage(
    panel().getByRole("img", { name: "章尾插图𠮷🌊", exact: true }),
  );
  await shot("author-desktop-frozen.png");
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, replacement);
  const replaced = await request("assets.replace", {
    bookId: book.id,
    expected: {
      id: assets[0].id,
      revision: assets[0].revision,
      diskHash: assets[0].diskHash,
    },
  });
  await request("assets.delete", {
    bookId: book.id,
    expected: {
      id: replaced.record.id,
      revision: replaced.record.revision,
      diskHash: replaced.record.diskHash,
    },
    deleted: true,
  });
  assert.equal(
    (
      await request("publication.image", {
        bookId: book.id,
        id: saved.id,
        hash: saved.hash,
        index: 0,
      })
    ).dataUrl,
    before.dataUrl,
  );
  await panel()
    .getByRole("button", { name: "创建发布副本", exact: true })
    .click();
  await panel()
    .getByText(/图像资源已被其他操作修改/)
    .waitFor();
  assert.equal(
    (await request("publication.list", { bookId: book.id })).snapshots.length,
    1,
  );
  await close();
  await launch();
  await open();
  await panel()
    .locator(".publication-history button")
    .filter({ hasText: "带图雾港" })
    .click();
  await loadedImage(
    panel().getByRole("img", { name: "封面𠮷🌊", exact: true }),
  );
  await panel()
    .getByLabel("副本章节", { exact: true })
    .selectOption(book.chapters[1].id);
  await loadedImage(
    panel().getByRole("img", { name: "章尾插图𠮷🌊", exact: true }),
  );
  report.formatOptions = await panel()
    .getByLabel("发布副本导出格式")
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => ({
        value: option.value,
        disabled: option.disabled,
      })),
    );
  assert.equal(
    await panel()
      .getByLabel("发布副本导出格式")
      .locator('option[value="txt"]')
      .evaluate((option) => option.disabled),
    true,
  );
  await assert.rejects(
    request("publication.export", {
      bookId: book.id,
      id: saved.id,
      hash: saved.hash,
      format: "txt",
    }),
    /含图/,
  );
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await panel()
    .getByRole("button", { name: "导出此副本", exact: true })
    .click();
  await panel()
    .getByText("已取消导出，未创建文件。", { exact: true })
    .waitFor();
  assert.deepEqual(await readdir(exports), []);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, exports);
  await panel()
    .getByRole("button", { name: "导出此副本", exact: true })
    .click();
  await panel()
    .getByText(/本地导出完成：/)
    .waitFor();
  const directories = await readdir(exports);
  assert.equal(directories.length, 1);
  const directory = join(exports, directories[0]);
  report.htmlDirectory = directory;
  const manifest = JSON.parse(
    await readFile(join(directory, "publication-manifest.json"), "utf8"),
  );
  assert.equal(manifest.snapshotHash, saved.hash);
  for (const item of manifest.files) {
    const bytes = await readFile(join(directory, item.path));
    assert.equal(digest(bytes), item.sha256);
    assert.equal(bytes.length, item.bytes);
    assert.doesNotMatch(
      bytes.toString("utf8"),
      /PRIVATE_IMAGE_|UNSELECTED_CHAPTER_SENTINEL/,
    );
  }
  assert.equal(
    manifest.files.filter((item) => item.path.startsWith("images/")).length,
    2,
  );
  report.snapshotHash = saved.hash;
  report.imageFiles = manifest.files.filter((item) =>
    item.path.startsWith("images/"),
  );
  assert.ok(
    !manifest.files.some((item) => item.path.includes(assets[2].blob.sha256)),
  );
  assert.equal(
    report.formatOptions.find((option) => option.value === "docx").disabled,
    false,
  );
  await panel().getByLabel("发布副本导出格式").selectOption("docx");
  await panel()
    .getByRole("button", { name: "导出此副本", exact: true })
    .click();
  await panel()
    .getByText(/本地导出完成：.*docx/)
    .waitFor();
  const docxDirectories = (await readdir(exports)).filter((name) =>
    name.includes("-docx-"),
  );
  assert.equal(docxDirectories.length, 1);
  report.docxDirectory = join(exports, docxDirectories[0]);
  report.docxSnapshot = JSON.parse(
    await readFile(
      join(
        data,
        "library",
        book.id,
        ".zinovel/publications",
        `${saved.id}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(report.docxSnapshot.hash, saved.hash);
  const docxManifest = JSON.parse(
    await readFile(
      join(report.docxDirectory, "publication-manifest.json"),
      "utf8",
    ),
  );
  assert.equal(docxManifest.snapshotHash, saved.hash);
  assert.equal(docxManifest.templateVersion, 2);
  assert.equal(docxManifest.illustrationCount, 2);
  assert.equal(docxManifest.embeddedImages.length, 2);
  assert.deepEqual(
    docxManifest.embeddedImages.map((image) => image.sha256).sort(),
    report.imageFiles.map((image) => image.sha256).sort(),
  );
  assert.equal(
    digest(await readFile(join(report.docxDirectory, "book.docx"))),
    docxManifest.files[0].sha256,
  );
  await shot("author-illustrated-docx-export.png");
  assert.equal(
    report.formatOptions.find((option) => option.value === "pdf").disabled,
    false,
  );
  await panel().getByLabel("发布副本导出格式").selectOption("pdf");
  await panel()
    .getByRole("button", { name: "导出此副本", exact: true })
    .click();
  await panel()
    .getByText(/本地导出完成：.*pdf/)
    .waitFor();
  const pdfDirectories = (await readdir(exports)).filter((name) =>
    name.includes("-pdf-"),
  );
  assert.equal(pdfDirectories.length, 1);
  report.pdfDirectory = join(exports, pdfDirectories[0]);
  const pdfManifest = JSON.parse(
    await readFile(
      join(report.pdfDirectory, "publication-manifest.json"),
      "utf8",
    ),
  );
  assert.equal(pdfManifest.snapshotHash, saved.hash);
  assert.equal(pdfManifest.templateVersion, 2);
  assert.equal(pdfManifest.illustrationCount, 2);
  assert.deepEqual(pdfManifest.sourceImages, docxManifest.embeddedImages);
  assert.equal(
    digest(await readFile(join(report.pdfDirectory, "book.pdf"))),
    pdfManifest.files[0].sha256,
  );
  await shot("author-illustrated-pdf-export.png");
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await page.setViewportSize({ width: 806, height: 803 });
  await open();
  await panel()
    .locator(".publication-history button")
    .filter({ hasText: "带图雾港" })
    .click();
  await loadedImage(
    panel().getByRole("img", { name: "封面𠮷🌊", exact: true }),
  );
  await shot("author-dark-narrow-frozen.png");
  assert.equal(
    await panel().evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  );
  assert.deepEqual(await readFile(manuscript), original);
  await close();
  const runner = join(work, "reader.cjs");
  await writeFile(
    runner,
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.ZINOVEL_READER_DATA);app.whenReady().then(()=>{const w=new BrowserWindow({show:true,width:1300,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});w.loadFile(process.env.ZINOVEL_READER_FILE)});app.on('window-all-closed',()=>app.quit());`,
  );
  const readerEnv = {
    ...process.env,
    ZINOVEL_READER_DATA: join(work, "reader-data"),
    ZINOVEL_READER_FILE: join(directory, "index.html"),
  };
  delete readerEnv.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronPath,
    args: [runner],
    env: readerEnv,
  });
  page = await app.firstWindow();
  owned = await captureOwnedProcesses(app.process().pid);
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("request", (item) => {
    if (/^https?:/.test(item.url()))
      report.errors.push("Unexpected standalone reader HTTP request");
  });
  await page.getByRole("heading", { name: "带图雾港", exact: true }).waitFor();
  await loadedImage(page.getByRole("img", { name: "封面𠮷🌊", exact: true }));
  assert.equal(
    (
      await page
        .getByRole("img", { name: "封面𠮷🌊", exact: true })
        .getAttribute("src")
    ).startsWith("images/"),
    true,
  );
  await shot("html-desktop-cover.png");
  assert.equal(
    await page.evaluate(() => typeof window.IMAGE_SCRIPT_RAN),
    "undefined",
  );
  await page.getByRole("link", { name: "渡口", exact: true }).click();
  await loadedImage(
    page.getByRole("img", { name: "章尾插图𠮷🌊", exact: true }),
  );
  await page.getByLabel("背景", { exact: true }).selectOption("dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("html-phone-dark-illustration.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.reload();
  await loadedImage(
    page.getByRole("img", { name: "章尾插图𠮷🌊", exact: true }),
  );
  assert.equal(
    await page.getByLabel("背景", { exact: true }).inputValue(),
    "dark",
  );
  await close();
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual author UI exports the frozen cover and chapter illustration as tagged PDF after source replacement/recycle; image inventory, snapshot and output fingerprints match DOCX/HTML while original manuscript stays unchanged",
    "actual author UI exports the old frozen cover and chapter illustration to editable DOCX after source replacement/recycle; v2 recipe, two embedded image fingerprints, exported file hash and original manuscript are preserved",
    "legacy form migrates on explicit editing; incomplete image alternative text is preserved through close/reopen and blocks capture until corrected",
    "actual author selection captures two frozen images with public-only text; source replacement/recycle rejects stale recapture without altering old snapshot, preview or manuscript; full app restart loads exact old images",
    "image IPC requires the selected snapshot/hash/index; unsupported image formats reject before directory choice; cancellation creates no files; actual HTML writes two image blobs and verifies every manifest file hash",
    "standalone file reader loads cover and chapter-end illustration, escapes public script text, excludes private/unselected resources, makes no HTTP requests and preserves dark preference through reload; desktop and 390px reader fit without horizontal overflow",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    if (report.status === "failed") await terminateOwnedProcesses(owned);
    else await close();
  }
  await writeFile(
    join(out, "publication-resources-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
