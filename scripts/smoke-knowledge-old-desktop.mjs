import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, ".."),
  oldExecutable = resolve(
    process.argv[2] ||
      join(root, "release/v0.1.0-alpha.11/win-unpacked/ZiNovel Studio.exe"),
  );
await access(oldExecutable);
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "knowledge-old-desktop-")),
  store = new NovelStore(join(data, "library")),
  book = await store.importBook("旧桌面认知回退合成稿", [
    { title: "旧信", body: "旧信有一道蓝印。\n林舟仍怀疑船主寄信。🌊" },
  ]);
const make = (kind, title) =>
  store.materials.save(book.id, {
    kind,
    title,
    status: "planned",
    fields:
      kind === "proposition"
        ? { claim: "船主寄信", truthIntent: "尚未确定" }
        : {},
    notes: "",
    chapterIds: [],
  });
let owner = await make("character", "林舟");
await make("proposition", "寄信人");
const proposition = (
    await store.materials.list(book.id, { kind: "proposition" })
  ).items[0],
  chapter = await store.readChapter(book.id, book.chapters[0].id),
  source = {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  };
owner = await store.materials.mutateEvidence(book.id, owner, {
  action: "add",
  kind: "knowledge",
  scope: "character",
  statement: "旧记录只说明林舟看见蓝印。",
  storyTime: "抵港日",
  relatedIds: [],
  source,
});
const legacy = await store.knowledge.legacy.preview(
    book.id,
    owner.id,
    owner.evidence[0].id,
  ),
  input = {
    propositionId: proposition.id,
    scope: "reader",
    characterId: null,
    state: "suspects",
    statement: "读者怀疑船主寄信。",
    storyTime: "抵港日",
  },
  event = await store.knowledge.linkLegacy(book.id, input, legacy, source),
  choice = await store.knowledge.choices.select(book.id, event, null);
const base = join(data, "library", book.id),
  paths = [
    `knowledge/origins/${event.id}.json`,
    `knowledge/choices/${input.propositionId}.reader.reader.json`,
    `materials/${owner.id}.json`,
    `manuscript/${chapter.id}.md`,
  ],
  before = await Promise.all(paths.map((p) => readFile(join(base, p))));
const shots = join(root, "screenshots", "stage-004", "knowledge-old-desktop");
await mkdir(shots, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  oldVersion: "",
  newVersion: "",
  boundary:
    "packaged alpha.11 runtime on synthetic alpha.12-format knowledge; not NSIS downgrade or complete application migration qualification",
};
let application, page;
const dialog = () =>
    page.getByRole("dialog", { name: "认知矩阵", exact: true }),
  detail = () =>
    dialog().getByRole("region", { name: "认知记录详情", exact: true });
async function launch(old) {
  const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
  delete env.ELECTRON_RUN_AS_NODE;
  if (old) {
    for (const key of Object.keys(env))
      if (key.toLowerCase() === "path") delete env[key];
    env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
  }
  application = await electron.launch({
    executablePath: old ? oldExecutable : electronPath,
    args: old ? [] : [root],
    cwd: old ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  const version = await application.evaluate(({ app }) => app.getVersion());
  if (old) {
    report.oldVersion = version;
    assert.equal(version, "0.1.0-alpha.11");
  } else {
    report.newVersion = version;
    assert.equal(version, "0.1.0-alpha.12");
  }
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  const editor = page.getByLabel("正文编辑器");
  await editor.waitFor();
  await editor.click();
  await editor.press("Control+Home");
  await editor.press("Shift+End");
  await page.getByRole("button", { name: "认知矩阵", exact: true }).click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "共 1 个命题" })
    .waitFor();
  await dialog()
    .getByRole("button", { name: "查看认知依据", exact: true })
    .click();
}
try {
  await launch(true);
  await detail()
    .getByRole("button", { name: "修订并重新绑定依据", exact: true })
    .click();
  await dialog()
    .getByLabel("认知说明", { exact: true })
    .fill("旧版桌面手工修订后，读者仍只是在怀疑。");
  await dialog()
    .getByRole("button", { name: "保存并绑定当前选区", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /怀疑 · 有效 · 版本 2/ })
    .waitFor();
  await detail().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, "old-packaged-edit.png") });
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await application.close();
  application = null;
  for (let n = 0; n < paths.length; n++)
    assert.deepEqual(await readFile(join(base, paths[n])), before[n]);
  const changed = await store.knowledge.read(book.id, event.id);
  assert.equal(changed.origin.targetChanged, true);
  assert.equal(changed.origin.source.eventId, legacy.eventId);
  assert.equal(
    (await store.knowledge.choices.read(book.id, input)).freshness,
    "stale",
  );
  await launch(false);
  const origin = detail().getByRole("region", {
    name: "旧认知来源",
    exact: true,
  });
  await origin
    .getByText("新认知已修订；这里保留最初关联的版本 1。", { exact: true })
    .waitFor();
  await detail()
    .getByRole("region", { name: "作者当前认知选择", exact: true })
    .getByRole("heading", { name: "作者当前选择 · 怀疑 · 待复核", exact: true })
    .waitFor();
  await origin.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(shots, "new-runtime-provenance-retained.png"),
  });
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  assert.equal(choice.snapshot.statement, event.statement);
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual archived alpha.11 packaged runtime reads the new synthetic library and explicitly edits only its supported event using saved source selection",
    "old app preserves new frozen origin, author choice, original legacy card and manuscript bytes exactly",
    "current app shows the old writer changed the target version and keeps the original provenance; the frozen author choice is stale instead of silently following the old edit",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (application) {
    await page
      ?.waitForFunction(
        () => !document.querySelector(".knowledge-body:disabled"),
      )
      .catch(() => {});
    await application.close();
  }
  await writeFile(
    join(shots, "knowledge-old-desktop.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
