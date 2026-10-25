import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { PlanningSnapshot } from "./planning-types";

export function useSceneTree(bookId: string) {
  const [snapshot, setSnapshot] = useState<PlanningSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    let alive = true;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      const token = ++sequence.current;
      setLoading(true);
      try {
        const next = await api<PlanningSnapshot>("planning.read", { bookId });
        if (alive && token === sequence.current) {
          setSnapshot(next);
          setError("");
        }
      } catch (e) {
        if (alive && token === sequence.current) setError((e as Error).message);
      } finally {
        running = false;
        if (alive && token === sequence.current) setLoading(false);
        if (alive && again) {
          again = false;
          void read();
        }
      }
    };
    const changed = (event: Event) => {
      const target = (event as CustomEvent<{ bookId?: string }>).detail?.bookId;
      if (target && target !== bookId) return;
      clearTimeout(timer);
      // Ordinary manuscript keystrokes never emit this event or rescan scenes.
      timer = setTimeout(() => void read(), 120);
    };
    void read();
    window.addEventListener("novel-reference-options-changed", changed);
    window.addEventListener("novel-scene-planning-changed", changed);
    return () => {
      alive = false;
      sequence.current++;
      clearTimeout(timer);
      window.removeEventListener("novel-reference-options-changed", changed);
      window.removeEventListener("novel-scene-planning-changed", changed);
    };
  }, [bookId, refresh]);
  return {
    snapshot,
    error,
    loading,
    refresh: () => {
      setLoading(true);
      setRefresh((n) => n + 1);
    },
  };
}
