import { assetId, assetHash, validateAssetBlob } from "./assets.mjs";

export const imageEditProtocol = "openai-images-edits";
export function imageTaskReference(value) {
  const exact = (object, fields) => {
    if (
      !object ||
      typeof object !== "object" ||
      Array.isArray(object) ||
      Object.keys(object).some((key) => !fields.includes(key))
    )
      throw new Error("图像参考记录字段不支持，原记录已保留");
  };
  exact(value, ["algorithm", "asset", "sourceBlob", "derivative"]);
  exact(value.asset, ["id", "revision", "diskHash"]);
  if (
    value.algorithm !== "reference-png-v1" ||
    !Number.isSafeInteger(value.asset.revision) ||
    value.asset.revision < 1
  )
    throw new Error("图像参考版本无效");
  const derivative = validateAssetBlob(value.derivative);
  if (
    derivative.format !== "png" ||
    derivative.orientation !== 1 ||
    derivative.width > 1536 ||
    derivative.height > 1536 ||
    derivative.bytes > 4 * 1024 * 1024
  )
    throw new Error("参考衍生图必须为1536边/4MiB以内的正向PNG");
  return {
    algorithm: value.algorithm,
    asset: {
      id: assetId(value.asset.id),
      revision: value.asset.revision,
      diskHash: assetHash(value.asset.diskHash),
    },
    sourceBlob: validateAssetBlob(value.sourceBlob),
    derivative,
  };
}
