import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../../packages/novel-storage/kernel.mjs";
const [root, bookId, expected, input, stage, review] = process.argv.slice(2);
const originalPath = BookStorageKernel.prototype.path;
BookStorageKernel.prototype.path = async function (bookRoot, path) {
  const resolved = await originalPath.call(this, bookRoot, path);
  if (path !== `.zinovel/image-tasks/${JSON.parse(expected).id}.json`)
    return resolved;
  let pending;
  try {
    pending = JSON.parse(
      (await readFile(join(bookRoot, ".zinovel/pending.json"), "utf8")) ||
        "null",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const task = pending?.entries?.find((entry) => entry.path === path);
  if (!task || JSON.parse(task.after).candidates[0].decision !== "accepted")
    return resolved;
  if (stage === "journal") process.exit(95);
  const asset = pending.entries.find((entry) =>
    entry.path.startsWith("assets/items/"),
  );
  if (
    asset &&
    (await readFile(join(bookRoot, asset.path), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })) === asset.after
  )
    process.exit(96);
  return resolved;
};
const store = new NovelStore(root);
if (review)
  await store.imageTasks.adoptReviewed(
    bookId,
    JSON.parse(expected),
    0,
    JSON.parse(input),
    JSON.parse(review),
  );
else
  await store.imageTasks.adopt(
    bookId,
    JSON.parse(expected),
    0,
    JSON.parse(input),
  );
throw new Error("Adoption crash checkpoint was not reached");
