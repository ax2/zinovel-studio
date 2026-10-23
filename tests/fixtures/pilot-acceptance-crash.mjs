import { join } from "node:path";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { TaskJournal } from "../../packages/novel-harness/task-journal.mjs";
import { PilotTaskAcceptance } from "../../packages/novel-harness/pilot-acceptance.mjs";
const [root, id, stage] = process.argv.slice(2);
if (!root || !id || !["intent-written", "pilot-saved"].includes(stage))
  process.exit(2);
const service = new PilotTaskAcceptance(
  new TaskJournal(join(root, "tasks")),
  new NovelStore(join(root, "library")).pilots,
  async (point) => {
    if (point === stage) process.exit(91);
  },
);
await service.accept(id, "作者确认的试写 🌊\n他沿河追上了渡船。");
throw new Error("Expected pilot checkpoint was not reached");
