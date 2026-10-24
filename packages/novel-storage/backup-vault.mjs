import {
  mkdir,
  open,
  readFile,
  readdir,
  lstat,
  realpath,
  link,
  unlink,
  statfs,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readUtf8File } from "./encoding.mjs";
import { canonicalDestination, withinDirectory } from "./backup-path.mjs";
import { acquireVaultWriteLock } from "./vault-lock.mjs";

const LIMIT = 512 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const date = (value) =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function checkedPath(path) {
  if (
    typeof path !== "string" ||
    !path.isWellFormed() ||
    path.length > 1024 ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\\:\x00-\x1f<>"|?*]/.test(part) ||
          /[ .]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("增量备份包含不安全或不可搬移的路径");
  return path;
}
function checkedIdentity(value) {
  if (
    !exact(value, ["format", "version", "id", "bookId", "createdAt"]) ||
    value.format !== "zinovel-backup-vault" ||
    value.version !== 1 ||
    !uuid.test(value.id) ||
    !uuid.test(value.bookId) ||
    !date(value.createdAt)
  )
    throw new Error("增量备份库身份或版本不支持，原目录已保留");
  return value;
}
function checkedSnapshot(value, identity) {
  if (
    !exact(value, [
      "format",
      "version",
      "id",
      "bookId",
      "vaultId",
      "createdAt",
      "files",
      "hash",
    ]) ||
    value.format !== "zinovel-backup" ||
    value.version !== 2 ||
    !uuid.test(value.id) ||
    value.bookId !== identity.bookId ||
    value.vaultId !== identity.id ||
    !date(value.createdAt) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 100000
  )
    throw new Error("增量备份快照身份或格式不支持");
  const seen = new Set();
  let total = 0;
  for (const file of value.files) {
    if (
      !exact(file, ["path", "bytes", "sha256"]) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !sha.test(file.sha256)
    )
      throw new Error("增量备份文件表无效");
    const key = checkedPath(file.path).toLowerCase();
    if (seen.has(key)) throw new Error("增量备份路径重复");
    seen.add(key);
    total += file.bytes;
    if (total > LIMIT) throw new Error("增量备份超过当前512MiB恢复上限");
  }
  const { hash, ...projection } = value;
  if (
    !sha.test(hash) ||
    digest(Buffer.from(JSON.stringify(projection))) !== hash
  )
    throw new Error("增量备份快照摘要不一致");
  return value;
}
/** Append-only CAS backup service. Every public operation uses the existing sole book queue. */
export class BackupVault {
  constructor(storage, restoreContents) {
    this.storage = storage;
    this.restoreContents = restoreContents;
  }
  async root(source) {
    const root = resolve(source),
      info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("增量备份库根不能是链接或普通文件");
    const canonical = await realpath(root);
    const identity = checkedIdentity(
      JSON.parse(
        await readUtf8File(await this.storage.path(canonical, "vault.json")),
      ),
    );
    return { root: canonical, identity };
  }
  async object(root, file) {
    const path = await this.storage.path(root, `objects/${file.sha256}`),
      info = await lstat(path);
    if (!info.isFile() || info.size !== file.bytes)
      throw new Error("增量备份对象大小或类型无效");
    const bytes = await readFile(path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error("增量备份对象损坏，未修改原稿或历史备份");
    return bytes;
  }
  async publish(root, relative, bytes, operation) {
    const temporary = await this.storage.path(
      root,
      `.staging/${operation}-${randomUUID()}.tmp`,
    );
    const target = await this.storage.path(root, relative);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (digest(await readFile(temporary)) !== digest(bytes))
        throw new Error("增量备份临时文件校验失败");
      // Link only the owned flushed temporary, never a live source/manuscript file.
      await link(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  capture(
    bookId,
    destination,
    {
      maxBytes = LIMIT,
      signal,
      onProgress,
      onCommitting,
      existingVault = false,
      expectedVaultId,
    } = {},
  ) {
    return this.storage.exclusive(async () => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMIT)
        throw new Error("增量备份容量限制无效");
      signal?.throwIfAborted();
      if (expectedVaultId !== undefined && !uuid.test(expectedVaultId))
        throw new Error("增量备份库授权身份无效");
      const bookRoot = await this.storage.bookRoot(bookId),
        book = await this.storage.manifest(bookRoot);
      if (book.id !== bookId || !uuid.test(bookId))
        throw new Error("源作品身份不一致");
      const parent = await canonicalDestination(resolve(destination)),
        library = await realpath(this.storage.root);
      if (withinDirectory(library, parent))
        throw new Error("增量备份不能位于受管书库内部");
      const scan = async () => {
        const files = [];
        let total = 0;
        const walk = async (directory, prefix = "") => {
          for (const item of await readdir(directory, {
            withFileTypes: true,
          })) {
            if (item.isSymbolicLink()) throw new Error("增量备份不跟随源链接");
            if (item.name.endsWith(".tmp")) continue;
            const name = checkedPath(prefix + item.name),
              path = await this.storage.path(bookRoot, name);
            if (item.isDirectory()) await walk(path, name + "/");
            else {
              const info = await lstat(path);
              if (!item.isFile() || !info.isFile())
                throw new Error("增量备份包含非普通文件");
              total += info.size;
              if (total > maxBytes || files.length >= 100000)
                throw new Error("增量备份超过逻辑容量或文件数量上限");
              files.push({ path: name, bytes: info.size });
            }
          }
        };
        await walk(bookRoot);
        return files.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
      };
      await onProgress?.({ phase: "scanning", copiedBytes: 0 });
      const planned = await scan();
      const files = [],
        names = new Set();
      for (const file of planned) {
        signal?.throwIfAborted();
        const key = file.path.toLowerCase();
        if (names.has(key))
          throw new Error("源目录路径存在大小写别名，不能生成可搬移备份");
        names.add(key);
        const bytes = await readFile(
          await this.storage.path(bookRoot, file.path),
        );
        if (bytes.length !== file.bytes)
          throw new Error("源文件在备份期间改变");
        files.push({ ...file, sha256: digest(bytes) });
      }
      signal?.throwIfAborted();
      await mkdir(parent, { recursive: true });
      const root = existingVault
        ? parent
        : join(parent, `zinovel-vault-${bookId}`);
      let fresh = false;
      if (!existingVault)
        try {
          await mkdir(root);
          fresh = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      if (
        (await lstat(root)).isSymbolicLink() ||
        !(await lstat(root)).isDirectory()
      )
        throw new Error("备份库目录不能是链接");
      if (!fresh) {
        const selected = await this.root(root);
        if (
          selected.identity.bookId !== bookId ||
          (expectedVaultId !== undefined &&
            selected.identity.id !== expectedVaultId)
        )
          throw new Error("增量备份库已改变或属于另一作品");
      }
      const operation = randomUUID(),
        lockPath = await this.storage.path(root, ".writer.lock");
      const owner = json({
        operation,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      const lock = acquireVaultWriteLock(lockPath, owner);
      let committed;
      try {
        if (fresh) {
          await mkdir(await this.storage.path(root, ".staging"));
          const identity = {
            format: "zinovel-backup-vault",
            version: 1,
            id: randomUUID(),
            bookId,
            createdAt: new Date().toISOString(),
          };
          await this.publish(
            root,
            "vault.json",
            Buffer.from(json(identity)),
            operation,
          );
          await mkdir(await this.storage.path(root, "objects"));
          await mkdir(await this.storage.path(root, "snapshots"));
        }
        const state = await this.root(root);
        if (state.identity.bookId !== bookId)
          throw new Error("增量备份库属于另一作品");
        if (
          expectedVaultId !== undefined &&
          state.identity.id !== expectedVaultId
        )
          throw new Error("增量备份库授权身份已改变");
        for (const name of [".staging", "objects", "snapshots"]) {
          if (!(await lstat(await this.storage.path(root, name))).isDirectory())
            throw new Error("备份库结构无效");
        }
        const missing = new Map();
        for (const file of files) {
          try {
            await this.object(root, file);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            missing.set(file.sha256, file);
          }
        }
        const space = await statfs(root, { bigint: true });
        const newBytes = [...missing.values()].reduce(
          (sum, file) => sum + file.bytes,
          0,
        );
        if (
          space.bavail * space.bsize <
          BigInt(newBytes + Buffer.byteLength(json(files)) + 65536)
        )
          throw new Error("目标磁盘可用空间不足");
        let copiedBytes = 0;
        for (const file of missing.values()) {
          signal?.throwIfAborted();
          const bytes = await readFile(
            await this.storage.path(bookRoot, file.path),
          );
          if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
            throw new Error("源文件在备份期间改变");
          await this.publish(root, `objects/${file.sha256}`, bytes, operation);
          copiedBytes += bytes.length;
          await onProgress?.({
            phase: "object-written",
            copiedBytes,
            objects: missing.size,
          });
        }
        // Recheck the exact entire source before publishing the only visible commit record.
        await onProgress?.({
          phase: "verifying",
          copiedBytes,
          objects: missing.size,
        });
        for (const file of files) {
          signal?.throwIfAborted();
          const bytes = await readFile(
            await this.storage.path(bookRoot, file.path),
          );
          if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
            throw new Error("源文件在备份期间改变");
          await this.object(root, file);
        }
        if (JSON.stringify(await scan()) !== JSON.stringify(planned))
          throw new Error("源目录在备份期间改变");
        const projection = {
          format: "zinovel-backup",
          version: 2,
          id: randomUUID(),
          bookId,
          vaultId: state.identity.id,
          createdAt: new Date().toISOString(),
          files,
        };
        const snapshot = {
          ...projection,
          hash: digest(Buffer.from(JSON.stringify(projection))),
        };
        checkedSnapshot(snapshot, state.identity);
        await onProgress?.({
          phase: "ready-to-commit",
          copiedBytes,
          objects: missing.size,
        });
        signal?.throwIfAborted();
        onCommitting?.();
        await this.publish(
          root,
          `snapshots/${snapshot.id}.json`,
          Buffer.from(json(snapshot)),
          operation,
        );
        committed = {
          path: root,
          snapshotId: snapshot.id,
          hash: snapshot.hash,
          files: files.length,
          logicalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
          copiedBytes,
          newObjects: missing.size,
        };
        try {
          await onProgress?.({
            phase: "committed",
            copiedBytes,
            objects: missing.size,
          });
        } catch {
          committed.notificationFailed = true;
        }
        return committed;
      } finally {
        try {
          lock.close();
        } catch (error) {
          if (committed) committed.lockReleaseFailed = true;
          else throw error;
        }
      }
    });
  }
  list(source) {
    return this.storage.exclusive(async () => {
      const { root, identity } = await this.root(source),
        snapshots = [],
        errors = [];
      for (const name of await readdir(
        await this.storage.path(root, "snapshots"),
      )) {
        if (!name.endsWith(".json")) continue;
        try {
          const snapshot = checkedSnapshot(
            JSON.parse(
              await readUtf8File(
                await this.storage.path(root, `snapshots/${name}`),
              ),
            ),
            identity,
          );
          if (name !== `${snapshot.id}.json`)
            throw new Error("快照文件身份不一致");
          snapshots.push({
            id: snapshot.id,
            hash: snapshot.hash,
            createdAt: snapshot.createdAt,
            files: snapshot.files.length,
            logicalBytes: snapshot.files.reduce(
              (sum, file) => sum + file.bytes,
              0,
            ),
          });
        } catch {
          errors.push({
            file: name,
            message: "快照清单损坏或不支持，原文件已保留",
          });
        }
      }
      return {
        vaultId: identity.id,
        bookId: identity.bookId,
        snapshots: snapshots.sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
        errors,
        scope:
          "Lists committed manifest validity only; restore verifies every object",
      };
    });
  }
  restore(source, snapshotId, { expectedHash, expectedVaultId } = {}) {
    return this.storage.exclusive(async () => {
      if (!uuid.test(snapshotId)) throw new Error("无效增量备份快照ID");
      const { root, identity } = await this.root(source);
      if (expectedVaultId !== undefined && identity.id !== expectedVaultId)
        throw new Error("所选增量备份库身份已改变，请重新选择");
      const snapshot = checkedSnapshot(
        JSON.parse(
          await readUtf8File(
            await this.storage.path(root, `snapshots/${snapshotId}.json`),
          ),
        ),
        identity,
      );
      if (snapshot.id !== snapshotId) throw new Error("快照文件身份不一致");
      if (expectedHash !== undefined && snapshot.hash !== expectedHash)
        throw new Error("所选增量备份版本已改变，请刷新列表");
      const contents = new Map();
      for (const file of snapshot.files)
        contents.set(file.path, await this.object(root, file));
      const sourceBook = JSON.parse(
        contents.get("book.json")?.toString("utf8") || "{}",
      );
      if (sourceBook.id !== identity.bookId)
        throw new Error("快照作品身份不一致");
      return this.restoreContents(contents);
    });
  }
}
