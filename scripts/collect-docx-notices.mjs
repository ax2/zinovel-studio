import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, ".."),
  destination = join(root, "licenses/docx-runtime");
await mkdir(destination, { recursive: true });
const queue = [
    { name: "docx", require: createRequire(join(root, "package.json")) },
  ],
  seen = new Set(),
  components = [],
  files = {};
while (queue.length) {
  const item = queue.shift();
  if (item.name.startsWith("@types/")) continue;
  let entry;
  try {
    entry = item.require.resolve(`${item.name}/package.json`);
  } catch (error) {
    if (
      error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
      error.code !== "MODULE_NOT_FOUND"
    )
      throw error;
    entry = item.require.resolve(item.name);
  }
  let directory = dirname(entry),
    pkg;
  for (;;) {
    try {
      const candidate = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (candidate.name === item.name) {
        pkg = candidate;
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Package root missing: ${item.name}`);
    directory = parent;
  }
  const identity = `${pkg.name}@${pkg.version}`;
  if (seen.has(identity)) continue;
  seen.add(identity);
  const notices = (await readdir(directory)).filter((name) =>
    /^(licen[sc]e|notice|copying)(?:[.-].*)?$/i.test(name),
  );
  if (!notices.length) {
    const readme = (await readdir(directory)).find((name) =>
      /^readme(?:\.md)?$/i.test(name),
    );
    if (readme) {
      const content = await readFile(join(directory, readme), "utf8");
      if (
        /copyright/i.test(content) &&
        /permission is hereby granted|permission to use, copy, modify/i.test(
          content,
        )
      )
        notices.push(readme);
    }
  }
  if (!notices.length) throw new Error(`Licence text missing: ${identity}`);
  const retained = [];
  for (const name of notices) {
    const bytes = await readFile(join(directory, name)),
      hash = createHash("sha256").update(bytes).digest("hex");
    const output = `${identity.replace(/[^a-z0-9._-]/gi, "_")}-${name}`;
    try {
      if (!bytes.equals(await readFile(join(destination, output))))
        throw new Error(`Existing notice changed: ${output}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(join(destination, output), bytes, { flag: "wx" });
    }
    files[output] = hash;
    retained.push(output);
  }
  components.push({
    name: pkg.name,
    version: pkg.version,
    declaredLicense: pkg.license || "not-declared",
    notices: retained,
  });
  const request = createRequire(join(directory, "package.json"));
  for (const name of Object.keys(pkg.dependencies || {}))
    queue.push({ name, require: request });
}
await writeFile(
  join(destination, "provenance.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      entry: "docx@9.14.0",
      scope:
        "Full declared runtime dependency closure of the bundled DOCX producer; type-only packages omitted; retained text and metadata are not a complete distribution certification",
      components: components.sort((a, b) => a.name.localeCompare(b.name)),
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log({
  components: components.length,
  notices: Object.keys(files).length,
});
