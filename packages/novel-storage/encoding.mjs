import { readFile } from "node:fs/promises";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Canonical text is UTF-8. Preserve a real BOM and reject undecodable bytes. */
export async function readUtf8File(path) {
  const bytes = await readFile(path);
  return decodeUtf8(bytes);
}
export function decodeUtf8(bytes) {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    if (error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
    const invalid = new Error("文件 UTF-8 编码无法读取，原文件已保留", {
      cause: error,
    });
    invalid.code = error.code;
    throw invalid;
  }
}
