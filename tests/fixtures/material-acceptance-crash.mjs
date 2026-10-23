import { join } from "node:path";
import { NovelStore } from "../../packages/novel-storage/store.mjs";
import { TaskJournal } from "../../packages/novel-harness/task-journal.mjs";
import { MaterialTaskAcceptance } from "../../packages/novel-harness/material-acceptance.mjs";
const [root, id, stage] = process.argv.slice(2);
if (!root || !id || !["intent-written", "material-saved"].includes(stage))
  process.exit(2);
const service = new MaterialTaskAcceptance(
  new TaskJournal(join(root, "tasks")),
  new NovelStore(join(root, "library")).materials,
  async (point) => {
    if (point === stage) process.exit(91);
  },
);
await service.accept(id, {
  title: "崩溃恢复角色",
  fields: { desire: "作者确认的目标" },
  notes: "作者确认稿 🌊",
});
throw new Error("Expected material checkpoint was not reached");
