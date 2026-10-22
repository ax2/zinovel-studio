/**
 * Shared visual/export order: unassigned chapters, then each stable volume.
 * @template {{id:string,title:string,volumeId?:string|null,deletedAt?:string}} T
 * @param {{chapters:T[],volumes?:Array<{id:string}>}} book
 * @returns {T[]}
 */
export function orderedChapters(book, { includeDeleted = false } = {}) {
  const order = new Map(
    (book.volumes || []).map((volume, index) => [volume.id, index + 1]),
  );
  return book.chapters
    .filter((chapter) => includeDeleted || !chapter.deletedAt)
    .map((chapter, index) => ({
      chapter,
      index,
      rank: order.get(chapter.volumeId) || 0,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.chapter);
}
