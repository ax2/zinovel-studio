import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { cpus, totalmem, release } from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "writing-bench-")),
  data = join(work, "data");
const store = new NovelStore(join(data, "library"));
const paragraph =
  "雨水沿着旧港的屋檐落下，林舟把信放在桌上。他知道这封信并不是偶然来到这里，却还无法辨认其中隐藏的线索。";
const ordinary = paragraph.repeat(100).slice(0, 3000),
  long = Array.from({ length: 500 }, () =>
    paragraph.repeat(2).slice(0, 100),
  ).join("\n\n");
const chapters = Array.from({ length: 1000 }, (_, index) => ({
  title: `第${index + 1}章 ${index ? "远行" : "长章压力测试"}`,
  volume: `第${Math.floor(index / 100) + 1}卷`,
  body: (index === 0 ? long : ordinary) + (index === 999 ? "终卷检索锚点" : ""),
}));
const begin = performance.now(),
  book = await store.importBook("百万字合成长篇", chapters);
const report = {
  platform: process.platform,
  osRelease: release(),
  cpu: cpus()[0]?.model,
  memoryGiB: Math.round(totalmem() / 1024 ** 3),
  chapters: 1000,
  totalCharacters: chapters.reduce((n, c) => n + c.body.length, 0),
  longChapterCharacters: long.length,
  fixtureBuildMs: Math.round(performance.now() - begin),
  checks: [],
  errors: [],
  metrics: {},
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  const start = performance.now();
  application = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.getByRole("heading", { name: "把故事写下来" }).waitFor();
  report.metrics.launchToLibraryMs = Math.round(performance.now() - start);
  const opening = performance.now();
  await page.getByRole("button", { name: /百万字合成长篇/ }).click();
  const editor = page.getByLabel("正文编辑器");
  await editor.waitFor();
  report.metrics.openLongChapterMs = Math.round(performance.now() - opening);
  await editor.focus();
  await editor.press("Control+End");
  const samples = [];
  for (let index = 0; index < 25; index++) {
    const start = performance.now();
    await page.keyboard.insertText("字");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  report.metrics.inputToTwoFramesP95Ms = Math.round(
    samples[Math.floor(samples.length * 0.95)],
  );
  const saving = performance.now();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  report.metrics.autosaveAfterLastInputMs = Math.round(
    performance.now() - saving,
  );
  const path = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${book.chapters[0].id}.md`,
  );
  assert.equal(await readFile(path, "utf8"), long + "字".repeat(25));
  report.checks.push(
    "50k-character chapter receives 25 native text insertions and saves exact bytes",
  );
  const searchStart = performance.now();
  const search = await page.evaluate(
    (bookId) =>
      window.novel.request("book.search", { bookId, query: "终卷检索锚点" }),
    book.id,
  );
  report.metrics.search1000ChaptersMs = Math.round(
    performance.now() - searchStart,
  );
  assert.equal(search.hits.length, 1);
  assert.equal(search.hits[0].chapterId, book.chapters[999].id);
  report.checks.push(
    "three-million-character book search finds exact final-chapter source",
  );
  // Synthetic composition verifies application save gating, not the Windows IME candidate UI.
  const before = await readFile(path, "utf8");
  await editor.dispatchEvent("compositionstart", { data: "拼音" });
  await page.keyboard.insertText("中文");
  await editor.press("Control+s");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(await readFile(path, "utf8"), before);
  await editor.dispatchEvent("compositionend", { data: "中文" });
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(path, "utf8"), before + "中文");
  report.checks.push(
    "synthetic composition defers saving until compositionend; not a system IME certification",
  );
  await editor.press("Control+Home");
  await page.screenshot({
    path: join(root, "screenshots/stage-002/long-chapter.png"),
  });
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  throw error;
} finally {
  if (application) await application.close();
  await writeFile(
    join(root, "assessments/writing-benchmark.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
