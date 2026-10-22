import { join } from "node:path";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { TaskJournal } from "../../packages/novel-harness/task-journal.mjs";
import { TaskAcceptance } from "../../packages/novel-harness/acceptance.mjs";

const [root, id, stage] = process.argv.slice(2);
if (!root || !id || !["intent-written", "manuscript-saved"].includes(stage))
  process.exit(2);
const service = new TaskAcceptance(
  new TaskJournal(join(root, "tasks")),
  new NovelStore(join(root, "library")),
  async (point) => {
    if (point === stage) process.exit(91); // No cleanup: exercise a real process boundary after durable writes.
  },
);
await service.accept(id, "作者确认的新句。𠮷🌊");
throw new Error("Expected acceptance checkpoint was not reached");
