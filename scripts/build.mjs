import { build } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";
await mkdir("dist/workbench", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["apps/desktop/main.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "dist/desktop/main.cjs",
    external: ["electron", "@deepseek-ai/dsh-sdk-client", "sharp"],
  }),
  build({
    entryPoints: ["apps/desktop/preload.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "dist/desktop/preload.cjs",
    external: ["electron"],
  }),
  build({
    entryPoints: ["apps/workbench/main.tsx"],
    bundle: true,
    platform: "browser",
    target: "chrome132",
    format: "esm",
    outfile: "dist/workbench/app.js",
    loader: { ".css": "css" },
  }),
]);
await copyFile("apps/workbench/index.html", "dist/workbench/index.html");
await cp("skills", "dist/resources/skills", { recursive: true });
await copyFile(
  "packages/novel-harness/novel.patch.yml",
  "dist/resources/novel.patch.yml",
);
await build({
  entryPoints: ["packages/novel-harness/tools-plugin.mjs"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/resources/tools-plugin.mjs",
});
console.log("Built desktop and writing workbench.");
