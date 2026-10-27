import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
import { generatedStage, inspiration } from "../tests/fixtures/novel-batch.mjs";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
import { waitForCondition } from "./windows-installer-observation.mjs";
const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "novel-batch-ui-")),
  data = join(work, "data");
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "novel-batch",
);
await mkdir(out, { recursive: true });
const seed = new NovelStore(join(data, "library"));
await seed.initialize();
const baseline = await seed.importBook("批量隔离合成原稿", [
  { title: "旧信", body: "原有小说不可被批量创作改写。𠮷🌊" },
]);
const original = await seed.readChapter(baseline.id, baseline.chapters[0].id);
let releaseFirst;
const firstReply = new Promise((r) => {
  releaseFirst = r;
});
const replyGates = new Map([[1, firstReply]]),
  releases = [releaseFirst];
const model = await modelFixture({
  beforeReply: (index) => replyGates.get(index),
  replyText: (body) => {
    const prompt = body.messages
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : (m.content || [])
              .filter((b) => b.type === "text")
              .map((b) => b.text),
      )
      .join("\n");
    const index = Number(prompt.match(/批量创作第(\d+)\//)?.[1]) - 1;
    const context = JSON.parse(
      prompt.match(/<context>\n([\s\S]*?)\n<\/context>/)?.[1] || "{}",
    );
    const stage = context.volume
      ? `volume-${context.volume.number}`
      : context.chapter
        ? `chapter-${context.chapter.globalIndex}`
        : context.chapters
          ? "state"
          : "plan";
    return JSON.stringify(generatedStage(index, stage));
  },
});
function blockNextReply() {
  let release;
  const number = model.requests.length + 1;
  replyGates.set(
    number,
    new Promise((r) => {
      release = r;
    }),
  );
  releases.push(release);
  return { number, release };
}
let app, page, owned;
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  scope:
    "Browser plugin not available; actual Electron author UI + official DeepSeek Harness SDK/agent with a deterministic local SSE server. No real paid provider, native IME, literary, installed or store-quality claim.",
};
const host = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function start() {
  const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.ZINOVEL_TEST_EXECUTABLE) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
  }
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: root,
    env,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
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
  const key = runtime.packaged ? "appAsarSha256" : "desktopBundleSha256",
    hash = createHash("sha256")
      .update(
        await readFile(
          runtime.packaged ? runtime.path : join(root, "dist/desktop/main.cjs"),
        ),
      )
      .digest("hex");
  if (report[key]) assert.equal(report[key], hash);
  report[key] = hash;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1200, 900),
  );
  await page
    .getByRole("button", { name: "灵感批量创作", exact: true })
    .waitFor();
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
async function shot(name) {
  await page.screenshot({ path: join(out, name) });
  report.viewports.push({
    name,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      theme: document.documentElement.dataset.theme,
    }))),
  });
}
try {
  await start();
  await host("settings.save", {
    baseURL: model.url,
    model: "deepseek-v4-flash",
    apiKey: "fixture-novel-batch-local-only",
    budget: { maxOutputTokens: 2048 },
  });
  await page.getByRole("button", { name: "灵感批量创作", exact: true }).click();
  await page
    .getByLabel("批量创作灵感", { exact: true })
    .fill(inspiration.inspiration);
  await page.getByLabel("全书预期字数", { exact: true }).fill("80000");
  await page.getByLabel("每本试写章数", { exact: true }).fill("2");
  await page.getByLabel("同时创建小说数", { exact: true }).fill("2");
  await page.getByLabel("本批模型请求上限", { exact: true }).fill("30");
  await page
    .getByLabel("本批输出Token预留上限", { exact: true })
    .fill("300000");
  await page
    .getByRole("button", {
      name: "冻结参数并预览批次（不调用模型）",
      exact: true,
    })
    .click();
  await page.getByRole("heading", { name: "待发送", exact: true }).waitFor();
  const job = (await host("batch.list")).items[0];
  assert.equal(model.requests.length, 0);
  assert.equal((await host("library.list")).books.length, 1);
  await shot("batch-parameters-preview.png");
  await page
    .getByRole("button", {
      name: "开始 / 继续批量生成（会调用模型）",
      exact: true,
    })
    .click();
  await waitForCondition(async () => model.requests.length === 1, {
    timeoutMs: 60000,
    intervalMs: 250,
    label: "First actual Harness batch request",
  });
  await assert.rejects(host("batch.start", { id: job.id }), /已有批量任务/);
  await assert.rejects(
    host("ai.generate", {
      skillId: "novel-polish",
      instruction: "保留原意",
      context: original.body,
      selectedText: original.body,
      target: {
        bookId: baseline.id,
        chapterId: original.id,
        body: original.body,
        start: 0,
        end: original.body.length,
        baseHash: original.diskHash,
      },
    }),
    /已有写作任务|批量创作/,
  );
  await assert.rejects(host("ai.cancel"), /对应批次/);
  assert.equal(model.requests.length, 1);
  releaseFirst();
  await page
    .getByRole("heading", { name: "本批生成完成", exact: true })
    .waitFor({ timeout: 240000 });
  const result = (await host("batch.list")).items.find(
    (item) => item.id === job.id,
  );
  assert.equal(result.requestCount, 12);
  assert.equal(result.reservedOutputTokens, 12 * 2048);
  assert.equal(model.requests.length, 12);
  assert.ok(result.books.every((b) => b.status === "created"));
  const books = (await host("library.list")).books.filter(
    (b) => b.generationBatchId === job.id,
  );
  assert.equal(books.length, 2);
  for (const book of books) {
    assert.equal(book.chapters.length, 2);
    assert.equal(book.volumes.length, 2);
    assert.equal(book.targetWords, 80000);
    const docs = (await host("project.list", { bookId: book.id })).documents;
    assert.equal(docs.length, 17);
    assert.ok(docs.every((d) => d.origin === "generated"));
    const metadata = await host("project.read", {
      bookId: book.id,
      id: docs.find(
        (d) => d.path === "production/publish/chapter-002.frontmatter.yml",
      ).id,
    });
    assert.match(
      metadata.text,
      /volume: 2\nchapterInVolume: 1\nglobalIndex: 2\n/,
    );
    const state = await host("project.read", {
      bookId: book.id,
      id: docs.find((d) => d.path === "production/state/current-state.md").id,
    });
    assert.match(state.text, /已试写两章/);
    for (const chapter of book.chapters)
      assert.match(
        (await host("chapter.read", { bookId: book.id, chapterId: chapter.id }))
          .body,
        /船票.*𠮷/s,
      );
    const receipt = JSON.parse(
      await readFile(
        join(data, "library", book.id, ".zinovel/generated-origin.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.requestIds.length, 6);
    assert.equal(receipt.model, "deepseek-v4-flash");
    for (const id of receipt.requestIds) {
      const task = JSON.parse(
        await readFile(join(data, "tasks", id, "task.json"), "utf8"),
      );
      assert.equal(task.id, id);
      assert.equal(task.kind, "batch-stage");
      assert.equal(task.batchId, job.id);
    }
  }
  for (const request of model.requests)
    assert.deepEqual(request.tools.map((t) => t.name).sort(), [
      "novel_change_propose",
      "novel_selection_read",
    ]);
  assert.equal(
    (
      await host("chapter.read", {
        bookId: baseline.id,
        chapterId: original.id,
      })
    ).body,
    original.body,
  );
  report.checks.push(
    "actual author parameter preview makes zero requests; official Harness completes twelve fixed-identity stage requests for two distinct novels with seventeen generated assets each, full volume detail, exact trial chapter count and matching site publication sidecars; target words stay separate from actual trial output",
  );
  report.checks.push(
    "duplicate batch start, unrelated text generation and generic cancel refuse while the batch owns the Harness; only two novel tools are exposed, prior manuscript is unchanged, and portable receipts bind six real task identities to each new draft",
  );
  await shot("batch-completed-desktop.png");
  await page.getByRole("button", { name: "关闭批量创作", exact: true }).click();
  await page.getByRole("button", { name: "深色主题", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(806, 803),
  );
  await page.getByRole("button", { name: "灵感批量创作", exact: true }).click();
  await page.getByLabel("创作批次", { exact: true }).selectOption(job.id);
  await shot("batch-completed-dark-narrow.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.getByRole("button", { name: "关闭批量创作", exact: true }).click();
  await close();
  const before = model.requests.length;
  await start();
  await page.getByRole("button", { name: "灵感批量创作", exact: true }).click();
  await page.getByLabel("创作批次", { exact: true }).selectOption(job.id);
  await page
    .getByRole("heading", { name: "本批生成完成", exact: true })
    .waitFor();
  assert.equal(model.requests.length, before);
  assert.equal((await host("library.list")).books.length, 3);
  await assert.rejects(host("batch.start", { id: job.id }), /已经完成/);
  assert.equal(model.requests.length, before);
  const ledger = await readFile(
    join(data, "novel-batches", job.id, "job.json"),
    "utf8",
  );
  assert.equal(ledger.includes("fixture-novel-batch-local-only"), false);
  report.checks.push(
    "full desktop restart shows completed batch and all three books without any replay; completed start refuses, private batch ledger has no credential, and desktop/dark narrow UI stays within viewport",
  );
  // Explicit author cancellation stops a real SDK request and retains a non-replayed paused batch.
  const cancelled = await host("batch.prepare", {
    input: { ...inspiration, novelCount: 1 },
  });
  const cancelGate = blockNextReply();
  await host("batch.start", { id: cancelled.id });
  await waitForCondition(
    async () => model.requests.length === cancelGate.number,
    {
      timeoutMs: 60000,
      intervalMs: 250,
      label: "Actual cancellable batch request",
    },
  );
  await page.getByLabel("创作批次", { exact: true }).selectOption(cancelled.id);
  await page
    .getByRole("button", { name: "停止当前批次并保留候选", exact: true })
    .click();
  await page.getByRole("heading", { name: "已暂停", exact: true }).waitFor();
  cancelGate.release();
  const cancelResult = (await host("batch.list")).items.find(
    (v) => v.id === cancelled.id,
  );
  assert.equal(cancelResult.attempts[0].status, "cancelled");
  assert.equal((await host("library.list")).books.length, 3);
  await shot("batch-explicit-cancel.png");
  report.checks.push(
    "actual author stop closes the current official Harness request, waits for the durable cancellation record, leaves a paused batch and creates no incomplete novel",
  );
  // Force the owned desktop and current SDK child tree to exit after a real request reached the server.
  const interrupted = await host("batch.prepare", {
    input: { ...inspiration, novelCount: 1 },
  });
  const unknownGate = blockNextReply();
  await host("batch.start", { id: interrupted.id });
  await waitForCondition(
    async () => model.requests.length === unknownGate.number,
    {
      timeoutMs: 60000,
      intervalMs: 250,
      label: "Actual request before force exit",
    },
  );
  owned = await captureOwnedProcesses(app.process().pid);
  await terminateOwnedProcesses(owned);
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
  const afterCrashCount = model.requests.length;
  unknownGate.release();
  await start();
  assert.equal(model.requests.length, afterCrashCount);
  const recovered = (await host("batch.list")).items.find(
    (v) => v.id === interrupted.id,
  );
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.attempts[0].status, "remote-unknown");
  await assert.rejects(
    host("batch.start", { id: interrupted.id }),
    /远端结果未知/,
  );
  assert.equal(model.requests.length, afterCrashCount);
  await page.getByRole("button", { name: "灵感批量创作", exact: true }).click();
  await page
    .getByLabel("创作批次", { exact: true })
    .selectOption(interrupted.id);
  await shot("batch-unknown-after-forced-exit.png");
  await page
    .getByRole("checkbox", {
      name: "我已核对原任务，确认未知请求重新发送可能再次计费。",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", {
      name: "开始 / 继续批量生成（会调用模型）",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "本批生成完成", exact: true })
    .waitFor({ timeout: 180000 });
  const retried = (await host("batch.list")).items.find(
    (v) => v.id === interrupted.id,
  );
  assert.equal(retried.requestCount, 7);
  assert.equal(retried.attempts[0].status, "remote-unknown");
  assert.equal(retried.attempts[1].status, "complete");
  assert.notEqual(retried.attempts[0].id, retried.attempts[1].id);
  assert.equal((await host("library.list")).books.length, 4);
  assert.equal(
    (
      await host("chapter.read", {
        bookId: baseline.id,
        chapterId: original.id,
      })
    ).body,
    original.body,
  );
  report.checks.push(
    "actual owned desktop/SDK force exit after server receipt recovers remote-unknown without replay; unacknowledged start refuses, explicit author acknowledgement creates a new charged request identity, and the completed retry creates exactly one draft with original books preserved",
  );
  report.requestCount = model.requests.length;
  assert.equal(report.requestCount, 20);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  for (const release of releases) release();
  if (app) {
    if (report.status === "failed") await terminateOwnedProcesses(owned);
    else await close();
  }
  await model.close();
  await writeFile(
    join(out, "novel-batch-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
