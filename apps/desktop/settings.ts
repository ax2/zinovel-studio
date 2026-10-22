import { safeStorage } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSettings } from "../../packages/novel-harness/runtime.mjs";
import { atomicWriteText } from "../../packages/novel-storage/atomic.mjs";
export class ModelSettings {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private async read() {
    try {
      return JSON.parse(await readFile(join(this.root, "model.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...validateSettings({}), encryptedKey: "" };
      throw error;
    }
  }
  async public() {
    const data = await this.read(),
      { encryptedKey } = data;
    return {
      ...validateSettings(data),
      hasKey: !!encryptedKey,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }
  async secret() {
    const data = await this.read();
    return {
      settings: validateSettings(data),
      apiKey: data.encryptedKey
        ? safeStorage.decryptString(Buffer.from(data.encryptedKey, "base64"))
        : "",
    };
  }
  save(input: {
    baseURL: string;
    model: string;
    apiKey?: string;
    clearKey?: boolean;
    budget?: Record<string, number>;
  }) {
    const operation = this.queue.then(() => this.saveExclusive(input));
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async saveExclusive(input: {
    baseURL: string;
    model: string;
    apiKey?: string;
    clearKey?: boolean;
    budget?: Record<string, number>;
  }) {
    if (
      input.apiKey !== undefined &&
      (typeof input.apiKey !== "string" || input.apiKey.length > 16384)
    )
      throw new Error("API Key 格式无效或过长");
    const config = validateSettings(input),
      existing = await this.read();
    let encryptedKey = existing.encryptedKey || "";
    if (input.clearKey) encryptedKey = "";
    if (input.apiKey?.trim()) {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === "linux" &&
          safeStorage.getSelectedStorageBackend() === "basic_text")
      )
        throw new Error("系统安全存储不可用，未保存 API Key");
      encryptedKey = safeStorage
        .encryptString(input.apiKey.trim())
        .toString("base64");
    }
    await atomicWriteText(
      join(this.root, "model.json"),
      JSON.stringify({ ...config, encryptedKey }, null, 2),
    );
    return this.public();
  }
}
