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
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { waitForCondition as eventually } from "./windows-installer-observation.mjs";

if (process.platform !== "win32")
  throw new Error("Windows installer validation requires Windows");
const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const installer = join(
  root,
  "release",
  `ZiNovel-Studio-${pkg.version}-windows-x64-setup.exe`,
);
const installerSha256 = createHash("sha256")
  .update(await readFile(installer))
  .digest("hex");
// These packages inspect output independently; none is needed by the application.
try {
  await execute(
    process.env.ZINOVEL_QA_PYTHON || "python",
    [
      "-I",
      "-X",
      "utf8",
      "-c",
      "import pdfplumber, pypdf, pypdfium2, docx, PIL",
    ],
    { windowsHide: true },
  );
} catch (error) {
  throw new Error(
    "Independent document QA dependencies are unavailable; configure ZINOVEL_QA_PYTHON before installing the candidate",
    { cause: error },
  );
}
const registry =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\81b55339-fc21-4fe7-949e-a90dc443ef5a";
// Never replace an existing user's installation while testing the production installer.
let existing = false;
try {
  await execute("reg.exe", ["query", registry], { windowsHide: true });
  existing = true;
} catch (error) {
  if (error.code !== 1) throw error;
}
if (existing)
  throw new Error(
    "An existing ZiNovel Studio install was found; refusing to overwrite it",
  );
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "installer-qa-"));
const install = join(work, "中文 安装目录");
const executable = join(install, "ZiNovel Studio.exe");
const reportRoot = join(root, "screenshots", "release");
await mkdir(reportRoot, { recursive: true });
const evidence = {
  version: pkg.version,
  installerSha256,
  install,
  checks: [],
  status: "running",
};
const childOptions = {
  cwd: work,
  windowsHide: true,
  timeout: 600000,
  maxBuffer: 4 * 1024 * 1024,
};
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
let application;
try {
  const startedAt = Date.now();
  // /D must be the last argument. Node supplies it as one native Windows argument.
  await execute(installer, ["/S", `/D=${install}`], childOptions);
  await eventually(() => exists(executable), "Installed executable missing");
  evidence.installMs = Date.now() - startedAt;
  const manifestResult = await execute(
    executable,
    [
      "-e",
      'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
      join(install, "resources/app.asar/package.json"),
    ],
    { ...childOptions, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
  const manifest = JSON.parse(manifestResult.stdout);
  assert.equal(manifest.version, pkg.version);
  evidence.checks.push(
    "real NSIS per-user install to Chinese/space directory; bundled manifest version",
  );
  const result = await execute(
    process.execPath,
    [join(root, "scripts/smoke-desktop.mjs")],
    {
      ...childOptions,
      timeout: 240000,
      env: {
        ...process.env,
        ZINOVEL_TEST_EXECUTABLE: executable,
        ZINOVEL_QA_STAGE: "release/installed",
      },
    },
  );
  process.stdout.write(result.stdout);
  const desktop = JSON.parse(
    await readFile(join(reportRoot, "installed/desktop-smoke.json"), "utf8"),
  );
  assert.equal(desktop.status, "passed");
  evidence.checks.push(...desktop.checks.map((check) => `installed: ${check}`));
  for (const [script, receipt, scriptArgs = []] of [
    ["smoke-tasks.mjs", "tasks/task-smoke.json"],
    ["smoke-acceptance.mjs", "acceptance/acceptance-smoke.json"],
    ["smoke-task-compatibility.mjs", "compatibility/compatibility-smoke.json"],
    ["smoke-stream.mjs", "stream/stream-smoke.json"],
    ["smoke-budget-ui.mjs", "budget/budget-smoke.json"],
    [
      "smoke-candidate-review.mjs",
      "candidate-review/candidate-review-smoke.json",
    ],
    ["smoke-materials.mjs", "materials/materials-smoke.json"],
    ["smoke-evidence.mjs", "evidence/evidence-smoke.json"],
    ["smoke-material-context.mjs", "context/context-smoke.json"],
    [
      "smoke-material-proposal.mjs",
      "material-proposal/material-proposal-smoke.json",
    ],
    ["smoke-planning.mjs", "planning/planning-smoke.json"],
    ["smoke-world-proposals.mjs", "world-proposals/world-proposals-smoke.json"],
    ["smoke-pilots.mjs", "pilots/pilots-smoke.json"],
    ["smoke-pilot-agent.mjs", "pilot-agent/pilot-agent-smoke.json"],
    ["smoke-continuity.mjs", "continuity/continuity-smoke.json"],
    ["smoke-relationships.mjs", "relationships/relationships-smoke.json"],
    ["smoke-knowledge.mjs", "knowledge/knowledge-smoke.json"],
    ["smoke-reader.mjs", "reader/reader-smoke.json"],
    ["smoke-utf8-integrity.mjs", "utf8-integrity/utf8-integrity-smoke.json"],
    ["smoke-offline-writing.mjs", "offline-writing/offline-writing-smoke.json"],
    ["smoke-diagnostics.mjs", "diagnostics/diagnostics-smoke.json"],
    [
      "smoke-model-credentials.mjs",
      "model-credentials/model-credentials-smoke.json",
    ],
    ["smoke-model-profiles.mjs", "model-profiles/model-profiles-smoke.json"],
    [
      "smoke-backup-vault.mjs",
      "incremental-backup/incremental-backup-smoke.json",
      ["--allow-same-disk"],
    ],
    [
      "smoke-independent-backup.mjs",
      "independent-backup/independent-backup-smoke.json",
      ["--allow-same-disk"],
    ],
    [
      "smoke-publication-capture.mjs",
      "publication-capture/publication-capture-smoke.json",
    ],
    ["smoke-publication-ui.mjs", "publication-ui/publication-ui-smoke.json"],
    [
      "smoke-publication-pdf-output.mjs",
      "publication-pdf/publication-pdf-smoke.json",
    ],
    ["smoke-assets.mjs", "assets/assets-smoke.json"],
    [
      "smoke-publication-docx-output.mjs",
      "publication-docx/publication-docx-smoke.json",
    ],
    ["smoke-maps-ipc.mjs", "maps-ipc/maps-ipc-smoke.json"],
    [
      "smoke-publication-resources.mjs",
      "publication-resources/publication-resources-smoke.json",
    ],
    ["smoke-maps-ui.mjs", "maps-ui/maps-ui-smoke.json"],
    ["smoke-map-atlas-ui.mjs", "atlas-ui/atlas-ui-smoke.json"],
    [
      "smoke-publication-html-output.mjs",
      "publication-html/publication-html-output-smoke.json",
    ],
    [
      "smoke-creative-journey.mjs",
      "creative-journey/creative-journey-smoke.json",
    ],
    [
      "smoke-knowledge-context.mjs",
      "knowledge-context/knowledge-context-smoke.json",
    ],
    [
      "smoke-knowledge-context-targets.mjs",
      "knowledge-context-targets/knowledge-context-targets-smoke.json",
    ],
    [
      "smoke-knowledge-creation.mjs",
      "knowledge-creation/knowledge-creation-smoke.json",
    ],
    [
      "smoke-knowledge-choices.mjs",
      "knowledge-choices/knowledge-choices-smoke.json",
    ],
    [
      "smoke-knowledge-legacy.mjs",
      "knowledge-legacy/knowledge-legacy-smoke.json",
    ],
  ]) {
    const result = await execute(
      process.execPath,
      [join(root, "scripts", script), ...scriptArgs],
      {
        ...childOptions,
        timeout: 240000,
        env: {
          ...process.env,
          ZINOVEL_TEST_EXECUTABLE: executable,
          ZINOVEL_QA_STAGE: "release/installed",
        },
      },
    );
    process.stdout.write(result.stdout);
    const verified = JSON.parse(
      await readFile(join(reportRoot, "installed", receipt), "utf8"),
    );
    assert.equal(verified.status, "passed");
    evidence.checks.push(
      ...verified.checks.map((check) => `installed: ${check}`),
    );
  }
  const data = desktop.dataDirectory;
  const books = await readdir(join(data, "library"));
  const book = JSON.parse(
    await readFile(join(data, "library", books[0], "book.json"), "utf8"),
  );
  const file = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${book.chapters[0].id}.md`,
  );
  const before = await readFile(file);
  const reinstallStartedAt = Date.now();
  await execute(installer, ["/S", `/D=${install}`], childOptions);
  evidence.reinstallMs = Date.now() - reinstallStartedAt;
  assert.deepEqual(await readFile(file), before);
  const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
  delete env.ELECTRON_RUN_AS_NODE;
  // Deliberately no development project argument or working directory.
  application = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: work,
    env,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  await page.locator(".book-card").filter({ hasText: "雾港来信" }).click();
  await page.getByLabel("正文编辑器").waitFor();
  assert.equal(
    (
      await page.getByLabel("正文编辑器").locator(".cm-line").allTextContents()
    ).join("\n"),
    before.toString("utf8"),
  );
  await page.screenshot({ path: join(reportRoot, "reinstalled.png") });
  await application.close();
  application = undefined;
  evidence.checks.push(
    "same-version reinstall preserves exact manuscript bytes and opens them in installed UI",
  );
  const uninstaller = (await readdir(install)).find((name) =>
    /^Uninstall .*\.exe$/i.test(name),
  );
  assert.ok(uninstaller, "uninstaller is included");
  const uninstallStartedAt = Date.now();
  await execute(
    join(install, uninstaller),
    ["/S", "/currentuser"],
    childOptions,
  );
  evidence.uninstallObservation = await eventually(
    async () => !(await exists(executable)),
    "Uninstaller did not remove the installed executable",
  );
  evidence.uninstallRegistryObservation = await eventually(async () => {
    try {
      await execute("reg.exe", ["query", registry], { windowsHide: true });
      return false;
    } catch (error) {
      if (error.code === 1) return true;
      throw error;
    }
  }, "Uninstaller did not remove its registration");
  assert.deepEqual(await readFile(file), before);
  evidence.uninstallMs = Date.now() - uninstallStartedAt;
  evidence.checks.push(
    "real NSIS uninstall removes app and registration and retains synthetic user manuscript",
  );
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error.stack;
  throw error;
} finally {
  if (application?.process()?.exitCode === null) await application.close();
  await writeFile(
    join(reportRoot, "installer-smoke.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
}
