import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  work = await mkdtemp(join(root, ".cache", "model-credentials-")),
  data = join(work, "data");
const legacy = process.argv.includes("--expect-legacy-forwarding"),
  out = join(
    root,
    legacy
      ? "assessments/stage-003/model-credential-legacy"
      : "screenshots/" +
          (process.env.ZINOVEL_QA_STAGE || "stage-003") +
          "/model-credentials",
  );
await mkdir(out, { recursive: true });
const oldKey = "synthetic-old-service-only-7361",
  newKey = "synthetic-new-service-only-9432",
  received = [];
const original = await modelFixture(),
  next = await modelFixture({
    beforeReply: (_index, headers) =>
      received.push({
        old:
          headers["x-api-key"] === oldKey ||
          headers.authorization === `Bearer ${oldKey}`,
        fresh:
          headers["x-api-key"] === newKey ||
          headers.authorization === `Bearer ${newKey}`,
      }),
  });
const store = new NovelStore(join(data, "library")),
  book = await store.importBook("合成服务凭据隔离", [
    { title: "旧港", body: "合成原稿𠮷🌊。" },
  ]);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const k of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(k.toLowerCase()))
      delete env[k];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const report = {
  status: "running",
  checks: [],
  errors: [],
  scope:
    "Synthetic keys only; actual desktop settings UI and official Harness requests to two separate local endpoints; header evidence stores booleans, never credentials; no real provider or native IME qualification",
};
const request = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const dialog = () =>
  page.getByRole("dialog", { name: "模型设置", exact: true });
async function open() {
  await page.getByTitle("模型设置", { exact: true }).first().click();
  await dialog().getByLabel("服务地址", { exact: true }).waitFor();
}
async function save() {
  await dialog().getByRole("button", { name: "保存设置", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
}
async function generate() {
  const chapter = await request("chapter.read", {
    bookId: book.id,
    chapterId: book.chapters[0].id,
  });
  return request("ai.generate", {
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
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = createHash("sha256")
      .update(await readFile(runtime.path))
      .digest("hex");
  await open();
  await dialog().getByLabel("服务地址", { exact: true }).fill(original.url);
  await dialog().getByLabel("API Key", { exact: true }).fill(oldKey);
  await save();
  assert.equal((await request("settings.get")).hasKey, true);
  const file = join(data, "model.json"),
    before = await readFile(file);
  assert.ok(!before.includes(Buffer.from(oldKey)));
  if (!legacy) {
    const legacyConfig = JSON.parse(before);
    delete legacyConfig.schemaVersion;
    delete legacyConfig.credentialScope;
    await writeFile(file, JSON.stringify(legacyConfig));
    assert.equal((await request("settings.get")).hasKey, true);
    await generate();
    assert.equal(original.requests.length, 3);
    const legacyBytes = await readFile(file);
    await open();
    await dialog().getByLabel("服务地址", { exact: true }).fill(next.url);
    await dialog().getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(await readFile(file), legacyBytes);
  }
  await open();
  await dialog().getByLabel("服务地址", { exact: true }).fill(next.url);
  if (!legacy) {
    assert.match(await dialog().innerText(), /留空.*清除|清除.*旧/);
    await page.screenshot({
      path: join(out, "desktop-service-change-warning.png"),
    });
  }
  await save();
  if (legacy) {
    assert.equal((await request("settings.get")).hasKey, true);
    await generate();
    assert.equal(next.requests.length, 3);
    assert.ok(received.every((item) => item.old));
    report.status = "confirmed-vulnerability";
    report.forwardedOldCredentialRequests = received.filter(
      (item) => item.old,
    ).length;
    report.checks.push(
      "Existing settings UI saved a changed service address with an empty Key field; previous encrypted synthetic credential was reused by all three actual official Harness requests to the second endpoint",
    );
  } else {
    assert.equal((await request("settings.get")).hasKey, false);
    await assert.rejects(generate(), /Key|密钥|凭据/);
    assert.equal(next.requests.length, 0);
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.encryptedKey, "");
    await open();
    await dialog().getByLabel("API Key", { exact: true }).fill(newKey);
    await save();
    await generate();
    assert.equal(next.requests.length, 3);
    assert.ok(received.every((item) => !item.old && item.fresh));
    await open();
    await dialog()
      .getByLabel("模型名称", { exact: true })
      .fill("synthetic-other-text-model");
    await save();
    assert.equal((await request("settings.get")).hasKey, true);
    const boundBytes = await readFile(file),
      mismatched = { ...JSON.parse(boundBytes), baseURL: original.url };
    const mismatchBytes = Buffer.from(JSON.stringify(mismatched));
    await writeFile(file, mismatchBytes);
    const publicMismatch = await request("settings.get");
    assert.equal(publicMismatch.hasKey, false);
    assert.equal(publicMismatch.credentialMismatch, true);
    await assert.rejects(generate(), /不匹配/);
    assert.equal(original.requests.length, 3);
    assert.equal(next.requests.length, 3);
    assert.deepEqual(await readFile(file), mismatchBytes);
    await open();
    assert.match(await dialog().innerText(), /旧密钥不会发送/);
    await page.screenshot({
      path: join(out, "desktop-external-scope-blocked.png"),
    });
    await dialog()
      .getByRole("button", { name: "关闭模型设置", exact: true })
      .click();
    const futureBytes = Buffer.from(
      JSON.stringify({
        ...JSON.parse(boundBytes),
        schemaVersion: 999,
        privateProof: "合成未知元数据勿回显",
      }),
    );
    await writeFile(file, futureBytes);
    await assert.rejects(
      request("settings.get"),
      (error) =>
        /不支持/.test(error.message) &&
        !error.message.includes("合成未知元数据"),
    );
    await assert.rejects(
      request("settings.save", { baseURL: next.url, model: "synthetic" }),
      /不支持/,
    );
    assert.deepEqual(await readFile(file), futureBytes);
    const missingScope = { ...JSON.parse(boundBytes) };
    delete missingScope.credentialScope;
    const missingScopeBytes = Buffer.from(JSON.stringify(missingScope));
    await writeFile(file, missingScopeBytes);
    await assert.rejects(request("settings.get"), /不支持/);
    assert.deepEqual(await readFile(file), missingScopeBytes);
    await writeFile(file, boundBytes);
    await open();
    await dialog().getByLabel("API Key", { exact: true }).fill(oldKey);
    await dialog()
      .getByRole("button", { name: "清除已保存的密钥", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: "清除已保存的密钥", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await dialog().getByLabel("API Key", { exact: true }).inputValue(),
      "",
    );
    await save();
    assert.equal((await request("settings.get")).hasKey, false);
    await open();
    await dialog().getByLabel("API Key", { exact: true }).fill(newKey);
    await save();
    await open();
    await dialog()
      .getByLabel("服务地址", { exact: true })
      .fill(next.url + "/");
    await save();
    assert.equal((await request("settings.get")).hasKey, true);
    await open();
    await dialog().getByLabel("API Key", { exact: true }).fill(oldKey);
    await dialog().getByLabel("服务地址", { exact: true }).fill(original.url);
    assert.equal(
      await dialog().getByLabel("API Key", { exact: true }).inputValue(),
      "",
    );
    await save();
    assert.equal((await request("settings.get")).hasKey, false);
    assert.equal(original.requests.length, 3);
    assert.equal(
      (
        await request("chapter.read", {
          bookId: book.id,
          chapterId: book.chapters[0].id,
        })
      ).body,
      "合成原稿𠮷🌊。",
    );
    assert.ok(!(await readFile(file)).includes(Buffer.from(newKey)));
    report.checks.push(
      "Changing service address and leaving Key blank clears the old encrypted credential; official generation refuses before any new-endpoint request; explicit replacement credential is the only credential observed on three real Harness tool-roundtrip requests",
      "Same-service model selection and canonical trailing slash preserve the credential; changing address and explicit key clearing discard unsaved Key input; returning to old endpoint cannot resurrect an old credential; original manuscript unchanged and stored bytes contain no plaintext key",
      "Unversioned legacy encrypted settings still generate through the original endpoint; cancelling service editing preserves exact legacy bytes; externally mismatched service scope refuses decryption/use without changing stored bytes or contacting another provider; unknown future schema refuses read/save and preserves exact bytes until explicit synthetic repair",
    );
    await open();
    await page.screenshot({ path: join(out, "desktop-service-scope.png") });
    await dialog()
      .getByRole("button", { name: "关闭模型设置", exact: true })
      .click();
    await page
      .getByLabel("主导航")
      .getByTitle("深色主题", { exact: true })
      .click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 820, height: 840 }),
    );
    await open();
    report.geometry = await dialog().evaluate((node) => {
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
    await page.screenshot({ path: join(out, "dark-narrow-service-scope.png") });
    assert.deepEqual(report.errors, []);
    report.oldCredentialForwarded = false;
    report.newCredentialRequests = received.filter((item) => item.fresh).length;
    report.status = "passed";
  }
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    owned = await captureOwnedProcesses(app.process().pid);
    if (report.status === "failed") await terminateOwnedProcesses(owned);
    else {
      await app.close();
      await confirmOwnedProcessesExited(owned);
    }
  }
  await original.close();
  await next.close();
  await writeFile(
    join(out, "model-credentials-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
