import { resolve } from "node:path";
process.env.ZINOVEL_TEST_EXECUTABLE = resolve(
  import.meta.dirname,
  "../release/win-unpacked/ZiNovel Studio.exe",
);
process.env.ZINOVEL_QA_STAGE = "release/unpacked";
await import("./smoke-desktop.mjs");
