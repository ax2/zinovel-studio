import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalDestination, withinDirectory } from "./backup-path.mjs";

const operations = new Set([
  "app.ready",
  "renderer.gone",
  "chapter.save",
  "book.create",
  "book.structure",
  "book.backup",
  "library.restore",
  "materials.save",
  "knowledge.save",
  "pilots.save",
  "assets.import",
  "maps.save",
  "publication.capture",
  "publication.export",
  "backup.choose",
  "backup.append",
  "backup.restore",
  "settings.save",
  "ai.generate",
  "ai.materialGenerate",
  "ai.pilotGenerate",
  "ai.accept",
  "ai.materialAccept",
  "ai.pilotAccept",
  "ai.cancel",
]);
const codes = new Map([
  ["ENOSPC", "storage-full"],
  ["EACCES", "permission"],
  ["EPERM", "permission"],
  ["ENOENT", "missing"],
  ["EEXIST", "already-exists"],
  ["ECONNREFUSED", "unavailable"],
  ["ETIMEDOUT", "timeout"],
  ["ABORT_ERR", "cancelled"],
]);
const version = (value) =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : "unknown";

/** Session-only, bounded metadata. Never accepts event messages, payloads or arbitrary field spreads. */
export class Diagnostics {
  #events = [];
  #sequence = 0;
  #discarded = 0;
  #runtime;
  constructor({ appVersion, electronVersion, nodeVersion, platform, arch }) {
    this.#runtime = Object.freeze({
      app: version(appVersion),
      electron: version(electronVersion),
      node: version(nodeVersion),
      platform: ["win32", "darwin", "linux"].includes(platform)
        ? platform
        : "unknown",
      arch: ["x64", "arm64", "ia32"].includes(arch) ? arch : "unknown",
    });
  }
  /** @param {string} operation @param {{success?: boolean, durationMs?: number, error?: unknown}} [options] */
  record(operation, { success = true, durationMs = 0, error } = {}) {
    // Successful reads/polls do not crowd out failures or persist author activity unnecessarily.
    if (!operations.has(operation) && success) return;
    let code = success ? "ok" : "unexpected";
    if (
      !success &&
      error &&
      (typeof error === "object" || typeof error === "function")
    ) {
      try {
        const ownCode = Object.getOwnPropertyDescriptor(error, "code")?.value;
        code = codes.get(ownCode) || "unexpected";
      } catch {
        /* An untrusted error object is never serialized or allowed to break writing. */
      }
    }
    this.#events.push(
      Object.freeze({
        sequence: ++this.#sequence,
        // Minute precision is sufficient for support; still local activity metadata, disclosed in UI.
        at: new Date().toISOString().slice(0, 16) + "Z",
        operation: operations.has(operation) ? operation : "other",
        outcome: success ? "ok" : "error",
        code,
        durationBucketMs: Number.isFinite(durationMs)
          ? Math.ceil(Math.min(3600000, Math.max(0, durationMs)) / 100) * 100
          : 0,
      }),
    );
    if (this.#events.length > 200) {
      this.#events.shift();
      this.#discarded++;
    }
  }
  clear() {
    this.#events = [];
    this.#sequence = 0;
    this.#discarded = 0;
  }
  snapshot() {
    return {
      format: "zinovel-diagnostics",
      version: 1,
      runtime: { ...this.#runtime },
      scope:
        "Current session only; no manuscript, prompt, candidate, book/task identity, paths, model endpoint, credential, raw error or stack. No automatic upload.",
      discarded: this.#discarded,
      events: this.#events.map((event) => ({ ...event })),
    };
  }
  async exportNewFile(dataRoot, target) {
    if (typeof target !== "string" || !isAbsolute(target))
      throw new Error("请选择新的诊断导出文件");
    const root = await canonicalDestination(dataRoot),
      path = await canonicalDestination(target);
    if (withinDirectory(root, path))
      throw new Error("诊断文件不能导出到应用数据目录及其别名内部");
    const snapshot = this.snapshot(),
      text = JSON.stringify(snapshot, null, 2) + "\n";
    await writeFile(path, text, { flag: "wx", flush: true });
    return {
      path,
      bytes: Buffer.byteLength(text),
      events: snapshot.events.length,
    };
  }
}
