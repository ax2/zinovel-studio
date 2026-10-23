import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  access,
} from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";

if (process.platform !== "win32")
  throw new Error("Windows upgrade validation requires Windows");
const root = resolve(import.meta.dirname, ".."),
  run = promisify(execFile);
const previousInstaller = resolve(
  process.argv[2] ||
    "release/ZiNovel-Studio-0.1.0-alpha.3-windows-x64-setup.exe",
);
const previousManifest = JSON.parse(
  await readFile(
    resolve(process.argv[3] || "release/v0.1.0-alpha.3/release-manifest.json"),
    "utf8",
  ),
);
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const currentInstaller = join(
  root,
  "release",
  `ZiNovel-Studio-${pkg.version}-windows-x64-setup.exe`,
);
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
assert.equal(previousManifest.version, "0.1.0-alpha.3");
assert.notEqual(pkg.version, previousManifest.version);
assert.equal(previousManifest.installer, basename(previousInstaller));
assert.equal(
  await digest(previousInstaller),
  previousManifest.sha256,
  "Previous installer must match its manifest",
);
const currentSha256 = await digest(currentInstaller);
const registry =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\81b55339-fc21-4fe7-949e-a90dc443ef5a";
let exists = false;
try {
  await run("reg.exe", ["query", registry], { windowsHide: true });
  exists = true;
} catch (error) {
  if (error.code !== 1) throw error;
}
if (exists)
  throw new Error(
    "Existing ZiNovel Studio installation found; refusing upgrade test",
  );
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "upgrade-qa-")),
  install = join(work, "中文 升级目录"),
  data = join(work, "synthetic-data");
const executable = join(install, "ZiNovel Studio.exe"),
  options = {
    cwd: work,
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
  };
const store = new NovelStore(join(data, "library")),
  journal = new TaskJournal(join(data, "tasks"));
const book = await store.importBook("跨版本升级合成小说", [
  { title: "旧版写作", body: "初始合成正文。" },
]);
const body = "旧版实际保存的正文。𠮷🌊\n\n升级后必须完整保留。";
const manuscript = join(
  data,
  "library",
  book.id,
  "manuscript",
  `${book.chapters[0].id}.md`,
);
const screenshots = join(root, "screenshots", "release", "upgrade");
await mkdir(screenshots, { recursive: true });
const report = {
  status: "running",
  installDirectory: install,
  syntheticDataDirectory: data,
  fromVersion: previousManifest.version,
  toVersion: pkg.version,
  previousInstallerSha256: previousManifest.sha256,
  currentInstallerSha256: currentSha256,
  checks: [],
  errors: [],
};
let application, page;
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env))
  if (key.toLowerCase() === "path") delete env[key];
env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
async function launch(version) {
  application = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: work,
    env,
    timeout: 45000,
  });
  assert.equal(
    await application.evaluate(({ app }) => app.getVersion()),
    version,
  );
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  page = await application.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
}
async function snapshot() {
  const files = {};
  async function walk(directory) {
    for (const item of await readdir(join(data, directory), {
      withFileTypes: true,
    })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else {
        assert.equal(item.isFile(), true);
        files[path] = await digest(join(data, path));
      }
    }
  }
  await walk("library");
  await walk("tasks");
  // Only record the encrypted settings file's digest, never its contents.
  files["model.json"] = await digest(join(data, "model.json"));
  return files;
}
try {
  const started = Date.now();
  await run(previousInstaller, ["/S", `/D=${install}`], options);
  report.previousInstallMs = Date.now() - started;
  await launch(previousManifest.version);
  await page.getByLabel("正文编辑器").fill(body);
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(manuscript, "utf8"), body);
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page
    .getByLabel("模型名称", { exact: true })
    .fill("synthetic-upgrade-model");
  await page
    .getByLabel("API Key", { exact: true })
    .fill("synthetic-upgrade-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  await page.screenshot({ path: join(screenshots, "before-upgrade.png") });
  await application.close();
  application = undefined;
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    id = randomUUID();
  await journal.create(
    {
      id,
      status: "preparing",
      bookId: book.id,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      skillId: "novel-polish",
      model: "synthetic-upgrade-model",
      startedAt: new Date().toISOString(),
    },
    {
      context: body,
      selectedText: body,
      instruction: "升级合成验证",
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
    candidate: "保留的旧版候选。",
  });
  const before = await snapshot();
  const upgradeStarted = Date.now();
  await run(currentInstaller, ["/S", `/D=${install}`], options);
  report.upgradeMs = Date.now() - upgradeStarted;
  assert.deepEqual(
    await snapshot(),
    before,
    "installer must preserve exact existing library, tasks and encrypted settings bytes",
  );
  await launch(pkg.version);
  assert.equal(
    (
      await page.getByLabel("正文编辑器").locator(".cm-line").allTextContents()
    ).join("\n"),
    body,
  );
  const config = await page.evaluate(() =>
    window.novel.request("settings.get"),
  );
  assert.equal(config.model, "synthetic-upgrade-model");
  assert.equal(config.hasKey, true);
  assert.equal(config.budget.maxSteps, 12);
  assert.deepEqual(
    await snapshot(),
    before,
    "opening upgraded app must preserve saved domain files",
  );
  const trigger = page.getByRole("button", {
    name: "写作任务记录",
    exact: true,
  });
  if (!(await trigger.isVisible()))
    await page.getByTitle("打开创作参考").click();
  await trigger.click();
  await page.locator(".task-row").first().click();
  await page.getByRole("button", { name: "继续审阅", exact: true }).click();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    "保留的旧版候选。",
  );
  await page
    .getByLabel("候选文本", { exact: true })
    .fill("升级后的审阅草稿𠮷🌊");
  await page.getByRole("button", { name: "保存审阅草稿", exact: true }).click();
  await page
    .getByLabel("审阅草稿状态")
    .filter({ hasText: "审阅草稿已保存" })
    .waitFor();
  assert.equal(
    (await journal.read(id)).reviewDraft.text,
    "升级后的审阅草稿𠮷🌊",
  );
  assert.equal(await readFile(manuscript, "utf8"), body);
  await page.screenshot({ path: join(screenshots, "after-upgrade.png") });
  await application.close();
  application = undefined;
  const uninstaller = (await readdir(install)).find((name) =>
    /^Uninstall .*\.exe$/i.test(name),
  );
  assert.ok(uninstaller);
  await run(join(install, uninstaller), ["/S", "/currentuser"], options);
  let removed = false;
  for (let i = 0; i < 150; i++) {
    try {
      await access(executable);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      removed = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.equal(removed, true, "upgraded app must uninstall");
  let registrationGone = false;
  for (let i = 0; i < 150; i++) {
    try {
      await run("reg.exe", ["query", registry], { windowsHide: true });
    } catch (error) {
      if (error.code !== 1) throw error;
      registrationGone = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.equal(
    registrationGone,
    true,
    "upgraded app must remove its uninstall registration",
  );
  assert.equal(await readFile(manuscript, "utf8"), body);
  report.checks.push(
    "manifest-verified alpha.3 installed and actually edited/saved Unicode manuscript and OS-encrypted synthetic settings",
    "new version silently installed over old app in the same directory; all prior library/task/settings bytes retained and opened in the exact new packaged EXE with system-only PATH",
    "old candidate recovered in new review UI, saved review draft separately without changing formal manuscript; upgraded app uninstalled while retaining user data",
  );
  assert.deepEqual(report.errors, []);
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
    join(screenshots, "upgrade-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
