export type AssetPurpose =
  | "cover"
  | "portrait"
  | "map"
  | "illustration"
  | "reference";
export interface AssetInput {
  title: string;
  purpose: AssetPurpose;
  source: string;
  rights: string;
  notes: string;
  linkedIds: string[];
}
export interface AssetBlob {
  sha256: string;
  bytes: number;
  format: "png" | "jpeg" | "webp";
  mime: string;
  width: number;
  height: number;
  orientation: number;
  displayWidth: number;
  displayHeight: number;
}
export interface AssetExpected {
  id: string;
  revision: number;
  diskHash: string;
}
export interface AssetStoredRecord extends AssetInput {
  id: string;
  revision: number;
  schemaVersion: 1;
  bookId: string;
  creationHash: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  blob: AssetBlob;
}
export interface AssetRecord extends AssetStoredRecord {
  diskHash: string;
}
export const assetPurposes: AssetPurpose[];
export const assetLimits: Readonly<{
  bytes: number;
  pixels: number;
  dimension: number;
  thumbnail: number;
}>;
export function assetId(value: unknown): string;
export function assetHash(value: unknown): string;
export function assetInput(value: unknown): AssetInput;
export function assetDraftInput(value: unknown): AssetInput;
export function validateAssetBlob(value: unknown): AssetBlob;
export function validateAssetRecord(
  value: unknown,
  id: string,
  origins: string[],
): AssetStoredRecord;
