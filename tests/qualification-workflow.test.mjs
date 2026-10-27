import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
test("manual qualification cannot enter any Release creation/publication step", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.qualification_only.default, true);
  const steps = workflow.jobs.release.steps, writes = steps.filter((s) => /gh release (?:create|edit)/.test(s.run || ""));
  assert.equal(writes.length, 2);
  for (const step of writes) { assert.match(step.if, /github.event_name == 'push'/); assert.match(step.if, /startsWith\(github.ref, 'refs\/tags\/v'\)/); }
  const gate = steps.find((s) => s.run === "node scripts/check-release-ready.mjs");
  assert.match(gate.if, /github.event_name != 'workflow_dispatch'/);
  assert.match(gate.if, /inputs.qualification_only != true/);
});
