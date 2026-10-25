export type PlannedScene = {
  id: string;
  title: string;
  state: string;
  fields?: Record<string, string>;
};
export type PlanningColumn = {
  id: string | null;
  title: string;
  state: string;
  volume?: string;
  scenes: PlannedScene[];
};
export type PlanningSnapshot = {
  revision: number;
  diskHash: string | null;
  errorCount: number;
  columns: PlanningColumn[];
};
