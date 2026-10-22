export interface Chapter { id: string; title: string; revision: number; hash: string; status: string; updatedAt: string; body: string; diskHash: string; externalChange?: boolean }
export interface Book { id: string; title: string; revision: number; chapters: Chapter[]; updatedAt: string }
declare global { interface Window { novel: { request<T = any>(action: string, payload?: object): Promise<T>; onClosing(listener: () => void): () => void } } }
export const api = <T = any>(action: string, payload?: object): Promise<T> => window.novel.request<T>(action, payload);
