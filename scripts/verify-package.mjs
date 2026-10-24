import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { join, resolve, relative, dirname, matchesGlob } from "node:path";
import assert from "node:assert/strict";
import originalFs from "original-fs";

const root = resolve(import.meta.dirname, "..");
const unpacked = join(root, "release/win-unpacked");
const app = join(unpacked, "resources/app.asar");
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const resourceExclusions = JSON.parse(
  await readFile(join(root, "plan/runtime-resource-exclusions.json"), "utf8"),
);
const bundled = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
assert.deepEqual(
  JSON.parse(
    await readFile(join(app, "plan/runtime-resource-exclusions.json"), "utf8"),
  ),
  resourceExclusions,
);
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
      if (!physical) {
        const packagedPath = relative(app, path).replaceAll("\\", "/");
        assert.ok(
          !resourceExclusions.patterns.some((pattern) =>
            matchesGlob(packagedPath, pattern),
          ),
          `Unused profile payload included: ${packagedPath}`,
        );
      }
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
const omittedPayloads = [
  "node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe",
  "node_modules/@deepseek-ai/libreoffice-kit-win32-x64/program/share/registry/main.xcd",
  "node_modules/@deepseek-ai/dsh-experimental-inspector/lib/devtools/entrypoints/lighthouse_worker/lighthouse_worker.js",
  "node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js",
  "node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.excel.js",
];
for (const path of omittedPayloads)
  await assert.rejects(
    lstat(join(app, path)),
    { code: "ENOENT" },
    `Unused payload included: ${path}`,
  );
const speechFiles = await readdir(
  join(app, "node_modules/sherpa-onnx-win-x64"),
);
assert.ok(
  !speechFiles.some((name) => /\.(dll|node)$/i.test(name)),
  "Unused voice native payload included",
);
for (const name of [
  "@deepseek-ai/libreoffice-kit-win32-x64",
  "sherpa-onnx-win-x64",
  "@deepseek-ai/dsh-experimental-inspector",
  "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
])
  assert.ok(
    packages.some((pkg) => pkg.name === name),
    `Retained manifest missing: ${name}`,
  );
const inventory = {
  version: source.version,
  fileCount,
  totalBytes,
  packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
  distributionProfile: resourceExclusions.profile,
  resourceExclusions: resourceExclusions.patterns,
  omittedPayloads,
  note: "Selected generic office/voice/inspector/browser payloads omitted; package metadata, code and notices retained. Dependency manifest presence does not assert every optional upstream resource is shipped.",
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
