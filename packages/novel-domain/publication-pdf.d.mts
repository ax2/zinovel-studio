import type { PublicationPdfOptions } from "./publication-pdf-options.mjs";
import type { PublicationResourceReference } from "./publication-resources.mjs";
export const publicationPdfInputLimit: number;
export interface PublicationPdfDocument {
  readonly html: string;
  readonly options: Readonly<PublicationPdfOptions>;
  readonly title: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly htmlHash: string;
  readonly templateVersion: number;
  readonly resources?: readonly Readonly<PublicationResourceReference>[];
}
export function publicationPdfDocument(
  input: unknown,
  layout?: unknown,
): Readonly<PublicationPdfDocument>;
