import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import { resolve, join, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { readAssetSource } from "../../packages/novel-storage/image-decoder.mjs";
import { assetId } from "../../packages/novel-domain/assets.mjs";
import { mapId } from "../../packages/novel-domain/maps.mjs";
import { PublicationCaptures } from "../../packages/novel-storage/publication-captures.mjs";
import { BackupSessions } from "../../packages/novel-storage/backup-sessions.mjs";
import { Diagnostics } from "../../packages/novel-storage/diagnostics.mjs";
import type { PublicationSnapshot } from "../../packages/novel-domain/publication.mjs";
import { exportPublication } from "../../packages/novel-storage/publication-export.mjs";
import { publicationPdfOptions } from "../../packages/novel-domain/publication-pdf-options.mjs";
import { publicationDocxOptions } from "../../packages/novel-domain/publication-docx-options.mjs";
import { renderPublicationPdf } from "./publication-pdf";
import { claimDesktopSingleInstance } from "./upstream/single-instance";
import { desktopNodeEnvironment } from "./upstream/node-environment";
import { NovelHarness } from "../../packages/novel-harness/runtime.mjs";
import { ModelSettings } from "./settings";
import { ImageJobService } from "../../packages/novel-harness/image-jobs.mjs";
import { ImportSessions } from "../../packages/novel-storage/import-session.mjs";
import { ProjectImportSessions } from "../../packages/novel-storage/project-import.mjs";
import { randomUUID } from "node:crypto";
import { bindWritingTarget } from "../../packages/novel-harness/target.mjs";
import { TaskJournal } from "../../packages/novel-harness/task-journal.mjs";
import { TaskAcceptance } from "../../packages/novel-harness/acceptance.mjs";
import { MaterialTaskAcceptance } from "../../packages/novel-harness/material-acceptance.mjs";
import { PilotTaskAcceptance } from "../../packages/novel-harness/pilot-acceptance.mjs";
import { ContinuityQueries } from "../../packages/novel-storage/continuity-queries.mjs";
import { SessionQueries } from "../../packages/novel-storage/session-queries.mjs";
import { bindPilotInput } from "../../packages/novel-harness/pilot-target.mjs";
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
const projectImports = new ProjectImportSessions(store);
const publicationCaptures = new PublicationCaptures(store.publication);
const backupSessions = new BackupSessions(store.backups);
const diagnostics = new Diagnostics({
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
});
const publicationExports = new Set<Promise<unknown>>();
// Map background/history writes may also decode outside the book queue.
const assetOperations = new Set<Promise<unknown>>();
let publicationClosing = false;
function publicationHash(hash: unknown): string {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("请重新打开发布副本预览后导出");
  return hash;
}
const settings = new ModelSettings(dataRoot);
const imageJobs = new ImageJobService(
  store.imageTasks,
  (capability: string, choice: unknown, options: { secret?: boolean }) => {
    if (capability !== "image") throw new Error("图像任务不能使用文字模型");
    return settings.image(choice, options);
  },
);
function assertImageCloseSafe() {
  if (imageJobs.status())
    throw new Error(
      "图像任务仍在运行或有结果尚未保存。请返回图像任务完成取消、本地补存或明确放弃后再退出；当前未释放候选原图。",
    );
}
const journal = new TaskJournal(join(dataRoot, "tasks"));
const acceptance = new TaskAcceptance(journal, store);
const materialAcceptance = new MaterialTaskAcceptance(journal, store.materials);
const pilotAcceptance = new PilotTaskAcceptance(journal, store.pilots);
const continuityQueries = new ContinuityQueries(store.continuity);
const contextQueries = new SessionQueries({
  query: (bookId: string, options: object, signal: AbortSignal) =>
    store.context.choices(bookId, options, signal),
});
const legacyQueries = new ContinuityQueries({
  query: (bookId: string, options: object, signal: AbortSignal) =>
    store.knowledge.legacy.list(bookId, options, signal),
});
const knowledgeQueries = new ContinuityQueries({
  query: (bookId: string, options: object, signal: AbortSignal) =>
    store.knowledge.matrix(bookId, options, signal),
});
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
  assertImageCloseSafe();
  publicationClosing = true;
  continuityQueries.cancelAll();
  knowledgeQueries.cancelAll();
  legacyQueries.cancelAll();
  contextQueries.cancelAll();
  cancelCloseAttempt();
  await harness.cancel();
  await acceptance.whenIdle();
  await materialAcceptance.whenIdle();
  await pilotAcceptance.whenIdle();
  await publicationCaptures.stop();
  await backupSessions.stop();
  await Promise.allSettled([...publicationExports]);
  await Promise.allSettled([...assetOperations]);
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
const imports = new ImportSessions({
  createBook: (title: string, chapters: any[], metadata: any) =>
    store.importBook(title, chapters, metadata),
  applicationVersion: app.getVersion(),
});

async function materialTaskInput(payload: any) {
  const card = await store.materials.read(payload.bookId, payload.expected?.id);
  if (
    card.deletedAt ||
    card.diskHash !== payload.expected?.diskHash ||
    card.revision !== payload.expected?.revision
  )
    throw new Error("资料已改变或尚未保存，请重新读取后生成");
  const materialContext = payload.materialIds?.length
    ? await store.context.pack(payload.bookId, payload.materialIds)
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
async function pilotTaskInput(payload: any) {
  const input = await bindPilotInput(store.pilots, payload);
  const materialContext = payload.materialIds?.length
    ? await store.context.pack(payload.bookId, payload.materialIds)
    : undefined;
  if (materialContext && materialContext.hash !== payload.materialContextHash)
    throw new Error("所选资料或认知已改变，请刷新资料快照再生成");
  return { ...input, materialContext };
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
      await pilotAcceptance.recoverAll();
      diagnostics.record("app.ready");
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
          const operationStarted = performance.now();
          try {
            let value: unknown;
            switch (action) {
              case "image.settings":
              case "image.status":
              case "image.list":
              case "image.read":
              case "image.prepare":
              case "image.start":
              case "image.cancel":
              case "image.retry-save":
              case "image.discard-retained":
              case "image.reconcile":
              case "image.preview":
              case "image.reference-preview":
              case "image.adopt":
              case "image.compare-target":
              case "image.adopt-reviewed":
              case "image.discard": {
                const fields: Record<string, string[]> = {
                  "image.settings": [],
                  "image.status": [],
                  "image.list": ["bookId", "offset"],
                  "image.read": ["bookId", "id"],
                  "image.prepare": ["bookId", "input"],
                  "image.start": ["bookId", "expected", "choice"],
                  "image.cancel": ["bookId", "id"],
                  "image.retry-save": ["bookId", "id"],
                  "image.discard-retained": [
                    "bookId",
                    "expected",
                    "confirmation",
                  ],
                  "image.reconcile": ["bookId", "expected"],
                  "image.preview": ["bookId", "id", "index"],
                  "image.reference-preview": ["bookId", "id"],
                  "image.adopt": ["bookId", "expected", "index", "input"],
                  "image.compare-target": ["bookId", "expected", "index"],
                  "image.adopt-reviewed": [
                    "bookId",
                    "expected",
                    "index",
                    "input",
                    "review",
                  ],
                  "image.discard": ["bookId", "expected"],
                };
                if (
                  Object.keys(payload).some(
                    (key) => !fields[action].includes(key),
                  )
                )
                  throw new Error("图像操作不接受额外字段或外部路径");
                if (
                  publicationClosing &&
                  ![
                    "image.settings",
                    "image.status",
                    "image.list",
                    "image.read",
                    "image.cancel",
                  ].includes(action)
                )
                  throw new Error("程序正在关闭，未开始新的图像操作");
                if (action === "image.settings")
                  value = await settings.imagePublic();
                else if (action === "image.status") value = imageJobs.status();
                else if (action === "image.list")
                  value = await store.imageTasks.list(
                    payload.bookId,
                    payload.offset ?? 0,
                  );
                else if (action === "image.read")
                  value = await store.imageTasks.read(
                    payload.bookId,
                    payload.id,
                  );
                else if (action === "image.reference-preview")
                  value = await store.imageTasks.referencePreview(
                    payload.bookId,
                    payload.id,
                  );
                else if (action === "image.prepare")
                  value = await imageJobs.prepare(
                    payload.bookId,
                    payload.input,
                  );
                else if (action === "image.start")
                  value = await imageJobs.start(
                    payload.bookId,
                    payload.expected,
                    payload.choice,
                  );
                else if (action === "image.cancel")
                  value = imageJobs.cancel(payload.bookId, payload.id);
                else if (action === "image.retry-save")
                  value = await imageJobs.retryLocalSave(
                    payload.bookId,
                    payload.id,
                  );
                else if (action === "image.discard-retained")
                  value = await imageJobs.discardRetained(
                    payload.bookId,
                    payload.expected,
                    payload.confirmation,
                  );
                else if (action === "image.discard") {
                  const job = imageJobs.status();
                  if (
                    job?.bookId === payload.bookId &&
                    job?.id === payload.expected?.id
                  )
                    throw new Error(
                      "当前进程仍保留该任务，请先取消等待或明确处理待补存候选",
                    );
                  value = await store.imageTasks.discard(
                    payload.bookId,
                    payload.expected,
                  );
                } else {
                  const operation =
                    action === "image.compare-target"
                      ? store.imageTasks.compareTarget(
                          payload.bookId,
                          payload.expected,
                          payload.index,
                        )
                      : action === "image.adopt-reviewed"
                        ? store.imageTasks.adoptReviewed(
                            payload.bookId,
                            payload.expected,
                            payload.index,
                            payload.input,
                            payload.review,
                          )
                        : action === "image.adopt"
                          ? store.imageTasks.adopt(
                              payload.bookId,
                              payload.expected,
                              payload.index,
                              payload.input,
                            )
                          : action === "image.reconcile"
                            ? store.imageTasks.reconcileReceived(
                                payload.bookId,
                                payload.expected,
                              )
                            : store.imageTasks
                                .preview(
                                  payload.bookId,
                                  payload.id,
                                  payload.index,
                                )
                                .then((result: any) => ({
                                  blob: result.blob,
                                  diskHash: result.diskHash,
                                  thumbnail: `data:image/png;base64,${Buffer.from(result.thumbnail).toString("base64")}`,
                                }));
                  assetOperations.add(operation);
                  try {
                    value = await operation;
                  } finally {
                    assetOperations.delete(operation);
                  }
                }
                break;
              }
              case "profiles.list":
                if (Object.keys(payload).length)
                  throw new Error("模型列表读取不接受自定义路径");
                value = await settings.profileList();
                break;
              case "profiles.migrate":
                if (
                  Object.keys(payload).some(
                    (key) => !["legacyToken", "restoreMissing"].includes(key),
                  ) ||
                  typeof payload.legacyToken !== "string" ||
                  (payload.restoreMissing !== undefined &&
                    typeof payload.restoreMissing !== "boolean")
                )
                  throw new Error("请明确确认已读取的迁移或恢复配置");
                value = await settings.migrateProfiles(
                  payload as Parameters<ModelSettings["migrateProfiles"]>[0],
                );
                break;
              case "profiles.add":
              case "profiles.update":
              case "profiles.select":
              case "profiles.remove": {
                const keys =
                  action === "profiles.add"
                    ? ["input", "expected"]
                    : action === "profiles.update"
                      ? ["id", "input", "expected"]
                      : action === "profiles.select"
                        ? ["capability", "id", "expected"]
                        : ["id", "expected"];
                if (Object.keys(payload).some((key) => !keys.includes(key)))
                  throw new Error("模型配置操作不接受额外字段");
                value = await settings.mutateProfiles(action, payload);
                break;
              }
              case "diagnostics.get":
              case "diagnostics.clear":
              case "diagnostics.export": {
                if (Object.keys(payload).length)
                  throw new Error("诊断操作不接受路径或自定义内容");
                if (action === "diagnostics.clear") diagnostics.clear();
                if (action === "diagnostics.export") {
                  if (publicationClosing)
                    throw new Error("程序正在关闭，未导出诊断");
                  const selected = await dialog.showSaveDialog(window, {
                    title: "导出诊断为新文件",
                    defaultPath: `ZiNovel-diagnostics-${Date.now()}.json`,
                    filters: [{ name: "JSON", extensions: ["json"] }],
                  });
                  if (publicationClosing)
                    throw new Error("程序正在关闭，未写入诊断文件");
                  value =
                    selected.canceled || !selected.filePath
                      ? { cancelled: true }
                      : await diagnostics.exportNewFile(
                          dataRoot,
                          selected.filePath,
                        );
                } else value = diagnostics.snapshot();
                break;
              }
              case "backup.choose":
              case "backup.open": {
                if (publicationClosing)
                  throw new Error("程序正在关闭，未选择备份目录");
                if (Object.keys(payload).some((key) => key !== "bookId"))
                  throw new Error("备份目录只能通过原生选择器授权");
                if (
                  !(await store.listBooks()).books.some(
                    (book: { id: string }) => book.id === payload.bookId,
                  )
                )
                  throw new Error("作品不可读或已移除，未选择备份目录");
                const selected = await dialog.showOpenDialog(window, {
                  title:
                    action === "backup.choose"
                      ? "选择书库外的增量备份位置"
                      : "打开增量备份库文件夹",
                  properties:
                    action === "backup.choose"
                      ? ["openDirectory", "createDirectory"]
                      : ["openDirectory"],
                });
                if (publicationClosing)
                  throw new Error("程序正在关闭，未开始备份操作");
                value = selected.canceled
                  ? { cancelled: true }
                  : action === "backup.choose"
                    ? backupSessions.startNew(
                        event.sender.id,
                        payload.bookId,
                        selected.filePaths[0],
                      )
                    : await backupSessions.open(
                        event.sender.id,
                        payload.bookId,
                        selected.filePaths[0],
                      );
                break;
              }
              case "backup.append":
                value = backupSessions.startSelected(
                  event.sender.id,
                  payload.bookId,
                  payload.token,
                );
                break;
              case "backup.refresh":
                value = await backupSessions.refresh(
                  event.sender.id,
                  payload.bookId,
                  payload.token,
                );
                break;
              case "backup.page":
                value = backupSessions.page(
                  event.sender.id,
                  payload.bookId,
                  payload.token,
                  payload.page,
                );
                break;
              case "backup.status":
                value = backupSessions.status(
                  event.sender.id,
                  payload.bookId,
                  payload.id,
                );
                break;
              case "backup.cancel":
                value = backupSessions.cancel(
                  event.sender.id,
                  payload.bookId,
                  payload.id,
                );
                break;
              case "backup.result":
                value = await backupSessions.completed(
                  event.sender.id,
                  payload.bookId,
                  payload.id,
                );
                break;
              case "backup.restore":
                value = {
                  book: await backupSessions.restore(
                    event.sender.id,
                    payload.bookId,
                    payload.token,
                    payload.id,
                    payload.hash,
                  ),
                };
                break;
              case "library.list":
                value = await store.listBooks();
                break;
              case "book.create":
                value = await store.createBook(payload.title, true);
                break;
              case "project.list":
                value = await store.project.list(payload.bookId);
                break;
              case "project.initialize":
                value = await store.project.initialize(payload.bookId);
                break;
              case "project.read":
                value = await store.project.read(payload.bookId, payload.id);
                break;
              case "project.create":
                value = await store.project.create(
                  payload.bookId,
                  payload.input,
                );
                break;
              case "project.save":
                value = await store.project.save(payload.bookId, payload.input);
                break;
              case "project.history":
                value = await store.project.history(
                  payload.bookId,
                  payload.id,
                  payload.revision,
                );
                break;
              case "project.import-preview": {
                const choice = await dialog.showOpenDialog(window!, {
                  title:
                    payload.kind === "site"
                      ? "选择小说站单本小说索引 Markdown"
                      : "选择单本小说创作工程目录",
                  properties: [
                    payload.kind === "site" ? "openFile" : "openDirectory",
                  ],
                  ...(payload.kind === "site"
                    ? { filters: [{ name: "小说索引", extensions: ["md"] }] }
                    : {}),
                });
                value = choice.canceled
                  ? null
                  : await projectImports.preview(choice.filePaths[0]);
                break;
              }
              case "project.import-confirm":
                value = await projectImports.confirm(
                  payload.token,
                  payload.fingerprint,
                );
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
              case "reader.catalog":
                value = await store.reader.catalog(
                  payload.bookId,
                  payload.options,
                );
                break;
              case "reader.chapter":
                value = await store.reader.chapter(
                  payload.bookId,
                  payload.chapterId,
                  payload.catalogHash,
                  payload.options,
                );
                break;
              case "annotations.read":
                value = await store.readAnnotations(
                  payload.bookId,
                  payload.chapterId,
                );
                break;
              case "continuity.query":
                value = await continuityQueries.query(
                  payload.bookId,
                  payload.options,
                  {
                    sessionId: payload.sessionId,
                    requestId: payload.requestId,
                  },
                );
                break;
              case "continuity.cancel":
                value = { cancelled: continuityQueries.cancel(payload) };
                break;
              case "materials.list":
                value = await store.materials.list(
                  payload.bookId,
                  payload.options,
                );
                break;
              case "knowledge.matrix":
                value = await knowledgeQueries.query(
                  payload.bookId,
                  payload.options,
                  payload,
                );
                break;
              case "knowledge.cancel":
                value = { cancelled: knowledgeQueries.cancel(payload) };
                break;
              case "knowledge.list":
                value = await store.knowledge.list(
                  payload.bookId,
                  payload.options,
                );
                break;
              case "knowledge.read":
                value = await store.knowledge.read(payload.bookId, payload.id);
                break;
              case "knowledge.save":
                value = await store.knowledge.save(
                  payload.bookId,
                  payload.input,
                  payload.expected,
                  payload.source,
                  undefined,
                  payload.creationId,
                );
                break;
              case "knowledge.creation":
                value = await store.knowledge.creation(
                  payload.bookId,
                  payload.creationId,
                );
                break;
              case "knowledge.retire":
                value = await store.knowledge.setRetired(
                  payload.bookId,
                  payload.expected,
                  payload.retired,
                );
                break;
              case "knowledge.history":
                value = await store.knowledge.history(
                  payload.bookId,
                  payload.id,
                  payload.offset || 0,
                );
                break;
              case "knowledge.choice":
                value = await store.knowledge.choices.read(
                  payload.bookId,
                  payload.target,
                );
                break;
              case "knowledge.legacy-list":
                value = await legacyQueries.query(
                  payload.bookId,
                  payload.options,
                  payload,
                );
                break;
              case "knowledge.legacy-cancel":
                value = { cancelled: legacyQueries.cancel(payload) };
                break;
              case "knowledge.legacy-preview":
                value = await store.knowledge.legacy.preview(
                  payload.bookId,
                  payload.ownerId,
                  payload.eventId,
                );
                break;
              case "knowledge.link-legacy":
                value = await store.knowledge.linkLegacy(
                  payload.bookId,
                  payload.input,
                  payload.legacyExpected,
                  payload.source,
                  payload.creationId,
                );
                break;
              case "knowledge.choose":
                value = await store.knowledge.choices.select(
                  payload.bookId,
                  payload.eventExpected,
                  payload.choiceExpected,
                  payload.reason || "",
                );
                break;
              case "knowledge.clear-choice":
                value = await store.knowledge.choices.clear(
                  payload.bookId,
                  payload.target,
                  payload.expected,
                );
                break;
              case "knowledge.choice-history":
                value = await store.knowledge.choices.history(
                  payload.bookId,
                  payload.target,
                  payload.offset || 0,
                );
                break;
              case "planning.read":
                value = await store.planning.read(payload.bookId);
                break;
              case "pilots.groups":
                value = await store.pilots.listGroups(payload.bookId);
                break;
              case "pilots.createGroup":
                value = await store.pilots.createGroup(
                  payload.bookId,
                  payload.input,
                );
                break;
              case "pilots.group":
                value = await store.pilots.readGroup(
                  payload.bookId,
                  payload.groupId,
                );
                break;
              case "pilots.list":
                value = await store.pilots.list(
                  payload.bookId,
                  payload.groupId,
                );
                break;
              case "pilots.read":
                value = await store.pilots.read(payload.bookId, payload.id);
                break;
              case "pilots.save":
                value = await store.pilots.save(
                  payload.bookId,
                  payload.groupId,
                  payload.input,
                  payload.expected,
                  payload.parent,
                );
                break;
              case "pilots.delete":
                value = await store.pilots.setDeleted(
                  payload.bookId,
                  payload.expected,
                  payload.deleted,
                );
                break;
              case "pilots.choose":
                value = await store.pilots.choose(
                  payload.bookId,
                  payload.expectedGroup,
                  payload.expected,
                  payload.reason,
                );
                break;
              case "pilots.feedback":
                value = await store.pilots.addFeedback(
                  payload.bookId,
                  payload.expected,
                  payload.input,
                );
                break;
              case "pilots.versions":
                value = await store.pilots.versions(
                  payload.bookId,
                  payload.id,
                  payload.feedback === true,
                );
                break;
              case "pilots.promote":
                value = await store.pilots.promote(
                  payload.bookId,
                  payload.expected,
                  payload.title,
                );
                break;
              case "planning.move":
                value = await store.planning.move(
                  payload.bookId,
                  payload.mutation,
                  payload.expected,
                );
                break;
              case "materials.context":
                value = await store.context.pack(
                  payload.bookId,
                  payload.materialIds,
                );
                break;
              case "context.choices":
                value = await contextQueries.query(
                  payload.bookId,
                  payload.options,
                  payload,
                );
                break;
              case "context.cancel":
                value = { cancelled: contextQueries.cancel(payload) };
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
                value = await imports.choose(selected.filePaths);
                break;
              }
              case "import.preview": {
                value = await imports.preview(
                  payload.id,
                  payload.encoding,
                  payload.split,
                );
                break;
              }
              case "import.review":
                value = imports.edit(
                  payload.id,
                  payload.revision,
                  payload.operation,
                );
                break;
              case "book.import-origin":
                value = await store.importOrigins.read(payload.bookId);
                break;
              case "import.commit": {
                value = await imports.commit(
                  payload.id,
                  payload.revision,
                  payload.title,
                );
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
              case "maps.list":
                value = await store.maps.list(payload.bookId, payload.options);
                break;
              case "atlas.read":
                value = await store.atlas.read(payload.bookId);
                break;
              case "atlas.inspect":
                value = await store.atlas.inspect(
                  payload.bookId,
                  payload.options,
                );
                break;
              case "atlas.history":
                value = await store.atlas.history(payload.bookId);
                break;
              case "atlas.save":
                if (publicationClosing)
                  throw new Error("程序正在关闭，地图册未提交");
                value = await store.atlas.save(
                  payload.bookId,
                  payload.input,
                  payload.expected,
                );
                break;
              case "atlas.restore-version":
                if (publicationClosing)
                  throw new Error("程序正在关闭，地图册未提交");
                value = await store.atlas.restoreVersion(
                  payload.bookId,
                  payload.expected,
                  payload.historical,
                );
                break;
              case "maps.read":
                value = await store.maps.read(payload.bookId, payload.id);
                break;
              case "maps.creation":
                value = await store.maps.creation(payload.bookId, payload.id);
                break;
              case "maps.create":
                if (publicationClosing)
                  throw new Error("程序正在关闭，未创建新的地图");
                value = await store.maps.create(
                  payload.bookId,
                  payload.input,
                  mapId(payload.creationId),
                );
                break;
              case "maps.save":
                if (publicationClosing)
                  throw new Error("程序正在关闭，未保存新的地图调整");
                value = await store.maps.save(
                  payload.bookId,
                  payload.input,
                  payload.expected,
                );
                break;
              case "maps.delete":
                if (publicationClosing)
                  throw new Error("程序正在关闭，未改变地图状态");
                value = await store.maps.setDeleted(
                  payload.bookId,
                  payload.expected,
                  payload.deleted,
                );
                break;
              case "maps.history":
                value = await store.maps.history(payload.bookId, payload.id);
                break;
              case "maps.preview":
                value = await store.maps.backgroundPreview(
                  payload.bookId,
                  payload.expected,
                  payload.historical ?? false,
                );
                break;
              case "maps.clear-background":
                if (publicationClosing)
                  throw new Error("程序正在关闭，未更改地图底图");
                value = await store.maps.setBackground(
                  payload.bookId,
                  payload.expected,
                  null,
                );
                break;
              case "maps.set-background":
              case "maps.restore-version": {
                if (publicationClosing)
                  throw new Error("程序正在关闭，未更改地图");
                if (assetOperations.size >= 2)
                  throw new Error("请等待当前图像操作完成");
                const operation =
                  action === "maps.set-background"
                    ? store.maps.setBackground(
                        payload.bookId,
                        payload.expected,
                        payload.asset,
                        payload.historical ?? false,
                      )
                    : store.maps.restoreVersion(
                        payload.bookId,
                        payload.expected,
                        payload.historical,
                      );
                assetOperations.add(operation);
                try {
                  value = await operation;
                } finally {
                  assetOperations.delete(operation);
                }
                break;
              }
              case "looks.read":
              case "looks.preview":
              case "looks.save":
              case "looks.choose":
              case "looks.delete": {
                const fields: Record<string, string[]> = {
                  "looks.read": ["bookId", "characterId"],
                  "looks.preview": [
                    "bookId",
                    "characterId",
                    "expected",
                    "entryId",
                    "selected",
                  ],
                  "looks.save": [
                    "bookId",
                    "character",
                    "expected",
                    "entryId",
                    "input",
                    "asset",
                  ],
                  "looks.choose": [
                    "bookId",
                    "character",
                    "expected",
                    "entryId",
                    "confirmation",
                  ],
                  "looks.delete": [
                    "bookId",
                    "characterId",
                    "expected",
                    "entryId",
                    "deleted",
                  ],
                };
                if (
                  !payload ||
                  typeof payload !== "object" ||
                  Array.isArray(payload) ||
                  Object.keys(payload).some(
                    (key) => !fields[action].includes(key),
                  )
                )
                  throw new Error("人物形象请求格式不支持");
                if (publicationClosing)
                  throw new Error("程序正在关闭，请稍后查看人物形象");
                if (assetOperations.size >= 4)
                  throw new Error("图像操作繁忙，请稍后重试");
                const operation =
                  action === "looks.read"
                    ? store.characterLooks.read(
                        payload.bookId,
                        payload.characterId,
                      )
                    : action === "looks.preview"
                      ? store.characterLooks.preview(
                          payload.bookId,
                          payload.characterId,
                          payload.expected,
                          payload.entryId,
                          payload.selected ?? false,
                        )
                      : action === "looks.save"
                        ? store.characterLooks.save(
                            payload.bookId,
                            payload.character,
                            payload.expected,
                            payload.entryId,
                            payload.input,
                            payload.asset ?? null,
                          )
                        : action === "looks.choose"
                          ? store.characterLooks.choose(
                              payload.bookId,
                              payload.character,
                              payload.expected,
                              payload.entryId,
                              payload.confirmation,
                            )
                          : store.characterLooks.setDeleted(
                              payload.bookId,
                              payload.characterId,
                              payload.expected,
                              payload.entryId,
                              payload.deleted,
                            );
                assetOperations.add(operation);
                try {
                  value = await operation;
                } finally {
                  assetOperations.delete(operation);
                }
                break;
              }
              case "assets.list":
                value = await store.assets.list(
                  payload.bookId,
                  payload.options,
                );
                break;
              case "assets.read":
                value = await store.assets.read(payload.bookId, payload.id);
                break;
              case "assets.link-options":
                value = await store.assets.linkOptions(
                  payload.bookId,
                  payload.ids,
                );
                break;
              case "assets.creation":
                value = await store.assets.creation(payload.bookId, payload.id);
                break;
              case "assets.preview":
                value = await store.assets.preview(
                  payload.bookId,
                  payload.expected,
                  payload.historical ?? false,
                );
                break;
              case "assets.save":
                if (publicationClosing)
                  throw new Error("程序正在关闭，未保存新的图像说明");
                value = await store.assets.save(
                  payload.bookId,
                  payload.input,
                  payload.expected,
                );
                break;
              case "assets.delete":
                if (publicationClosing)
                  throw new Error("程序正在关闭，未改变图像状态");
                value = await store.assets.setDeleted(
                  payload.bookId,
                  payload.expected,
                  payload.deleted,
                );
                break;
              case "assets.restore-version": {
                if (publicationClosing)
                  throw new Error("程序正在关闭，未采用历史图像");
                const operation = store.assets.restoreVersion(
                  payload.bookId,
                  payload.expected,
                  payload.historical,
                );
                assetOperations.add(operation);
                try {
                  value = await operation;
                } finally {
                  assetOperations.delete(operation);
                }
                break;
              }
              case "assets.history":
                value = await store.assets.history(payload.bookId, payload.id);
                break;
              case "assets.import":
              case "assets.replace": {
                if (publicationClosing)
                  throw new Error("程序正在关闭，未开始图像操作");
                if (assetOperations.size >= 2)
                  throw new Error("请等待当前图像操作完成");
                const parentWindow = window,
                  actionName = action;
                const operation = (async () => {
                  if (actionName === "assets.import") {
                    assetId(payload.creationId);
                    const existing = await store.assets.creation(
                      payload.bookId,
                      payload.creationId,
                    );
                    if (existing)
                      return {
                        cancelled: false,
                        record: existing,
                        recovered: true,
                      };
                  } else {
                    const expected = store.assets.expected(payload.expected),
                      existing = await store.assets.read(
                        payload.bookId,
                        expected.id,
                      );
                    if (
                      existing.diskHash !== expected.diskHash ||
                      existing.revision !== expected.revision ||
                      existing.deletedAt
                    )
                      throw new Error("图像版本已经改变，请重新读取后替换");
                  }
                  if (publicationClosing)
                    throw new Error("程序正在关闭，未开始图像操作");
                  const selected = await dialog.showOpenDialog(parentWindow, {
                    title:
                      actionName === "assets.import"
                        ? "导入小说图像（保留原图）"
                        : "替换图像（保留历史版本）",
                    defaultPath:
                      process.env.ZINOVEL_DATA_ROOT || app.getPath("pictures"),
                    properties: ["openFile"],
                    filters: [
                      {
                        name: "PNG / JPEG / WebP 静态图像",
                        extensions: ["png", "jpg", "jpeg", "webp"],
                      },
                    ],
                  });
                  if (selected.canceled) return { cancelled: true };
                  if (selected.filePaths.length !== 1)
                    throw new Error("请选择一张本地图像");
                  const bytes = await readAssetSource(selected.filePaths[0]);
                  if (publicationClosing)
                    throw new Error("程序正在关闭，图像未提交");
                  if (actionName === "assets.replace")
                    return {
                      cancelled: false,
                      record: await store.assets.replace(
                        payload.bookId,
                        bytes,
                        payload.expected,
                      ),
                    };
                  const title =
                    basename(
                      selected.filePaths[0],
                      extname(selected.filePaths[0]),
                    )
                      .slice(0, 180)
                      .replace(/[\uD800-\uDBFF]$/, "") || "新图像";
                  return {
                    cancelled: false,
                    record: await store.assets.import(
                      payload.bookId,
                      bytes,
                      {
                        title,
                        purpose: "reference",
                        source: "",
                        rights: "",
                        notes: "",
                        linkedIds: [],
                      },
                      payload.creationId,
                    ),
                  };
                })();
                assetOperations.add(operation);
                try {
                  value = await operation;
                } finally {
                  assetOperations.delete(operation);
                }
                break;
              }
              case "publication.catalog":
                value = await store.publication.catalog(payload.bookId);
                break;
              case "publication.list":
                value = await store.publication.list(payload.bookId);
                break;
              case "publication.capture":
                value = publicationCaptures.start(
                  event.sender.id,
                  payload.bookId,
                  payload.input,
                );
                break;
              case "publication.capture-status":
                value = publicationCaptures.status(
                  event.sender.id,
                  payload.bookId,
                  payload.id,
                );
                break;
              case "publication.cancel":
                value = publicationCaptures.cancel(
                  event.sender.id,
                  payload.bookId,
                  payload.id,
                );
                break;
              case "publication.preview": {
                const snapshot: PublicationSnapshot =
                  await store.publication.read(
                    payload.bookId,
                    payload.id,
                    publicationHash(payload.hash),
                  );
                value = {
                  ...snapshot,
                  content: {
                    ...snapshot.content,
                    chapters: snapshot.content.chapters.map(
                      ({ body, ...chapter }) => chapter,
                    ),
                  },
                };
                break;
              }
              case "publication.image": {
                const snapshot = await store.publication.read(
                  payload.bookId,
                  payload.id,
                  publicationHash(payload.hash),
                );
                value = await store.publicationResources.preview(
                  payload.bookId,
                  snapshot,
                  payload.index,
                );
                break;
              }
              case "publication.chapter": {
                const snapshot: PublicationSnapshot =
                  await store.publication.read(
                    payload.bookId,
                    payload.id,
                    publicationHash(payload.hash),
                  );
                const chapter = snapshot.content.chapters.find(
                  (item) => item.id === payload.chapterId,
                );
                if (!chapter) throw new Error("章节不属于本次发布副本");
                value = chapter;
                break;
              }
              case "publication.export": {
                if (publicationClosing)
                  throw new Error("程序正在关闭，未开始导出");
                const parentWindow = window;
                const exporting = (async () => {
                  const hash = publicationHash(payload.hash);
                  const initialSnapshot = await store.publication.read(
                    payload.bookId,
                    payload.id,
                    hash,
                  );
                  if (
                    !["txt", "md", "html", "pdf", "docx"].includes(
                      payload.format,
                    )
                  )
                    throw new Error("请选择支持的本地导出格式");
                  if (
                    initialSnapshot.content.resources?.length &&
                    !["html", "docx", "pdf"].includes(payload.format)
                  )
                    throw new Error(
                      "含图发布副本当前支持HTML、DOCX和PDF导出，其他格式尚未接入，不会丢弃图片",
                    );
                  const pdfOptions =
                    payload.format === "pdf"
                      ? publicationPdfOptions(payload.pdfOptions)
                      : undefined;
                  const docxOptions =
                    payload.format === "docx"
                      ? publicationDocxOptions(payload.docxOptions)
                      : undefined;
                  if (publicationClosing)
                    throw new Error("程序正在关闭，未开始导出");
                  const selected = await dialog.showOpenDialog(parentWindow, {
                    title: "选择发布副本的导出位置（创建新目录）",
                    defaultPath:
                      process.env.ZINOVEL_DATA_ROOT || app.getPath("documents"),
                    properties: ["openDirectory", "createDirectory"],
                  });
                  if (selected.canceled) return { cancelled: true };
                  const snapshot = await store.publication.read(
                    payload.bookId,
                    payload.id,
                    hash,
                  );
                  if (publicationClosing)
                    throw new Error("程序正在关闭，未开始导出");
                  return {
                    cancelled: false,
                    ...(await exportPublication(
                      snapshot,
                      selected.filePaths[0],
                      payload.format,
                      undefined,
                      payload.format === "pdf"
                        ? {
                            options: pdfOptions,
                            engine: {
                              electron: process.versions.electron,
                              chromium: process.versions.chrome,
                            },
                            render: (
                              document: Parameters<
                                typeof renderPublicationPdf
                              >[0],
                              images: Map<string, Uint8Array>,
                            ) =>
                              renderPublicationPdf(
                                document,
                                join(dataRoot, "publication-render"),
                                images,
                              ),
                          }
                        : payload.format === "docx"
                          ? { options: docxOptions }
                          : undefined,
                      ["html", "docx", "pdf"].includes(payload.format)
                        ? await store.publicationResources.images(
                            payload.bookId,
                            snapshot,
                          )
                        : undefined,
                    )),
                  };
                })();
                publicationExports.add(exporting);
                try {
                  value = await exporting;
                } finally {
                  publicationExports.delete(exporting);
                }
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
                const config = await settings.secret(payload.modelChoice);
                const materialContext = payload.materialIds?.length
                  ? await store.context.pack(target.bookId, payload.materialIds)
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
                const config = await settings.secret(payload.modelChoice);
                value = await harness.generate(
                  input,
                  config.settings,
                  config.apiKey,
                );
                break;
              }
              case "ai.pilotSnapshot":
                value = await store.pilots.taskSnapshot(
                  payload.bookId,
                  payload.expected,
                );
                break;
              case "ai.pilotGenerate": {
                const input = await pilotTaskInput(payload),
                  config = await settings.secret(payload.modelChoice);
                value = await harness.generate(
                  input,
                  config.settings,
                  config.apiKey,
                );
                break;
              }
              case "ai.pilotEstimate":
                value = await harness.preview(
                  await pilotTaskInput(payload),
                  await settings.writingPublic(payload.modelChoice),
                );
                break;
              case "ai.pilotAccept":
                value = await pilotAcceptance.accept(
                  payload.id,
                  payload.candidate,
                );
                break;
              case "ai.pilotTasks":
                if (
                  typeof payload.pilotId !== "string" ||
                  !/^[0-9a-f-]{36}$/.test(payload.pilotId)
                )
                  throw new Error("试写任务范围无效");
                value = await journal.list(payload.bookId, 40, {
                  pilotId: payload.pilotId,
                  offset: payload.offset ?? 0,
                });
                break;
              case "ai.materialEstimate":
                value = await harness.preview(
                  await materialTaskInput(payload),
                  await settings.writingPublic(payload.modelChoice),
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
                  ? await store.context.pack(
                      payload.bookId,
                      payload.materialIds,
                    )
                  : undefined;
                value = await harness.preview(
                  { ...payload, materialContext },
                  await settings.writingPublic(payload.modelChoice),
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
                const kind = (await journal.read(payload.id)).record.kind;
                if (kind === "pilot")
                  await pilotAcceptance.reconcile(payload.id);
                else if (kind === "material")
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
                assertImageCloseSafe();
                publicationClosing = true;
                continuityQueries.cancelAll();
                knowledgeQueries.cancelAll();
                legacyQueries.cancelAll();
                contextQueries.cancelAll();
                cancelCloseAttempt();
                await harness.cancel();
                await acceptance.whenIdle();
                await materialAcceptance.whenIdle();
                await pilotAcceptance.whenIdle();
                await publicationCaptures.stop();
                await backupSessions.stop();
                await Promise.allSettled([...publicationExports]);
                await Promise.allSettled([...assetOperations]);
                await store.whenIdle();
                closing = true;
                window.close();
                return { ok: true };
              case "app.close-cancelled":
                publicationClosing = false;
                cancelCloseAttempt();
                value = { cancelled: true };
                break;
              default:
                throw new Error("不支持的操作");
            }
            diagnostics.record(action, {
              durationMs: performance.now() - operationStarted,
            });
            return { ok: true, value };
          } catch (error) {
            diagnostics.record(action, {
              success: false,
              durationMs: performance.now() - operationStarted,
              error,
            });
            if (action === "app.close-ready" && !closing)
              publicationClosing = false;
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
        diagnostics.record("renderer.gone", { success: false });
        cancelCloseAttempt();
        if (closing || recoveryDialog || !window || window.isDestroyed())
          return;
        recoveryDialog = true;
        publicationClosing = true;
        try {
          await harness.cancel();
          await publicationCaptures.cancelAll();
          await backupSessions.cancelAll();
          await Promise.allSettled([...publicationExports]);
          await Promise.allSettled([...assetOperations]);
          await store.whenIdle();
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            title: "写作窗口需要恢复",
            message: "写作窗口已停止运行，作品文件已保留。",
            detail: imageJobs.status()
              ? "图像任务仍在处理或有候选等待补存，当前进程保留其结果。请重新打开窗口后处理，尚未允许释放候选原图。"
              : `原因：${details.reason}。重新打开后可恢复已有编辑缓存；未写入缓存的最后输入可能丢失。`,
            buttons: imageJobs.status() ? ["重新打开"] : ["重新打开", "退出"],
            defaultId: 0,
            cancelId: 0,
          });
          if (!window || window.isDestroyed()) return;
          if (result.response === 0) {
            publicationClosing = false;
            await window.loadFile(entry);
          } else await closeAfterRecovery();
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
