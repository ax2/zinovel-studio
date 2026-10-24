import { realpath } from "node:fs/promises";
import { basename, dirname, relative, sep, isAbsolute, join } from "node:path";

/** Resolve existing ancestors too, so a prospective child cannot conceal a Junction. */
export async function canonicalDestination(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}
export function withinDirectory(root, path) {
  const inside = relative(root, path);
  return (
    !inside ||
    (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep))
  );
}
