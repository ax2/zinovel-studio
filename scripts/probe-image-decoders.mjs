import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

// Research probe only. Production code must declare its own direct dependency.
const root = resolve(import.meta.dirname, "..");
const candidates = (await readdir(join(root, "node_modules/.pnpm"))).filter(
  (name) => name.startsWith("sharp@0.35.5_"),
);
assert.equal(candidates.length, 1);
const sharpRoot = join(
  root,
  "node_modules/.pnpm",
  candidates[0],
  "node_modules/sharp",
);
const sharp = createRequire(join(sharpRoot, "package.json"))(sharpRoot);
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "image-decoders-"));
const source = {
  create: { width: 64, height: 32, channels: 3, background: "#126b83" },
};
const fixtures = {
  "plain.png": await sharp(source).png().toBuffer(),
  "oriented.jpg": await sharp(source)
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer(),
  "plain.webp": await sharp(source).webp().toBuffer(),
};
fixtures["truncated.png"] = fixtures["plain.png"].subarray(0, 40);
fixtures["corrupt-pixels.png"] = Buffer.from(fixtures["plain.png"]);
const pixelChunk = fixtures["corrupt-pixels.png"].indexOf(Buffer.from("IDAT"));
assert.ok(pixelChunk > 0);
fixtures["corrupt-pixels.png"][pixelChunk + 5] ^= 0xff;
for (const [name, bytes] of Object.entries(fixtures))
  await writeFile(join(work, name), bytes);
const runner = join(work, "probe.cjs");
await writeFile(
  runner,
  `const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.ZINOVEL_IMAGE_PROBE_DATA);app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL('about:blank');});`,
);
const env = {
  ...process.env,
  ZINOVEL_IMAGE_PROBE_DATA: join(work, "browser-data"),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  status: "running",
  scope:
    "Synthetic decoder research only; no novel asset feature, renderer preview or installed-app qualification",
  runtime: {},
  native: [],
  sharp: [],
  errors: [],
};
let app, owned;
const output = join(root, "assessments/stage-007/image-decoder-probe.json");
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [runner],
    cwd: root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  report.runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node,
  }));
  report.native = await app.evaluate(
    ({ nativeImage }, files) => {
      return files.map(({ name, bytes }) => {
        const image = nativeImage.createFromBuffer(Buffer.from(bytes));
        return {
          name,
          empty: image.isEmpty(),
          size: image.getSize(),
        };
      });
    },
    Object.entries(fixtures).map(([name, bytes]) => ({
      name,
      bytes: Array.from(bytes),
    })),
  );
  for (const [name, bytes] of Object.entries(fixtures)) {
    const entry = { name };
    try {
      const metadata = await sharp(bytes, {
        failOn: "warning",
        limitInputPixels: 40000000,
        limitInputChannels: 4,
      }).metadata();
      entry.metadata = {
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        orientation: metadata.orientation,
        autoOrient: metadata.autoOrient,
      };
      const decoded = await sharp(bytes, {
        failOn: "warning",
        limitInputPixels: 40000000,
        limitInputChannels: 4,
      })
        .autoOrient()
        .resize({
          width: 32,
          height: 32,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer({ resolveWithObject: true });
      entry.preview = {
        width: decoded.info.width,
        height: decoded.info.height,
        bytes: decoded.data.length,
      };
    } catch (error) {
      entry.rejected = String(error.message);
    }
    report.sharp.push(entry);
  }
  assert.equal(report.native.find((x) => x.name === "plain.png").empty, false);
  assert.equal(
    report.sharp.find((x) => x.name === "plain.webp").preview.width,
    32,
  );
  assert.deepEqual(
    report.sharp.find((x) => x.name === "oriented.jpg").metadata.autoOrient,
    { width: 32, height: 64 },
  );
  assert.deepEqual(
    report.sharp.find((x) => x.name === "oriented.jpg").preview,
    {
      width: 16,
      height: 32,
      bytes: report.sharp.find((x) => x.name === "oriented.jpg").preview.bytes,
    },
  );
  assert.ok(report.sharp.find((x) => x.name === "truncated.png").rejected);
  const corruptPixels = report.sharp.find(
    (x) => x.name === "corrupt-pixels.png",
  );
  assert.equal(corruptPixels.metadata.width, 64);
  assert.ok(corruptPixels.rejected);
  for (const [name, bytes] of Object.entries(fixtures))
    assert.deepEqual(await readFile(join(work, name)), bytes);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error.stack || error));
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else {
        await app.close();
        await confirmOwnedProcessesExited(owned);
      }
    } else await app?.close();
  } catch (error) {
    report.status = "failed";
    report.errors.push(String(error));
    throw error;
  } finally {
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(report);
  }
}
