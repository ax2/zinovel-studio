import {
  WINDOWS_CREDENTIAL_PREFIX,
  windowsCredentialAvailable,
  protectWindowsCredential,
  unprotectWindowsCredential,
} from "./windows-credentials.mjs";

/** New Windows writes use self-contained CurrentUser DPAPI; existing Electron ciphertext stays readable. */
export function createCredentialCodec(
  safeStorage,
  platform = process.platform,
) {
  const legacyAvailable = () => {
    try {
      return (
        safeStorage.isEncryptionAvailable() &&
        !(
          platform === "linux" &&
          safeStorage.getSelectedStorageBackend() === "basic_text"
        )
      );
    } catch {
      return false;
    }
  };
  return {
    available() {
      return platform === "win32"
        ? windowsCredentialAvailable()
        : legacyAvailable();
    },
    encode(key) {
      if (platform === "win32") return protectWindowsCredential(key);
      if (!legacyAvailable())
        throw new Error("系统安全存储不可用，未保存模型Key");
      return safeStorage.encryptString(key).toString("base64");
    },
    decode(value) {
      if (typeof value !== "string" || !value || value.length > 131072)
        throw new Error("模型凭据格式无效，原密文已保留");
      if (value.startsWith("win-dpapi-")) {
        if (
          platform !== "win32" ||
          !value.startsWith(WINDOWS_CREDENTIAL_PREFIX)
        )
          throw new Error("模型凭据版本或系统不支持，原密文已保留");
        return unprotectWindowsCredential(value);
      }
      if (
        !legacyAvailable() ||
        value.length % 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
      )
        throw new Error("旧模型凭据无法读取，原密文已保留");
      const bytes = Buffer.from(value, "base64");
      try {
        if (bytes.toString("base64") !== value)
          throw new Error("Invalid encoding");
        return safeStorage.decryptString(bytes);
      } catch {
        throw new Error("旧模型凭据无法解密，原密文已保留；请重新输入Key");
      } finally {
        bytes.fill(0);
      }
    },
  };
}
