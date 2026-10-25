import koffi from "koffi";
import { join, isAbsolute } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

export const WINDOWS_CREDENTIAL_PREFIX = "win-dpapi-v1:";
const MAX_ENCODED = 131072,
  MAX_PLAIN = 65536;
let native;
function bindings() {
  if (process.platform !== "win32")
    throw new Error("当前平台不支持Windows用户凭据封装");
  if (!native) {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    if (!isAbsolute(systemRoot)) throw new Error("Windows系统目录无法核对");
    const crypt = koffi.load(join(systemRoot, "System32", "Crypt32.dll")),
      kernel = koffi.load(join(systemRoot, "System32", "Kernel32.dll"));
    koffi.struct("ZiNovelCredentialDataBlobV1", {
      cbData: "uint32_t",
      pbData: "void *",
    });
    native = {
      protect: crypt.func(
        "int __stdcall CryptProtectData(const ZiNovelCredentialDataBlobV1 *input, str16 description, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ ZiNovelCredentialDataBlobV1 *output)",
      ),
      unprotect: crypt.func(
        "int __stdcall CryptUnprotectData(const ZiNovelCredentialDataBlobV1 *input, void *description, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ ZiNovelCredentialDataBlobV1 *output)",
      ),
      free: kernel.func("void * __stdcall LocalFree(void *memory)"),
    };
  }
  return native;
}
export function windowsCredentialAvailable() {
  try {
    bindings();
    return true;
  } catch {
    return false;
  }
}
const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
function secret(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !value.isWellFormed() ||
    value.length > 16384 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new Error("模型Key为空、过长或包含不支持的字符");
  return value;
}
function transform(input, decrypt, consume) {
  const output = { cbData: 0, pbData: null };
  let api,
    allocated = false,
    view;
  try {
    api = bindings();
    // CRYPTPROTECT_UI_FORBIDDEN only. Never use machine scope or prompt UI.
    const ok = (decrypt ? api.unprotect : api.protect)(
      { cbData: input.length, pbData: input },
      null,
      null,
      null,
      null,
      1,
      output,
    );
    if (!ok) throw new Error("Windows用户凭据处理未完成，原配置已保留");
    allocated = !!output.pbData;
    if (
      !allocated ||
      !Number.isSafeInteger(output.cbData) ||
      output.cbData < 1 ||
      output.cbData > (decrypt ? MAX_PLAIN : MAX_ENCODED)
    )
      throw new Error("Windows用户凭据返回大小无效");
    // Electron forbids external ArrayBuffer views. Copy via Koffi's decoder.
    const decoded = koffi.decode(output.pbData, "uint8_t", output.cbData);
    view = Buffer.from(decoded);
    decoded.fill(0);
    return consume(view);
  } finally {
    input.fill(0);
    view?.fill(0);
    if (allocated) {
      try {
        if (view)
          koffi.encode(
            output.pbData,
            "uint8_t",
            Buffer.alloc(output.cbData),
            output.cbData,
          );
      } finally {
        api.free(output.pbData);
      }
    }
  }
}
/** Self-contained CurrentUser DPAPI envelope; no Chromium Local State key is needed. */
export function protectWindowsCredential(value) {
  const key = secret(value),
    plain = Buffer.from(
      JSON.stringify({
        format: "zinovel-user-credential",
        schemaVersion: 1,
        secret: key,
        digest: digest(key),
      }),
      "utf8",
    );
  if (plain.length > MAX_PLAIN) {
    plain.fill(0);
    throw new Error("模型Key封装超限");
  }
  return transform(plain, false, (cipher) => {
    const wrapped = WINDOWS_CREDENTIAL_PREFIX + cipher.toString("base64");
    if (wrapped.length > MAX_ENCODED) throw new Error("模型Key密文超限");
    return wrapped;
  });
}
export function unprotectWindowsCredential(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith(WINDOWS_CREDENTIAL_PREFIX) ||
    value.length > MAX_ENCODED
  )
    throw new Error("Windows凭据格式或版本不支持，原密文已保留");
  const encoded = value.slice(WINDOWS_CREDENTIAL_PREFIX.length);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error("Windows凭据编码无效，原密文已保留");
  const cipher = Buffer.from(encoded, "base64");
  if (cipher.toString("base64") !== encoded) {
    cipher.fill(0);
    throw new Error("Windows凭据编码无效，原密文已保留");
  }
  return transform(cipher, true, (plain) => {
    try {
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plain),
      );
      if (
        !data ||
        Object.keys(data).sort().join(",") !==
          "digest,format,schemaVersion,secret" ||
        data.format !== "zinovel-user-credential" ||
        data.schemaVersion !== 1 ||
        typeof data.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.digest) ||
        !timingSafeEqual(
          Buffer.from(data.digest, "hex"),
          Buffer.from(digest(secret(data.secret)), "hex"),
        )
      )
        throw new Error("Invalid envelope");
      return data.secret;
    } catch {
      throw new Error("Windows凭据内容校验失败，原密文已保留");
    }
  });
}
