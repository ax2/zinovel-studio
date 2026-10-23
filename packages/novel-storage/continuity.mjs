import { evidenceKinds } from "../novel-domain/evidence.mjs";
import { orderedChapters } from "../novel-domain/structure.mjs";
import { RelationshipProjection } from "../novel-domain/relationship-graph.mjs";

const identifier = (value) =>
  typeof value === "string" && (!value || /^[0-9a-f-]{36}$/.test(value));

/** Read-only projection. Domain files remain authoritative; no inferred facts. */
export class ContinuityStore {
  constructor(storage, materials) {
    this.storage = storage;
    this.materials = materials;
  }
  async query(bookId, options = {}) {
    const {
      kind = "",
      scope = "",
      ownerId = "",
      relatedId = "",
      participantId = "",
      eventId = "",
      chapterId = "",
      state = "",
      query = "",
      offset = 0,
      includeRelations = false,
    } = options;
    if (
      !["", ...evidenceKinds.map((item) => item.id)].includes(kind) ||
      !["", "world", "reader", "character"].includes(scope) ||
      !["", "current", "stale", "missing", "retired", "deleted"].includes(
        state,
      ) ||
      ![ownerId, relatedId, chapterId, participantId, eventId].every(
        identifier,
      ) ||
      typeof includeRelations !== "boolean" ||
      typeof query !== "string" ||
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000
    )
      throw new Error("全书证据筛选条件无效");
    const startedAt = new Date().toISOString();
    const owners = [];
    const errors = await this.materials.scan(bookId, (data) => {
      if ((!ownerId || data.id === ownerId) && data.evidence?.length)
        owners.push(data.id);
    });
    owners.sort();
    const items = [],
      needle = query.toLocaleLowerCase();
    const counts = { current: 0, stale: 0, missing: 0, retired: 0, deleted: 0 };
    let total = 0;
    const graph = includeRelations ? new RelationshipProjection() : null;
    // One source card per lock: manuscript saves can run between cards.
    // A scan can span revisions; actions must reread and validate their own target.
    for (const owner of owners) {
      try {
        await this.storage.exclusive(async () => {
          const { root, book } = await this.materials.context(bookId);
          const card = await this.materials.view(
            await this.materials.record(root, owner),
            book,
            root,
          );
          const chapterOrder = new Map(
            orderedChapters(book).map((chapter, index) => [
              chapter.id,
              index + 1,
            ]),
          );
          for (const event of card.evidence) {
            if (
              (kind && event.kind !== kind) ||
              (eventId && event.id !== eventId) ||
              (scope && event.scope !== scope) ||
              (chapterId && event.chapterId !== chapterId) ||
              (participantId &&
                card.id !== participantId &&
                !event.relatedIds.includes(participantId)) ||
              (relatedId && !event.relatedIds.includes(relatedId))
            )
              continue;
            if (
              needle &&
              ![
                card.title,
                event.statement,
                event.storyTime,
                event.chapterTitle,
                event.anchor.quote,
                ...event.related.map((item) => item.title),
              ]
                .join("\n")
                .toLocaleLowerCase()
                .includes(needle)
            )
              continue;
            const condition = card.deletedAt
              ? "deleted"
              : event.status === "retired"
                ? "retired"
                : event.freshness;
            if (!Object.hasOwn(counts, condition))
              throw new Error("证据有效性状态无效");
            counts[condition]++;
            if (state && condition !== state) continue;
            if (
              (total >= offset && items.length < 40) ||
              (graph && event.kind === "relation")
            ) {
              const row = {
                ...event,
                key: `${card.id}/${event.id}`,
                ownerId: card.id,
                ownerTitle: card.title,
                ownerKind: card.kind,
                ownerRevision: card.revision,
                ownerHash: card.diskHash,
                ownerDeleted: !!card.deletedAt,
                condition,
                chapterOrder: chapterOrder.get(event.chapterId) ?? null,
              };
              if (total >= offset && items.length < 40) items.push(row);
              graph?.add(row);
            }
            total++;
          }
        });
      } catch {
        errors.push(`资料 ${owner} 的证据无法读取，原始文件已保留`);
      }
    }
    // Do not return a plausible empty result for a book removed during scanning.
    await this.storage.exclusive(() => this.materials.context(bookId));
    return {
      items,
      total,
      counts,
      errors,
      offset,
      pageSize: 40,
      scannedSources: owners.length,
      startedAt,
      completedAt: new Date().toISOString(),
      consistency: "live-scan",
      order: "source-id-then-record-order",
      ...(graph ? { relationships: graph.result() } : {}),
    };
  }
}
