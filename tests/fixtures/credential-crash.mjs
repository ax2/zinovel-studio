import { open } from "node:fs/promises";
import { protectWindowsCredential } from "../../packages/novel-storage/windows-credentials.mjs";
const file = await open(process.argv[2], "wx", 0o600);
await file.writeFile(
  protectWindowsCredential("synthetic-dpapi-crash-key𠮷"),
  "utf8",
);
await file.sync();
// Deliberately omit graceful application/pref-store shutdown.
process.exit(91);
