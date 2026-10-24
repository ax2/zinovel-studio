import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
const stage = process.env.ZINOVEL_QA_STAGE || "stage-007";
const ui = JSON.parse(
  await readFile(
    join(
      root,
      "screenshots",
      stage,
      "publication-ui/publication-ui-smoke.json",
    ),
    "utf8",
  ),
);
assert.equal(ui.status, "passed");
const out = ui.htmlDirectory;
const manifest = JSON.parse(
  await readFile(join(out, "publication-manifest.json"), "utf8"),
);
assert.equal(manifest.state, "exported");
assert.equal(manifest.format, "html");
const cache = await mkdtemp(join(root, ".cache", "publication-output-"));
const shotDir = join(root, "screenshots", stage, "publication-html");
await mkdir(shotDir, { recursive: true });
const digest = (value) => createHash("sha256").update(value).digest("hex");
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
let app, page, owned;
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
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow({ timeout: 45000 });

  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") report.errors.push(m.text());
  });
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()))
      report.errors.push("unexpected network request");
  });
  await page.getByRole("heading", { name: "雾港选章", exact: true }).waitFor();
  assert.ok(page.url().endsWith("/index.html"));
  assert.ok((await page.title()).includes("目录"));
  await shot("directory-desktop.png");
  await page.getByRole("link", { name: "开始阅读", exact: true }).click();
  await page
    .getByRole("heading", { name: "第二章 渡口", exact: true })
    .waitFor();
  assert.ok(
    (await page.getByRole("article").innerText()).includes("第二章结尾。"),
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      leak: typeof globalThis.PUBLICATION_SCRIPT_RAN,
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
    .getByRole("heading", { name: "第一章 旧信", exact: true })
    .waitFor();
  const frozenBody = await page.getByRole("article").innerText();
  assert.ok(frozenBody.includes("𠮷🌊"));
  assert.ok(
    frozenBody.includes("<script>window.PUBLICATION_SCRIPT_RAN=true</script>"),
  );
  assert.equal(
    await page.evaluate(() => typeof window.PUBLICATION_SCRIPT_RAN),
    "undefined",
  );
  assert.ok(!frozenBody.includes("作者捕获后明确外部改稿"));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await shot("frozen-body-phone-dark.png");
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
    .getByRole("heading", { name: "第一章 旧信", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "24px",
  );
  await page.getByRole("link", { name: "上一章", exact: true }).click();
  await page
    .getByRole("heading", { name: "第二章 渡口", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "目录", exact: true }).click();
  await page.getByRole("heading", { name: "雾港选章", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await shot("directory-phone-dark.png");
  for (const entry of manifest.files) {
    const bytes = await readFile(join(out, entry.path));
    assert.equal(digest(bytes), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
  }
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "Actual author UI exported HTML opens independently with reversed chapter order, previous/next/directory/reload, frozen Unicode body and no script execution",
    "External stylesheet and fixed font selectors pass restrictive CSP; real controls persist dark theme and 24px across file navigation/reload; 390px desktop simulation has no horizontal overflow",
    "Actual author UI export inventory matches every file byte; no HTTP requests or workbench IPC/Node globals; standalone Chromium viewer only",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  report.url = page?.url();
  report.title = await page?.title().catch(() => null);
  await writeFile(
    join(shotDir, "publication-html-output-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await page
    ?.screenshot({ path: join(shotDir, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else {
        await app.close();
        await confirmOwnedProcessesExited(owned);
      }
    } else await app?.close();
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error);
    throw error;
  } finally {
    await writeFile(
      join(shotDir, "publication-html-output-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
}
