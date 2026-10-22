import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const unpacked = join(root, "release/win-unpacked");
const app = join(unpacked, "resources/app");
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bundled = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
assert.equal(bundled.version, source.version);
for (const name of ["dsh", "dsh-sdk-client"]) {
  const pkg = JSON.parse(
    await readFile(
      join(app, "node_modules/@deepseek-ai", name, "package.json"),
      "utf8",
    ),
  );
  assert.equal(pkg.version, source.dependencies[`@deepseek-ai/${name}`]);
}
for (const path of [
  "dist/desktop/main.cjs",
  "dist/desktop/preload.cjs",
  "dist/workbench/index.html",
  "dist/resources/novel.patch.yml",
  "dist/resources/tools-plugin.mjs",
  "dist/resources/skills/catalog.json",
  "LICENSE",
  "NOTICE",
  "apps/desktop/upstream/LICENSE",
])
  assert.ok(
    (await lstat(join(app, path))).isFile(),
    `Missing packaged file: ${path}`,
  );
assert.deepEqual((await readdir(join(app, "dist"))).sort(), [
  "desktop",
  "resources",
  "workbench",
]);
const packages = [];
let fileCount = 0,
  totalBytes = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      stat = await lstat(path);
    assert.ok(
      !stat.isSymbolicLink(),
      `Packaged links may depend on a development machine: ${relative(unpacked, path)}`,
    );
    if (stat.isDirectory()) await inspect(path);
    else {
      fileCount++;
      totalBytes += stat.size;
      if (
        entry.name === "package.json" &&
        path.includes(`${join("node_modules", "")}`)
      ) {
        const pkg = JSON.parse(await readFile(path, "utf8"));
        if (pkg.name && pkg.version)
          packages.push({
            name: pkg.name,
            version: pkg.version,
            license: pkg.license || "not-declared",
            path: relative(unpacked, path).replaceAll("\\", "/"),
          });
      }
    }
  }
}
await inspect(unpacked);
assert.ok(
  !packages.some((pkg) =>
    ["electron-builder", "playwright", "typescript"].includes(pkg.name),
  ),
  "Development tools leaked into the production payload",
);
const inventory = {
  version: source.version,
  fileCount,
  totalBytes,
  packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
};
await writeFile(
  join(root, "release/runtime-inventory.json"),
  JSON.stringify(inventory, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    version: source.version,
    fileCount,
    totalBytes,
    packageEntries: packages.length,
    status: "passed",
  }),
);
