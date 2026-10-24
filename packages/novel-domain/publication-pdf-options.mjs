import { normalizePublicationLayout } from "./publication-print-options.mjs";
export const defaultPublicationPdfOptions = publicationPdfOptions();
export function publicationPdfOptions(input = {}) {
  return normalizePublicationLayout(input, {
    label: "PDF",
    paper: "A5",
    papers: ["A4", "A5"],
  });
}
