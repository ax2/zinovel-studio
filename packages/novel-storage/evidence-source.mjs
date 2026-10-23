import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createAnchor } from "../novel-domain/anchors.mjs";

export async function checkedEvidenceSource(storage, root, book, source) {
  if (
    !source ||
    source.dirty ||
    typeof source.chapterId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(source.chapterId)
  )
    throw new Error("请保存正文并选择当前作品的证据");
  const chapter = book.chapters.find(
    (item) => item.id === source.chapterId && !item.deletedAt,
  );
  if (!chapter) throw new Error("证据章节不存在于当前作品");
  const bytes = await readFile(
    await storage.path(root, `manuscript/${chapter.id}.md`),
  );
  const body = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  if (
    typeof source.body !== "string" ||
    source.body !== body ||
    source.hash !== hash
  )
    throw new Error("正文已改变或尚未保存。请保存正文并重新选择证据。");
  if (
    !Number.isInteger(source.start) ||
    !Number.isInteger(source.end) ||
    source.end <= source.start ||
    source.end - source.start > 12000
  )
    throw new Error("请选择非空正文证据（最多 1.2 万字符）");
  return {
    chapterId: chapter.id,
    anchor: createAnchor(body, source.start, source.end, hash),
  };
}
