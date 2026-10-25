import { randomUUID } from "node:crypto";
import { previewImport } from "./importer.mjs";

function label(value, optional = false) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.trim().length > 200 ||
    (!optional && !value.trim()) ||
    /[\r\n\0]/.test(value)
  )
    throw new Error("卷章名称需要完整的单行文字，最长200字");
  return value.trim();
}

class ImportReview {
  #original;
  #chapters;
  #metadata;
  #revision = randomUUID();
  #adjustments = 0;
  #characters = 0;
  #originalCharacters;
  constructor(preview) {
    this.#metadata = {
      ...preview,
      sources: preview.sources.map((x) => ({ ...x })),
    };
    this.#original = preview.chapters.map((x) => ({ ...x, id: randomUUID() }));
    this.#chapters = this.#original;
    for (const chapter of this.#chapters)
      for (const character of chapter.body) this.#characters++;
    this.#originalCharacters = this.#characters;
  }
  snapshot() {
    return {
      revision: this.#revision,
      preview: {
        ...this.#metadata,
        sources: this.#metadata.sources.map((x) => ({ ...x })),
        chapters: this.#chapters.map((x) => ({ ...x })),
        totalCharacters: this.#characters,
        adjustments: this.#adjustments,
      },
    };
  }
  chapters(revision) {
    if (revision !== this.#revision)
      throw new Error("导入预览已经改变，请核对最新预览后重试");
    return this.#chapters.map((x) => ({ ...x }));
  }
  provenance(applicationVersion) {
    return {
      applicationVersion,
      encoding: this.#metadata.encoding,
      automaticSplit: this.#metadata.split,
      originalChapterCount: this.#original.length,
      manualAdjustmentCount: this.#adjustments,
      sources: this.#metadata.sources.map((source) => ({
        name: source.name,
        bytes: source.bytes,
        sha256: source.sha256,
      })),
    };
  }
  edit(revision, operation) {
    const next = this.chapters(revision);
    if (!operation || typeof operation !== "object")
      throw new Error("无效的预览调整");
    if (operation.type === "reset") {
      this.#chapters = this.#original;
      this.#adjustments = 0;
      this.#characters = this.#originalCharacters;
    } else {
      const index = next.findIndex((x) => x.id === operation.chapterId);
      if (index < 0) throw new Error("预览章节已失效，请重新选择");
      const chapter = next[index];
      switch (operation.type) {
        case "rename":
          chapter.title = label(operation.title);
          chapter.volume = label(operation.volume, true);
          break;
        case "split": {
          const offset = operation.offset;
          if (
            !Number.isSafeInteger(offset) ||
            offset <= 0 ||
            offset >= chapter.body.length
          )
            throw new Error("请把拆分光标放在正文内部");
          if (
            chapter.body.charCodeAt(offset - 1) >= 0xd800 &&
            chapter.body.charCodeAt(offset - 1) <= 0xdbff &&
            chapter.body.charCodeAt(offset) >= 0xdc00 &&
            chapter.body.charCodeAt(offset) <= 0xdfff
          )
            throw new Error("拆分位置不能切开一个完整字符");
          if (next.length >= 2000)
            throw new Error("拆分后超过2000章，请分批导入");
          next.splice(index + 1, 0, {
            ...chapter,
            id: randomUUID(),
            title: label(operation.title),
            body: chapter.body.slice(offset),
          });
          chapter.body = chapter.body.slice(0, offset);
          break;
        }
        case "merge-next": {
          const following = next[index + 1];
          if (!following) throw new Error("本章之后没有可合并章节");
          if (!["", "\n", "\n\n"].includes(operation.separator))
            throw new Error("请选择合并分隔方式");
          chapter.body += operation.separator + following.body;
          this.#characters += operation.separator.length;
          next.splice(index + 1, 1);
          break;
        }
        default:
          throw new Error("不支持的预览调整");
      }
      this.#chapters = next;
      this.#adjustments++;
    }
    this.#revision = randomUUID();
    return this.snapshot();
  }
}

// Host-owned sessions: native selection supplies paths, renderer supplies only a
// session token, an exact preview token, and a bounded editing operation.
export class ImportSessions {
  #entries = new Map();
  #preview;
  #createBook;
  #applicationVersion;
  /** @param {{createBook: Function, preview?: typeof previewImport, applicationVersion?: string | null}} options */
  constructor({
    createBook,
    preview = previewImport,
    applicationVersion = null,
  }) {
    this.#createBook = createBook;
    this.#preview = preview;
    this.#applicationVersion = applicationVersion;
  }
  #entry(id) {
    const intake = this.#entries.get(id);
    if (!intake) throw new Error("导入预览已失效，请重新选择文件");
    if (intake.committing) throw new Error("作品正在创建，请勿重复提交");
    return intake;
  }
  async choose(paths) {
    if (this.#entries.size >= 5) {
      const disposable = [...this.#entries].find(
        ([, item]) => !item.committing,
      );
      if (!disposable) throw new Error("正在处理的导入过多，请稍后重试");
      this.#entries.delete(disposable[0]);
    }
    const id = randomUUID(),
      intake = {
        paths: [...paths],
        generation: 0,
        review: null,
        committing: false,
      };
    this.#entries.set(id, intake);
    try {
      return await this.preview(id, "utf-8", true);
    } catch (error) {
      if (this.#entries.get(id) !== intake) throw error;
      return {
        id,
        error:
          error instanceof TypeError
            ? "初次 UTF-8 解码失败，请更换编码重试。"
            : error.message,
      };
    }
  }
  async preview(id, encoding, split) {
    const intake = this.#entry(id),
      generation = ++intake.generation;
    intake.review = null;
    const preview = await this.#preview(intake.paths, encoding, split);
    if (this.#entries.get(id) !== intake || intake.generation !== generation)
      throw new Error("导入预览已经改变，请核对最新预览后重试");
    intake.review = new ImportReview(preview);
    return { id, ...intake.review.snapshot() };
  }
  edit(id, revision, operation) {
    const intake = this.#entry(id);
    if (!intake.review) throw new Error("请先完成导入预览");
    return { id, ...intake.review.edit(revision, operation) };
  }
  async commit(id, revision, title) {
    const intake = this.#entry(id);
    if (!intake.review) throw new Error("请先完成导入预览");
    const chapters = intake.review.chapters(revision);
    intake.committing = true;
    try {
      const book = await this.#createBook(
        title,
        chapters,
        intake.review.provenance(this.#applicationVersion),
      );
      this.#entries.delete(id);
      return book;
    } finally {
      intake.committing = false;
    }
  }
}
