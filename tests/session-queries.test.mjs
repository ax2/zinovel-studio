import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SessionQueries } from "../packages/novel-storage/session-queries.mjs";
test("independent selectors do not supersede each other; same-selector changes and shutdown cancel exact in-flight scans", async () => {
  const calls = [],
    queries = new SessionQueries({
      query: (_book, _options, signal) =>
        new Promise((resolve, reject) => {
          calls.push({ signal, resolve });
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    }),
    a = randomUUID(),
    b = randomUUID();
  const first = queries.query("book", {}, { sessionId: a, requestId: 1 }),
    firstCancelled = assert.rejects(first, { name: "AbortError" }),
    other = queries.query("book", {}, { sessionId: b, requestId: 1 }),
    otherCancelled = assert.rejects(other, { name: "AbortError" });
  assert.equal(calls[0].signal.aborted, false);
  const next = queries.query("book", {}, { sessionId: a, requestId: 2 });
  await firstCancelled;
  assert.equal(calls[1].signal.aborted, false);
  assert.equal(queries.cancel({ sessionId: a, requestId: 1 }), false);
  calls[2].resolve("new");
  assert.equal(await next, "new");
  queries.cancelAll();
  await otherCancelled;
  assert.equal(queries.sessions.size, 0);
  await assert.rejects(
    queries.query("book", {}, { sessionId: "../invalid", requestId: 1 }),
    /身份/,
  );
});
