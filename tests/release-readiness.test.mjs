import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseReadiness } from "../scripts/check-release-ready.mjs";
test("stage preview qualification never bypasses stable product gate or accepts stale/failed/traversing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-release-gate-"));
  await mkdir(join(root, "plan"));
  await mkdir(join(root, "iterations/releases"), { recursive: true });
  const write = (path, value) =>
    writeFile(join(root, path), JSON.stringify(value));
  await write("package.json", { version: "0.1.0-alpha.8" });
  await write("stage.md", {});
  await write("report.json", { status: "passed" });
  await write("iterations/releases/v0.1.0-alpha.8.md", {});
  const preview = {
    schemaVersion: 1,
    version: "0.1.0-alpha.8",
    ready: true,
    evidence: ["stage.md"],
    reports: ["report.json"],
    limitations: ["Preview only"],
  };
  await write("plan/preview-readiness.json", preview);
  await write("plan/release-readiness.json", {
    schemaVersion: 1,
    ready: false,
    checks: [],
  });
  await write("plan/features.json", { features: [{ status: "planned" }] });
  assert.equal(releaseReadiness(root).allowed, true);
  await write("package.json", { version: "0.1.0" });
  assert.equal(releaseReadiness(root).channel, "stable");
  assert.equal(releaseReadiness(root).allowed, false);
  await write("package.json", { version: "0.1.0-alpha.9" });
  assert.equal(releaseReadiness(root).allowed, false);
  await write("package.json", { version: "0.1.0-alpha.8" });
  await write("report.json", { status: "failed" });
  assert.equal(releaseReadiness(root).allowed, false);
  await write("report.json", { status: "passed" });
  await write("plan/preview-readiness.json", {
    ...preview,
    evidence: ["../stage.md"],
  });
  assert.equal(releaseReadiness(root).allowed, false);
  await write("package.json", { version: "0.1.0-preview.8" });
  assert.equal(releaseReadiness(root).allowed, false);
});
