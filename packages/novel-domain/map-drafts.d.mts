import type { MapElement, MapInput, MapReference } from "./maps.mjs";
export interface MapCoordinateDraft {
  id: string;
  value: string;
}
export interface MapScaleDraft {
  from: string;
  to: string;
  distance: string;
  unit: string;
}
export interface MapLocalDraft {
  schemaVersion: 1;
  bookId: string;
  id: string;
  expected: MapReference;
  input: MapInput;
  selectedId: string | null;
  coordinates: MapCoordinateDraft | null;
  scale: MapScaleDraft | null;
  drawingId: string | null;
}
export interface MapCreationIntent {
  schemaVersion: 1;
  bookId: string;
  id: string;
  input: MapInput;
}
export function referenceForMap(value: unknown): MapReference;
export function fieldsForMap(value: unknown): MapInput;
export function parseMapLocalDraft(
  raw: string,
  bookId: string,
  id: string,
): MapLocalDraft;
export function parseMapCreationIntent(
  raw: string,
  bookId: string,
): MapCreationIntent;
export function parseMapCoordinates(
  value: string,
  min?: number,
  max?: number,
): Array<{ x: number; y: number }>;
export function mapCoordinateText(value: MapElement): string;
export function applyMapCoordinates(
  input: MapInput,
  draft: MapCoordinateDraft | null,
): MapInput;
export function applyMapScale(
  input: MapInput,
  draft: MapScaleDraft | null,
): MapInput;
