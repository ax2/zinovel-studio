/** Bounded visual projection. Every admitted event keeps ALL associated targets. */
export class RelationshipProjection {
  constructor({ nodeLimit = 24, eventLimit = 60 } = {}) {
    this.nodeLimit = nodeLimit;
    this.eventLimit = eventLimit;
    this.nodes = new Map();
    this.events = [];
    this.totalEvents = 0;
  }
  add(row) {
    if (row.kind !== "relation") return;
    this.totalEvents++;
    const candidates = [
      {
        id: row.ownerId,
        title: row.ownerTitle,
        kind: row.ownerKind,
        state: row.ownerDeleted ? "deleted" : "active",
      },
      ...row.related.map((target) => ({
        id: target.id,
        title: target.title,
        kind: target.kind || "unknown",
        state: target.state,
      })),
    ];
    const additional = new Set(
      candidates
        .filter((node) => !this.nodes.has(node.id))
        .map((node) => node.id),
    );
    if (
      this.events.length >= this.eventLimit ||
      this.nodes.size + additional.size > this.nodeLimit
    )
      return;
    for (const node of candidates) {
      const prior = this.nodes.get(node.id);
      if (!prior)
        this.nodes.set(node.id, { ...node, changedDuringScan: false });
      else if (
        prior.title !== node.title ||
        prior.state !== node.state ||
        prior.kind !== node.kind
      )
        prior.changedDuringScan = true;
    }
    this.events.push({ ...row, number: this.events.length + 1 });
  }
  result() {
    return {
      nodes: [...this.nodes.values()],
      events: this.events,
      totalEvents: this.totalEvents,
      omittedEvents: this.totalEvents - this.events.length,
      nodeLimit: this.nodeLimit,
      eventLimit: this.eventLimit,
    };
  }
}
