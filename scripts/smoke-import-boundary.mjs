import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(root, ".cache", "import-boundary-ui-"));
const directory = join(work, "合成目录"),
  legacy = join(work, "旧编码.txt");
await mkdir(join(directory, "卷一"), { recursive: true });
const originals = new Map([
  [join(directory, "卷一", "2.md"), Buffer.from("第二章 灯塔\n𠮷🙂灯光。")],
  [join(directory, "卷一", "10.txt"), Buffer.from("第十章 旧港\n另一段。")],
  [join(directory, ".ignored.txt"), Buffer.from("隐藏原件")],
  [legacy, Buffer.from([0xc4, 0xe3, 0xba, 0xc3])],
]);
for (const [path, bytes] of originals) await writeFile(path, bytes);
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-002",
  "import-boundary",
);
await mkdir(out, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: join(work, "data") };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const report = {
  status: "running",
  checks: [],
  errors: [],
  scope:
    "Browser plugin not available; actual Electron UI/host IPC. Native dialog fixture selection is stubbed. Synthetic manuscripts only; no native IME or arbitrary external-write atomicity claim.",
};
const host = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function choose(path, directoryChoice = false) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await page
    .getByRole("button", {
      name: directoryChoice ? "选择稿件目录" : "选择 TXT / Markdown",
      exact: true,
    })
    .click();
}
try {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: root,
    env,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  assert.equal(
    runtime.version,
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  report[runtime.packaged ? "appAsarSha256" : "desktopBundleSha256"] =
    createHash("sha256")
      .update(
        await readFile(
          runtime.packaged ? runtime.path : join(root, "dist/desktop/main.cjs"),
        ),
      )
      .digest("hex");
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1008, 681),
  );
  await page.getByRole("button", { name: "导入作品", exact: true }).click();
  await choose(directory, true);
  await page.getByText("2 个源文件 · 2 章", { exact: false }).waitFor();
  const entries = page.locator(".import-preview button");
  assert.deepEqual(await entries.allTextContents(), [
    "第二章 灯塔",
    "第十章 旧港",
  ]);
  await page.getByRole("checkbox", { name: "按章卷标题自动拆分" }).uncheck();
  await page.getByRole("button", { name: "重新预览", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("textarea.import-body")
      ?.value.includes("第二章 灯塔"),
  );
  await page.screenshot({ path: join(out, "directory-preview.png") });
  report.checks.push(
    "Real directory traversal uses numeric order, ignores hidden sources, and supports explicit split-off preview without modifying sources",
  );
  for (const encoding of ["utf-16le", "utf-16be"]) {
    const path = join(work, `${encoding}.txt`);
    const bytes = Buffer.from("\uFEFF第一章 旧字\r\n旧稿𠮷🙂", "utf16le");
    if (encoding === "utf-16be") bytes.swap16();
    originals.set(path, bytes);
    await writeFile(path, bytes);
    await choose(path);
    await page
      .getByRole("alert")
      .filter({ hasText: "UTF-8 解码失败" })
      .waitFor();
    await page.getByLabel("导入编码").selectOption(encoding);
    await page.getByRole("button", { name: "重新预览", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("textarea.import-body")?.value === "旧稿𠮷🙂",
    );
  }
  report.encodings = ["utf-8", "utf-16le", "utf-16be", "gb18030"];
  await page.getByLabel("导入编码").selectOption("utf-16le");
  await choose(legacy);
  await page.getByRole("alert").filter({ hasText: "UTF-8 解码失败" }).waitFor();
  assert.equal(await page.getByLabel("导入编码").inputValue(), "utf-8");
  assert.equal(
    await page
      .getByRole("checkbox", { name: "按章卷标题自动拆分" })
      .isChecked(),
    true,
  );
  await page.getByLabel("导入编码").selectOption("gb18030");
  await page.getByRole("button", { name: "重新预览", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("textarea.import-body")?.value === "你好",
  );
  const id = await page.evaluate(async () => {
    // Get a separate actual host preview token to test stale-preview revocation.
    return (await window.novel.request("import.choose", {})).id;
  });
  await host("import.preview", { id, encoding: "gb18030", split: false });
  await assert.rejects(
    host("import.preview", { id, encoding: "utf-8", split: false }),
  );
  await assert.rejects(
    host("import.commit", { id, title: "不得使用旧预览" }),
    /请先完成导入预览/,
  );
  assert.equal((await host("library.list")).books.length, 0);
  report.checks.push(
    "A new selection resets displayed decoding/splitting to the host defaults; UTF16 LE/BE and GB18030 retries decode Chinese/supplementary text correctly and failed re-preview revokes the prior host commit token",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(806, 803),
  );
  await page.screenshot({ path: join(out, "legacy-preview-narrow.png") });
  await writeFile(legacy, "预览之后改动的源文件");
  await page.getByLabel("导入作品名称").fill("冻结预览合成稿");
  await page
    .getByRole("button", { name: "确认导入为新作品", exact: true })
    .click();
  await page.getByLabel("正文编辑器").waitFor();
  assert.equal(
    (await page.getByLabel("正文编辑器").innerText()).trim(),
    "你好",
  );
  const books = (await host("library.list")).books;
  assert.equal(books.length, 1);
  assert.equal(books[0].chapters.length, 1);
  for (const [path, bytes] of originals) {
    if (path !== legacy) assert.deepEqual(await readFile(path), bytes);
  }
  assert.equal(await readFile(legacy, "utf8"), "预览之后改动的源文件");
  report.checks.push(
    "Author confirmation imports the frozen preview into one new book while preserving externally changed source bytes and all unselected originals",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    if (report.status === "failed" && owned)
      await terminateOwnedProcesses(owned);
    await app.close().catch(() => {});
    if (owned) await confirmOwnedProcessesExited(owned);
  }
  await writeFile(
    join(out, "import-boundary-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
