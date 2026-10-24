import { acquireVaultWriteLock } from "../../packages/novel-storage/vault-lock.mjs";
const lock = acquireVaultWriteLock(
  process.argv[2],
  JSON.stringify({ pid: process.pid, synthetic: true }),
);
process.stdout.write("locked\n");
let closed = false;
function release() {
  if (closed) return;
  closed = true;
  lock.close();
  process.exit(0);
}
process.stdin.once("data", release);
process.stdin.once("end", release);
process.stdin.resume();
