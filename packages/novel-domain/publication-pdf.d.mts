import type { PublicationPdfOptions } from "./publication-pdf-options.mjs";
export const publicationPdfInputLimit: number;
export interface PublicationPdfDocument {
  readonly html: string;
  readonly options: Readonly<PublicationPdfOptions>;
  readonly title: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly htmlHash: string;
  readonly templateVersion: number;
}
export function publicationPdfDocument(
  input: unknown,
  layout?: unknown,
): Readonly<PublicationPdfDocument>;
