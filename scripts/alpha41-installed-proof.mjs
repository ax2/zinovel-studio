const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
/** Only author-executable reports qualify here; source layout reports cannot stand in for them. */
export function validateAlpha41Installed(reports, target) {
  if (!sha(target.appAsarSha256) || typeof target.version !== "string")
    throw new Error("Installed target identity is missing");
  for (const [key, count] of [
    ["resources", 6],
    ["docx", 2],
    ["pdf", 2],
    ["project", 3],
    ["batch", 5],
  ]) {
    const r = reports[key];
    if (
      !r ||
      r.status !== "passed" ||
      r.version !== target.version ||
      r.packaged !== true ||
      r.appAsarSha256 !== target.appAsarSha256 ||
      !Array.isArray(r.checks) ||
      r.checks.length !== count ||
      r.checks.some((c) => typeof c !== "string" || !c.trim()) ||
      (r.errors !== undefined && (!Array.isArray(r.errors) || r.errors.length))
    )
      throw new Error(
        `Installed ${key} author proof is missing, stale or from another executable`,
      );
  }
  if (reports.batch.requestCount !== 20)
    throw new Error("Installed batch request/recovery proof is incomplete");
  if (
    !Array.isArray(reports.docx.cases) ||
    reports.docx.cases.length !== 1 ||
    reports.docx.cases[0].name !== "actual-author-export" ||
    !Array.isArray(reports.pdf.reports) ||
    reports.pdf.reports.length !== 1 ||
    reports.pdf.reports[0].name !== "actual-author-export"
  )
    throw new Error(
      "Source-generator layout cases cannot qualify installed author exports",
    );
  const docx = reports.docx.cases[0],
    pdf = reports.pdf.reports[0];
  if (
    docx.status !== "passed" ||
    docx.allTextEditable !== true ||
    !sha(docx.sha256) ||
    !sha(docx.pdfSha256) ||
    !Number.isSafeInteger(docx.pdfPages) ||
    docx.pdfPages < 1 ||
    pdf.images?.status !== "passed" ||
    !Array.isArray(pdf.images?.placements) ||
    pdf.images.placements.length !== 2 ||
    !sha(pdf.images.pdfSha256)
  )
    throw new Error(
      "Installed illustrated document independent inspection is incomplete",
    );
  return Object.fromEntries(
    Object.entries(reports).map(([key, r]) => [
      key,
      {
        version: r.version,
        appAsarSha256: r.appAsarSha256,
        checks: r.checks,
        scope: r.scope,
      },
    ]),
  );
}
