import { open, readdir, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BookStorageKernel } from "../novel-storage/kernel.mjs";
import { decodeUtf8 } from "../novel-storage/encoding.mjs";
import { validateSettings } from "./runtime.mjs";
import {
  batchInput,
  batchFingerprint,
  batchResult,
  batchPlan,
  batchVolume,
  batchChapter,
  batchState,
  batchStagePrompt,
  assembleBatchBook,
} from "../novel-domain/novel-batch.mjs";

const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const json = (v) => JSON.stringify(v, null, 2) + "\n";
const now = () => new Date().toISOString();
async function boundedText(path) {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 2 * 1024 * 1024)
      throw new Error("批量任务记录过大或不是普通文件");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const r = await file.read(bytes, count, bytes.length - count, count);
      if (!r.bytesRead) break;
      count += r.bytesRead;
    }
    const after = await file.stat();
    if (
      count !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("批量任务记录在读取期间改变");
    return decodeUtf8(bytes.subarray(0, count));
  } finally {
    await file.close();
  }
}
/** Private job ledger; the canonical library is written only through the injected single NovelStore owner. */
export class NovelBatch {
  #kernel;
  #active;
  #ready;
  constructor({
    root,
    generate,
    readTask,
    cancel,
    commit,
    acquire = (_id) => {},
    release = (_id) => {},
  }) {
    this.root = root;
    this.generate = generate;
    this.readTask = readTask;
    this.cancelTask = cancel;
    this.commit = commit;
    this.acquire = acquire;
    this.release = release;
    this.#kernel = new BookStorageKernel(root);
  }
  async #load(id) {
    const root = await this.#kernel.bookRoot(id);
    await this.#kernel.recover(root);
    const raw = await boundedText(await this.#kernel.path(root, "job.json")),
      job = JSON.parse(raw);
    if (
      !job ||
      job.schemaVersion !== 1 ||
      job.id !== id ||
      !["prepared", "running", "paused", "partial", "completed"].includes(
        job.status,
      ) ||
      job.inputHash !== batchFingerprint(batchInput(job.input)) ||
      job.settingsHash !== batchFingerprint(validateSettings(job.settings)) ||
      !Array.isArray(job.books) ||
      job.books.length !== job.input.novelCount ||
      !Array.isArray(job.attempts) ||
      job.attempts.length > 500 ||
      job.books.some(
        (b, i) =>
          !uuid(b.id) ||
          b.index !== i ||
          !["pending", "failed", "created"].includes(b.status),
      ) ||
      job.attempts.some(
        (a) =>
          !uuid(a.id) ||
          !Number.isSafeInteger(a.bookIndex) ||
          a.bookIndex < 0 ||
          a.bookIndex >= job.books.length ||
          !/^(plan|volume-\d+|chapter-\d+|state)$/.test(a.stage) ||
          ![
            "running",
            "returned",
            "complete",
            "rejected",
            "failed",
            "cancelled",
            "remote-unknown",
          ].includes(a.status),
      ) ||
      !Number.isSafeInteger(job.reservedOutputTokens) ||
      job.reservedOutputTokens < 0
    )
      throw new Error("批量任务身份、版本或记录校验失败，原文件已保留");
    if (
      new Set(job.attempts.map((a) => a.id)).size !== job.attempts.length ||
      new Set(job.books.map((b) => b.id)).size !== job.books.length ||
      job.reservedOutputTokens !==
        job.attempts.length * job.settings.budget.maxOutputTokens
    )
      throw new Error("批量请求身份或预算账本不一致");
    return { root, raw, job };
  }
  async #write(c, changes = {}) {
    c.job.updatedAt = now();
    const next = json(c.job);
    if (Buffer.byteLength(next) > 2 * 1024 * 1024)
      throw new Error("批量任务清单过大");
    const expectedBefore = {
      "job.json": c.raw,
      ...Object.fromEntries(Object.keys(changes).map((p) => [p, null])),
    };
    await this.#kernel.transaction(
      c.root,
      { ...changes, "job.json": next },
      { expectedBefore },
    );
    c.raw = next;
    return c;
  }
  #summary(job) {
    return {
      id: job.id,
      status: job.status,
      input: job.input,
      model: job.settings.model,
      modelProfile: job.settings.modelProfile,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      reservedOutputTokens: job.reservedOutputTokens,
      requestCount: job.attempts.length,
      errorCode: job.errorCode,
      books: job.books,
      attempts: job.attempts.map(
        ({ id, bookIndex, stage, status, errorCode, outputHash }) => ({
          id,
          bookIndex,
          stage,
          status,
          errorCode,
          outputHash,
        }),
      ),
    };
  }
  initialize() {
    return (this.#ready ??= this.#recover());
  }
  async #recover() {
    await this.#kernel.initialize();
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !uuid(e.name)) continue;
      await this.#kernel.exclusive(async () => {
        let c;
        try {
          c = await this.#load(e.name);
        } catch {
          return;
        }
        if (c.job.status !== "running") return;
        const changes = {};
        for (const a of c.job.attempts.filter((a) => a.status === "running")) {
          let task;
          try {
            task = await this.readTask(a.id);
          } catch {
            /* Unknown is never permission to resend. */
          }
          if (
            task?.record?.status === "awaiting-review" &&
            typeof task.record.candidate === "string" &&
            task.record.candidate.length <= 120000
          ) {
            a.status = "returned";
            a.outputHash = batchFingerprint(task.record.candidate);
            changes[`outputs/${a.id}.json`] = json({
              text: task.record.candidate,
            });
          } else {
            a.status = "remote-unknown";
            a.errorCode = "application-restarted";
          }
        }
        c.job.status = "paused";
        await this.#write(c, changes);
      });
    }
  }
  async create(input, settings) {
    input = batchInput(input);
    settings = validateSettings(settings);
    await this.initialize();
    return this.#kernel.exclusive(async () => {
      const id = randomUUID(),
        root = join(this.root, id);
      await mkdir(root);
      const job = {
        schemaVersion: 1,
        id,
        status: "prepared",
        input,
        inputHash: batchFingerprint(input),
        settings,
        settingsHash: batchFingerprint(settings),
        startedAt: now(),
        updatedAt: now(),
        reservedOutputTokens: 0,
        books: Array.from({ length: input.novelCount }, (_, index) => ({
          id: randomUUID(),
          index,
          status: "pending",
        })),
        attempts: [],
      };
      await this.#kernel.transaction(
        root,
        { "job.json": json(job) },
        { expectedBefore: { "job.json": null } },
      );
      return this.#summary(job);
    });
  }
  async list() {
    await this.initialize();
    return this.#kernel.exclusive(async () => {
      const items = [],
        errors = [];
      for (const e of await readdir(this.root, { withFileTypes: true })) {
        if (!uuid(e.name)) continue;
        try {
          items.push(this.#summary((await this.#load(e.name)).job));
        } catch {
          errors.push({
            id: e.name,
            message: "批量任务无法读取，原始记录保留",
          });
        }
      }
      return {
        items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        errors,
      };
    });
  }
  async read(id) {
    await this.initialize();
    return this.#kernel.exclusive(async () =>
      this.#summary((await this.#load(id)).job),
    );
  }
  status() {
    return this.#active
      ? { id: this.#active.id, cancelling: this.#active.cancelled }
      : null;
  }
  async whenIdle() {
    await this.#active?.done;
  }
  async cancel(id) {
    const active = this.#active;
    if (!active || active.id !== id) throw new Error("该批量任务当前没有运行");
    active.cancelled = true;
    if (active.calling) await this.cancelTask();
    await active.done;
    return this.read(id);
  }
  async run(id, { acknowledgeUnknown = false } = {}) {
    await this.initialize();
    if (this.#active) throw new Error("已有批量任务运行中");
    this.acquire(id);
    // Reserve before the first ledger read so duplicate start cannot launch two workers.
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const active = { id, cancelled: false, calling: false, done };
    this.#active = active;
    try {
      await this.#kernel.exclusive(async () => {
        const c = await this.#load(id);
        if (c.job.status === "completed")
          throw new Error("本批已经完成，不会重复创建作品");
        const latest = new Map(
          c.job.attempts.map((a) => [`${a.bookIndex}/${a.stage}`, a]),
        );
        if (
          [...latest.values()].some((a) => a.status === "remote-unknown") &&
          acknowledgeUnknown !== true
        )
          throw new Error(
            "存在远端结果未知的请求；先核对原任务，明确确认再次付费后才能重试",
          );
        c.job.status = "running";
        delete c.job.errorCode;
        await this.#write(c);
      });
      void this.#work(active)
        .catch(async () => {
          // Disk/ledger failures abort the worker; no recursive paid retry or raw provider error logging.
          await this.#kernel
            .exclusive(async () => {
              const c = await this.#load(id);
              c.job.status = "paused";
              c.job.errorCode = "local-or-context-check";
              await this.#write(c);
            })
            .catch(() => {});
        })
        .finally(() => {
          if (this.#active === active) this.#active = undefined;
          this.release(id);
          finish();
        });
      return this.read(id);
    } catch (error) {
      if (this.#active === active) this.#active = undefined;
      this.release(id);
      finish();
      throw error;
    }
  }
  async #stage(active, bookIndex, stage, data, validate) {
    let c = await this.#kernel.exclusive(() => this.#load(active.id));
    const prompt = batchStagePrompt(
      c.job.input,
      bookIndex,
      stage.startsWith("volume-")
        ? "volume"
        : stage.startsWith("chapter-")
          ? "chapter"
          : stage,
      data,
    );
    const old = c.job.attempts.findLast(
      (a) => a.bookIndex === bookIndex && a.stage === stage,
    );
    if (old && ["complete", "returned"].includes(old.status)) {
      if (stage !== "plan" && old.inputHash !== batchFingerprint(prompt)) {
        old.status = "rejected";
        old.errorCode = "dependencies-changed";
        await this.#kernel.exclusive(() => this.#write(c));
        return { failed: true };
      }
      const raw = JSON.parse(
        await boundedText(
          await this.#kernel.path(c.root, `outputs/${old.id}.json`),
        ),
      );
      if (batchFingerprint(raw.text) !== old.outputHash)
        throw new Error("批量候选指纹改变，未使用损坏结果");
      let value;
      try {
        value = validate(batchResult(raw.text));
      } catch {
        old.status = "rejected";
        old.errorCode = "result-structure";
        await this.#kernel.exclusive(() => this.#write(c));
        return { failed: true };
      }
      if (old.status === "returned") {
        old.status = "complete";
        await this.#kernel.exclusive(() => this.#write(c));
      }
      return { value };
    }
    if (active.cancelled) return { failed: true };
    const cap = c.job.settings.budget.maxOutputTokens;
    if (
      c.job.attempts.length >= c.job.input.requestLimit ||
      c.job.reservedOutputTokens + cap > c.job.input.outputTokenLimit
    ) {
      c.job.books[bookIndex].errorCode = "budget-limit";
      await this.#kernel.exclusive(() => this.#write(c));
      return { failed: true, budget: true };
    }
    const attempt = {
      id: randomUUID(),
      bookIndex,
      stage,
      status: "running",
      inputHash: batchFingerprint(prompt),
      startedAt: now(),
    };
    c.job.attempts.push(attempt);
    c.job.reservedOutputTokens += cap;
    await this.#kernel.exclusive(() =>
      this.#write(c, {
        [`inputs/${attempt.id}.json`]: json({
          prompt,
          settingsHash: c.job.settingsHash,
        }),
      }),
    );
    let response, task;
    try {
      active.calling = true;
      response = await this.generate({
        requestId: attempt.id,
        prompt,
        settings: c.job.settings,
        batchId: active.id,
        stage,
        bookIndex,
      });
    } catch (error) {
      try {
        task = await this.readTask(attempt.id);
      } catch {
        /* Retain unknown. */
      }
      if (task?.record?.status === "awaiting-review")
        response = { text: task.record.candidate };
      else {
        attempt.status = active.cancelled
          ? "cancelled"
          : error?.code === "BATCH_NOT_SENT"
            ? "failed"
            : ["failed", "cancelled"].includes(task?.record?.status)
              ? "failed"
              : "remote-unknown";
        attempt.errorCode = "generation-stopped";
      }
    } finally {
      active.calling = false;
    }
    let value;
    const changes = {};
    if (
      response &&
      (response.id === undefined || response.id === attempt.id) &&
      typeof response.text === "string" &&
      response.text.length <= 120000
    ) {
      attempt.outputHash = batchFingerprint(response.text);
      changes[`outputs/${attempt.id}.json`] = json({ text: response.text });
      try {
        value = validate(batchResult(response.text));
        attempt.status = "complete";
      } catch {
        attempt.status = "rejected";
        attempt.errorCode = "result-structure";
      }
    } else if (attempt.status === "running") {
      attempt.status = "remote-unknown";
      attempt.errorCode = "missing-result";
    }
    attempt.completedAt = now();
    await this.#kernel.exclusive(() => this.#write(c, changes));
    return value ? { value } : { failed: true };
  }
  async #book(active, index) {
    let c = await this.#kernel.exclusive(() => this.#load(active.id));
    if (c.job.books[index].status === "created") return true;
    const input = c.job.input,
      usedTitles = c.job.books
        .filter((b) => b.index !== index && b.title)
        .map((b) => b.title);
    const planResult = await this.#stage(
      active,
      index,
      "plan",
      { usedTitles },
      (v) => batchPlan(v, input, usedTitles),
    );
    if (!planResult.value) return false;
    const plan = planResult.value,
      volumes = [],
      chapters = [];
    c = await this.#kernel.exclusive(() => this.#load(active.id));
    c.job.books[index].title = plan.title;
    await this.#kernel.exclusive(() => this.#write(c));
    for (const volume of plan.volumes) {
      const r = await this.#stage(
        active,
        index,
        `volume-${volume.number}`,
        { synopsis: plan.synopsis, documents: plan.documents, volume },
        (v) => batchVolume(v, volume),
      );
      if (!r.value) return false;
      volumes.push(r.value);
    }
    const planned = volumes.flatMap((v) => v.chapters);
    for (let n = 0; n < input.trialChapters; n++) {
      const r = await this.#stage(
        active,
        index,
        `chapter-${n + 1}`,
        {
          synopsis: plan.synopsis,
          documents: plan.documents,
          chapter: planned[n],
          precedingChapters: chapters
            .slice(-2)
            .map(({ title, text, postState }) => ({ title, text, postState })),
        },
        (v) => batchChapter(v, planned[n]),
      );
      if (!r.value) return false;
      chapters.push(r.value);
    }
    const final = await this.#stage(
      active,
      index,
      "state",
      {
        synopsis: plan.synopsis,
        chapters: chapters.map(({ globalIndex, title, postState }) => ({
          globalIndex,
          title,
          postState,
        })),
      },
      batchState,
    );
    if (!final.value || active.cancelled) return false;
    const output = assembleBatchBook(
      input,
      plan,
      volumes,
      chapters,
      final.value,
      c.job.books[index].id,
    );
    c = await this.#kernel.exclusive(() => this.#load(active.id));
    const receipt = {
      bookId: c.job.books[index].id,
      batchId: c.job.id,
      bookIndex: index,
      inputHash: c.job.inputHash,
      targetWords: input.targetWords,
      genre: input.genre,
      model: c.job.settings.model,
      service: c.job.settings.baseURL,
      modelProfileId: c.job.settings.modelProfile?.id ?? null,
      requestIds: c.job.attempts
        .filter((a) => a.bookIndex === index && a.status === "complete")
        .map((a) => a.id),
      volumes: plan.volumes.map((v) => v.title),
      contentHash: batchFingerprint({
        title: output.title,
        chapters: output.chapters,
        documents: output.documents.map(({ path, text }) => ({ path, text })),
      }),
    };
    // Persist the exact creation intent before canonical library effects. Commit is idempotent by book ID + receipt.
    c.job.books[index].commitHash = receipt.contentHash;
    await this.#kernel.exclusive(() => this.#write(c));
    const book = await this.commit(output, receipt);
    if (book.id !== receipt.bookId) throw new Error("生成作品提交身份不符");
    c = await this.#kernel.exclusive(() => this.#load(active.id));
    Object.assign(c.job.books[index], {
      status: "created",
      title: output.title,
      actualTrialCharacters: output.actualTrialCharacters,
      trialChapters: output.chapters.length,
    });
    await this.#kernel.exclusive(() => this.#write(c));
    return true;
  }
  async #work(active) {
    const count = (await this.#kernel.exclusive(() => this.#load(active.id)))
      .job.books.length;
    for (let index = 0; index < count && !active.cancelled; index++) {
      const success = await this.#book(active, index);
      if (!success) {
        const c = await this.#kernel.exclusive(() => this.#load(active.id));
        c.job.books[index].status = "failed";
        await this.#kernel.exclusive(() => this.#write(c));
      }
    }
    const c = await this.#kernel.exclusive(() => this.#load(active.id));
    c.job.status = active.cancelled
      ? "paused"
      : c.job.books.every((b) => b.status === "created")
        ? "completed"
        : "partial";
    await this.#kernel.exclusive(() => this.#write(c));
  }
}
