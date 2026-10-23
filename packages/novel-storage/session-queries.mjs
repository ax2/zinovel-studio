import { ContinuityQueries } from "./continuity-queries.mjs";
/** Independent mounted selectors must not supersede another selector's scan. */
export class SessionQueries {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
  }
  token(request) {
    if (
      !request ||
      typeof request.sessionId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(request.sessionId) ||
      !Number.isSafeInteger(request.requestId) ||
      request.requestId < 1
    )
      throw new Error("参考资料查询身份无效");
    return request.sessionId;
  }
  async query(bookId, options, request) {
    const key = this.token(request);
    let entry = this.sessions.get(key);
    if (!entry) {
      if (this.sessions.size >= 32)
        throw new Error("参考资料查询过多，请关闭不用的窗口");
      entry = { queries: new ContinuityQueries(this.store), pending: 0 };
      this.sessions.set(key, entry);
    }
    entry.pending++;
    try {
      return await entry.queries.query(bookId, options, request);
    } finally {
      if (--entry.pending === 0 && this.sessions.get(key) === entry)
        this.sessions.delete(key);
    }
  }
  cancel(request) {
    const key = this.token(request);
    return this.sessions.get(key)?.queries.cancel(request) || false;
  }
  cancelAll() {
    for (const entry of this.sessions.values()) entry.queries.cancelAll();
    this.sessions.clear();
  }
}
