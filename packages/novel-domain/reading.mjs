const uuid = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => key in value);
export const readingDefaults = {
  theme: "sepia",
  width: "desktop",
  fontSize: 20,
  lineHeight: 1.8,
};
export function parseReadingState(raw, bookId) {
  if (raw === null)
    return {
      schemaVersion: 1,
      bookId,
      preferences: { ...readingDefaults },
      progress: null,
    };
  if (typeof raw !== "string" || raw.length > 65536)
    throw new Error("本机阅读进度格式不支持，原记录已保留");
  const value = JSON.parse(raw),
    prefs = value?.preferences,
    progress = value?.progress;
  if (
    !exactKeys(value, ["schemaVersion", "bookId", "preferences", "progress"]) ||
    value.schemaVersion !== 1 ||
    value.bookId !== bookId ||
    !uuid(bookId) ||
    !exactKeys(prefs, ["theme", "width", "fontSize", "lineHeight"]) ||
    !["light", "dark", "sepia"].includes(prefs.theme) ||
    !["desktop", "phone"].includes(prefs.width) ||
    ![16, 18, 20, 24, 28, 32].includes(prefs.fontSize) ||
    ![1.5, 1.8, 2.1, 2.4].includes(prefs.lineHeight) ||
    (progress !== null &&
      (!exactKeys(progress, ["chapterId", "bodyHash", "paragraph"]) ||
        !uuid(progress.chapterId) ||
        typeof progress.bodyHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(progress.bodyHash) ||
        !Number.isSafeInteger(progress.paragraph) ||
        progress.paragraph < 0))
  )
    throw new Error("本机阅读进度格式不支持，原记录已保留");
  return value;
}
export function resumeReading(progress, chapter, paragraphCount) {
  if (!progress || progress.chapterId !== chapter.id)
    return { paragraph: 0, changed: false };
  if (progress.bodyHash !== chapter.bodyHash)
    return { paragraph: 0, changed: true };
  return {
    paragraph: Math.min(progress.paragraph, Math.max(0, paragraphCount - 1)),
    changed: false,
  };
}
