import { readFile, readdir, lstat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";

export function splitManuscript(text, fallbackTitle) {
  const chapters = [];
  let volume = "",
    title = fallbackTitle,
    lines = [],
    explicit = false;
  const flush = () => {
    if (explicit || lines.some((line) => line.trim()))
      chapters.push({ title, volume, body: lines.join("\n") });
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
  const files = [];
  const visit = async (path, depth = 0) => {
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
      if (stat.size > 32 * 1024 * 1024)
        throw new Error("单文件超过 32 MiB，请拆分后导入");
      files.push(path);
      if (files.length > 2000)
        throw new Error("导入超过 2000 个文件，请缩小范围");
    }
  };
  for (const path of paths) await visit(path);
  const chapters = [],
    sources = [];
  let bytesTotal = 0;
  for (const path of [...new Set(files)]) {
    const bytes = await readFile(path);
    bytesTotal += bytes.length;
    if (bytesTotal > 128 * 1024 * 1024) throw new Error("本轮导入超过 128 MiB");
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const title = basename(path, extname(path));
    chapters.push(
      ...(split
        ? splitManuscript(text, title)
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
