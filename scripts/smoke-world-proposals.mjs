import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { materialKind } from "../packages/novel-domain/materials.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "world-proposals-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("世界资料提案合成验证", [
  { title: "渡口", body: "旧港的渡船出发了。" },
]);
const cards = [];
for (const kind of ["organization", "item", "ability", "research"])
  cards.push(
    await store.materials.save(book.id, {
      kind,
      title: `${materialKind(kind).label}验证`,
      status: "planned",
      chapterIds: [book.chapters[0].id],
      notes: "合成虚构材料",
      fields:
        kind === "research"
          ? {
              boundary: "待核实",
              checkedAt: "尚未核对",
              citation: "作者提供的合成测试年表",
              claim: "建港年代待查",
            }
          : { cost: "代价待完善" },
    }),
  );
const proposal = { title: "", fields: {}, notes: "" },
  model = await modelFixture({ materialProposal: proposal });
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "world-proposals",
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
const report = { status: "running", checks: [], errors: [], viewports: [] };
const panel = () => page.getByRole("region", { name: "创作资料", exact: true });
const assistant = () =>
  panel().getByRole("region", { name: "资料 AI 协作", exact: true });
const review = () =>
  page.getByRole("dialog", { name: "审阅资料候选", exact: true });
try {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-world-proposals-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  if (
    !(await page
      .getByRole("button", { name: "资料卡", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "资料卡", exact: true }).click();
  for (const original of cards) {
    Object.assign(proposal, {
      title: original.title,
      fields: {
        ...original.fields,
        ...(original.kind === "research"
          ? {
              uncertainty: "只有合成出处，不能声称查证",
              adaptation: "仅用作虚构设定",
            }
          : { cost: "每次使用均损耗一枚信标，不能免费重置" }),
      },
      notes: "仍为作者计划",
    });
    await panel()
      .getByRole("combobox", { name: "资料类型", exact: true })
      .selectOption(original.kind);
    await panel()
      .getByRole("button", { name: new RegExp(`^${original.title}`) })
      .click();
    await page.waitForFunction(
      (title) =>
        document.querySelector('[aria-label="资料标题"]')?.value === title,
      original.title,
    );
    await assistant()
      .locator("summary")
      .filter({ hasText: "AI 完善这份资料" })
      .click();
    await assistant()
      .getByLabel("资料修改要求", { exact: true })
      .fill("完善规则与代价；现实资料只整理已有来源，保留作者核对记录。");
    const requestCount = model.requests.length;
    await assistant()
      .getByRole("button", { name: "估算资料任务", exact: true })
      .click();
    await assistant()
      .getByRole("status")
      .filter({ hasText: "作者材料约" })
      .waitFor();
    assert.equal(model.requests.length, requestCount);
    await assistant()
      .getByRole("button", { name: "生成资料候选", exact: true })
      .click();
    await review().waitFor({ timeout: 45000 });
    assert.equal(model.requests.length, requestCount + 3);
    assert.equal(
      (await store.materials.read(book.id, original.id)).diskHash,
      original.diskHash,
    );
    if (original.kind === "research") {
      assert.equal(
        await review()
          .getByLabel("候选材料性质（作者标记）", { exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await review()
          .getByLabel("候选核对日期与方法", { exact: true })
          .getAttribute("readonly"),
        "",
      );
      assert.equal(
        await review()
          .getByLabel("候选核对日期与方法", { exact: true })
          .inputValue(),
        "尚未核对",
      );
      assert.match(
        JSON.stringify(model.requests.at(-1).messages),
        /当前工具没有网络检索能力/,
      );
      await review()
        .getByLabel("候选材料性质（作者标记）", { exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(screenshots, "research-review-light.png"),
      });
      report.viewports.push(
        await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          theme: document.documentElement.dataset.theme,
        })),
      );
    }
    await review()
      .getByRole("button", { name: "接受资料修改", exact: true })
      .click();
    await review().waitFor({ state: "hidden" });
    const accepted = await store.materials.read(book.id, original.id);
    assert.equal(accepted.revision, 2);
    assert.equal(accepted.status, "planned");
    assert.deepEqual(accepted.chapterIds, original.chapterIds);
    if (original.kind === "research") {
      assert.equal(accepted.fields.boundary, "待核实");
      assert.equal(accepted.fields.checkedAt, "尚未核对");
    } else assert.equal(accepted.fields.cost, proposal.fields.cost);
  }
  for (const request of model.requests)
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_material_propose",
      "novel_material_read",
    ]);
  assert.equal(
    await readFile(
      join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
      "utf8",
    ),
    "旧港的渡船出发了。",
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "real Electron and official Harness complete organization/item/ability/research proposals with explicit review and acceptance; four estimates dispatch zero requests; twelve local fixture requests expose only material-read/propose",
    "research classification and verification remain disabled/read-only during review and unchanged after acceptance; model is told it has no network verification tool; manuscript bytes, author status and chapter references remain unchanged",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  if (page)
    await page
      .screenshot({ path: join(screenshots, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await model.close();
  await writeFile(
    join(screenshots, "world-proposals-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
