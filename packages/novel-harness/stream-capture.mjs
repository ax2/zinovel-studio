import { atomicWriteText } from "../novel-storage/atomic.mjs";

/** Bounded, text-only recovery journal for official process-local stream frames. */
export class StreamCapture {
  #timer;
  #pending = Promise.resolve();
  #writing = false;
  #dirty = false;
  #error;
  #closed = false;
  #sessionId;
  #characters = 0;
  #attempts = new Map();
  #truncated = false;
  constructor(path, { intervalMs = 200, write = atomicWriteText } = {}) {
    this.path = path;
    this.intervalMs = intervalMs;
    this.write = write;
  }
  accept({ agent, frame }) {
    if (this.#closed || !frame || typeof agent?.session?.id !== "string")
      return;
    this.#sessionId ??= agent.session.id;
    if (agent.session.id !== this.#sessionId) return;
    const id = frame.attemptId;
    if (typeof id !== "string" || id.length > 200) return;
    if (frame.type === "start") {
      if (this.#attempts.has(id)) return;
      if (this.#attempts.size >= 32) {
        this.#truncated = true;
        this.#dirty = true;
        this.flush().catch(() => {});
        return;
      }
      this.#attempts.set(id, { id, text: "", lastIndex: -1, ended: false });
      return;
    }
    const attempt = this.#attempts.get(id);
    if (!attempt || attempt.ended) return;
    if (frame.type === "end") {
      attempt.ended = true;
      this.#dirty = true;
      this.flush().catch(() => {});
      return;
    }
    if (
      frame.type !== "chunk" ||
      !Number.isSafeInteger(frame.index) ||
      frame.index <= attempt.lastIndex
    )
      return;
    attempt.lastIndex = frame.index;
    if (
      frame.chunk?.type !== "text-delta" ||
      typeof frame.chunk.text !== "string"
    )
      return;
    // Do not retain reasoning, tool arguments, credentials, or arbitrary protocol data.
    const remaining = Math.max(0, 120000 - this.#characters);
    let text = frame.chunk.text.slice(0, remaining);
    // A length cap must not split an astral character into an invalid surrogate.
    if (text.length < frame.chunk.text.length && /[\uD800-\uDBFF]$/.test(text))
      text = text.slice(0, -1);
    attempt.text += text;
    this.#characters += text.length;
    if (text.length < frame.chunk.text.length) attempt.truncated = true;
    this.#dirty = true;
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.flush().catch(() => {});
    }, this.intervalMs);
  }
  async flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#dirty && !this.#writing) {
      this.#writing = true;
      // Keep only the newest in-memory state while I/O is slow, never queue
      // an unbounded series of full snapshots behind the active replacement.
      this.#pending = this.#drain().finally(() => {
        this.#writing = false;
      });
    }
    await this.#pending;
    if (this.#error)
      throw new Error("流式片段保存失败", { cause: this.#error });
  }
  async #drain() {
    while (this.#dirty) {
      this.#dirty = false;
      const value = JSON.stringify({
        schemaVersion: 1,
        sessionId: this.#sessionId,
        updatedAt: new Date().toISOString(),
        truncated: this.#truncated,
        attempts: [...this.#attempts.values()].map(
          ({ lastIndex, ...attempt }) => attempt,
        ),
      });
      try {
        await this.write(this.path, value + "\n");
      } catch (error) {
        this.#error = error;
      }
    }
  }
  async close() {
    this.#closed = true;
    await this.flush();
  }
}

/** Treat captured text as a reference, never a completed proposal. */
export function readStreamPartial(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 32
  )
    return {};
  let total = 0;
  const texts = [];
  for (const attempt of value.attempts) {
    if (
      typeof attempt?.text !== "string" ||
      (total += attempt.text.length) > 120000
    )
      return {};
    if (attempt.text.trim()) texts.push(attempt.text);
  }
  if (!texts.length) return {};
  return {
    candidate: texts.join("\n\n"),
    partialCandidate: true,
    partialSource: "stream",
    streamTruncated:
      value.truncated === true ||
      value.attempts.some((attempt) => attempt.truncated === true),
  };
}
