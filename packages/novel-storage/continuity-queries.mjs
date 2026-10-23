import { randomUUID } from "node:crypto";

const identity = (value) => {
  if (
    !value ||
    typeof value.sessionId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.sessionId) ||
    !Number.isSafeInteger(value.requestId) ||
    value.requestId < 1
  )
    throw new Error("证据查询身份无效");
  return { sessionId: value.sessionId, requestId: value.requestId };
};

/** One workbench per desktop window; stale cleanup may only cancel its own call. */
export class ContinuityQueries {
  #active = null;
  constructor(store) {
    this.store = store;
  }
  async query(bookId, options, request) {
    const token =
      request?.sessionId === undefined && request?.requestId === undefined
        ? { sessionId: randomUUID(), requestId: 1 }
        : identity(request);
    this.cancelAll();
    const controller = new AbortController();
    this.#active = { ...token, controller };
    try {
      return await this.store.query(bookId, options, controller.signal);
    } finally {
      if (this.#active?.controller === controller) this.#active = null;
    }
  }
  cancel(request) {
    const token = identity(request),
      current = this.#active;
    if (
      !current ||
      current.sessionId !== token.sessionId ||
      current.requestId !== token.requestId ||
      current.controller.signal.aborted
    )
      return false;
    current.controller.abort(new DOMException("证据查询已取消", "AbortError"));
    return true;
  }
  cancelAll() {
    this.#active?.controller.abort(
      new DOMException("证据查询已取消", "AbortError"),
    );
  }
}
