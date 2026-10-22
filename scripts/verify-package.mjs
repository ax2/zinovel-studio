import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import assert from "node:assert/strict";
import originalFs from "original-fs";

const root = resolve(import.meta.dirname, "..");
const unpacked = join(root, "release/win-unpacked");
const app = join(unpacked, "resources/app.asar");
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
async function findDependency(packageDirectory, name) {
  let directory = packageDirectory;
  for (;;) {
    try {
      return JSON.parse(
        await readFile(
          join(directory, "node_modules", name, "package.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (directory === app) return null;
    const parent = dirname(directory);
    if (parent === directory || !parent.startsWith(app)) return null;
    directory = parent;
  }
}
async function inspect(directory, physical) {
  const readDirectory = physical ? originalFs.promises.readdir : readdir;
  const getStat = physical ? originalFs.promises.lstat : lstat;
  for (const entry of await readDirectory(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      stat = await getStat(path);
    assert.ok(
      !stat.isSymbolicLink(),
      `Packaged links may depend on a development machine: ${relative(unpacked, path)}`,
    );
    if (stat.isDirectory()) await inspect(path, physical);
    else {
      if (physical) {
        fileCount++;
        totalBytes += stat.size;
      }
      if (
        !physical &&
        entry.name === "package.json" &&
        path.includes(`${join("node_modules", "")}`)
      ) {
        const pkg = JSON.parse(await readFile(path, "utf8"));
        // Check actual package roots, not package.json fixtures within their tests.
        if (
          pkg.name &&
          path.endsWith(join("node_modules", pkg.name, "package.json"))
        ) {
          const required = { ...pkg.peerDependencies, ...pkg.dependencies };
          for (const name of Object.keys(required)) {
            if (
              pkg.optionalDependencies?.[name] ||
              (!pkg.dependencies?.[name] &&
                pkg.peerDependenciesMeta?.[name]?.optional)
            )
              continue;
            assert.ok(
              await findDependency(dirname(path), name),
              `Missing runtime dependency ${name} required by ${pkg.name}; must resolve inside the shipped app`,
            );
          }
        }
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
await inspect(unpacked, true);
await inspect(app, false);
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
