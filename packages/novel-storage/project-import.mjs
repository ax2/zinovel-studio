import { lstat, readdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { decodeUtf8 } from "./encoding.mjs";
import {
  captureProjectDocuments,
  projectDocumentKind,
  projectScaffold,
} from "../novel-domain/book-project.mjs";

const digest = (v) => createHash("sha256").update(v).digest("hex");
function metadata(text) {
  const doc = parseDocument(text, {
    schema: "core",
    uniqueKeys: true,
    maxAliasCount: 0,
  });
  if (doc.errors.length)
    throw new Error("小说站元数据 YAML 无法解析，请保留原文件");
  const value = doc.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("小说站元数据须为字段映射");
  return value;
}
function frontmatter(text) {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("小说站文件缺少 YAML frontmatter");
  return { meta: metadata(match[1]), body: text.slice(match[0].length) };
}
async function rejectLinkedPath(source) {
  for (let p = source; ; p = dirname(p)) {
    if ((await lstat(p)).isSymbolicLink())
      throw new Error("工程导入不跟随链接");
    if (dirname(p) === p) break;
  }
}
async function boundedText(path, stat, remaining) {
  if (stat.size > 8 * 1024 * 1024 || stat.size > remaining)
    throw new Error("导入单文件超过 8 MiB 或总量超过 128 MiB");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  const same = (s) =>
    s.isFile() &&
    s.size === stat.size &&
    s.ino === stat.ino &&
    s.dev === stat.dev &&
    s.mtimeMs === stat.mtimeMs &&
    s.ctimeMs === stat.ctimeMs;
  try {
    if (!same(await file.stat())) throw new Error("源文件已改变，请重新预览");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const r = await file.read(bytes, count, bytes.length - count, count);
      if (!r.bytesRead) break;
      count += r.bytesRead;
    }
    if (count !== stat.size || !same(await file.stat()))
      throw new Error("源文件在读取期间改变，请重新预览");
    return decodeUtf8(bytes.subarray(0, count));
  } finally {
    await file.close();
  }
}

/** Read only recognized authoring paths, never treat outlines/state as chapters. */
export async function scanNovelProject(source) {
  source = resolve(source);
  // A normal selected file/directory may live beneath a user's workspace junction.
  // Bind the canonical root once, reject a linked selection and all links inside it.
  if ((await lstat(source)).isSymbolicLink())
    throw new Error("工程导入不跟随链接");
  source = await realpath(source);
  await rejectLinkedPath(source);
  const stat = await lstat(source),
    files = [],
    ignored = [],
    documents = [],
    chapters = [],
    sources = [];
  let bytes = 0,
    visits = 0,
    kind,
    title,
    root,
    slug;
  const read = async (path, relative) => {
    const s = await lstat(path);
    if (s.isSymbolicLink() || !s.isFile())
      throw new Error("工程导入只读取普通文件");
    const text = await boundedText(path, s, 128 * 1024 * 1024 - bytes);
    bytes += Buffer.byteLength(text);
    sources.push({
      path: relative,
      hash: digest(text),
      bytes: Buffer.byteLength(text),
    });
    return text;
  };
  const walk = async (directory, prefix = "", depth = 0) => {
    if (depth > 8) throw new Error("工程目录超过 8 层");
    for (const e of await readdir(directory, { withFileTypes: true })) {
      if (++visits > 8192) throw new Error("工程文件数量过多，请缩小范围");
      const p = prefix + e.name;
      if (e.isSymbolicLink()) throw new Error("工程导入不跟随链接");
      if (e.isDirectory()) {
        if (
          !prefix &&
          ![
            "manuscript",
            "worldbuilding",
            "outline",
            "production",
            "assets",
          ].includes(e.name)
        ) {
          ignored.push(p + "/");
          continue;
        }
        if (
          p === "assets" ||
          p.startsWith("assets/images") ||
          !p.startsWith("assets/")
        )
          await walk(join(directory, e.name), p + "/", depth + 1);
        else ignored.push(p + "/");
      } else if (e.isFile()) {
        if (/^manuscript\/volume-\d+\/chapter-\d+\.md$/.test(p)) files.push(p);
        else {
          try {
            projectDocumentKind(p);
            files.push(p);
          } catch {
            ignored.push(p);
          }
        }
      } else throw new Error("工程包含特殊文件，未导入");
    }
  };
  let siteMeta;
  if (stat.isFile()) {
    // The selected Astro novel-index determines the sibling chapter directory.
    if (
      !/^[a-z0-9][a-z0-9-]*\.md$/.test(basename(source)) ||
      basename(dirname(source)) !== "novels"
    )
      throw new Error("请选择小说站 src/content/novels 下的单本小说 Markdown");
    kind = "zicode-site";
    slug = basename(source, ".md");
    root = dirname(source);
    const text = await read(source, `${slug}.md`),
      parsed = frontmatter(text);
    siteMeta = parsed.meta;
    if (siteMeta.slug !== undefined && siteMeta.slug !== slug)
      throw new Error("小说站 slug 与索引文件名不一致");
    title = siteMeta.title;
    documents.push({ path: "README.md", text });
    const chapterRoot = join(dirname(root), "novel-chapters", slug);
    await rejectLinkedPath(chapterRoot);
    const s = await lstat(chapterRoot);
    if (!s.isDirectory() || s.isSymbolicLink())
      throw new Error("小说站章节目录不是普通目录");
    for (const e of await readdir(chapterRoot, { withFileTypes: true })) {
      if (!e.isFile() || e.isSymbolicLink() || !/^\d+\.md$/.test(e.name)) {
        ignored.push(`novel-chapters/${slug}/${e.name}`);
        continue;
      }
      if (chapters.length >= 2000) throw new Error("工程超过 2000 章");
      const parsed = frontmatter(
        await read(
          join(chapterRoot, e.name),
          `novel-chapters/${slug}/${e.name}`,
        ),
      );
      chapters.push({
        meta: parsed.meta,
        body: parsed.body,
        filenameIndex: Number(basename(e.name, ".md")),
      });
    }
  } else if (stat.isDirectory()) {
    kind = "zicode-writing-project";
    root = source;
    slug = basename(source);
    await walk(root);
    for (const path of files.sort()) {
      const text = await read(join(root, ...path.split("/")), path),
        match = path.match(/^manuscript\/volume-(\d+)\/chapter-(\d+)\.md$/);
      if (match) {
        if (chapters.length >= 2000) throw new Error("工程超过 2000 章");
        const header = text.match(/^\uFEFF?#\s+([^\r\n]+)(?:\r?\n|$)/)?.[1];
        if (!header) throw new Error("工程章节缺少首行章标题");
        chapters.push({
          meta: {
            title: header,
            volume: Number(match[1]),
            globalIndex: Number(match[2]),
          },
          body: text,
          filenameIndex: Number(match[2]),
        });
      } else documents.push({ path, text });
    }
    title =
      documents
        .find((d) => d.path === "README.md")
        ?.text.match(/^\uFEFF?#\s+([^\r\n]+)/)?.[1] || slug;
    const docs = new Map(documents.map((d) => [d.path, d]));
    for (const chapter of chapters) {
      const path = `production/publish/chapter-${String(chapter.filenameIndex).padStart(3, "0")}.frontmatter.yml`;
      if (!docs.has(path)) continue;
      const m = metadata(docs.get(path).text);
      if (
        m.novelSlug !== slug ||
        m.globalIndex !== chapter.filenameIndex ||
        m.volume !== chapter.meta.volume ||
        m.title !== chapter.meta.title ||
        !Number.isSafeInteger(m.chapterInVolume) ||
        m.chapterInVolume < 1
      )
        throw new Error("章节发布旁车与正文标题、卷号、章号或 slug 不一致");
      chapter.meta = m;
    }
  } else throw new Error("请选择小说工程目录或小说站索引文件");
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200)
    throw new Error("小说工程标题无效");
  const indices = new Set();
  for (const chapter of chapters) {
    const m = chapter.meta;
    if (kind === "zicode-site" && m.novelSlug !== slug)
      throw new Error("小说站章节 slug 与所选小说不一致");
    if (
      !Number.isSafeInteger(m.globalIndex) ||
      m.globalIndex < 1 ||
      m.globalIndex !== chapter.filenameIndex ||
      indices.has(m.globalIndex) ||
      !Number.isSafeInteger(m.volume) ||
      m.volume < 1 ||
      typeof m.title !== "string" ||
      !m.title.trim() ||
      m.title.length > 200
    )
      throw new Error("章节顺序、卷号或标题无效或重复");
    indices.add(m.globalIndex);
  }
  if (!chapters.length && !documents.length)
    throw new Error("没有找到小说正文或创作资产");
  chapters.sort((a, b) => a.meta.globalIndex - b.meta.globalIndex);
  const available = new Set(documents.map((d) => d.path));
  const missing = projectScaffold(title)
    .filter((d) => !available.has(d.path))
    .map((d) => d.path);
  if (documents.length) captureProjectDocuments(documents);
  return {
    kind,
    title: title.trim(),
    documents,
    missing,
    ignored,
    sources,
    chapters: chapters.map((c) => ({
      title: c.meta.title,
      body: c.body,
      volume:
        siteMeta?.volumeTitles?.find((v) => v.volume === c.meta.volume)
          ?.title || `第${c.meta.volume}卷`,
    })),
  };
}

/** Host-owned immutable previews; renderer gets summaries and an opaque single-use token. */
export class ProjectImportSessions {
  #current;
  #committing = false;
  constructor(store) {
    this.store = store;
  }
  async preview(source) {
    if (this.#committing) throw new Error("已有工程正在导入");
    this.#current = undefined;
    const result = await scanNovelProject(source),
      token = randomUUID();
    const fingerprint = digest(JSON.stringify(result));
    this.#current = { result, token, fingerprint, source };
    return {
      token,
      fingerprint,
      kind: result.kind,
      title: result.title,
      chapterCount: result.chapters.length,
      documents: result.documents.map(({ path, text }) => ({
        path,
        bytes: Buffer.byteLength(text),
      })),
      missing: result.missing,
      ignored: result.ignored,
    };
  }
  async confirm(token, fingerprint) {
    const current = this.#current;
    if (
      this.#committing ||
      !current ||
      current.token !== token ||
      current.fingerprint !== fingerprint
    )
      throw new Error("工程预览已经失效，请重新选择");
    this.#committing = true;
    this.#current = undefined;
    try {
      const latest = await scanNovelProject(current.source);
      if (digest(JSON.stringify(latest)) !== fingerprint)
        throw new Error("源工程已改变，请重新预览；未创建作品");
      const d = current.result;
      return await this.store.importBook(
        d.title,
        d.chapters,
        undefined,
        d.documents.length ? d.documents : projectScaffold(d.title),
      );
    } finally {
      this.#committing = false;
    }
  }
}
