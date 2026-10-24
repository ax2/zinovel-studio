import type { AssetStoredRecord } from "./assets.mjs";

export interface MapPoint {
  x: number;
  y: number;
}
export interface MapScale {
  from: MapPoint;
  to: MapPoint;
  distance: number;
  unit: string;
}
interface MapElementBase {
  id: string;
  title: string;
  notes: string;
  deletedAt?: string;
}
export interface MapPlace extends MapElementBase {
  kind: "place";
  point: MapPoint;
  locationId: string | null;
}
export interface MapRegion extends MapElementBase {
  kind: "region";
  points: MapPoint[];
  locationId: string | null;
}
export interface MapRoute extends MapElementBase {
  kind: "route";
  fromId: string;
  toId: string;
  via: MapPoint[];
  travelNotes: string;
}
export type MapElement = MapPlace | MapRegion | MapRoute;
export interface MapInput {
  title: string;
  notes: string;
  era: string;
  canvas: { width: number; height: number };
  scale: MapScale | null;
  elements: MapElement[];
}
export interface MapBackground {
  record: AssetStoredRecord;
  diskHash: string;
}
export interface MapStoredRecord extends MapInput {
  schemaVersion: 1;
  id: string;
  bookId: string;
  revision: number;
  creationHash: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  background: MapBackground | null;
}
export interface MapRecord extends MapStoredRecord {
  diskHash: string;
}
export interface MapReference {
  id: string;
  revision: number;
  diskHash: string;
}
export interface MapSummary extends MapReference {
  title: string;
  era: string;
  updatedAt: string;
  deletedAt?: string;
  backgroundTitle: string | null;
  places: number;
  regions: number;
  routes: number;
}
export interface MapRouteGeometry {
  points: MapPoint[];
  distance: number | null;
  unit: string | null;
  state: "unscaled" | "author-scaled" | "retired" | "missing-endpoint";
}
export const mapLimits: Readonly<{
  elements: 1000;
  vertices: 128;
  bytes: 1048576;
}>;
export function mapId(value: unknown): string;
export function mapHash(value: unknown): string;
export function mapPoint(value: unknown): MapPoint;
export function mapPolygon(value: unknown): MapPoint[];
export function mapInput(value: unknown): MapInput;
export function mapDraftInput(value: unknown): MapInput;
export function mapBackground(
  value: unknown,
  origins: string[],
): MapBackground | null;
export function validateMapRecord(
  value: unknown,
  id: string,
  origins: string[],
): MapStoredRecord;
export function mapRouteGeometries(
  value: unknown,
): Array<MapRouteGeometry & { id: string }>;
export function mapRouteGeometry(value: unknown, id: string): MapRouteGeometry;
