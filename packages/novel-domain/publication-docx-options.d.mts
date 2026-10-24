import type { PublicationLayout } from "./publication-print-options.mjs";
export type PublicationDocxOptions = PublicationLayout<"Letter" | "A4" | "A5">;
export const defaultPublicationDocxOptions: Readonly<PublicationDocxOptions>;
export function publicationDocxOptions(
  input?: unknown,
): Readonly<PublicationDocxOptions>;
