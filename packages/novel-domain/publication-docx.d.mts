import type { PublicationDocxOptions } from "./publication-docx-options.mjs";
export const publicationDocxLimits: Readonly<{
  bytes: number;
  paragraphs: number;
  breaks: number;
}>;
export function publicationDocx(
  input: unknown,
  layout?: unknown,
): Promise<
  Readonly<{
    bytes: Buffer;
    options: Readonly<PublicationDocxOptions>;
    templateVersion: number;
    snapshotId: string;
    snapshotHash: string;
    recipeHash: string;
    engine: string;
    paragraphCount: number;
  }>
>;
