import { BrowserWindow, session } from "electron";
import { mkdir, mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PublicationPdfDocument } from "../../packages/novel-domain/publication-pdf.mjs";
import { publicationRasterImages } from "../../packages/novel-domain/publication-raster-images.mjs";

let rendering = false;
async function removeOwnFile(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/** Runs outside the manuscript queue, without preload, script execution or network. */
export async function renderPublicationPdf(
  document: PublicationPdfDocument,
  root: string,
  inputImages: Map<string, Uint8Array> = new Map(),
) {
  if (rendering) throw new Error("已有PDF正在排版，请等待完成");
  rendering = true;
  let folder: string | undefined, file: string | undefined;
  let imageDirectory: string | undefined;
  const imageFiles: string[] = [];
  const allowedImages = new Set<string>(),
    loadedImages = new Set<string>();
  let resolveImages: () => void = () => {};
  let rejectImages: (error: Error) => void = () => {};
  const imagesReady = new Promise<void>((resolve, reject) => {
    resolveImages = resolve;
    rejectImages = reject;
  });
  let window: BrowserWindow | undefined, timer: NodeJS.Timeout | undefined;
  const isolated = session.fromPartition("zinovel-publication-pdf", {
    cache: false,
  });
  let allowed = "";
  isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel: !(
        (details.url === allowed && details.resourceType === "mainFrame") ||
        (allowedImages.has(details.url) && details.resourceType === "image")
      ),
    }),
  );
  isolated.webRequest.onCompleted((details) => {
    if (allowedImages.has(details.url)) {
      loadedImages.add(details.url);
      if (loadedImages.size === allowedImages.size) resolveImages();
    }
  });
  isolated.webRequest.onErrorOccurred((details) => {
    if (allowedImages.has(details.url))
      rejectImages(new Error("冻结发行图读取失败，未创建正式导出"));
  });
  try {
    const images = await publicationRasterImages(
      document.resources || [],
      inputImages,
      "PDF",
    );
    await mkdir(root, { recursive: true });
    folder = await mkdtemp(join(root, "pdf-"));
    if (images.size) {
      imageDirectory = join(folder, "images");
      await mkdir(imageDirectory);
      for (const [hash, bytes] of images) {
        const path = join(imageDirectory, `${hash}.png`);
        await writeFile(path, bytes, { flag: "wx" });
        imageFiles.push(path);
        allowedImages.add(pathToFileURL(path).href);
      }
    } else resolveImages();
    file = join(folder, "render.html");
    await writeFile(file, document.html, { encoding: "utf8", flag: "wx" });
    allowed = pathToFileURL(file).href;
    window = new BrowserWindow({
      show: false,
      width: 800,
      height: 1000,
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: false,
        webSecurity: true,
        devTools: false,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    });
    const target = window;
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.webContents.on("will-navigate", (event, url) => {
      if (url !== allowed) event.preventDefault();
    });
    target.webContents.on("will-redirect", (event) => event.preventDefault());
    const failed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("PDF排版超过90秒，未创建正式导出目录")),
        90_000,
      );
      target.webContents.once("render-process-gone", () =>
        reject(new Error("PDF排版进程已退出，原快照未改动")),
      );
    });
    const render = (async () => {
      await Promise.all([target.loadFile(file!), imagesReady]);
      const margin = document.options.margin === "wide" ? 22 : 16;
      return target.webContents.printToPDF({
        pageSize: document.options.paper,
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate:
          '<div style="width:100%;text-align:center;font-size:9px;color:#555"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        margins: {
          top: margin / 25.4,
          bottom: (margin + 4) / 25.4,
          left: margin / 25.4,
          right: margin / 25.4,
        },
        generateDocumentOutline: true,
        generateTaggedPDF: true,
      });
    })();
    const bytes = await Promise.race([render, failed]);
    if (
      bytes.length > 128 * 1024 * 1024 ||
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-" ||
      !bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
    )
      throw new Error("PDF输出无效或超过128 MiB，原快照未改动");
    return bytes;
  } finally {
    if (timer) clearTimeout(timer);
    allowed = "";
    allowedImages.clear();
    loadedImages.clear();
    isolated.webRequest.onBeforeRequest(null);
    isolated.webRequest.onCompleted(null);
    isolated.webRequest.onErrorOccurred(null);
    if (window && !window.isDestroyed()) window.destroy();
    try {
      await isolated.clearStorageData();
      if (file) await removeOwnFile(file);
      for (const path of imageFiles) await removeOwnFile(path);
      if (imageDirectory) await rmdir(imageDirectory);
      if (folder) await rmdir(folder);
    } finally {
      rendering = false;
    }
  }
}
