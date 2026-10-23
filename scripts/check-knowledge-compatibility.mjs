import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve("."),
  old = process.argv[2] || "89fdc6a95f2a503720ab771408ea13e350111f66";
const work = await mkdtemp(join(root, ".cache", "knowledge-old-writer-"));
const tree = execFileSync(
  "git",
  [
    "ls-tree",
    "-r",
    "--name-only",
    old,
    "--",
    "packages/novel-domain",
    "packages/novel-storage",
  ],
  { encoding: "utf8", windowsHide: true },
)
  .trim()
  .split(/\r?\n/);
for (const file of tree) {
  const target = resolve(work, file),
    inside = relative(work, target);
  assert.ok(!inside.startsWith("..") && !isAbsolute(inside));
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(
    target,
    execFileSync("git", ["show", `${old}:${file}`], { windowsHide: true }),
  );
}
await writeFile(join(work, "package.json"), '{"type":"module"}');
const { NovelStore: OldStore } = await import(
  pathToFileURL(join(work, "packages/novel-storage/store.mjs")).href
);
const library = join(work, "library"),
  store = new NovelStore(library);
const book = await store.importBook("旧写入器兼容合成稿", [
  { title: "来信", body: "林舟认出了旧船的蓝印。" },
]);
const make = (kind, title) =>
  store.materials.save(book.id, {
    kind,
    title,
    status: "planned",
    fields:
      kind === "proposition"
        ? { claim: "船主寄来了信", truthIntent: "尚未确定" }
        : {},
    notes: "",
    chapterIds: [],
  });
const proposition = await make("proposition", "寄信人"),
  person = await make("character", "林舟"),
  chapter = await store.readChapter(book.id, book.chapters[0].id);
const source = {
  chapterId: chapter.id,
  body: chapter.body,
  hash: chapter.diskHash,
  start: 0,
  end: 8,
};
const legacyOwner = await store.materials.mutateEvidence(book.id, person, {
  action: "add",
  kind: "knowledge",
  scope: "character",
  statement: "旧记录只说明林舟看见蓝印。",
  storyTime: "抵港日",
  relatedIds: [],
  source,
});
const legacy = await store.knowledge.legacy.preview(
  book.id,
  person.id,
  legacyOwner.evidence[0].id,
);
const event = await store.knowledge.linkLegacy(
  book.id,
  {
    propositionId: proposition.id,
    scope: "character",
    characterId: person.id,
    state: "suspects",
    statement: "林舟怀疑船主寄信。",
    storyTime: "抵港日",
  },
  legacy,
  {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  },
);
const protectedFiles = [
  `materials/${proposition.id}.json`,
  `knowledge/events/${event.id}.json`,
  `knowledge/origins/${event.id}.json`,
  `manuscript/${chapter.id}.md`,
];
const before = await Promise.all(
  protectedFiles.map((p) => readFile(join(library, book.id, p))),
);
const oldStore = new OldStore(library);
if (!oldStore.knowledge) {
  await assert.rejects(
    oldStore.materials.read(book.id, proposition.id),
    /未知创作资料类型/,
  );
  await assert.rejects(
    oldStore.materials.save(book.id, proposition, proposition),
    /未知创作资料类型/,
  );
  assert.equal((await oldStore.materials.list(book.id)).errors.length, 1);
} else {
  assert.equal(
    (await oldStore.materials.read(book.id, proposition.id)).id,
    proposition.id,
  );
}
const oldPerson = await oldStore.materials.read(book.id, person.id);
await oldStore.materials.save(
  book.id,
  { ...oldPerson, notes: "旧版本明确修改人物笔记" },
  oldPerson,
);
for (let i = 0; i < protectedFiles.length; i++)
  assert.deepEqual(
    await readFile(join(library, book.id, protectedFiles[i])),
    before[i],
  );
assert.equal(
  (await store.knowledge.read(book.id, event.id)).freshness,
  "stale",
);
const report = {
  status: "passed",
  oldSource: old,
  currentSource: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  method:
    "actual pinned historical domain/storage modules executed in Node; no old desktop installation or full downgrade qualification",
  checks: [
    oldStore.knowledge
      ? "old reader supports proposition; no unrelated read mutates source"
      : "old material reader and writer reject new proposition kind without overwriting its source",
    "old supported-card edit leaves independent knowledge event, new proposition and manuscript byte-for-byte unchanged",
    "new reader detects old supported-card definition change as stale",
  ],
};
if (oldStore.knowledge) {
  const originPath = join(
      library,
      book.id,
      `knowledge/origins/${event.id}.json`,
    ),
    originBefore = await readFile(originPath),
    oldEvent = await oldStore.knowledge.read(book.id, event.id);
  await oldStore.knowledge.save(
    book.id,
    { ...oldEvent, statement: "旧写入器明确重新绑定的合成认知" },
    oldEvent,
    source,
  );
  assert.deepEqual(await readFile(originPath), originBefore);
  const viewed = await store.knowledge.read(book.id, event.id);
  assert.equal(viewed.origin.targetChanged, true);
  assert.equal(viewed.origin.source.event.id, legacy.eventId);
  report.checks.push(
    "old knowledge writer can explicitly rebind its supported event without erasing frozen provenance; new reader discloses changed target version",
  );
}
await writeFile(join(work, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ work, report }, null, 2));
