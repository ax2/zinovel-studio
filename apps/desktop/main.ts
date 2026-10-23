import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { claimDesktopSingleInstance } from "./upstream/single-instance";
import { desktopNodeEnvironment } from "./upstream/node-environment";
import { NovelHarness } from "../../packages/novel-harness/runtime.mjs";
import { ModelSettings } from "./settings";
import { previewImport } from "../../packages/novel-storage/importer.mjs";
import { randomUUID } from "node:crypto";
import { bindWritingTarget } from "../../packages/novel-harness/target.mjs";
import { TaskJournal } from "../../packages/novel-harness/task-journal.mjs";
import { TaskAcceptance } from "../../packages/novel-harness/acceptance.mjs";
import { MaterialTaskAcceptance } from "../../packages/novel-harness/material-acceptance.mjs";
import {
  validateMaterialInput,
  materialMarkdown,
} from "../../packages/novel-domain/materials.mjs";

app.setName("ZiNovel Studio");
const dataRoot =
  process.env.ZINOVEL_DATA_ROOT ||
  join(app.getPath("appData"), "ZiNovel Studio");
app.setPath("userData", dataRoot);
const store = new NovelStore(join(dataRoot, "library"));
const settings = new ModelSettings(dataRoot);
const journal = new TaskJournal(join(dataRoot, "tasks"));
const acceptance = new TaskAcceptance(journal, store);
const materialAcceptance = new MaterialTaskAcceptance(journal, store.materials);
const harness = new NovelHarness({
  journal,
  root: dataRoot,
  resources: resolve(__dirname, "../resources"),
  environment: desktopNodeEnvironment(process.execPath, undefined, process.env),
});
const entry = resolve(__dirname, "../workbench/index.html");
let window: BrowserWindow | undefined;
let closing = false;
let closeTimer: NodeJS.Timeout | undefined;
let recoveryDialog = false;
function cancelCloseAttempt() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = undefined;
}
async function closeAfterRecovery() {
  cancelCloseAttempt();
  await harness.cancel();
  await acceptance.whenIdle();
  await materialAcceptance.whenIdle();
  await store.whenIdle();
  if (!window || window.isDestroyed()) return;
  window.webContents.session.flushStorageData();
  closing = true;
  window.destroy();
}
async function offerCloseRecovery() {
  cancelCloseAttempt();
  if (closing || recoveryDialog || !window || window.isDestroyed()) return;
  recoveryDialog = true;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "关闭前保存尚未完成",
      message: "写作窗口未能确认保存完成。",
      detail:
        "可以返回编辑、重试保存，或强制退出。强制退出会保留已有恢复缓存，但尚未进入缓存的输入可能丢失。",
      buttons: ["返回编辑", "重试保存", "强制退出"],
      defaultId: 0,
      cancelId: 0,
    });
    if (closing || !window || window.isDestroyed()) return;
    if (result.response === 2) await closeAfterRecovery();
    else if (result.response === 1) requestWindowClose();
  } finally {
    recoveryDialog = false;
  }
}
function requestWindowClose() {
  if (!window || window.isDestroyed() || closeTimer) return;
  window.webContents.send("novel:closing");
  closeTimer = setTimeout(() => {
    void offerCloseRecovery().catch((error) =>
      dialog.showErrorBox("关闭未完成", String(error)),
    );
  }, 8000);
}
const imports = new Map<
  string,
  { paths: string[]; preview: Awaited<ReturnType<typeof previewImport>> }
>();

async function materialTaskInput(payload: any) {
  const card = await store.materials.read(payload.bookId, payload.expected?.id);
  if (
    card.deletedAt ||
    card.diskHash !== payload.expected?.diskHash ||
    card.revision !== payload.expected?.revision
  )
    throw new Error("资料已改变或尚未保存，请重新读取后生成");
  const materialContext = payload.materialIds?.length
    ? await store.materials.contextPack(payload.bookId, payload.materialIds)
    : undefined;
  if (materialContext && materialContext.hash !== payload.materialContextHash)
    throw new Error("所选资料或证据已改变，请刷新资料快照再生成");
  return {
    skillId: payload.skillId,
    instruction: payload.instruction,
    context: materialMarkdown(card),
    selectedText: "",
    target: undefined,
    retryOf: undefined,
    materialContext,
    materialTarget: {
      bookId: payload.bookId,
      id: card.id,
      revision: card.revision,
      diskHash: card.diskHash,
      input: validateMaterialInput(card),
    },
  };
}

if (
  claimDesktopSingleInstance(app, () => {
    window?.show();
    window?.focus();
  })
) {
  app
    .whenReady()
    .then(async () => {
      await store.initialize();
      await harness.initialize();
      await acceptance.recoverAll();
      await materialAcceptance.recoverAll();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "文件",
            submenu: [{ label: "退出", click: () => window?.close() }],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo", label: "撤销" },
              { role: "redo", label: "重做" },
              { type: "separator" },
              { role: "cut", label: "剪切" },
              { role: "copy", label: "复制" },
              { role: "paste", label: "粘贴" },
              { role: "selectAll", label: "全选" },
            ],
          },
        ]),
      );
      ipcMain.handle(
        "novel:request",
        async (event, action: string, payload: Record<string, any> = {}) => {
          if (
            !window ||
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== pathToFileURL(entry).href
          )
            throw new Error("拒绝未授权窗口");
          try {
            let value: unknown;
            switch (action) {
              case "library.list":
                value = await store.listBooks();
                break;
              case "book.create":
                value = await store.createBook(payload.title);
                break;
              case "chapter.create":
                value = await store.createChapter(
                  payload.bookId,
                  payload.title,
                  payload.volumeId,
                );
                break;
              case "chapter.read":
                value = await store.readChapter(
                  payload.bookId,
                  payload.chapterId,
                );
                break;
              case "chapter.save":
                value = await store.saveChapter(payload);
                break;
              case "chapter.history":
                value = await store.history(payload.bookId, payload.chapterId);
                break;
              case "chapter.archive-conflict":
                value = await store.archiveConflict(payload);
                break;
              case "book.structure":
                value = await store.updateStructure(
                  payload.bookId,
                  payload.expectedRevision,
                  payload.mutation,
                );
                break;
              case "book.search":
                value = await store.search(payload.bookId, payload.query);
                break;
              case "annotations.read":
                value = await store.readAnnotations(
                  payload.bookId,
                  payload.chapterId,
                );
                break;
              case "materials.list":
                value = await store.materials.list(
                  payload.bookId,
                  payload.options,
                );
                break;
              case "planning.read":
                value = await store.planning.read(payload.bookId);
                break;
              case "planning.move":
                value = await store.planning.move(payload.bookId, payload.mutation, payload.expected);
                break;
              case "materials.context":
                value = await store.materials.contextPack(
                  payload.bookId,
                  payload.materialIds,
                );
                break;
              case "materials.read":
                value = await store.materials.read(payload.bookId, payload.id);
                break;
              case "materials.save":
                value = await store.materials.save(
                  payload.bookId,
                  payload.input,
                  payload.expected,
                );
                break;
              case "materials.delete":
                value = await store.materials.setDeleted(
                  payload.bookId,
                  payload.expected,
                  payload.deleted,
                );
                break;
              case "materials.history":
                value = await store.materials.history(
                  payload.bookId,
                  payload.id,
                );
                break;
              case "materials.evidence":
                value = await store.materials.mutateEvidence(
                  payload.bookId,
                  payload.expected,
                  payload.mutation,
                );
                break;
              case "materials.export": {
                const material = await store.materials.read(
                  payload.bookId,
                  payload.id,
                );
                const selected = await dialog.showSaveDialog(window, {
                  title: "导出已保存创作资料",
                  defaultPath: "创作资料.md",
                  filters: [{ name: "Markdown", extensions: ["md"] }],
                });
                if (selected.canceled || !selected.filePath)
                  value = { cancelled: true };
                else {
                  const { materialMarkdown } = await import(
                    "../../packages/novel-domain/materials.mjs"
                  );
                  await writeFile(
                    selected.filePath,
                    materialMarkdown(material),
                    "utf8",
                  );
                  value = { cancelled: false };
                }
                break;
              }
              case "annotations.mutate":
                value = await store.mutateAnnotations(
                  payload.bookId,
                  payload.chapterId,
                  payload.expectedRevision,
                  payload.expectedMetadataHash,
                  payload.expectedBodyHash,
                  payload.mutation,
                );
                break;
              case "book.backup": {
                const selected = await dialog.showOpenDialog(window, {
                  title: "选择独立备份目录",
                  properties: ["openDirectory", "createDirectory"],
                });
                value = selected.canceled
                  ? { cancelled: true }
                  : await store.createBackup(
                      payload.bookId,
                      selected.filePaths[0],
                    );
                break;
              }
              case "library.restore": {
                const selected = await dialog.showOpenDialog(window, {
                  title: "选择 ZiNovel 备份目录（恢复成新作品）",
                  properties: ["openDirectory"],
                });
                value = selected.canceled
                  ? { cancelled: true }
                  : { book: await store.restoreBackup(selected.filePaths[0]) };
                break;
              }
              case "import.choose": {
                const selected = await dialog.showOpenDialog(window, {
                  title: "选择小说稿件",
                  properties: payload.directory
                    ? ["openDirectory"]
                    : ["openFile", "multiSelections"],
                  filters: [{ name: "小说正文", extensions: ["md", "txt"] }],
                });
                if (selected.canceled) {
                  value = { cancelled: true };
                  break;
                }
                const id = randomUUID();
                // Keep paths for a decoding retry even if the first UTF-8 preview fails.
                imports.set(id, { paths: selected.filePaths, preview: null! });
                if (imports.size > 5)
                  imports.delete(imports.keys().next().value!);
                try {
                  const preview = await previewImport(selected.filePaths);
                  imports.set(id, { paths: selected.filePaths, preview });
                  value = { id, preview };
                } catch {
                  value = {
                    id,
                    error:
                      "初次 UTF-8 解码失败或内容不符合导入条件，请更换编码重试。",
                  };
                }
                break;
              }
              case "import.preview": {
                const intake = imports.get(payload.id);
                if (!intake) throw new Error("导入预览已失效，请重新选择文件");
                intake.preview = null!;
                intake.preview = await previewImport(
                  intake.paths,
                  payload.encoding,
                  payload.split,
                );
                value = { id: payload.id, preview: intake.preview };
                break;
              }
              case "import.commit": {
                const intake = imports.get(payload.id);
                if (!intake?.preview) throw new Error("请先完成导入预览");
                value = await store.importBook(
                  payload.title,
                  intake.preview.chapters,
                );
                imports.delete(payload.id);
                break;
              }
              case "book.export": {
                const snapshot = await store.exportSnapshot(payload.bookId);
                const selected = await dialog.showSaveDialog(window, {
                  title: "导出全书 Markdown",
                  defaultPath: `${snapshot.book.title.replace(/[<>:"/\\|?*]/g, "_")}.md`,
                  filters: [{ name: "Markdown", extensions: ["md"] }],
                });
                if (!selected.canceled && selected.filePath)
                  await writeFile(
                    selected.filePath,
                    `# ${snapshot.book.title}\n\n` +
                      snapshot.chapters
                        .map(
                          (chapter) => `## ${chapter.title}\n\n${chapter.body}`,
                        )
                        .join("\n\n"),
                    "utf8",
                  );
                value = { cancelled: selected.canceled };
                break;
              }
              case "skills.list":
                value = await harness.skills();
                break;
              case "settings.get":
                value = await settings.public();
                break;
              case "settings.save":
                value = await settings.save(
                  payload as Parameters<ModelSettings["save"]>[0],
                );
                break;
              case "ai.generate": {
                const chapter = await store.readChapter(
                  payload.target?.bookId,
                  payload.target?.chapterId,
                );
                const target = bindWritingTarget(
                  payload.target,
                  payload.context,
                  payload.selectedText,
                  chapter,
                );
                const config = await settings.secret();
                const materialContext = payload.materialIds?.length
                  ? await store.materials.contextPack(
                      target.bookId,
                      payload.materialIds,
                    )
                  : undefined;
                if (
                  materialContext &&
                  materialContext.hash !== payload.materialContextHash
                )
                  throw new Error("所选资料或证据已改变，请刷新资料快照再生成");
                value = await harness.generate(
                  {
                    skillId: payload.skillId,
                    instruction: payload.instruction,
                    context: payload.context,
                    selectedText: payload.selectedText,
                    target,
                    retryOf: payload.retryOf,
                    materialContext,
                  },
                  config.settings,
                  config.apiKey,
                );
                break;
              }
              case "ai.materialGenerate": {
                const input = await materialTaskInput(payload);
                const config = await settings.secret();
                value = await harness.generate(
                  input,
                  config.settings,
                  config.apiKey,
                );
                break;
              }
              case "ai.materialEstimate":
                value = await harness.preview(
                  await materialTaskInput(payload),
                  await settings.public(),
                );
                break;
              case "ai.materialAccept":
                value = await materialAcceptance.accept(
                  payload.id,
                  payload.proposal,
                );
                break;
              case "ai.materialTasks":
                if (
                  typeof payload.materialId !== "string" ||
                  !/^[0-9a-f-]{36}$/.test(payload.materialId)
                )
                  throw new Error("资料任务范围无效");
                value = await journal.list(payload.bookId, 40, {
                  materialId: payload.materialId,
                  offset: payload.offset ?? 0,
                });
                break;
              case "ai.estimate": {
                const materialContext = payload.materialIds?.length
                  ? await store.materials.contextPack(
                      payload.bookId,
                      payload.materialIds,
                    )
                  : undefined;
                value = await harness.preview(
                  { ...payload, materialContext },
                  await settings.public(),
                );
                break;
              }
              case "ai.tasks": {
                const tasks = await harness.tasks(payload.bookId, {
                  unbound: payload.unbound === true,
                  offset: payload.offset ?? 0,
                });
                const { books } = await store.listBooks();
                value = tasks.map((task) => ({
                  ...task,
                  bookTitle: books.find((book) => book.id === task.bookId)
                    ?.title,
                }));
                break;
              }
              case "ai.task":
                value = await harness.task(payload.id);
                break;
              case "ai.saveReview":
                value = await journal.saveReviewDraft(
                  payload.id,
                  payload.text,
                  payload.expectedRevision,
                );
                break;
              case "ai.discard":
                await harness.review(payload.id, "discarded", {
                  reviewedAt: new Date().toISOString(),
                });
                value = { discarded: true };
                break;
              case "ai.accept": {
                value = await acceptance.accept(payload.id, payload.candidate);
                break;
              }
              case "ai.reconcile": {
                if ((await journal.read(payload.id)).record.kind === "material")
                  await materialAcceptance.reconcile(payload.id);
                else await acceptance.reconcile(payload.id);
                value = await harness.task(payload.id);
                break;
              }
              case "ai.cancel":
                await harness.cancel();
                value = { cancelled: true };
                break;
              case "chapter.export": {
                const chapter = await store.readChapter(
                  payload.bookId,
                  payload.chapterId,
                );
                const selected = await dialog.showSaveDialog(window, {
                  title: "导出章节",
                  defaultPath: `${chapter.title.replace(/[<>:"/\\|?*]/g, "_")}.md`,
                  filters: [{ name: "Markdown", extensions: ["md"] }],
                });
                if (!selected.canceled && selected.filePath)
                  await writeFile(
                    selected.filePath,
                    `# ${chapter.title}\n\n${chapter.body}`,
                    "utf8",
                  );
                value = { cancelled: selected.canceled };
                break;
              }
              case "app.close-ready":
                cancelCloseAttempt();
                await harness.cancel();
                await acceptance.whenIdle();
                await materialAcceptance.whenIdle();
                await store.whenIdle();
                closing = true;
                window.close();
                return { ok: true };
              case "app.close-cancelled":
                cancelCloseAttempt();
                value = { cancelled: true };
                break;
              default:
                throw new Error("不支持的操作");
            }
            return { ok: true, value };
          } catch (error) {
            return {
              ok: false,
              error:
                error instanceof Error ? error.message : "操作失败，原稿已保留",
            };
          }
        },
      );
      window = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 800,
        minHeight: 600,
        title: "ZiNovel Studio",
        backgroundColor: "#f7f9fa",
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (url !== pathToFileURL(entry).href) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      window.on("close", (event) => {
        if (closing) return;
        event.preventDefault();
        requestWindowClose();
      });
      window.webContents.on("render-process-gone", async (_event, details) => {
        cancelCloseAttempt();
        if (closing || recoveryDialog || !window || window.isDestroyed())
          return;
        recoveryDialog = true;
        try {
          await harness.cancel();
          await store.whenIdle();
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            title: "写作窗口需要恢复",
            message: "写作窗口已停止运行，作品文件已保留。",
            detail: `原因：${details.reason}。重新打开后可恢复已有编辑缓存；未写入缓存的最后输入可能丢失。`,
            buttons: ["重新打开", "退出"],
            defaultId: 0,
            cancelId: 0,
          });
          if (!window || window.isDestroyed()) return;
          if (result.response === 0) await window.loadFile(entry);
          else await closeAfterRecovery();
        } catch (error) {
          dialog.showErrorBox("写作窗口恢复失败", String(error));
        } finally {
          recoveryDialog = false;
        }
      });
      await window.loadFile(entry);
    })
    .catch((error) => {
      dialog.showErrorBox("ZiNovel Studio 启动失败", String(error));
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
