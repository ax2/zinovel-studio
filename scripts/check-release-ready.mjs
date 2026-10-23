import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const gate = JSON.parse(
  readFileSync(resolve(root, "plan/release-readiness.json"), "utf8"),
);
const required = [
  "complete-product",
  "real-model-literary-workflow",
  "runtime-recovery-and-migration",
  "accessibility-and-performance",
  "publishing-formats-and-targets",
  "distribution-and-licenses",
];
const features = JSON.parse(
  readFileSync(resolve(root, "plan/features.json"), "utf8"),
).features;
const missing = required.filter(
  (id) =>
    !gate.checks?.some(
      (check) =>
        check.id === id &&
        check.verified === true &&
        check.evidence?.length &&
        check.evidence.every(
          (file) =>
            typeof file === "string" &&
            !file.includes("..") &&
            existsSync(resolve(root, file)),
        ),
    ),
);
if (
  gate.schemaVersion !== 1 ||
  gate.ready !== true ||
  missing.length ||
  features.some((feature) => feature.status !== "verified")
) {
  console.error(
    "公开发行被产品资格门禁阻止：完整需求和上架验收尚未通过。",
    missing.join(", "),
  );
  process.exitCode = 1;
} else console.log("产品资格材料齐备；继续执行本标签的独立构建与安装验证。");
