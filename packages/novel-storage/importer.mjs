import { open, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export function splitManuscript(text, fallbackTitle, limit = 2000) {
  const chapters = [];
  let volume = "",
    title = fallbackTitle,
    lines = [],
    explicit = false;
  const flush = () => {
    if (explicit || lines.some((line) => line.trim())) {
      if (chapters.length >= limit)
        throw new Error("拆分后超过 2000 章，请调整导入范围");
      chapters.push({ title, volume, body: lines.join("\n") });
    }
    lines = [];
    explicit = false;
  };
  for (const line of text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const heading = line.replace(/^#{1,3}\s+/, "").trim();
    if (/^第[零〇一二三四五六七八九十百千万两\d]+卷.{0,120}$/.test(heading)) {
      flush();
      volume = heading;
      title = `${volume} · 卷前`;
      continue;
    }
    if (
      /^第[零〇一二三四五六七八九十百千万两\d]+[章回节].{0,120}$/.test(
        heading,
      ) ||
      /^#{1,3}\s+/.test(line)
    ) {
      flush();
      title = heading;
      explicit = true;
      continue;
    }
    lines.push(line);
  }
  flush();
  if (!chapters.length)
    chapters.push({ title: fallbackTitle, volume: "", body: "" });
  return chapters;
}

export async function previewImport(paths, encoding = "utf-8", split = true) {
  if (!["utf-8", "gb18030", "utf-16le", "utf-16be"].includes(encoding))
    throw new Error("不支持的导入编码");
  const files = [],
    visited = new Set();
  const visit = async (path, depth = 0) => {
    path = resolve(path);
    if (visited.has(path)) return;
    visited.add(path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("导入不跟随符号链接");
    if (stat.isDirectory()) {
      if (depth > 5) throw new Error("导入目录层级超过 5 层，请缩小范围");
      for (const entry of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
      )) {
        if (entry.name.startsWith(".") || entry.name === "node_modules")
          continue;
        if (
          entry.isDirectory() ||
          [".txt", ".md"].includes(extname(entry.name).toLowerCase())
        )
          await visit(join(path, entry.name), depth + 1);
      }
    } else if ([".txt", ".md"].includes(extname(path).toLowerCase())) {
      if (!stat.isFile()) throw new Error("只能导入普通稿件文件");
      if (stat.size > 32 * 1024 * 1024)
        throw new Error("单文件超过 32 MiB，请拆分后导入");
      files.push({ path, stat });
      if (files.length > 2000)
        throw new Error("导入超过 2000 个文件，请缩小范围");
    }
  };
  for (const path of paths) await visit(path);
  const chapters = [],
    sources = [];
  let bytesTotal = 0;
  for (const { path, stat } of files) {
    const bytes = await readSource(path, stat, 128 * 1024 * 1024 - bytesTotal);
    bytesTotal += bytes.length;
    if (bytesTotal > 128 * 1024 * 1024) throw new Error("本轮导入超过 128 MiB");
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const title = basename(path, extname(path));
    if (chapters.length >= 2000)
      throw new Error("拆分后超过 2000 章，请调整导入范围");
    chapters.push(
      ...(split
        ? splitManuscript(text, title, 2000 - chapters.length)
        : [{ title, volume: "", body: text }]),
    );
    sources.push({
      name: basename(path),
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  if (!chapters.length) throw new Error("没有找到可导入的 TXT 或 Markdown");
  if (chapters.length > 2000)
    throw new Error("拆分后超过 2000 章，请调整导入范围");
  return {
    chapters,
    sources,
    encoding,
    split,
    totalCharacters: chapters.reduce(
      (total, item) => total + Array.from(item.body).length,
      0,
    ),
  };
}

// Bind the bytes to the enumerated file, and bound allocation/read even if the
// source grows after enumeration. This is a read-only preview, never a repair.
async function readSource(path, expected, remaining) {
  const same = (stat) =>
    stat.isFile() &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    stat.size === expected.size &&
    stat.mtimeMs === expected.mtimeMs &&
    stat.ctimeMs === expected.ctimeMs;
  const validate = (stat) => {
    if (stat.size > 32 * 1024 * 1024)
      throw new Error("单文件超过 32 MiB，请拆分后导入");
    if (stat.size > remaining) throw new Error("本轮导入超过 128 MiB");
    if (!same(stat)) throw new Error("预览期间源文件已经改变，请重新选择稿件");
  };
  validate(await lstat(path));
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    validate(await handle.stat());
    const bytes = Buffer.alloc(expected.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    validate(await handle.stat());
    validate(await lstat(path));
    if (length !== expected.size)
      throw new Error("预览期间源文件已经改变，请重新选择稿件");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
