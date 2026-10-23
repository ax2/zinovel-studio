import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
export async function contextProof(
  storage,
  root,
  book,
  data,
  selectedHash,
  origin,
  cache = new Map(),
) {
  const files = new Set();
  const addMaterial = (id) => {
    if (id) files.add(`materials/${id}.json`);
  };
  addMaterial(data.propositionId);
  addMaterial(data.characterId);
  const chapterIds = new Set([
    ...(data.chapterIds || []),
    ...(data.evidence || []).map((item) => item.chapterId),
    ...(data.chapterId ? [data.chapterId] : []),
  ]);
  for (const event of data.evidence || [])
    for (const related of event.relatedIds || []) addMaterial(related);
  for (const chapterId of chapterIds) files.add(`manuscript/${chapterId}.md`);
  if (data.propositionId) {
    files.add(`knowledge/events/${data.id}.json`);
    files.add(`knowledge/origins/${data.id}.json`);
    addMaterial(origin?.source?.ownerId);
  }
  const entries = [];
  for (const file of [...files].sort()) {
    if (!cache.has(file))
      cache.set(
        file,
        (async () => {
          try {
            const bytes = await readFile(await storage.path(root, file));
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            );
            return hash(bytes);
          } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
          }
        })(),
      );
    entries.push([file, await cache.get(file)]);
  }
  return hash(
    json([
      selectedHash,
      entries,
      [...chapterIds].sort().map((id) => {
        const chapter = book.chapters.find((item) => item.id === id);
        return [id, chapter?.title || null, chapter?.deletedAt || null];
      }),
    ]),
  );
}
