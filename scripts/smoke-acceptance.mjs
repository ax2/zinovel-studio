import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";

const root = resolve(import.meta.dirname, ".."),
  authored = "作者确认的新句。𠮷🌊";
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "acceptance-qa-"));
const store = new NovelStore(join(data, "library")),
  journal = new TaskJournal(join(data, "tasks"));
const cases = [
  {
    name: "写入正文之前",
    stage: "intent-written",
    expected: "awaiting-review",
  },
  { name: "正文写入回执之前", stage: "manuscript-saved", expected: "applied" },
  {
    name: "未写入时外部另稿",
    stage: "intent-written",
    external: "外部另稿，请保留。",
    expected: "acceptance-uncertain",
  },
  {
    name: "接受之后作者撤销",
    stage: "manuscript-saved",
    external: "恢复为作者的另一个版本。",
    expected: "applied",
  },
];
for (const item of cases) {
  const body = "合成原稿：灯塔还亮着。",
    book = await store.importBook(item.name, [{ title: "恢复验证章", body }]);
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    id = randomUUID();
  Object.assign(item, {
    book,
    chapter,
    id,
    body,
    file: join(data, "library", book.id, "manuscript", `${chapter.id}.md`),
  });
  await journal.create(
    {
      id,
      status: "preparing",
      bookId: book.id,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      skillId: "novel-polish",
      model: "synthetic-no-model",
      startedAt: new Date().toISOString(),
    },
    {
      context: body,
      selectedText: body,
      instruction: "合成恢复测试",
      target: {
        bookId: book.id,
        chapterId: chapter.id,
        body,
        start: 0,
        end: body.length,
        baseHash: chapter.diskHash,
      },
    },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", {
    candidate: "模型初稿，与作者确认文本不同。",
  });
  let exitCode = 0;
  try {
    await promisify(execFile)(
      process.execPath,
      [join(root, "tests/fixtures/acceptance-crash.mjs"), data, id, item.stage],
      { windowsHide: true, timeout: 20000 },
    );
  } catch (error) {
    exitCode = error.code;
  }
  assert.equal(
    exitCode,
    91,
    "worker must actually terminate at its durable checkpoint",
  );
  assert.equal((await journal.read(id)).record.status, "accepting");
  assert.equal(
    await readFile(item.file, "utf8"),
    item.stage === "intent-written" ? body : authored,
  );
  if (item.external) await writeFile(item.file, item.external, "utf8");
}
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-003",
  "acceptance",
);
await mkdir(screenshots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let application, page;
const report = { status: "running", checks: [], errors: [], cases: [] };
try {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.getByRole("heading", { name: "把故事写下来" }).waitFor();
  for (const item of cases) {
    const recovered = await journal.read(item.id);
    assert.equal(recovered.record.status, item.expected);
    const expectedBody =
      item.external || (item.stage === "intent-written" ? item.body : authored);
    assert.equal(await readFile(item.file, "utf8"), expectedBody);
    await page.locator(".book-card").filter({ hasText: item.name }).click();
    await page.getByLabel("正文编辑器").waitFor();
    if (
      !(await page
        .getByRole("button", { name: "写作任务记录", exact: true })
        .isVisible())
    )
      await page.getByTitle("打开创作参考").click();
    await page
      .getByRole("button", { name: "写作任务记录", exact: true })
      .click();
    await page.locator(".task-row").first().click();
    if (item.expected === "awaiting-review") {
      await page.getByText("恢复检查确认原稿仍在", { exact: false }).waitFor();
      await page.getByRole("button", { name: "继续审阅", exact: true }).click();
      assert.equal(await page.getByLabel("候选文本").inputValue(), authored);
      const resumedDraft = authored + "恢复后又调整并保存的草稿。";
      await page.getByLabel("候选文本").fill(resumedDraft);
      await page
        .getByRole("button", { name: "保存审阅草稿", exact: true })
        .click();
      await page
        .getByLabel("审阅草稿状态")
        .filter({ hasText: "审阅草稿已保存" })
        .waitFor();
      const savedTask = await journal.read(item.id);
      assert.equal(
        savedTask.reviewDraft.afterAcceptanceId,
        savedTask.record.acceptance.id,
      );
      await application.close();
      application = await electron.launch({
        executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
        args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
        cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
        env,
      });
      page = await application.firstWindow();
      page.on("pageerror", (error) => report.errors.push(error.message));
      await page.locator(".book-card").filter({ hasText: item.name }).click();
      await page.getByLabel("正文编辑器").waitFor();
      const taskButton = page.getByRole("button", {
        name: "写作任务记录",
        exact: true,
      });
      if (!(await taskButton.isVisible()))
        await page.getByTitle("打开创作参考").click();
      await taskButton.click();
      await page.locator(".task-row").first().click();
      await page.getByRole("button", { name: "继续审阅", exact: true }).click();
      assert.equal(
        await page.getByLabel("候选文本").inputValue(),
        resumedDraft,
      );
      await page.getByRole("button", { name: "接受候选", exact: true }).click();
      await page
        .getByRole("dialog", { name: "审阅 AI 候选" })
        .waitFor({ state: "hidden" });
      assert.equal(await readFile(item.file, "utf8"), resumedDraft);
      assert.equal(
        (await store.readChapter(item.book.id, item.chapter.id)).revision,
        2,
      );
    } else {
      assert.equal(
        await page
          .getByRole("button", { name: "继续审阅", exact: true })
          .count(),
        0,
      );
      if (item.expected === "acceptance-uncertain") {
        assert.equal(
          await page.getByLabel("接受前确认文本").inputValue(),
          authored,
        );
        await page
          .getByRole("button", { name: "重新核对接受状态", exact: true })
          .click();
        await page
          .getByText("接受操作未能完全确认", { exact: false })
          .waitFor();
        assert.equal(
          (await journal.read(item.id)).record.status,
          "acceptance-uncertain",
        );
        await page.screenshot({
          path: join(screenshots, "uncertain-acceptance.png"),
        });
      } else {
        await page
          .getByText("已找到本次接受的存盘回执", { exact: false })
          .waitFor();
        if (item.external)
          await page.screenshot({
            path: join(screenshots, "receipt-after-later-edit.png"),
          });
      }
      assert.equal(await readFile(item.file, "utf8"), expectedBody);
      await page.getByLabel("关闭任务记录").click();
    }
    report.cases.push({
      checkpoint: item.stage,
      laterExternalEdit: !!item.external,
      recoveredStatus: item.expected,
      manuscriptPreserved: true,
    });
    await page.getByTitle("书库", { exact: true }).click();
  }
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "four worker processes actually exited at durable checkpoints; desktop startup reconciled all task states without automatically applying candidates",
    "acceptance receipt survives later author edits; current manuscript is preserved; uncertain results cannot be silently accepted",
    "before-write interruption retains author-adjusted candidate; a newer review saved after recovery survives actual desktop restart and supersedes the prior acceptance intent; explicit retry saves exactly once",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await application?.close().catch(() => {});
  await writeFile(
    join(screenshots, "acceptance-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
