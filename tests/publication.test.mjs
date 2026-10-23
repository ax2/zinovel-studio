import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  makePublicationSnapshot,
  verifyPublicationSnapshot,
  publicationText,
  publicationHtml,
} from "../packages/novel-domain/publication.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const body =
    "旧信有一道蓝印。𠮷 🌊\r\n\r\n<script>globalThis.authorLeak=true</script>";
  return {
    id: randomUUID(),
    createdAt: "2026-10-24T00:00:00.000Z",
    bookId: randomUUID(),
    bookRevision: 2,
    metadata: {
      title: '雾港 <秘密> "书"',
      author: "合成作者",
      synopsis: "合成试读",
      rights: "作者保留作品权利",
      aiDisclosure: "测试数据",
    },
    chapters: [
      {
        id: randomUUID(),
        title: '第一章 "旧信"',
        volumeTitle: "卷一",
        revision: 3,
        savedHash: digest("旧稿"),
        bodyHash: digest(body),
        body,
      },
      {
        id: randomUUID(),
        title: "第二章 渡口",
        volumeTitle: "卷一",
        revision: 1,
        savedHash: digest("最后一段。"),
        bodyHash: digest("最后一段。"),
        body: "最后一段。",
      },
    ],
  };
}
test("publication freezes an exact content projection independent of snapshot identity and later author edits", () => {
  const input = fixture(),
    snapshot = makePublicationSnapshot(input),
    same = makePublicationSnapshot({
      ...input,
      id: randomUUID(),
      createdAt: "2026-10-25T00:00:00.000Z",
    });
  assert.equal(snapshot.hash, same.hash);
  assert.notEqual(snapshot.id, same.id);
  assert.ok(Object.isFrozen(snapshot.content.chapters[0]));
  const before = JSON.stringify(snapshot);
  input.metadata.title = "作者后改书名";
  input.chapters[0].body = "作者后改正文";
  input.chapters.reverse();
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(verifyPublicationSnapshot(snapshot), snapshot);
  assert.throws(() => {
    snapshot.content.chapters.push({});
  }, TypeError);
});
test("loaded publication snapshots reject future schema, tampered bytes, duplicate identities and unexpected private fields", () => {
  const original = makePublicationSnapshot(fixture()),
    alter = (fn) => {
      const item = structuredClone(original);
      fn(item);
      return item;
    };
  assert.throws(
    () => verifyPublicationSnapshot(alter((s) => (s.schemaVersion = 2))),
    /版本/,
  );
  assert.throws(
    () =>
      verifyPublicationSnapshot(
        alter((s) => (s.content.chapters[0].body += "外部改稿")),
      ),
    /正文/,
  );
  assert.throws(
    () =>
      verifyPublicationSnapshot(
        alter((s) => (s.content.metadata.title = "伪造书名")),
      ),
    /清单/,
  );
  assert.throws(
    () =>
      verifyPublicationSnapshot(
        alter((s) => (s.content.chapters[1].id = s.content.chapters[0].id)),
      ),
    /重复/,
  );
  assert.throws(
    () =>
      verifyPublicationSnapshot(
        alter((s) => (s.content.metadata.notes = "AUTHOR_PRIVATE_SENTINEL")),
      ),
    /格式/,
  );
  assert.throws(
    () =>
      verifyPublicationSnapshot(
        alter((s) => (s.content.chapters[0].futurePlot = "FUTURE_SECRET")),
      ),
    /格式/,
  );
  assert.throws(
    () => verifyPublicationSnapshot(alter((s) => (s.id = "../../source"))),
    /身份/,
  );
  assert.throws(
    () => makePublicationSnapshot({ ...fixture(), chapters: [] }),
    /为空/,
  );
  const bad = fixture();
  bad.chapters[0].body = "\ud800";
  bad.chapters[0].bodyHash = digest(bad.chapters[0].body);
  assert.throws(() => makePublicationSnapshot(bad), /Unicode/);
  assert.equal(
    JSON.stringify(original).includes("AUTHOR_PRIVATE_SENTINEL"),
    false,
  );
});
test("text exports preserve selected order and exact Unicode manuscript strings without rewriting the snapshot", () => {
  const snapshot = makePublicationSnapshot(fixture()),
    before = JSON.stringify(snapshot);
  for (const format of ["txt", "md"]) {
    const output = publicationText(snapshot, format);
    assert.ok(output.includes(snapshot.content.chapters[0].body));
    assert.ok(output.includes(snapshot.content.chapters[1].body));
    assert.ok(
      output.indexOf(snapshot.content.chapters[0].body) <
        output.indexOf(snapshot.content.chapters[1].body),
    );
    assert.equal(output.match(/卷一/g).length, 1);
    assert.ok(output.endsWith("最后一段。\n"));
  }
  assert.throws(() => publicationText(snapshot, "pdf"), /不支持/);
  assert.equal(JSON.stringify(snapshot), before);
});
test("standalone HTML uses only validated ID paths, escapes author text, paginates chapters and inventories exact output bytes", () => {
  const snapshot = makePublicationSnapshot(fixture()),
    { files, manifest } = publicationHtml(snapshot),
    [first, last] = snapshot.content.chapters;
  assert.equal(files.size, 6);
  assert.equal(manifest.state, "prepared");
  assert.equal(manifest.snapshotHash, snapshot.hash);
  for (const item of manifest.files) {
    assert.ok(files.has(item.path));
    assert.equal(item.bytes, Buffer.byteLength(files.get(item.path)));
    assert.equal(item.sha256, digest(files.get(item.path)));
    assert.doesNotMatch(item.path, /(?:^|\/)\.\.(?:\/|$)|\\/);
  }
  assert.equal(manifest.hash, digest(JSON.stringify(manifest.files)));
  const page = files.get(`chapters/${first.id}.html`);
  assert.ok(
    page.includes("&lt;script&gt;globalThis.authorLeak=true&lt;/script&gt;"),
  );
  assert.equal(page.includes("<script>globalThis.authorLeak"), false);
  assert.ok(page.includes(`rel="next" href="${last.id}.html"`));
  assert.equal(page.includes('rel="prev"'), false);
  assert.ok(
    files
      .get(`chapters/${last.id}.html`)
      .includes(`rel="prev" href="${first.id}.html"`),
  );
  assert.equal(
    files.get(`chapters/${last.id}.html`).includes('rel="next"'),
    false,
  );
  assert.ok(files.get("index.html").includes(`chapters/${last.id}.html`));
  assert.equal(files.get("index.html").includes(first.body), false);
  assert.ok(page.includes('content="width=device-width,initial-scale=1"'));
  assert.doesNotMatch(
    files.get("reader.js"),
    /fetch\(|XMLHttpRequest|window\.novel|require\(/,
  );
  assert.ok(page.includes("script-src 'self'"));
});
