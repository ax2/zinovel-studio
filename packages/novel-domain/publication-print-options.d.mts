export interface PublicationLayout<Paper extends string> {
  paper: Paper;
  font: "serif" | "sans";
  size: number;
  leading: number;
  margin: "standard" | "wide";
  keepParagraphs: "balanced" | "flow";
}
export function normalizePublicationLayout<Paper extends string>(
  input: unknown,
  specification: { label: string; paper: Paper; papers: readonly Paper[] },
): Readonly<PublicationLayout<Paper>>;
