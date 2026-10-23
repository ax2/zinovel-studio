import koffi from "koffi";

// QA-only metadata inventory. No process names, command lines or credentials are returned.
const kernel = process.platform === "win32" ? koffi.load("kernel32.dll") : null;
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
function birthTime(pid) {
  const handle = open(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!handle) return null; // Protected or concurrently exited processes remain unproven.
  try {
    const created = {},
      exited = {},
      system = {},
      user = {};
    if (!times(handle, created, exited, system, user)) return null;
    const ticks = (BigInt(created.high) << 32n) | BigInt(created.low);
    return new Date(
      Number((ticks - 116444736000000000n) / 10000n),
    ).toISOString();
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
      result.push({
        ProcessId: entry.th32ProcessID,
        ParentProcessId: entry.th32ParentProcessID,
        CreationDate: birthTime(entry.th32ProcessID),
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
