import { readFile, mkdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const lock = JSON.parse(await readFile("upstream.lock.json", "utf8"));
const destination = resolve("vendor/deepseek-harness");
function git(args) {
  const result = spawnSync("git", args, {
    cwd: destination,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error("Upstream source acquisition failed");
}
await mkdir(destination, { recursive: true });
let exists = false;
try {
  await access(resolve(destination, ".git"));
  exists = true;
} catch {}
if (exists) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: destination,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.stdout.trim() !== lock.commit)
    throw new Error(
      "Existing checkout differs from pin; preserve it and inspect manually",
    );
} else {
  git(["init"]);
  git(["remote", "add", "origin", lock.repository]);
  git(["fetch", "--depth", "1", "origin", lock.commit]);
  git(["checkout", "--detach", "FETCH_HEAD"]);
}
console.log(`Verified checkout: ${lock.commit}`);
