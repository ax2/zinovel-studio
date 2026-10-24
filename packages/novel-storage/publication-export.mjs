import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  stat,
  lstat,
  rename,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  verifyPublicationSnapshot,
  publicationText,
  publicationHtml,
} from "../novel-domain/publication.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

/** The host chooses parent through a native author action and reloads the exact snapshot first. */
export async function exportPublication(
  input,
  parent,
  format,
  exportId = randomUUID(),
) {
  const snapshot = verifyPublicationSnapshot(input);
  if (!["txt", "md", "html"].includes(format) || !uuid(exportId))
    throw new Error("导出格式或任务身份无效");
  const directory = await realpath(parent);
  if (!(await stat(directory)).isDirectory()) throw new Error("请选择导出目录");
  const title =
    Array.from(snapshot.content.metadata.title)
      .slice(0, 32)
      .join("")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[ .]+$/g, "") || "小说";
  const name = `小说-${title}-${format}-${exportId}`,
    final = join(directory, name);
  try {
    await lstat(final);
    throw new Error("导出目标已存在，原目录未改动");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const staging = join(directory, `.zinovel-export-${exportId}.tmp`);
  await mkdir(staging);
  let files, prepared;
  if (format === "html") {
    const html = publicationHtml(snapshot);
    files = html.files;
    files.delete("publication-manifest.json");
    prepared = html.manifest;
  } else {
    files = new Map([[`book.${format}`, publicationText(snapshot, format)]]);
    const inventory = [...files].map(([path, value]) => ({
      path,
      bytes: Buffer.byteLength(value),
      sha256: digest(value),
    }));
    prepared = {
      schemaVersion: 1,
      state: "prepared",
      format,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.hash,
      files: inventory,
      hash: digest(JSON.stringify(inventory)),
    };
  }
  for (const [path, text] of files) {
    if (
      path
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || /[\\:]/.test(part),
        )
    )
      throw new Error("导出文件路径无效，临时目录已保留");
    const destination = join(staging, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text, { encoding: "utf8", flag: "wx" });
  }
  for (const file of prepared.files) {
    const bytes = await readFile(join(staging, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error("导出文件核验失败，临时目录已保留");
  }
  const manifest = {
    ...prepared,
    state: "exported",
    exportId,
    exportedAt: new Date().toISOString(),
  };
  await writeFile(
    join(staging, "publication-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  await rename(staging, final);
  return {
    path: final,
    format,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    exportId,
    files: manifest.files.length,
    manifest,
  };
}
