import koffi from "koffi";
import { join } from "node:path";
import { terminateOriginalWithHandle } from "./owned-process-handle.mjs";

// QA-only identities and exact-handle shutdown for synthetic probes. No names,
// command lines or credentials are returned.
const kernel =
  process.platform === "win32"
    ? koffi.load(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "kernel32.dll",
        ),
      )
    : null;
const Entry = koffi.struct("ZiNovelQAProcessEntry", {
  dwSize: "uint32_t",
  cntUsage: "uint32_t",
  th32ProcessID: "uint32_t",
  th32DefaultHeapID: "uintptr_t",
  th32ModuleID: "uint32_t",
  cntThreads: "uint32_t",
  th32ParentProcessID: "uint32_t",
  pcPriClassBase: "int32_t",
  dwFlags: "uint32_t",
  szExeFile: koffi.array("char16_t", 260),
});
const FileTime = koffi.struct("ZiNovelQAFileTime", {
  low: "uint32_t",
  high: "uint32_t",
});
const create = kernel?.func(
  "void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)",
);
const first = kernel?.func(
  "int __stdcall Process32FirstW(void *snapshot, _Inout_ ZiNovelQAProcessEntry *entry)",
);
const next = kernel?.func(
  "int __stdcall Process32NextW(void *snapshot, _Inout_ ZiNovelQAProcessEntry *entry)",
);
const open = kernel?.func(
  "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
);
const times = kernel?.func(
  "int __stdcall GetProcessTimes(void *process, _Out_ ZiNovelQAFileTime *created, _Out_ ZiNovelQAFileTime *exited, _Out_ ZiNovelQAFileTime *system, _Out_ ZiNovelQAFileTime *user)",
);
const close = kernel?.func("int __stdcall CloseHandle(void *handle)");
const errorCode = kernel?.func("uint32_t __stdcall GetLastError()");
const wait = kernel?.func(
  "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)",
);
const terminate = kernel?.func(
  "int __stdcall TerminateProcess(void *process, uint32_t exitCode)",
);
function creationDate(handle) {
  const created = {},
    exited = {},
    system = {},
    user = {};
  if (!times(handle, created, exited, system, user)) return null;
  const ticks = (BigInt(created.high) << 32n) | BigInt(created.low),
    iso = new Date(
      Number((ticks - 116444736000000000n) / 10000n),
    ).toISOString();
  return iso.replace(
    /\.\d{3}Z$/,
    `.${(ticks % 10000000n).toString().padStart(7, "0")}Z`,
  );
}
function birthState(pid) {
  const handle = open(0x101000, 0, pid); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
  if (!handle) return { creation: null, exited: errorCode() === 87 };
  try {
    const state = wait(handle, 0);
    if (state === 0) return { creation: null, exited: true };
    if (state !== 258) return { creation: null, exited: false };
    return { creation: creationDate(handle), exited: false };
  } finally {
    close(handle);
  }
}
export function windowsProcessSnapshot() {
  if (!kernel) throw new Error("Windows process QA requires Windows");
  const handle = create(2, 0); // TH32CS_SNAPPROCESS
  if (
    !handle ||
    koffi.address(handle) ===
      (1n << BigInt(process.arch === "ia32" ? 32 : 64)) - 1n
  )
    throw new Error(`Windows process snapshot failed: ${errorCode()}`);
  try {
    const entry = { dwSize: koffi.sizeof(Entry) },
      result = [];
    if (!first(handle, entry))
      throw new Error(`Windows process enumeration failed: ${errorCode()}`);
    do {
      const state = birthState(entry.th32ProcessID);
      if (state.exited) continue;
      result.push({
        ProcessId: entry.th32ProcessID,
        ParentProcessId: entry.th32ParentProcessID,
        CreationDate: state.creation,
      });
    } while (next(handle, entry));
    const code = errorCode();
    if (code !== 18)
      throw new Error(`Windows process enumeration interrupted: ${code}`);
    return result;
  } finally {
    close(handle);
  }
}

export function terminateWindowsProcessIdentity(pid, identity, options) {
  if (!kernel) throw new Error("Windows process QA requires Windows");
  return terminateOriginalWithHandle(
    pid,
    identity,
    {
      open: (pid) => open(0x101001, 0, pid), // TERMINATE | QUERY_LIMITED_INFORMATION | SYNCHRONIZE
      openReadOnly: (pid) => open(0x101000, 0, pid),
      creationDate,
      wait: (handle) => wait(handle, 0),
      terminate: (handle) => !!terminate(handle, 1),
      close,
      error: errorCode,
    },
    options,
  );
}
