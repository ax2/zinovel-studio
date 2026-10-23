import test from "node:test";
import assert from "node:assert/strict";
import { RelationshipProjection } from "../packages/novel-domain/relationship-graph.mjs";

const row = (key, source, targets, changes = {}) => ({
  key,
  id: key,
  ownerId: source,
  ownerTitle: source,
  ownerKind: "character",
  ownerDeleted: false,
  kind: "relation",
  statement: "人物记录的关系变化",
  storyTime: "往事",
  condition: "current",
  chapterId: "chapter-1",
  anchor: { quote: "原始正文引文" },
  related: targets.map((id) => ({
    id,
    title: id,
    kind: "character",
    state: "active",
  })),
  ...changes,
});

test("parallel, opposite, multi-target and self relations retain every event and its evidence", () => {
  const graph = new RelationshipProjection();
  const events = [
    row("first", "甲", ["乙"], { statement: "甲信任乙" }),
    row("opposite", "甲", ["乙"], {
      statement: "甲怀疑乙",
      condition: "stale",
    }),
    row("reverse", "乙", ["甲"], { condition: "retired" }),
    row("several", "乙", ["甲", "丙"]),
    row("self", "丙", ["丙"]),
  ];
  for (const event of events) graph.add(event);
  graph.add({ ...events[0], kind: "knowledge" });
  const result = graph.result();
  assert.equal(result.nodes.length, 3);
  assert.equal(result.totalEvents, 5);
  assert.equal(result.events.length, 5);
  assert.equal(result.omittedEvents, 0);
  assert.deepEqual(
    result.events.map((event) => event.key),
    events.map((event) => event.key),
  );
  assert.deepEqual(
    result.events.map((event) => event.condition),
    events.map((event) => event.condition),
  );
  assert.deepEqual(
    result.events[3].related.map((target) => target.id),
    ["甲", "丙"],
  );
  assert.equal(result.events[4].ownerId, result.events[4].related[0].id);
  assert.equal(result.events[1].anchor.quote, "原始正文引文");
  assert.deepEqual(
    result.events.map((event) => event.number),
    [1, 2, 3, 4, 5],
  );
});

test("visual limits omit whole events with honest totals, never just part of an event's targets", () => {
  const graph = new RelationshipProjection({ nodeLimit: 3, eventLimit: 2 });
  graph.add(row("too-wide", "甲", ["乙", "丙", "丁"]));
  graph.add(row("fits", "甲", ["乙", "丙"]));
  graph.add(row("also-fits", "乙", ["甲"]));
  graph.add(row("too-many-events", "乙", ["丙"]));
  const result = graph.result();
  assert.equal(result.totalEvents, 4);
  assert.equal(result.omittedEvents, 2);
  assert.deepEqual(
    result.events.map((event) => event.key),
    ["fits", "also-fits"],
  );
  assert.equal(result.nodes.length, 3);
  assert.equal(result.events[0].related.length, 2);
  assert.equal(result.nodeLimit, 3);
  assert.equal(result.eventLimit, 2);
});

test("deleted and missing nodes remain visible and contradictory scan versions are disclosed", () => {
  const graph = new RelationshipProjection();
  graph.add(
    row("first", "甲", ["乙"], {
      related: [
        { id: "乙", title: "失联人物", kind: "unknown", state: "missing" },
      ],
    }),
  );
  graph.add(
    row("next", "乙", ["甲"], {
      ownerTitle: "乙的新名字",
      ownerDeleted: true,
      condition: "deleted",
    }),
  );
  const result = graph.result(),
    node = result.nodes.find((item) => item.id === "乙");
  assert.equal(node.state, "missing");
  assert.equal(node.changedDuringScan, true);
  assert.equal(result.events[1].condition, "deleted");
  assert.equal(result.events[0].related[0].state, "missing");
});
