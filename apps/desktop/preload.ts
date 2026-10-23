import { contextBridge, ipcRenderer } from "electron";
const allowed = new Set([
  "library.list",
  "book.create",
  "chapter.create",
  "chapter.read",
  "chapter.save",
  "chapter.history",
  "chapter.archive-conflict",
  "chapter.export",
  "app.close-ready",
  "app.close-cancelled",
  "skills.list",
  "settings.get",
  "settings.save",
  "ai.generate",
  "ai.materialGenerate",
  "ai.materialEstimate",
  "ai.materialAccept",
  "ai.materialTasks",
  "ai.estimate",
  "ai.cancel",
  "ai.tasks",
  "ai.task",
  "ai.discard",
  "ai.accept",
  "ai.saveReview",
  "ai.reconcile",
  "book.structure",
  "book.search",
  "annotations.read",
  "materials.list",
  "materials.read",
  "materials.save",
  "materials.delete",
  "materials.history",
  "materials.evidence",
  "materials.context",
  "materials.export",
  "annotations.mutate",
  "book.backup",
  "library.restore",
  "import.choose",
  "import.preview",
  "import.commit",
  "book.export",
]);
contextBridge.exposeInMainWorld("novel", {
  async request(action: string, payload = {}) {
    if (!allowed.has(action)) throw new Error("不支持的操作");
    const response = await ipcRenderer.invoke("novel:request", action, payload);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  },
  onClosing(listener: () => void) {
    ipcRenderer.on("novel:closing", listener);
    return () => ipcRenderer.removeListener("novel:closing", listener);
  },
});
