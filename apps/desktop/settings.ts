import { safeStorage } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSettings } from "../../packages/novel-harness/runtime.mjs";
import { atomicWriteText } from "../../packages/novel-storage/atomic.mjs";
import {
  modelServiceURL,
  modelCredentialPlan,
} from "../../packages/novel-domain/model-service.mjs";
export class ModelSettings {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private async read() {
    try {
      const data = JSON.parse(
        await readFile(join(this.root, "model.json"), "utf8"),
      );
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        (data.schemaVersion !== undefined && data.schemaVersion !== 1) ||
        (data.schemaVersion === 1 &&
          (typeof data.credentialScope !== "string" ||
            !data.credentialScope)) ||
        (data.encryptedKey !== undefined &&
          (typeof data.encryptedKey !== "string" ||
            data.encryptedKey.length > 131072))
      )
        throw new Error("模型设置格式不支持");
      const config = validateSettings(data);
      return {
        ...config,
        encryptedKey: data.encryptedKey || "",
        credentialScope:
          data.credentialScope === undefined
            ? config.baseURL
            : modelServiceURL(data.credentialScope),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          ...validateSettings({}),
          encryptedKey: "",
          credentialScope: modelServiceURL(undefined),
        };
      throw new Error("模型设置无法读取或版本不支持，原文件已保留");
    }
  }
  async public() {
    const data = await this.read(),
      { encryptedKey } = data;
    return {
      ...validateSettings(data),
      hasKey: !!encryptedKey && data.credentialScope === data.baseURL,
      credentialMismatch:
        !!encryptedKey && data.credentialScope !== data.baseURL,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }
  async secret() {
    const data = await this.read();
    if (data.encryptedKey && data.credentialScope !== data.baseURL)
      throw new Error(
        "模型服务地址与已保存凭据不匹配，未发送旧密钥；请重新输入或清除",
      );
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
    budget?: Record<string, unknown>;
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
    budget?: Record<string, unknown>;
  }) {
    const config = validateSettings(input),
      existing = await this.read(),
      plan = modelCredentialPlan(
        existing.credentialScope,
        config.baseURL,
        input,
      );
    let encryptedKey = existing.encryptedKey || "";
    if (plan.action === "clear") encryptedKey = "";
    if (plan.action === "replace") {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === "linux" &&
          safeStorage.getSelectedStorageBackend() === "basic_text")
      )
        throw new Error("系统安全存储不可用，未保存 API Key");
      encryptedKey = safeStorage
        .encryptString(input.apiKey!.trim())
        .toString("base64");
    }
    await atomicWriteText(
      join(this.root, "model.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          ...config,
          encryptedKey,
          credentialScope: plan.credentialScope,
        },
        null,
        2,
      ),
    );
    return this.public();
  }
}
