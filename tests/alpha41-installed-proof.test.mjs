import test from "node:test";
import assert from "node:assert/strict";
import { validateAlpha41Installed } from "../scripts/alpha41-installed-proof.mjs";
const target = { version: "0.1.0-alpha.41", appAsarSha256: "a".repeat(64) };
function proof() {
  const reports = Object.fromEntries(
    [
      ["resources", 6],
      ["docx", 2],
      ["pdf", 2],
      ["project", 3],
      ["batch", 5],
    ].map(([key, count]) => [
      key,
      {
        status: "passed",
        ...target,
        packaged: true,
        checks: Array.from(
          { length: count },
          (_, n) => `Synthetic verification ${n + 1}`,
        ),
        errors: [],
      },
    ]),
  );
  reports.docx.cases = [
    {
      name: "actual-author-export",
      status: "passed",
      allTextEditable: true,
      sha256: "b".repeat(64),
      pdfSha256: "c".repeat(64),
      pdfPages: 3,
    },
  ];
  reports.pdf.reports = [
    {
      name: "actual-author-export",
      images: {
        status: "passed",
        placements: [{}, {}],
        pdfSha256: "d".repeat(64),
      },
    },
  ];
  reports.batch.requestCount = 20;
  return reports;
}
test("all new installed author reports must bind to one actual package version and ASAR", () => {
  assert.equal(
    Object.keys(validateAlpha41Installed(proof(), target)).length,
    5,
  );
  for (const key of ["resources", "docx", "pdf", "project", "batch"])
    for (const mutation of [
      (p) => {
        delete p[key];
      },
      (p) => {
        p[key].packaged = false;
      },
      (p) => {
        p[key].version = "0.1.0-alpha.40";
      },
      (p) => {
        p[key].appAsarSha256 = "b".repeat(64);
      },
      (p) => {
        p[key].checks.pop();
      },
    ]) {
      const p = proof();
      mutation(p);
      assert.throws(() => validateAlpha41Installed(p, target));
    }
});
test("source layout cases and incomplete independent image/editability proof cannot replace installed exports", () => {
  for (const mutation of [
    (p) => {
      p.docx.cases.push({ name: "a4-flow" });
    },
    (p) => {
      p.pdf.reports[0].name = "a5-default";
    },
    (p) => {
      p.docx.cases[0].allTextEditable = false;
    },
    (p) => {
      p.pdf.reports[0].images.placements.pop();
    },
    (p) => {
      p.batch.requestCount = 12;
    },
  ]) {
    const p = proof();
    mutation(p);
    assert.throws(() => validateAlpha41Installed(p, target));
  }
});
