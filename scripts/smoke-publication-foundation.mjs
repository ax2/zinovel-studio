import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  makePublicationSnapshot,
  publicationHtml,
} from "../packages/novel-domain/publication.mjs";
const root = resolve("."),
  cache = await mkdtemp(join(root, ".cache", "publication-render-")),
  out = join(cache, "export");
await mkdir(out);
const shotDir = join(root, "screenshots/stage-007/html-foundation");
await mkdir(shotDir, { recursive: true });
const digest = (v) => createHash("sha256").update(v).digest("hex");
const sourceBody =
  "旧信有一道蓝印。𠮷 🌊\n\n<script>globalThis.authorLeak=true</script>\n第二段很长。".repeat(
    8,
  );
const input = {
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  bookId: randomUUID(),
  bookRevision: 1,
  metadata: {
    title: "独立阅读 <合成书> " + "很长书名".repeat(12),
    author: "合成作者",
    synopsis: "只包含明确选择的正文，不含作者设定。",
    rights: "合成验收作品，保留权利",
    aiDisclosure: "本文件仅为程序验收",
  },
  chapters: [
    {
      id: randomUUID(),
      title: '第一章 "蓝印"',
      volumeTitle: "卷一",
      revision: 1,
      savedHash: digest(sourceBody),
      bodyHash: digest(sourceBody),
      body: sourceBody,
    },
    {
      id: randomUUID(),
      title: "第二章 渡口",
      volumeTitle: "卷一",
      revision: 1,
      savedHash: digest("最后一段。"),
      bodyHash: digest("最后一段。"),
      body: "最后一段。",
    },
  ],
};
const snapshot = makePublicationSnapshot(input),
  artifact = publicationHtml(snapshot);
for (const [path, value] of artifact.files) {
  await mkdir(dirname(join(out, path)), { recursive: true });
  await writeFile(join(out, path), value);
}
const runner = join(cache, "browser.cjs");
await writeFile(
  runner,
  `const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.ZINOVEL_PUBLICATION_QA_DATA);let browserWindow;app.whenReady().then(()=>{browserWindow=new BrowserWindow({show:true,width:1300,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});browserWindow.loadFile(process.env.ZINOVEL_PUBLICATION_FILE);});app.on('window-all-closed',()=>app.quit());`,
);
const env = {
  ...process.env,
  ZINOVEL_PUBLICATION_QA_DATA: join(cache, "browser-data"),
  ZINOVEL_PUBLICATION_FILE: join(out, "index.html"),
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const report = {
  status: "running",
  checks: [],
  errors: [],
  environment: {
    browser:
      "Electron 44 bundled Chromium, standalone file pages; not workbench or actual mobile device",
    browserPlugin:
      "Browser plugin not available; repository Playwright/Electron fallback",
    artifactRoot: out,
  },
  viewports: [],
};
async function shot(name) {
  await page.screenshot({ path: join(shotDir, name) });
  report.viewports.push({
    name,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }))),
  });
}
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [runner],
    env,
    cwd: root,
    timeout: 45000,
  });
  page = await app.firstWindow({ timeout: 45000 });
  report.launchArguments = await app.evaluate(() => process.argv);
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") report.errors.push(m.text());
  });
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()))
      report.errors.push("unexpected network request");
  });
  await page
    .getByRole("heading", { name: input.metadata.title, exact: true })
    .waitFor();
  assert.ok(page.url().endsWith("/index.html"));
  assert.ok((await page.title()).includes("目录"));
  await shot("directory-desktop.png");
  await page.getByRole("link", { name: "开始阅读", exact: true }).click();
  await page
    .getByRole("heading", { name: input.chapters[0].title, exact: true })
    .waitFor();
  assert.ok(
    (await page.getByRole("article").innerText()).includes(
      "<script>globalThis.authorLeak=true</script>",
    ),
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      leak: typeof globalThis.authorLeak,
      novel: typeof window.novel,
      require: typeof window.require,
      process: typeof window.process,
    })),
    {
      leak: "undefined",
      novel: "undefined",
      require: "undefined",
      process: "undefined",
    },
  );
  await page.getByLabel("背景", { exact: true }).selectOption("dark");
  await page.getByLabel("字号", { exact: true }).selectOption("24");
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "24px",
  );
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(25, 37, 43)",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await shot("chapter-phone-dark.png");
  await page.getByRole("link", { name: "下一章", exact: true }).click();
  await page
    .getByRole("heading", { name: "第二章 渡口", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("字号", { exact: true }).inputValue(),
    "24",
  );
  assert.equal(
    await page.getByLabel("背景", { exact: true }).inputValue(),
    "dark",
  );
  assert.equal(
    await page.getByRole("link", { name: "下一章", exact: true }).count(),
    0,
  );
  await page.reload();
  await page
    .getByRole("heading", { name: "第二章 渡口", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "24px",
  );
  await page.getByRole("link", { name: "上一章", exact: true }).click();
  await page
    .getByRole("heading", { name: input.chapters[0].title, exact: true })
    .waitFor();
  await page.getByRole("link", { name: "目录", exact: true }).click();
  await page
    .getByRole("heading", { name: input.metadata.title, exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await shot("directory-phone-dark.png");
  for (const entry of artifact.manifest.files) {
    const bytes = await readFile(join(out, entry.path));
    assert.equal(digest(bytes), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
  }
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "Actual standalone file index/previous/next/last/reload render selected Unicode manuscript with no author tools or script execution",
    "External stylesheet and fixed font selectors pass restrictive CSP; real controls persist dark theme and 24px across file navigation/reload; 390px desktop simulation has no horizontal overflow",
    "Written artifact inventory matches every actual file byte; no HTTP requests, no workbench IPC/Node globals; no installed-app or host publication UI qualification",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  report.url = page?.url();
  report.title = await page?.title().catch(() => null);
  await writeFile(
    join(shotDir, "html-foundation-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await page
    ?.screenshot({ path: join(shotDir, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await app?.close().catch((e) => {
    report.cleanupFailure = String(e);
  });
  await writeFile(
    join(shotDir, "html-foundation-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
