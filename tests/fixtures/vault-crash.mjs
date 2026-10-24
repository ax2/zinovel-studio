import { NovelStore } from "../../packages/novel-storage/store.mjs";
const [root, bookId, destination, checkpoint] = process.argv.slice(2);
const store = new NovelStore(root);
await store.backups.capture(bookId, destination, {
  onProgress: (event) => {
    if (event.phase === checkpoint) process.exit(91);
  },
});
process.exit(92);
