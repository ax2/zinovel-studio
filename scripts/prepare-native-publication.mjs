import { _electron as electron } from "playwright";
import electronPath from "electron";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  stat,
  realpath,
} from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "native-publication-")),
  data = join(work, "data");
await mkdir(data);
const target = join(data, "中文 导出 验证");
await mkdir(target);
const store = new NovelStore(join(data, "library"));
const book = await store.importBook("原生保存合成稿", [
  { title: "第一章 原生目录", body: "第一段合成正文𠮷🌊。\n最后一段。" },
]);
const source = join(
    data,
    "library",
    book.id,
    "manuscript",
    book.chapters[0].id + ".md",
  ),
  before = await readFile(source);
const output = join(root, "screenshots", "stage-007", "publication-native");
await mkdir(output, { recursive: true });
const done = join(work, "observation-complete.flag"),
  descriptor = join(root, ".cache", "native-publication-current.json");
const report = {
  status: "running",
  version: "0.1.0-alpha.17",
  target,
  marker: done,
  checks: [],
  errors: [],
  scope:
    "Real Windows directory chooser; synthetic novel only; an operator must select the existing target directory",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, owned;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("unexpected page network request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByRole("button", { name: "导出与发布", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "导出发布副本", exact: true });
  await panel.getByLabel("公开书名", { exact: true }).fill("原生导出验证");
  await panel.getByRole("checkbox", { name: /第一章 原生目录/ }).check();
  await panel
    .getByRole("button", { name: "创建发布副本", exact: true })
    .click();
  await panel
    .getByRole("article", {
      name: "发布副本章节：第一章 原生目录",
      exact: true,
    })
    .waitFor();
  await panel
    .getByLabel("发布副本导出格式", { exact: true })
    .selectOption("txt");
  await writeFile(
    descriptor,
    JSON.stringify(
      { ...report, phase: "opening-native-picker", pid: app.process().pid },
      null,
      2,
    ),
  );
  await panel.getByRole("button", { name: "导出此副本", exact: true }).click();
  console.log(
    JSON.stringify({ phase: "awaiting-native-choice", target, marker: done }),
  );
  await panel
    .getByRole("status")
    .filter({ hasText: "本地导出完成" })
    .waitFor({ timeout: 240000 });
  const names = (await readdir(target)).filter((name) => !name.startsWith("."));
  assert.equal(names.length, 1);
  const directory = await realpath(join(target, names[0])),
    parent = await realpath(target);
  assert.ok(
    relative(parent, directory) &&
      !relative(parent, directory).startsWith(".."),
  );
  const manifest = JSON.parse(
    await readFile(join(directory, "publication-manifest.json"), "utf8"),
  );
  assert.equal(manifest.state, "exported");
  assert.equal(manifest.format, "txt");
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.equal(bytes.length, file.bytes);
  }
  assert.ok(
    (await readFile(join(directory, "book.txt"), "utf8")).includes(
      before.toString("utf8"),
    ),
  );
  assert.deepEqual(await readFile(source), before);
  assert.deepEqual(report.errors, []);
  report.directory = directory;
  report.checks.push(
    "Real native folder dialog returned the explicitly chosen Chinese/space folder; no dialog replacement",
    "Actual host wrote a new TXT/manifest directory, all file bytes/hash matched and synthetic source bytes remained unchanged",
  );
  await page.screenshot({ path: join(output, "native-export-complete.png") });
  await writeFile(
    descriptor,
    JSON.stringify(
      { ...report, phase: "exported-awaiting-observation" },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase: "exported-awaiting-observation",
      directory,
      marker: done,
    }),
  );
  const until = Date.now() + 120000;
  let observed = false;
  while (Date.now() < until) {
    try {
      await stat(done);
      observed = true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(
    observed,
    true,
    "Native post-export observation was not acknowledged",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await writeFile(
    join(output, "native-export-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else {
        await app.close();
        await confirmOwnedProcessesExited(owned);
      }
    }
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error);
    throw error;
  } finally {
    await writeFile(
      join(output, "native-export-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
}
