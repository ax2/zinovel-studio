import type { PublicationResourceReference } from "./publication-resources.mjs";
export interface PublicationMetadata {
  title: string;
  author: string;
  synopsis: string;
  rights: string;
  aiDisclosure: string;
}
export interface PublicationChapter {
  id: string;
  title: string;
  volumeTitle: string;
  revision: number;
  savedHash: string;
  bodyHash: string;
  body: string;
}
export interface PublicationSnapshot {
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly createdAt: string;
  readonly hash: string;
  readonly content: {
    readonly bookId: string;
    readonly bookRevision: number;
    readonly metadata: Readonly<PublicationMetadata>;
    readonly chapters: readonly Readonly<PublicationChapter>[];
    readonly resources?: readonly Readonly<PublicationResourceReference>[];
  };
}
export interface PublicationManifest {
  schemaVersion: 1;
  state: "prepared";
  format: "html";
  snapshotId: string;
  snapshotHash: string;
  files: { path: string; bytes: number; sha256: string }[];
  hash: string;
}
export function publicationMetadata(input: unknown): PublicationMetadata;
export function makePublicationSnapshot(input: {
  id: string;
  createdAt: string;
  bookId: string;
  bookRevision: number;
  metadata: PublicationMetadata;
  chapters: readonly PublicationChapter[];
  resources?: readonly PublicationResourceReference[];
}): PublicationSnapshot;
export function verifyPublicationSnapshot(input: unknown): PublicationSnapshot;
export function publicationText(input: unknown, format: "txt" | "md"): string;
export function publicationHtml(input: unknown): {
  files: Map<string, string>;
  manifest: PublicationManifest;
};
