import type { PublicationDocxOptions } from "./publication-docx-options.mjs";
export const publicationDocxLimits: Readonly<{
  bytes: number;
  paragraphs: number;
  breaks: number;
}>;
export function publicationDocx(
  input: unknown,
  layout?: unknown,
  inputImages?: Map<string, Uint8Array>,
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
    illustrationCount: number;
    embeddedImages: readonly Readonly<{
      sha256: string;
      bytes: number;
      width: number;
      height: number;
    }>[];
  }>
>;
