import { normalizePublicationLayout } from "./publication-print-options.mjs";
export const defaultPublicationDocxOptions = publicationDocxOptions();
export function publicationDocxOptions(input = {}) {
  return normalizePublicationLayout(input, {
    label: "DOCX",
    paper: "Letter",
    papers: ["Letter", "A4", "A5"],
  });
}
