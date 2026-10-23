import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Flush a same-directory temporary file before replacement; failure preserves the old target. */
export async function atomicWriteText(path, text) {
  if (typeof text !== "string" || !text.isWellFormed())
    throw new Error("待保存文本格式无效或包含不完整Unicode，原文件已保留");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
