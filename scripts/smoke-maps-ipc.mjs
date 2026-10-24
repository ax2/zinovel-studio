import { _electron as electron } from "playwright";
import electronPath from "electron";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache/maps-ipc-")),
  data = join(work, "data"),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("地图宿主验收", [
    { title: "旧信", body: "原稿不受地图改变。𠮷🌊" },
  ]),
  other = await store.createBook("另一部书");
const location = await store.materials.save(book.id, {
  kind: "location",
  title: "雾港",
  notes: "合成地点",
  status: "planned",
  fields: {},
  chapterIds: [],
});
const foreign = await store.materials.save(other.id, {
  kind: "location",
  title: "外书地点",
  notes: "",
  status: "planned",
  fields: {},
  chapterIds: [],
});
const bytes = await sharp({
  create: { width: 80, height: 40, channels: 3, background: "#126b83" },
})
  .withMetadata({ orientation: 6 })
  .jpeg()
  .toBuffer();
const asset = await store.assets.import(book.id, bytes, {
  title: "合成地图",
  purpose: "map",
  source: "程序合成",
  rights: "本地验收",
  notes: "",
  linkedIds: [],
});
const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    book.chapters[0].id + ".md",
  ),
  manuscriptBefore = await readFile(manuscript),
  otherBefore = await readFile(join(data, "library", other.id, "book.json"));
const output = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-006",
  "maps-ipc",
);
await mkdir(output, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  scope:
    "Real Electron author workspace and host IPC, including native image decode and actual file transactions; map editing UI is not tested here",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const fields = (record) =>
  Object.fromEntries(
    ["title", "notes", "era", "canvas", "scale", "elements"].map((key) => [
      key,
      record[key],
    ]),
  );
const hash = (value) => createHash("sha256").update(value).digest("hex");
const a = {
    id: randomUUID(),
    kind: "place",
    title: "雾港",
    notes: "",
    point: { x: 0, y: 0 },
    locationId: location.id,
  },
  b = {
    id: randomUUID(),
    kind: "place",
    title: "石桥",
    notes: "",
    point: { x: 1, y: 1 },
    locationId: null,
  };
const input = {
  title: "河历三年地图𠮷🌊",
  era: "河历三年",
  notes: "手绘计划，不自动成为正文事实",
  canvas: { width: 1000, height: 700 },
  scale: null,
  elements: [
    a,
    b,
    {
      id: randomUUID(),
      kind: "region",
      title: "旧城湾",
      notes: "",
      locationId: null,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    },
    {
      id: randomUUID(),
      kind: "route",
      title: "渡口旧路",
      notes: "",
      fromId: a.id,
      toId: b.id,
      via: [],
      travelNotes: "行程由作者决定",
    },
  ],
};
let app, page, owned;
try {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? work : root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      report.errors.push(message.text());
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("Unexpected page HTTP request");
  });
  await page.waitForURL(/\/workbench\/index\.html$/);
  assert.equal(await page.title(), "ZiNovel Studio");
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  assert.ok(await page.getByLabel("正文编辑器").isVisible());
  assert.equal(
    await page.evaluate(
      () =>
        typeof window.require === "undefined" && typeof process === "undefined",
    ),
    true,
  );
  const request = (action, payload) =>
    page.evaluate(
      ({ action, payload }) => window.novel.request(action, payload),
      { action, payload },
    );
  await assert.rejects(request("maps.unknown", { bookId: book.id }), /不支持/);
  await assert.rejects(
    request("maps.create", { bookId: book.id, input }),
    /身份/,
  );
  const creationId = randomUUID();
  let map = await request("maps.create", {
    bookId: book.id,
    input,
    creationId,
  });
  assert.equal(map.id, creationId);
  assert.equal(map.elements.length, 4);
  assert.equal((await request("maps.list", { bookId: other.id })).total, 0);
  await assert.rejects(
    request("maps.create", {
      bookId: book.id,
      creationId: randomUUID(),
      input: { ...input, elements: [{ ...a, locationId: foreign.id }] },
    }),
  );
  const updatedInput = { ...fields(map), title: "作者调整后的地图" };
  map = await request("maps.save", {
    bookId: book.id,
    input: updatedInput,
    expected: map,
  });
  assert.equal(
    (await request("maps.create", { bookId: book.id, input, creationId }))
      .revision,
    map.revision,
  );
  map = await request("maps.set-background", {
    bookId: book.id,
    expected: map,
    asset,
  });
  assert.deepEqual(map.canvas, { width: 40, height: 80 });
  const preview = await request("maps.preview", {
    bookId: book.id,
    expected: map,
  });
  assert.equal(preview.background.record.blob.sha256, asset.blob.sha256);
  assert.match(preview.dataUrl, /^data:image\/png;base64,/);
  report.checks.push(
    "real isolated main-window IPC creates/edits a typed map with stable place/region/route IDs; creation reconciliation returns the later version; foreign location and missing creation identity reject without writes; actual JPEG decode freezes EXIF-oriented background",
  );
  const file = join(data, "library", book.id, "world/maps", map.id + ".json"),
    external = JSON.parse(await readFile(file, "utf8"));
  external.title = "同修订外部地图";
  const rawExternal = JSON.stringify(external, null, 2) + "\n";
  await writeFile(file, rawExternal);
  await assert.rejects(
    request("maps.save", {
      bookId: book.id,
      input: { ...fields(map), title: "过期作者调整" },
      expected: map,
    }),
    /已被其他/,
  );
  assert.equal(await readFile(file, "utf8"), rawExternal);
  const disk = await request("maps.read", { bookId: book.id, id: map.id });
  map = await request("maps.save", {
    bookId: book.id,
    input: { ...fields(disk), title: "明确对照后保存" },
    expected: disk,
  });
  const history = await request("maps.history", {
    bookId: book.id,
    id: map.id,
  });
  const previous = history.items.find(
    (record) => record.diskHash === disk.diskHash,
  );
  assert.ok(previous);
  assert.match(
    (
      await request("maps.preview", {
        bookId: book.id,
        expected: previous,
        historical: true,
      })
    ).dataUrl,
    /^data:image\/png;base64,/,
  );
  map = await request("maps.restore-version", {
    bookId: book.id,
    expected: map,
    historical: previous,
  });
  assert.equal(map.title, external.title);
  assert.equal(map.elements[0].id, a.id);
  map = await request("maps.delete", {
    bookId: book.id,
    expected: map,
    deleted: true,
  });
  assert.equal((await request("maps.list", { bookId: book.id })).total, 0);
  assert.equal(
    (
      await request("maps.list", {
        bookId: book.id,
        options: { deleted: true },
      })
    ).total,
    1,
  );
  map = await request("maps.delete", {
    bookId: book.id,
    expected: map,
    deleted: false,
  });
  const withoutBackground = await request("maps.clear-background", {
    bookId: book.id,
    expected: map,
  });
  assert.equal(withoutBackground.background, null);
  const beforeCorruption = await readFile(file),
    malformed = Buffer.from([0xc3, 0x28]);
  await writeFile(file, malformed);
  await assert.rejects(
    request("maps.read", { bookId: book.id, id: map.id }),
    /UTF-8/,
  );
  assert.equal(
    (await request("maps.list", { bookId: book.id })).errors.length,
    1,
  );
  assert.deepEqual(await readFile(file), malformed);
  await writeFile(file, beforeCorruption); // Explicit synthetic repair, not application auto-repair.
  assert.equal(
    (await request("maps.creation", { bookId: book.id, id: creationId }))
      .revision,
    withoutBackground.revision,
  );
  report.checks.push(
    "actual host save rejects same-revision external edit and retains bytes; explicit new baseline saves external preimage history, historical background preview/adoption creates a new revision; map recycle/restore and clear background preserve identities; malformed UTF-8 remains byte-identical until explicit synthetic repair",
  );
  assert.equal(await request("atlas.read", { bookId: book.id }), null);
  const child = await request("maps.create", {
    bookId: book.id,
    creationId: randomUUID(),
    input: { ...input, title: "雾港城市子图", elements: [] },
  });
  const foreignMap = await request("maps.create", {
    bookId: other.id,
    creationId: randomUUID(),
    input: { ...input, title: "同名但外书", elements: [] },
  });
  const epoch = { id: randomUUID(), title: "河历三年", notes: "作者手工分组" };
  const atlasInput = {
    notes: "作者地图册，不转换坐标",
    epochs: [epoch],
    entries: [
      {
        mapId: map.id,
        parentId: null,
        anchorId: null,
        epochId: null,
        notes: "",
      },
      {
        mapId: child.id,
        parentId: map.id,
        anchorId: a.id,
        epochId: epoch.id,
        notes: "从世界图城门进入城市图",
      },
    ],
  };
  await assert.rejects(
    request("atlas.save", {
      bookId: book.id,
      input: {
        ...atlasInput,
        entries: [{ ...atlasInput.entries[0], mapId: foreignMap.id }],
      },
      expected: null,
    }),
  );
  let atlas = await request("atlas.save", {
    bookId: book.id,
    input: atlasInput,
    expected: null,
  });
  const atlasRows = await request("atlas.inspect", {
    bookId: book.id,
    options: { epochId: epoch.id },
  });
  assert.equal(atlasRows.total, 1);
  assert.equal(atlasRows.rows[0].entry.mapId, child.id);
  assert.equal(atlasRows.rows[0].anchorState, "ready");
  const atlasFile = join(data, "library", book.id, "world/map-atlas.json"),
    atlasExternal = JSON.parse(await readFile(atlasFile, "utf8"));
  atlasExternal.notes = "同修订的真实外部地图册调整";
  const atlasExternalRaw = JSON.stringify(atlasExternal, null, 2) + "\n";
  await writeFile(atlasFile, atlasExternalRaw);
  await assert.rejects(
    request("atlas.save", {
      bookId: book.id,
      input: { ...atlasInput, notes: "过期本机输入" },
      expected: atlas,
    }),
    /其他操作/,
  );
  assert.equal(await readFile(atlasFile, "utf8"), atlasExternalRaw);
  const atlasBaseline = await request("atlas.read", { bookId: book.id });
  atlas = await request("atlas.save", {
    bookId: book.id,
    input: { ...atlasInput, notes: "明确采用磁盘基线后的说明" },
    expected: atlasBaseline,
  });
  const atlasHistory = await request("atlas.history", { bookId: book.id });
  assert.equal(atlasHistory.items[0].notes, atlasExternal.notes);
  atlas = await request("atlas.restore-version", {
    bookId: book.id,
    expected: atlas,
    historical: atlasHistory.items[0],
  });
  assert.equal(atlas.revision, 3);
  assert.equal(atlas.notes, atlasExternal.notes);
  const retiredParent = await request("maps.delete", {
    bookId: book.id,
    expected: withoutBackground,
    deleted: true,
  });
  assert.equal(
    (await request("atlas.inspect", { bookId: book.id })).rows[1].anchorState,
    "parent-unavailable",
  );
  assert.equal(
    (await request("atlas.read", { bookId: book.id })).diskHash,
    atlas.diskHash,
  );
  await request("maps.delete", {
    bookId: book.id,
    expected: retiredParent,
    deleted: false,
  });
  report.checks.push(
    "actual host atlas IPC persists explicit epoch/parent/anchor IDs, rejects foreign maps and stale raw-hash saves without overwriting external bytes, returns filtered lightweight diagnostics, preserves exact preimage history and adopts it as a new revision; retired parent is disclosed without changing directory references; no atlas editing UI claim",
  );
  await page.screenshot({ path: join(output, "map-host-workspace.png") });
  await app.close();
  app = null;
  await confirmOwnedProcessesExited(owned);
  report.ownedProcessesConfirmedExited = owned.size;
  assert.deepEqual(await readFile(manuscript), manuscriptBefore);
  assert.deepEqual(
    await readFile(join(data, "library", other.id, "book.json")),
    otherBefore,
  );
  assert.deepEqual(
    await readFile(
      join(
        data,
        "library",
        book.id,
        "assets/blobs",
        asset.blob.sha256 + ".jpeg",
      ),
    ),
    bytes,
  );
  assert.deepEqual(report.errors, []);
  report.manuscriptSha256 = hash(manuscriptBefore);
  report.checks.push(
    "actual Electron close retains exact formal manuscript, other-book metadata and selected original image; author workspace is nonblank, renderer has no Node globals, no page errors or external page requests",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.stack;
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  if (app?.process()?.exitCode === null) {
    await app.close();
    await confirmOwnedProcessesExited(owned);
  }
  await writeFile(
    join(output, "maps-ipc-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
