import type { AssetExpected, AssetStoredRecord } from "./assets.mjs";
export type CharacterLookField =
  | "title"
  | "age"
  | "outfit"
  | "expression"
  | "view"
  | "period"
  | "constraints"
  | "notes";
export type CharacterLookInput = Record<CharacterLookField, string>;
export interface CharacterLookEntry {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  character: AssetExpected;
  asset: { record: AssetStoredRecord; diskHash: string };
  input: CharacterLookInput;
}
export interface CharacterLookExpected {
  revision: number;
  diskHash: string;
}
export interface CharacterLookSelection {
  source: CharacterLookExpected;
  entryId: string;
  entryRevision: number;
  selectedAt: string;
  character: AssetExpected;
}
export interface CharacterLookCollection {
  schemaVersion: 1;
  bookId: string;
  characterId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  entries: CharacterLookEntry[];
  selected: CharacterLookSelection | null;
}
export interface CharacterLookView {
  record: (CharacterLookCollection & { diskHash: string }) | null;
  character: AssetExpected;
  selectedEntry: CharacterLookEntry | null;
  selectedError: string | null;
  characterChanged: boolean;
}
export const characterLookLimits: Readonly<{ entries: number; bytes: number }>;
export const characterLookFields: ReadonlyArray<
  readonly [CharacterLookField, string, number]
>;
export function characterLookInput(
  value: unknown,
  options?: { draft?: boolean },
): CharacterLookInput;
export function characterLookExpected(
  value: unknown,
  withId?: false,
): CharacterLookExpected;
export function characterLookExpected(
  value: unknown,
  withId: true,
): AssetExpected;
export function validateCharacterLooks(
  value: unknown,
  characterId: string,
  origins: string[],
): CharacterLookCollection;
