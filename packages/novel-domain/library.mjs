/** Search/sort never mutates the authoritative library list. */
export function selectBooks(
  books,
  {
    query = "",
    genre = "",
    series = "",
    archived = "active",
    sort = "recent",
  } = {},
) {
  const search = query.trim().toLocaleLowerCase("zh-CN");
  return books
    .filter(
      (book) =>
        (!search ||
          `${book.title}\n${book.author || ""}`
            .toLocaleLowerCase("zh-CN")
            .includes(search)) &&
        (!genre || book.genre === genre) &&
        (!series || book.series === series) &&
        (archived === "all" ||
          (archived === "archived" ? !!book.archivedAt : !book.archivedAt)),
    )
    .sort(
      (a, b) =>
        (sort === "title"
          ? a.title.localeCompare(b.title, "zh-CN")
          : b.updatedAt.localeCompare(a.updatedAt)) || a.id.localeCompare(b.id),
    );
}
