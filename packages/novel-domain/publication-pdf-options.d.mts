export interface PublicationPdfOptions {
  paper: "A4" | "A5";
  font: "serif" | "sans";
  size: number;
  leading: number;
  margin: "standard" | "wide";
  keepParagraphs: "balanced" | "flow";
}
export const defaultPublicationPdfOptions: Readonly<PublicationPdfOptions>;
export function publicationPdfOptions(
  input?: unknown,
): Readonly<PublicationPdfOptions>;
