import koffi from "koffi";
import { toNamespacedPath } from "node:path";

let native;
function bindings() {
  if (process.platform !== "win32")
    throw new Error("增量备份原生写入锁暂仅支持Windows，完整独立副本仍可使用");
  if (!native) {
    const dll = koffi.load("kernel32.dll");
    native = {
      create: dll.func(
        "void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t sharing, void *security, uint32_t creation, uint32_t flags, void *templateFile)",
      ),
      write: dll.func(
        "int __stdcall WriteFile(void *handle, const void *buffer, uint32_t bytes, _Out_ uint32_t *written, void *overlapped)",
      ),
      end: dll.func("int __stdcall SetEndOfFile(void *handle)"),
      flush: dll.func("int __stdcall FlushFileBuffers(void *handle)"),
      close: dll.func("int __stdcall CloseHandle(void *handle)"),
      error: dll.func("uint32_t __stdcall GetLastError()"),
    };
  }
  return native;
}
/** The OS owns exclusion; exiting a process releases its handle without deleting another writer's pathname. */
export function acquireVaultWriteLock(path, owner) {
  const api = bindings();
  // OPEN_ALWAYS, no sharing, non-inheritable, do not follow a final reparse point.
  const handle = api.create(
    toNamespacedPath(path),
    0xc0000000,
    0,
    null,
    4,
    0x00200080,
    null,
  );
  const error = api.error();
  if (
    !handle ||
    koffi.address(handle) ===
      (1n << BigInt(process.arch === "ia32" ? 32 : 64)) - 1n
  ) {
    if (error === 32 || error === 33)
      throw new Error("增量备份库当前被占用，不能取得写入锁，请稍后重试");
    throw new Error(
      `无法获得原生增量备份写入锁（Windows ${error}），原目录已保留`,
    );
  }
  let closed = false;
  const release = () => {
    if (closed) return;
    if (!api.close(handle))
      throw new Error(`原生备份锁关闭失败（Windows ${api.error()}）`);
    closed = true;
  };
  try {
    const bytes = Buffer.from(owner, "utf8"),
      written = [0];
    if (
      !api.write(handle, bytes, bytes.length, written, null) ||
      written[0] !== bytes.length ||
      !api.end(handle) ||
      !api.flush(handle)
    )
      throw new Error(`原生备份锁身份写入失败（Windows ${api.error()}）`);
    return { close: release };
  } catch (error) {
    release();
    throw error;
  }
}
