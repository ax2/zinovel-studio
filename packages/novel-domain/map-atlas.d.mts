export interface MapEpoch {
  id: string;
  title: string;
  notes: string;
}
export interface MapAtlasEntry {
  mapId: string;
  parentId: string | null;
  anchorId: string | null;
  epochId: string | null;
  notes: string;
}
export interface MapAtlasInput {
  notes: string;
  epochs: MapEpoch[];
  entries: MapAtlasEntry[];
}
export interface MapAtlasStoredRecord extends MapAtlasInput {
  schemaVersion: 1;
  bookId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface MapAtlasRecord extends MapAtlasStoredRecord {
  diskHash: string;
}
export const atlasLimits: Readonly<{
  entries: number;
  epochs: number;
  depth: number;
  bytes: number;
}>;
export function mapAtlasInput(value: unknown): MapAtlasInput;
export function mapAtlasDraftInput(value: unknown): MapAtlasInput;
export interface MapAtlasReference {
  revision: number;
  diskHash: string;
}
export interface MapAtlasDraft {
  schemaVersion: 1;
  bookId: string;
  expected: MapAtlasReference | null;
  input: MapAtlasInput;
  selectedMapId: string | null;
}
export function parseMapAtlasDraft(raw: unknown, bookId: string): MapAtlasDraft;
export function validateMapAtlasRecord(
  value: unknown,
  origins: string[],
): MapAtlasStoredRecord;
