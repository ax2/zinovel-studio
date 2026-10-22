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
}
declare global {
  interface Window {
    novel: {
      request<T = any>(action: string, payload?: object): Promise<T>;
      onClosing(listener: () => void): () => void;
    };
  }
}
export const api = <T = any>(action: string, payload?: object): Promise<T> =>
  window.novel.request<T>(action, payload);
