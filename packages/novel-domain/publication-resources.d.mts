export interface PublicationResourcePlacement {
  placement: "cover" | "chapter-start" | "chapter-end";
  chapterId: string | null;
  alt: string;
  caption: string;
  credit: string;
}
export interface PublicationResourceSelection
  extends PublicationResourcePlacement {
  readonly asset: Readonly<{ id: string; revision: number; diskHash: string }>;
}
export interface PublicationResourceReference
  extends PublicationResourcePlacement {
  readonly source: Readonly<{
    assetId: string;
    revision: number;
    recordHash: string;
    blobHash: string;
  }>;
  readonly image: Readonly<{
    sha256: string;
    bytes: number;
    width: number;
    height: number;
  }>;
  readonly renderVersion: 1;
}
export const publicationResourceLimits: Readonly<{
  placements: number;
  imageBytes: number;
  totalBytes: number;
}>;
export function publicationResourceSelections(
  input: unknown,
  chapterIds: readonly string[],
): readonly Readonly<PublicationResourceSelection>[];
export function publicationResourceDrafts(
  input: unknown,
): readonly Readonly<PublicationResourceSelection>[];
export function publicationResourceReferences(
  input: unknown,
  chapterIds: readonly string[],
): readonly Readonly<PublicationResourceReference>[];
