import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtemp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "model-profiles-")),
  data = join(work, "data"),
  out = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-003",
    "model-profiles",
  );
await mkdir(out, { recursive: true });
const keys = [
    "synthetic-text-profile-A-918",
    "synthetic-text-profile-B-247",
    "synthetic-image-profile-C-536",
  ],
  received = [[], [], []];
const servers = await Promise.all(
  keys.map((_key, target) =>
    modelFixture({
      beforeReply: (_index, headers) =>
        received[target].push(
          keys.map(
            (key) =>
              headers["x-api-key"] === key ||
              headers.authorization === `Bearer ${key}`,
          ),
        ),
    }),
  ),
);
const store = new NovelStore(join(data, "library")),
  body = "合成独立模型原稿𠮷🌊。",
  book = await store.importBook("合成模型隔离", [{ title: "渡口", body }]);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const report = {
  status: "running",
  checks: [],
  errors: [],
  scope:
    "Synthetic keys and manuscript; real desktop UI, Windows safeStorage and official Harness to separate loopback endpoints; image adapter intentionally unavailable; no real provider or native IME qualification",
};
const request = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baseline = (view) => ({
  revision: view.revision,
  diskHash: view.diskHash,
});
const panel = () =>
  page.getByRole("dialog", { name: "模型与能力管理", exact: true });
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    env,
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? work : root,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  if (process.env.ZINOVEL_PROFILE_START_NARROW === "1") {
    await page.locator(".book-card").filter({ hasText: book.title }).waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 840 }),
    );
  }
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  if (!report.initialViewport)
    report.initialViewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      scale: devicePixelRatio,
    }));
}
async function close() {
  owned = await captureOwnedProcesses(app.process().pid);
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
}
async function open() {
  const current = await request("settings.get");
  await page.getByTitle("模型设置", { exact: true }).first().click();
  if (!current.profilesEnabled) {
    await page
      .getByRole("dialog", { name: "模型设置", exact: true })
      .getByLabel("服务地址", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "管理多个模型与能力", exact: true })
      .click();
  }
  await panel().waitFor();
}
async function generate(choice) {
  const chapter = await request("chapter.read", {
    bookId: book.id,
    chapterId: book.chapters[0].id,
  });
  return request("ai.generate", {
    ...(choice !== undefined ? { modelChoice: choice } : {}),
    skillId: "novel-polish",
    instruction: "润色合成选区",
    context: chapter.body,
    selectedText: chapter.body,
    target: {
      bookId: book.id,
      chapterId: chapter.id,
      body: chapter.body,
      start: 0,
      end: chapter.body.length,
      baseHash: chapter.hash,
    },
  });
}
try {
  await launch();
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = hash(await readFile(runtime.path));
  await request("settings.save", {
    baseURL: servers[0].url,
    model: "synthetic-text-A",
    apiKey: keys[0],
  });
  const legacyBytes = await readFile(join(data, "model.json"));
  await open();
  assert.equal(
    await panel()
      .getByRole("button", { name: "启用独立模型配置", exact: true })
      .isEnabled(),
    false,
  );
  await panel().getByLabel("我已了解迁移、备份和旧版兼容边界").check();
  await panel()
    .getByRole("button", { name: "启用独立模型配置", exact: true })
    .click();
  await panel().getByLabel("文字写作服务", { exact: true }).waitFor();
  const pointer = JSON.parse(await readFile(join(data, "model.json"), "utf8"));
  assert.equal(pointer.schemaVersion, 2);
  assert.deepEqual(
    await readFile(join(data, pointer.legacyBackup)),
    legacyBytes,
  );
  assert.equal(pointer.legacyHash, hash(legacyBytes));
  let view = await request("profiles.list");
  assert.equal(view.storeId, pointer.storeId);
  const profileA = view.profiles[0];
  assert.equal(profileA.hasKey, true);
  assert.ok(!JSON.stringify(view).includes(keys[0]));
  assert.ok(!JSON.stringify(view).includes("encryptedKey"));
  assert.deepEqual(
    received.map((x) => x.length),
    [0, 0, 0],
  );
  await panel()
    .getByRole("button", { name: "关闭模型管理", exact: true })
    .click();
  const first = await generate(baseline(view));
  assert.equal(received[0].length, 3);
  assert.ok(received[0].every((row) => row[0] && !row[1] && !row[2]));
  const taskA = await request("ai.task", { id: first.id });
  assert.equal(taskA.record.modelProfile.id, profileA.id);
  report.checks.push(
    "Explicit desktop migration preserves exact original encrypted settings in a hash-bound backup and activates the matching store identity; no network until explicit generation; actual Harness A uses only DPAPI credential A and freezes its profile on the task",
  );

  await open();
  await panel()
    .getByRole("button", { name: "新增模型配置", exact: true })
    .click();
  await panel().getByLabel("配置名称", { exact: true }).fill("文字服务B");
  await panel().getByLabel("服务地址", { exact: true }).fill(servers[1].url);
  await panel()
    .getByLabel("模型名称", { exact: true })
    .fill("synthetic-text-B");
  await panel().getByLabel("API Key", { exact: true }).fill(keys[1]);
  await panel()
    .getByRole("button", { name: "保存独立配置", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "编辑配置 文字服务B", exact: true })
    .waitFor();
  view = await request("profiles.list");
  const profileB = view.profiles.find((p) => p.label === "文字服务B");
  const stale = baseline(view);
  await panel()
    .getByLabel("文字写作服务", { exact: true })
    .selectOption(profileB.id);
  await panel().getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  view = await request("profiles.list");
  await panel()
    .getByRole("button", { name: "关闭模型管理", exact: true })
    .click();
  await assert.rejects(generate(stale), /已变化/);
  await assert.rejects(generate(), /重新读取模型配置/);
  assert.equal(received[1].length, 0);
  const editor = page.getByLabel("正文编辑器");
  await editor.click();
  await page.keyboard.press("Control+A");
  if (
    !(await page
      .getByRole("button", { name: "生成候选", exact: true })
      .isVisible())
  ) {
    await page.getByTitle("打开创作参考").click();
  }
  await page
    .getByLabel("本次文字模型")
    .filter({ hasText: "文字服务B" })
    .waitFor();
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("button", { name: "取消生成", exact: true })
    .waitFor({ state: "hidden", timeout: 45000 });
  assert.equal(received[1].length, 3);
  assert.ok(received[1].every((row) => !row[0] && row[1] && !row[2]));
  await page.keyboard.press("Escape");
  assert.deepEqual(
    (await request("ai.task", { id: first.id })).record.modelProfile,
    taskA.record.modelProfile,
  );
  report.checks.push(
    "Real author UI creates independent B and selects it; stale or missing displayed revision refuses before network; the ordinary writing button sends only selected B key through official Harness; old task metadata remains frozen and manuscript is not auto-applied",
  );

  // The image route is separately persisted; unsupported capability refuses before decrypt/send.
  view = await request("profiles.add", {
    expected: baseline(view),
    input: {
      label: "图像服务C",
      protocol: "openai-images",
      baseURL: servers[2].url,
      model: "synthetic-image-C",
      apiKey: keys[2],
      imageBudget: {
        maxImages: 2,
        maxCost: 6,
        pricing: { currency: "CNY", perImage: 3 },
      },
    },
  });
  const image = view.profiles.find((p) => p.capability === "image");
  await assert.rejects(
    request("profiles.select", {
      expected: baseline(view),
      capability: "text",
      id: image.id,
    }),
    /能力/,
  );
  view = await request("profiles.select", {
    expected: baseline(view),
    capability: "image",
    id: image.id,
  });
  assert.equal(view.routes.text, profileB.id);
  assert.equal(
    view.profiles.find((p) => p.id === profileB.id).budget.maxCost,
    0,
  );
  assert.equal(image.runnable, false);
  assert.equal(received[2].length, 0);
  await open();
  await panel()
    .getByRole("button", { name: "编辑配置 文字服务B", exact: true })
    .click();
  await panel().getByLabel("配置名称", { exact: true }).fill("保留冲突草稿");
  view = await request("profiles.add", {
    expected: baseline(view),
    input: {
      label: "无Key待删除配置",
      protocol: "anthropic-text",
      baseURL: servers[0].url,
      model: "synthetic-empty",
    },
  });
  assert.equal(
    view.profiles.find((p) => p.label === "无Key待删除配置").hasKey,
    false,
  );
  const beforeStale = await readFile(join(data, "model-profiles.json"));
  await panel()
    .getByRole("button", { name: "保存独立配置", exact: true })
    .click();
  await panel().getByRole("alert").filter({ hasText: "已变化" }).waitFor();
  assert.equal(
    await panel().getByLabel("配置名称", { exact: true }).inputValue(),
    "保留冲突草稿",
  );
  assert.deepEqual(
    await readFile(join(data, "model-profiles.json")),
    beforeStale,
  );
  await panel().getByRole("button", { name: "取消编辑", exact: true }).click();
  await panel()
    .getByRole("button", { name: "刷新配置列表", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "编辑配置 无Key待删除配置", exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "删除配置 无Key待删除配置", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "确认删除配置", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "编辑配置 无Key待删除配置", exact: true })
    .waitFor({ state: "hidden" });
  await panel()
    .getByRole("button", { name: "编辑配置 文字服务B", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "清除本配置Key并保存当前编辑", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "编辑配置 文字服务B", exact: true })
    .waitFor();
  view = await request("profiles.list");
  assert.equal(view.profiles.find((p) => p.id === profileB.id).hasKey, false);
  assert.equal(view.profiles.find((p) => p.id === profileA.id).hasKey, true);
  assert.equal(view.profiles.find((p) => p.id === image.id).hasKey, true);
  await panel()
    .getByRole("button", { name: "关闭模型管理", exact: true })
    .click();
  await assert.rejects(generate(baseline(view)), /Key/);
  assert.equal(received[1].length, 3);
  await open();
  await panel()
    .getByRole("button", { name: "编辑配置 文字服务B", exact: true })
    .click();
  await panel().getByLabel("API Key", { exact: true }).fill(keys[1]);
  await panel()
    .getByRole("button", { name: "保存独立配置", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "编辑配置 文字服务B", exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "关闭模型管理", exact: true })
    .click();
  report.checks.push(
    "An externally changed profile revision rejects UI save without overwriting bytes and keeps the Chinese form draft; explicit cancel/refresh permits confirmed deletion of an unused empty-key configuration; clearing B key affects neither A nor image C and prevents B network until its key is explicitly replaced",
  );
  const file = join(data, "model-profiles.json"),
    bytes = await readFile(file);
  for (const key of keys) assert.ok(!bytes.includes(Buffer.from(key)));
  await close();
  await launch();
  view = await request("profiles.list");
  assert.equal(view.routes.text, profileB.id);
  assert.equal(view.routes.image, image.id);
  assert.deepEqual(
    received.map((x) => x.length),
    [3, 3, 0],
  );
  await generate(baseline(view));
  assert.equal(received[1].length, 6);
  assert.ok(received[1].every((row) => !row[0] && row[1] && !row[2]));
  await open();
  await page.screenshot({ path: join(out, "desktop-profiles.png") });
  await panel()
    .getByRole("button", { name: "编辑配置 图像服务C", exact: true })
    .click();
  assert.equal(await panel().getByLabel("每次图像数量上限").inputValue(), "2");
  assert.equal(await panel().getByLabel("每张图像单价").inputValue(), "3");
  await panel().getByRole("button", { name: "取消编辑", exact: true }).click();
  await panel()
    .getByRole("button", { name: "关闭模型管理", exact: true })
    .click();
  report.checks.push(
    "Separate image configuration retains its own key and per-image budget without borrowing text pricing; image cannot route to text; restart retains both routes and DPAPI B credential, does not auto-generate, and image adapter is explicitly unavailable with zero requests",
  );

  // External corruption is injected only into this test's own application settings.
  const future = Buffer.from(
    JSON.stringify({ ...JSON.parse(bytes), schemaVersion: 999 }),
  );
  await writeFile(file, future);
  await assert.rejects(request("profiles.list"), /格式|版本|读取/);
  await assert.rejects(generate(baseline(view)), /格式|版本|读取/);
  assert.deepEqual(await readFile(file), future);
  await writeFile(file, bytes);
  const foreign = Buffer.from(
    JSON.stringify({
      ...JSON.parse(bytes),
      storeId: "00000000-0000-4000-8000-000000000000",
    }),
  );
  await writeFile(file, foreign);
  await assert.rejects(request("settings.get"), /身份/);
  assert.deepEqual(await readFile(file), foreign);
  await writeFile(file, bytes);
  await rename(file, join(work, "held-model-profiles.json"));
  await assert.rejects(generate(baseline(view)), /缺失/);
  assert.deepEqual(
    received.map((x) => x.length),
    [3, 6, 0],
  );
  await open();
  await panel()
    .getByText(/模型列表缺失，已阻止生成/)
    .waitFor();
  await panel().getByLabel("我已了解迁移、备份和旧版兼容边界").check();
  await panel()
    .getByRole("button", { name: "从迁移前备份明确恢复", exact: true })
    .click();
  await panel().getByLabel("文字写作服务", { exact: true }).waitFor();
  view = await request("profiles.list");
  assert.equal(view.profiles.length, 1);
  assert.equal(view.profiles[0].baseURL, servers[0].url);
  assert.deepEqual(
    await readFile(join(data, pointer.legacyBackup)),
    legacyBytes,
  );
  assert.deepEqual(
    await readFile(join(work, "held-model-profiles.json")),
    bytes,
  );
  await panel()
    .getByRole("button", { name: "关闭模型管理", exact: true })
    .click();
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    body,
  );
  report.checks.push(
    "Future schema and foreign store identity preserve exact bytes and refuse use; missing list blocks generation without legacy fallback; explicit desktop recovery restores only the original single configuration while preserving held newer profiles and exact migration backup; original manuscript remains unchanged",
  );

  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 820, height: 840 }),
  );
  await open();
  await panel()
    .getByRole("button", { name: "新增模型配置", exact: true })
    .click();
  await panel().getByLabel("配置名称", { exact: true }).fill("中文配置𠮷");
  await panel().getByLabel("服务地址", { exact: true }).fill(servers[1].url);
  await panel()
    .getByLabel("API Key", { exact: true })
    .fill("synthetic-unsaved-only");
  await panel().getByLabel("服务地址", { exact: true }).fill(servers[2].url);
  assert.equal(
    await panel().getByLabel("API Key", { exact: true }).inputValue(),
    "",
  );
  report.geometry = await panel().evaluate((node) => {
    const r = node.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
      scroll: node.scrollWidth,
      client: node.clientWidth,
      scale: devicePixelRatio,
      theme: "dark",
    };
  });
  assert.ok(
    report.geometry.left >= 0 &&
      report.geometry.right <= report.geometry.width &&
      report.geometry.top >= 0 &&
      report.geometry.bottom <= report.geometry.height &&
      report.geometry.scroll <= report.geometry.client + 1,
  );
  await page.screenshot({ path: join(out, "dark-narrow-profile-editor.png") });
  const unchanged = await readFile(file);
  await page.keyboard.press("Escape");
  await panel().waitFor({ state: "hidden" });
  assert.deepEqual(await readFile(file), unchanged);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  report.requests = received.map((x) => x.length);
  report.checks.push(
    "Actual dark narrow desktop profile form accepts synthetic Chinese text, changing endpoint discards unsaved key, Escape closes idle dialog, layout stays inside viewport; all requests checked as credential-identity booleans, no plaintext keys stored in settings or reports",
  );
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    owned = await captureOwnedProcesses(app.process().pid);
    if (report.status === "failed") await terminateOwnedProcesses(owned);
    else await close();
  }
  await Promise.all(servers.map((server) => server.close()));
  await writeFile(
    join(out, "model-profiles-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
