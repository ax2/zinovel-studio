import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { modelFixture } from "../tests/fixtures/model-server.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "desktop-qa-"));
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-001",
);
await mkdir(screenshots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  // A packaged app must not accidentally discover Node/pnpm on the developer PATH.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let application;
const model = await modelFixture({ delayMs: 250 });
const errors = [];
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "把故事写下来" }).waitFor();
  return page;
}
const manuscript =
  "雨停的时候，林舟在旧港收到了一封没有邮戳的信。\n\n信封上只有一行字：等灯塔熄灭，再打开它。\n\n他抬起头，远处的灯塔亮着，像一只不肯闭上的眼睛。\n\n罕见字与符号检查：𠮷、髙、🌊。";
const evidence = {
  dataDirectory: data,
  platform: process.platform,
  viewport: null,
  checks: [],
  errors,
};
try {
  let page = await launch();
  if (process.env.ZINOVEL_TEST_EXECUTABLE) {
    const runtime = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      executable: process.execPath,
    }));
    assert.equal(runtime.packaged, true);
    assert.equal(
      resolve(runtime.executable),
      resolve(process.env.ZINOVEL_TEST_EXECUTABLE),
    );
    evidence.checks.push(
      "installed executable is packaged; system-only PATH without development Node/pnpm",
    );
  }
  evidence.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("雾港来信");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page
    .locator(".empty-chapter")
    .getByRole("button", { name: "新建章节" })
    .click();
  await page.getByLabel("标题", { exact: true }).fill("第一章 旧信");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("正文编辑器").fill(manuscript);
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  evidence.checks.push(
    "create book/chapter; Chinese, astral Unicode and paragraph round trip",
  );
  const library = await page.evaluate(() =>
    window.novel.request("library.list"),
  );
  const book = library.books[0],
    chapter = book.chapters[0];
  const file = join(data, "library", book.id, "manuscript", `${chapter.id}.md`);
  assert.equal(await readFile(file, "utf8"), manuscript);
  await page.screenshot({ path: join(screenshots, "desktop-light.png") });
  await page.getByRole("button", { name: "深色主题", exact: true }).click();
  await page.screenshot({ path: join(screenshots, "desktop-dark.png") });
  await page.getByRole("button", { name: "浅色主题", exact: true }).click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  assert.equal(
    await page.locator(".reading").innerText(),
    manuscript
      .split("\n")
      .map((p) => p || "\u00a0")
      .join("\n\n"),
  );
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  evidence.checks.push("reading mode and theme switching");
  await page.getByLabel("正文编辑器").fill(manuscript + "\n新增段落。");
  // Closing immediately exercises the renderer flush rather than waiting for autosave.
  const closed = application.waitForEvent("close");
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await closed;
  assert.equal(await readFile(file, "utf8"), manuscript + "\n新增段落。");
  page = await launch();
  await page.locator(".book-card").filter({ hasText: "雾港来信" }).click();
  assert.equal(
    (
      await page.getByLabel("正文编辑器").locator(".cm-line").allTextContents()
    ).join("\n"),
    manuscript + "\n新增段落。",
  );
  evidence.checks.push(
    "immediate window close flush and process restart persistence",
  );
  const external = manuscript + "\n外部编辑的独立段落。";
  await writeFile(file, external, "utf8");
  await page
    .getByLabel("正文编辑器")
    .fill(manuscript + "\n应用中尚未保存的段落。");
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.getByRole("heading", { name: "正文已在其他地方修改" }).waitFor();
  assert.equal(await readFile(file, "utf8"), external);
  await page.screenshot({ path: join(screenshots, "conflict.png") });
  await page.getByRole("button", { name: "保留当前编辑", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  if (!(await page.getByRole("button", { name: "查看历史版本" }).isVisible()))
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "查看历史版本" }).click();
  await page
    .locator(".history-row")
    .filter({ hasText: "外部编辑的独立段落。" })
    .getByRole("button", { name: "恢复此版本" })
    .click();
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), external);
  evidence.checks.push(
    "external edit conflict, explicit keep-current, external preimage history restoration",
  );
  await page.getByTitle("模型设置", { exact: true }).first().click();
  await page.getByLabel("服务地址", { exact: true }).fill(model.url);
  await page.getByLabel("API Key", { exact: true }).fill("fixture-local-only");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置", exact: true })
    .waitFor({ state: "hidden" });
  const config = JSON.parse(await readFile(join(data, "model.json"), "utf8"));
  assert.ok(config.encryptedKey.length > 10);
  assert.equal(JSON.stringify(config).includes("fixture-local-only"), false);
  const editor = page.getByLabel("正文编辑器");
  await editor.focus();
  await editor.press("Control+Home");
  await editor.press("Shift+End");
  const range = await editor.evaluate(() => ({
    start: 0,
    end: window.getSelection().toString().length,
  }));
  assert.ok(range.end > range.start);
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page.getByRole("button", { name: "旧稿参考", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  assert.equal(
    await page.getByLabel("候选文本").inputValue(),
    model.replacement,
  );
  assert.equal(await readFile(file, "utf8"), external);
  await page.screenshot({ path: join(screenshots, "ai-review.png") });
  await page.getByRole("button", { name: "接受候选", exact: true }).click();
  await page.getByRole("button", { name: "写作工具", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ state: "hidden" });
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(
    await readFile(file, "utf8"),
    external.slice(0, range.start) +
      model.replacement +
      external.slice(range.end),
  );
  evidence.checks.push(
    "OS-encrypted settings; real Electron child Harness calls two tools; review then selection-only acceptance",
  );
  const generated = await readFile(file, "utf8");
  await editor.press("Control+z");
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), external);
  await editor.press("Control+y");
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), generated);
  evidence.checks.push(
    "AI selection acceptance is one reversible editor transaction; redo reproduces exact bytes",
  );
  await page.getByTitle("查找替换预览", { exact: true }).click();
  await page.getByLabel("查找内容", { exact: true }).fill("林舟");
  await page.getByLabel("替换为", { exact: true }).fill("林远");
  await page.getByRole("button", { name: "预览替换位置", exact: true }).click();
  assert.equal(await readFile(file, "utf8"), generated);
  await page.getByRole("button", { name: "应用本章替换", exact: true }).click();
  await page
    .getByRole("dialog", { name: "查找替换预览", exact: true })
    .waitFor({ state: "hidden" });
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(
    await readFile(file, "utf8"),
    generated.replaceAll("林舟", "林远"),
  );
  await editor.press("Control+z");
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), generated);
  evidence.checks.push(
    "literal find/replace previews before mutation and undoes as one transaction",
  );

  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  const changed = "作者在生成期间继续修改的正文。";
  await editor.fill(changed);
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  await page.getByRole("button", { name: "接受候选", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "生成期间正文已改变" })
    .waitFor();
  assert.equal(
    (await editor.locator(".cm-line").allTextContents()).join("\n"),
    changed,
  );
  await page.getByRole("button", { name: "关闭候选", exact: true }).click();
  await page.getByRole("button", { name: "关闭错误", exact: true }).click();
  evidence.checks.push(
    "stale AI proposal cannot overwrite edits made during generation",
  );
  const security = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
  }));
  assert.deepEqual(security, { require: "undefined", process: "undefined" });
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.novel.request("shell.execute", {});
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  evidence.checks.push(
    "isolated renderer has no Node globals; IPC rejects unknown operations",
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(850, 700),
  );
  await page.screenshot({ path: join(screenshots, "desktop-narrow.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  if (
    !(await page
      .getByRole("button", { name: "生成候选", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page
    .getByRole("button", { name: "生成候选", exact: true })
    .waitFor({ state: "visible" });
  await page.getByRole("button", { name: "关闭创作参考", exact: true }).click();
  evidence.checks.push(
    "narrow-window assistant remains reachable through reference drawer",
  );
  assert.deepEqual(errors, []);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error.stack;
  throw error;
} finally {
  if (application?.process()?.exitCode === null) await application.close();
  await model.close();
  await writeFile(
    join(screenshots, "desktop-smoke.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
}
