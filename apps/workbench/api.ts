export interface Chapter {
  id: string;
  title: string;
  revision: number;
  hash: string;
  status: string;
  updatedAt: string;
  body: string;
  diskHash: string;
  externalChange?: boolean;
  volumeId?: string | null;
  deletedAt?: string;
}
export interface Book {
  id: string;
  title: string;
  revision: number;
  chapters: Chapter[];
  updatedAt: string;
  volumes?: { id: string; title: string }[];
  genre?: string;
  series?: string;
  author?: string;
  archivedAt?: string;
}
declare global {
  interface Window {
    novel: {
      request<T = any>(action: string, payload?: object): Promise<T>;
      onClosing(listener: () => void): () => void;
    };
  }
}
const referenceMutations = new Set([
  "materials.save",
  "materials.delete",
  "materials.evidence",
  "knowledge.save",
  "knowledge.retire",
  "knowledge.link-legacy",
  "knowledge.choose",
  "knowledge.clear-choice",
  "ai.materialAccept",
  "book.structure",
]);
export const api = async <T = any>(
  action: string,
  payload?: object,
): Promise<T> => {
  const result = await window.novel.request<T>(action, payload);
  if (referenceMutations.has(action)) {
    const bookId =
      payload && "bookId" in payload && typeof payload.bookId === "string"
        ? payload.bookId
        : undefined;
    window.dispatchEvent(
      new CustomEvent("novel-reference-options-changed", {
        detail: { bookId },
      }),
    );
  }
  return result;
};
