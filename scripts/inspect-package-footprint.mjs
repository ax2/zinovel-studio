// Run with an archived app's embedded Electron Node to use its ASAR filesystem.
import { readdir, stat, readFile } from "node:fs/promises";
import originalFs from "original-fs";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";

const archive = resolve(process.argv[2]);
const pkg = JSON.parse(await readFile(join(archive, "package.json"), "utf8"));
const files = [],
  packages = new Map();
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) await walk(file);
    else {
      const bytes = (await stat(file)).size,
        path = relative(archive, file).replaceAll("\\", "/");
      files.push({ path, bytes });
      const match = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/.exec(path);
      if (match) packages.set(match[1], (packages.get(match[1]) || 0) + bytes);
    }
  }
}
await walk(archive);
console.log(
  JSON.stringify(
    {
      version: pkg.version,
      appAsarSha256: createHash("sha256")
        .update(await originalFs.promises.readFile(archive))
        .digest("hex"),
      files: files.length,
      totalLogicalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      largestFiles: files.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
      largestPackages: [...packages]
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20),
      scope:
        "Read-only logical ASAR resource sizes including unpacked entries; not actual disk allocation or runtime reachability proof",
    },
    null,
    2,
  ),
);
