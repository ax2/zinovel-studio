import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const result = spawnSync(
  resolve(root, "release/win-unpacked/ZiNovel Studio.exe"),
  [resolve(root, "scripts/verify-package.mjs")],
  {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    stdio: "inherit",
    timeout: 120000,
  },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(`Packaged runtime validation failed (${result.status})`);
