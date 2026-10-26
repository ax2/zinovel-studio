import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateOriginUpgrade } from "../scripts/origin-upgrade-proof.mjs";
const read = (p) =>
  JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const report = read(
  "../assessments/release/v0.1.0-alpha.39/origin-upgrade-smoke.json",
);
const source = read(
  "../assessments/release/v0.1.0-alpha.38/ci-public/release-manifest.json",
);
const manifest = read(
  "../assessments/release/v0.1.0-alpha.39/release-manifest.json",
);
const target = {
  version: manifest.version,
  sha256: manifest.sha256,
  appAsarSha256: manifest.imageStudio.appAsarSha256,
};
const validate = (r = report, s = source, t = target) =>
  validateOriginUpgrade(r, s, t, source.version);
test("accepts actual archived public38 to local39 origin upgrade evidence", () => {
  const result = validate();
  assert.equal(result.fromVersion, source.version);
  assert.equal(result.checks.length, 8);
  assert.deepEqual(result.originalImportOrigin, report.originalImportOrigin);
});
test("rejects stale source or target installer and runtime bindings", () => {
  for (const key of [
    "previousInstallerSha256",
    "previousAsarSha256",
    "currentInstallerSha256",
    "appAsarSha256",
  ]) {
    const r = structuredClone(report);
    r[key] = "f".repeat(64);
    assert.throws(() => validate(r), key);
  }
  assert.throws(() =>
    validate(report, source, { ...target, version: source.version }),
  );
});
test("rejects missing lifecycle readbacks, preservation claims and extra paid requests", () => {
  for (const key of [
    "originReadbacks",
    "legacyImportReadbacks",
    "sceneTreeReadbacks",
  ]) {
    const r = structuredClone(report);
    r[key] = 2;
    assert.throws(() => validate(r), key);
  }
  for (const key of [
    "importOriginPreserved",
    "legacyImportPreserved",
    "credentialsPreserved",
    "postUninstallDataReadable",
    "previousV2ReceiptPreserved",
  ]) {
    const r = structuredClone(report);
    r[key] = false;
    assert.throws(() => validate(r), key);
  }
  const r = structuredClone(report);
  r.requests.image++;
  assert.throws(() => validate(r));
});
test("rejects altered provenance, manuscript hashes and repeated chapter identities", () => {
  for (const change of [
    (r) => (r.originalImportOrigin.applicationVersion = "0.1.0-alpha.39"),
    (r) => (r.originFiles[0].sha256 = "a".repeat(64)),
    (r) => (r.legacyImportedBook.chapterHashes[0] = "b".repeat(64)),
    (r) => (r.originalImportOrigin.sources[0].bytes = 0),
    (r) =>
      (r.legacyImportedBook.chapterIds[1] = r.legacyImportedBook.chapterIds[0]),
  ]) {
    const r = structuredClone(report);
    change(r);
    assert.throws(() => validate(r));
  }
});
