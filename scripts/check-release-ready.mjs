import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
export function releaseReadiness(root) {
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const present = (file) => {
    if (typeof file !== "string" || !file || isAbsolute(file)) return false;
    const path = resolve(root, file),
      within = relative(root, path);
    return !within.startsWith("..") && !isAbsolute(within) && existsSync(path);
  };
  const evidence = (files) =>
    Array.isArray(files) && files.length > 0 && files.every(present);
  const { version } = read("package.json");
  if (/^\d+\.\d+\.\d+-(alpha|beta|rc)\.\d+$/.test(version)) {
    const gate = read("plan/preview-readiness.json"),
      errors = [];
    if (
      gate.schemaVersion !== 1 ||
      gate.version !== version ||
      gate.ready !== true
    )
      errors.push("预览资格尚未对应当前版本");
    if (
      !evidence(gate.evidence) ||
      !present(`iterations/releases/v${version}.md`)
    )
      errors.push("缺少阶段验收或版本说明");
    if (
      !evidence(gate.reports) ||
      !gate.reports.every((file) => read(file).status === "passed")
    )
      errors.push("阶段运行报告缺失或未通过");
    if (!Array.isArray(gate.limitations) || !gate.limitations.length)
      errors.push("预览版必须明确未完成范围");
    return { allowed: errors.length === 0, channel: "preview", errors };
  }
  if (!/^\d+\.\d+\.\d+$/.test(version))
    return {
      allowed: false,
      channel: "unknown",
      errors: ["不支持的发行版本格式"],
    };
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
          evidence(check.evidence),
      ),
  );
  if (
    gate.schemaVersion !== 1 ||
    gate.ready !== true ||
    missing.length ||
    !Array.isArray(features) ||
    !features.length ||
    features.some((feature) => feature.status !== "verified")
  ) {
    missing.push("完整功能与上架验收未通过");
  }
  return { allowed: !missing.length, channel: "stable", errors: missing };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = releaseReadiness(resolve(import.meta.dirname, ".."));
    if (!result.allowed) {
      console.error("发行资格检查未通过：", result.errors.join("；"));
      process.exitCode = 1;
    } else
      console.log(
        `${result.channel} 阶段资格齐备；仍须通过本标签构建、安装、运行及升级验证，才允许发布安装包。`,
      );
  } catch (error) {
    console.error("发行资格材料无法读取：", error.message);
    process.exitCode = 1;
  }
}
