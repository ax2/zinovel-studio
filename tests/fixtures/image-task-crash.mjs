import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BookStorageKernel } from "../../packages/novel-storage/kernel.mjs";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { AssetStore } from "../../packages/novel-storage/assets.mjs";
import sharp from "sharp";
const [root, bookId, expected, stage = "send-intent"] = process.argv.slice(2),
  before = BookStorageKernel.prototype.recover;
BookStorageKernel.prototype.recover = async function (bookRoot) {
  let pending;
  try {
    const raw = await readFile(join(bookRoot, ".zinovel/pending.json"), "utf8");
    pending = raw.trim() ? JSON.parse(raw) : null;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    pending?.entries?.some(
      (entry) =>
        entry.path === `.zinovel/image-tasks/${JSON.parse(expected).id}.json` &&
        JSON.parse(entry.after).status === stage,
    )
  )
    process.exit(97);
  return before.call(this, bookRoot);
};
const store = new NovelStore(root);
if (stage === "blob-written") {
  const original = AssetStore.prototype.putBlob;
  AssetStore.prototype.putBlob = async function (ctx, image) {
    await original.call(this, ctx, image);
    process.exit(98);
  };
}
const sent = await store.imageTasks.markSending(bookId, JSON.parse(expected));
if (stage !== "send-intent") {
  const bytes = await sharp({
    create: { width: 80, height: 48, channels: 4, background: "#286b8b" },
  })
    .png()
    .toBuffer();
  await store.imageTasks.receive(
    bookId,
    { id: sent.id, revision: sent.revision, diskHash: sent.diskHash },
    sent.attemptId,
    { candidates: [{ bytes }], usage: null, interruptedAfterResponse: false },
  );
}
throw new Error("Crash checkpoint was not reached");
