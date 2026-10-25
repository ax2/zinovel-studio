import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { atomicWriteText } from "../../packages/novel-storage/atomic.mjs";
const [library, bookId, characterId, stage] = process.argv.slice(2);
if (!["journal", "first-file"].includes(stage)) process.exit(2);
const store = new NovelStore(library),
  looks = store.characterLooks;
const state = await looks.read(bookId, characterId);
const recover = looks.storage.recover.bind(looks.storage);
looks.storage.recover = async (root) => {
  const raw = await readFile(join(root, ".zinovel/pending.json"), "utf8").catch(
    () => "",
  );
  if (raw) {
    const pending = JSON.parse(raw);
    if (
      pending.entries.some(
        (e) => e.path === `world/character-looks/${characterId}.json`,
      )
    ) {
      if (stage === "first-file") {
        const entry = pending.entries[0];
        await atomicWriteText(
          await looks.storage.path(root, entry.path),
          entry.after,
        );
      }
      process.exit(stage === "journal" ? 97 : 98);
    }
  }
  return recover(root);
};
await looks.choose(
  bookId,
  state.character,
  { revision: state.record.revision, diskHash: state.record.diskHash },
  state.record.entries[0].id,
  "confirm-portrait-choice-v1",
);
throw new Error(
  "Expected appearance transaction crash checkpoint was not reached",
);
