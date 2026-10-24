import { open, lstat, mkdir, link, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { assetHash } from "../novel-domain/assets.mjs";
import {
  publicationResourceSelections,
  publicationResourceReferences,
  publicationResourceLimits,
} from "../novel-domain/publication-resources.mjs";
import { preparePublicationImage } from "./publication-image.mjs";
import { binaryHash } from "./image-decoder.mjs";
import sharp from "sharp";
import { verifyPublicationSnapshot } from "../novel-domain/publication.mjs";

/** Shares the book kernel; methods named *Locked require the caller's existing exclusive(). */
export class PublicationResources {
  #active = 0;
  #previewTail = Promise.resolve();
  #previewPending = 0;
  constructor(storage, assets) {
    this.storage = storage;
    this.assets = assets;
  }
  async ownedContextLocked(bookId, snapshot) {
    const ctx = await this.assets.context(bookId);
    if (!ctx.origins.includes(snapshot.content.bookId))
      throw new Error("发行图不属于当前作品及恢复来源");
    return ctx;
  }
  async images(bookId, input) {
    const snapshot = verifyPublicationSnapshot(input),
      images = new Map();
    for (const reference of snapshot.content.resources || []) {
      if (images.has(reference.image.sha256)) continue;
      images.set(
        reference.image.sha256,
        await this.storage.exclusive(async () => {
          const ctx = await this.ownedContextLocked(bookId, snapshot);
          return this.bytesLocked(ctx.root, reference.image);
        }),
      );
    }
    return images;
  }
  async preview(bookId, input, index) {
    const snapshot = verifyPublicationSnapshot(input),
      resources = snapshot.content.resources || [];
    if (!Number.isSafeInteger(index) || index < 0 || index >= resources.length)
      throw new Error("图像不属于该发布副本");
    if (this.#previewPending >= 32)
      throw new Error("冻结图像预览繁忙，请稍后重新打开副本");
    this.#previewPending++;
    const result = this.#previewTail.then(() =>
      this.#previewImage(bookId, snapshot, index),
    );
    this.#previewTail = result.catch(() => {});
    try {
      return await result;
    } finally {
      this.#previewPending--;
    }
  }
  async #previewImage(bookId, snapshot, index) {
    const resources = snapshot.content.resources;
    const image = resources[index].image;
    const bytes = await this.storage.exclusive(async () => {
      const ctx = await this.ownedContextLocked(bookId, snapshot);
      return this.bytesLocked(ctx.root, image);
    });
    const thumbnail = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 20000000,
      limitInputChannels: 4,
    })
      .resize({
        width: 512,
        height: 512,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    if (thumbnail.length > 2 * 1024 * 1024) throw new Error("发行图预览过大");
    return {
      sha256: image.sha256,
      width: image.width,
      height: image.height,
      dataUrl: `data:image/png;base64,${thumbnail.toString("base64")}`,
    };
  }

  async bytesLocked(root, image) {
    assetHash(image.sha256);
    if (
      !Number.isSafeInteger(image.bytes) ||
      image.bytes < 1 ||
      image.bytes > publicationResourceLimits.imageBytes
    )
      throw new Error("出版发行图容量无效");
    const path = await this.storage.path(
      root,
      `assets/blobs/${image.sha256}.png`,
    );
    const info = await lstat(path);
    if (!info.isFile() || info.size !== image.bytes)
      throw new Error("冻结发行图丢失或大小已改变");
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(image.bytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await file.read(
          bytes,
          count,
          bytes.length - count,
          count,
        );
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (
        count !== image.bytes ||
        binaryHash(bytes.subarray(0, count)) !== image.sha256
      )
        throw new Error("冻结发行图hash不符，原文件已保留");
      return bytes.subarray(0, count);
    } finally {
      await file.close();
    }
  }

  async putLocked(root, prepared) {
    const { image, bytes } = prepared;
    if (bytes.length !== image.bytes || binaryHash(bytes) !== image.sha256)
      throw new Error("发行图生成字节不符，未保存");
    const path = await this.storage.path(
      root,
      `assets/blobs/${assetHash(image.sha256)}.png`,
    );
    await mkdir(dirname(path), { recursive: true });
    try {
      await lstat(path);
      await this.bytesLocked(root, image);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = await this.storage.path(
      root,
      `assets/blobs/.${randomUUID()}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw new Error("当前磁盘不能安全创建发行图，请保留临时文件");
    }
    await this.bytesLocked(root, image);
    await unlink(temporary);
  }

  async currentLocked(ctx, source) {
    const current = await this.assets.current(ctx, {
      id: source.assetId,
      revision: source.revision,
      diskHash: source.recordHash,
    });
    if (current.data.deletedAt)
      throw new Error("出版所选图像已进入回收站，请重新选择");
    if (current.data.blob.sha256 !== source.blobHash)
      throw new Error("出版原图来源hash不符");
    return current;
  }

  async verifyLocked(ctx, references) {
    const sources = new Set(),
      images = new Set();
    for (const reference of references) {
      const key = JSON.stringify(reference.source);
      if (!sources.has(key)) {
        await this.currentLocked(ctx, reference.source);
        sources.add(key);
      }
      if (!images.has(reference.image.sha256)) {
        await this.bytesLocked(ctx.root, reference.image);
        images.add(reference.image.sha256);
      }
    }
  }

  /** Makes immutable image blobs only; the caller must commit a validated snapshot separately. */
  async prepare(bookId, input, chapterIds, options = {}) {
    if (this.#active >= 2)
      throw new Error("出版图像处理中，请等待当前捕获完成");
    this.#active++;
    try {
      return await this.#prepare(bookId, input, chapterIds, options);
    } finally {
      this.#active--;
    }
  }
  async #prepare(bookId, input, chapterIds, { signal, onProgress } = {}) {
    const selections = publicationResourceSelections(input, chapterIds),
      references = [],
      cache = new Map();
    for (const selection of selections) {
      signal?.throwIfAborted();
      const key = JSON.stringify(selection.asset);
      let prepared = cache.get(key);
      if (!prepared) {
        const original = await this.storage.exclusive(async () => {
          signal?.throwIfAborted();
          const ctx = await this.assets.context(bookId),
            current = await this.assets.current(ctx, selection.asset);
          if (current.data.deletedAt)
            throw new Error("请先恢复所选图像，再用于出版");
          return {
            source: {
              assetId: current.data.id,
              revision: current.data.revision,
              recordHash: current.diskHash,
              blobHash: current.data.blob.sha256,
            },
            bytes: await this.assets.blobBytes(ctx, current.data.blob),
          };
        });
        // Decoding and full-size PNG generation must not hold the manuscript queue.
        const rendition = await preparePublicationImage(
          original.bytes,
          original.source.blobHash,
        );
        signal?.throwIfAborted();
        prepared = { ...rendition, source: original.source };
      }
      const { placement, chapterId, alt, caption, credit } = selection;
      const reference = {
        source: prepared.source,
        image: prepared.image,
        renderVersion: prepared.renderVersion,
        placement,
        chapterId,
        alt,
        caption,
        credit,
      };
      publicationResourceReferences([...references, reference], chapterIds);
      await this.storage.exclusive(async () => {
        signal?.throwIfAborted();
        const ctx = await this.assets.context(bookId);
        await this.currentLocked(ctx, reference.source);
        if (prepared.bytes) await this.putLocked(ctx.root, prepared);
        else await this.bytesLocked(ctx.root, prepared.image);
      });
      // Cache metadata only. Repeated uses read the already-normalized blob below.
      cache.set(key, { ...prepared, bytes: null });
      references.push(reference);
      await onProgress?.({
        completed: references.length,
        total: selections.length,
      });
      signal?.throwIfAborted();
    }
    return publicationResourceReferences(references, chapterIds);
  }
}
