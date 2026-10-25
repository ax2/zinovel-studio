import { safeStorage } from "electron";
import { readFile, lstat, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateSettings } from "../../packages/novel-harness/runtime.mjs";
import { atomicWriteText } from "../../packages/novel-storage/atomic.mjs";
import { decodeUtf8 } from "../../packages/novel-storage/encoding.mjs";
import { ModelProfiles } from "../../packages/novel-storage/model-profiles.mjs";
import {
  modelServiceURL,
  modelCredentialPlan,
} from "../../packages/novel-domain/model-service.mjs";

type Choice = { revision: number; diskHash: string };
type Input = {
  baseURL: string;
  model: string;
  apiKey?: string;
  clearKey?: boolean;
  budget?: Record<string, unknown>;
  profileId?: string;
  modelChoice?: Choice;
};
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const available = () =>
  safeStorage.isEncryptionAvailable() &&
  !(
    process.platform === "linux" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  );
const pointerFormat = "zinovel-model-profile-pointer";

export class ModelSettings {
  private queue: Promise<unknown> = Promise.resolve();
  private profiles: ModelProfiles;
  constructor(private root: string) {
    this.profiles = new ModelProfiles(root, {
      available,
      encode: (key: string) =>
        safeStorage.encryptString(key).toString("base64"),
      decode: (value: string) =>
        safeStorage.decryptString(Buffer.from(value, "base64")),
    });
  }
  private serial<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  private legacy(data: any) {
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      (data.schemaVersion !== undefined && data.schemaVersion !== 1) ||
      (data.schemaVersion === 1 &&
        (typeof data.credentialScope !== "string" || !data.credentialScope)) ||
      (data.encryptedKey !== undefined &&
        (typeof data.encryptedKey !== "string" ||
          data.encryptedKey.length > 131072))
    )
      throw new Error("旧模型设置格式不支持");
    const config = validateSettings(data);
    return {
      ...config,
      encryptedKey: data.encryptedKey || "",
      credentialScope:
        data.credentialScope === undefined
          ? config.baseURL
          : modelServiceURL(data.credentialScope),
    };
  }
  private async bytes(path: string) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      throw new Error("invalid settings file");
    const bytes = await readFile(path);
    if (bytes.length > 2 * 1024 * 1024) throw new Error("settings grew");
    return bytes;
  }
  private async snapshot(): Promise<any> {
    try {
      const bytes = await this.bytes(join(this.root, "model.json")),
        data = JSON.parse(decodeUtf8(bytes));
      if (data?.schemaVersion === 2 && data.format === pointerFormat) {
        if (
          typeof data.storeId !== "string" ||
          !/^[0-9a-f-]{36}$/.test(data.storeId) ||
          typeof data.legacyHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(data.legacyHash) ||
          data.legacyBackup !== ".model-legacy-" + data.legacyHash + ".json" ||
          Object.keys(data).some(
            (key) =>
              ![
                "format",
                "schemaVersion",
                "storeId",
                "legacyHash",
                "legacyBackup",
              ].includes(key),
          )
        )
          throw new Error("invalid model pointer");
        return {
          mode: "profiles",
          pointer: data,
          bytes,
          diskHash: hash(bytes),
        };
      }
      return {
        mode: "legacy",
        data: this.legacy(data),
        bytes,
        diskHash: hash(bytes),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          mode: "legacy",
          data: this.legacy({}),
          bytes: null,
          diskHash: "missing",
        };
      throw new Error("模型设置无法读取或版本不支持，原文件已保留");
    }
  }
  private legacyPublic(data: any) {
    return {
      ...validateSettings(data),
      hasKey: !!data.encryptedKey && data.credentialScope === data.baseURL,
      credentialMismatch:
        !!data.encryptedKey && data.credentialScope !== data.baseURL,
      encryptionAvailable: available(),
    };
  }
  private async state(): Promise<any> {
    const [snapshot, view] = await Promise.all([
      this.snapshot(),
      this.profiles.inspect(),
    ]);
    if (snapshot.mode === "legacy" && view.initialized)
      throw new Error("存在未激活的模型列表，未回退旧服务；原文件已保留");
    if (
      snapshot.mode === "profiles" &&
      view.initialized &&
      view.storeId !== snapshot.pointer.storeId
    )
      throw new Error("模型列表身份与激活记录不符，未使用任何服务");
    return { snapshot, view };
  }
  private modernPublic(view: any) {
    const profile = view.profiles?.find(
        (entry: any) => entry.id === view.routes?.text,
      ),
      empty = validateSettings({});
    return {
      baseURL: profile?.baseURL || "",
      model: profile?.model || "",
      budget: profile?.budget || empty.budget,
      hasKey: !!profile?.hasKey,
      credentialMismatch: !!profile?.credentialMismatch,
      encryptionAvailable: available(),
      profilesEnabled: true,
      profileId: profile?.id || null,
      profileLabel:
        profile?.label ||
        (view.initialized ? "未选择文字服务" : "模型列表缺失，需明确恢复"),
      modelChoice: view.initialized
        ? { revision: view.revision, diskHash: view.diskHash }
        : null,
      ...(view.lockReleaseFailed ? { lockReleaseFailed: true } : {}),
      ...(view.cleanupPending ? { cleanupPending: true } : {}),
    };
  }
  async public() {
    const { snapshot, view } = await this.state();
    return snapshot.mode === "profiles"
      ? this.modernPublic(view)
      : this.legacyPublic(snapshot.data);
  }
  async writing(choice: unknown, { secret = false } = {}): Promise<any> {
    const { snapshot, view } = await this.state();
    if (snapshot.mode === "legacy") {
      if (choice !== undefined)
        throw new Error("模型配置模式已改变，请刷新选择后再发送");
      const data = snapshot.data;
      if (data.encryptedKey && data.credentialScope !== data.baseURL)
        throw new Error(
          "模型服务地址与已保存凭据不匹配，未发送旧密钥；请重新输入或清除",
        );
      if (secret && data.encryptedKey && !available())
        throw new Error("系统安全存储不可用，未读取模型密钥");
      return {
        settings: validateSettings(data),
        ...(secret
          ? {
              apiKey: data.encryptedKey
                ? safeStorage.decryptString(
                    Buffer.from(data.encryptedKey, "base64"),
                  )
                : "",
            }
          : {}),
      };
    }
    if (!view.initialized)
      throw new Error("模型列表缺失，未回用旧服务；请明确恢复配置");
    const resolved = await this.profiles.resolve("text", choice, { secret }),
      profile = resolved.profile;
    if (!("budget" in profile)) throw new Error("当前配置不支持文字写作");
    return {
      settings: {
        baseURL: profile.baseURL,
        model: profile.model,
        budget: profile.budget,
        modelProfile: {
          id: profile.id,
          label: profile.label,
          revision: resolved.revision,
          protocol: profile.protocol,
        },
      },
      ...(secret && "apiKey" in resolved ? { apiKey: resolved.apiKey } : {}),
    };
  }
  secret(choice?: unknown) {
    return this.writing(choice, { secret: true });
  }
  async writingPublic(choice?: unknown) {
    return (await this.writing(choice)).settings;
  }
  async image(choice: unknown, { secret = false } = {}): Promise<any> {
    const { snapshot, view } = await this.state();
    if (snapshot.mode !== "profiles" || !view.initialized)
      throw new Error("请先建立并明确选择独立图像配置；未使用旧文字服务");
    return this.profiles.resolve("image", choice, { secret });
  }
  save(input: Input) {
    return this.serial(() => this.saveExclusive(input));
  }
  private async saveExclusive(input: Input) {
    const { snapshot, view } = await this.state();
    if (snapshot.mode === "profiles") {
      const profile = view.profiles?.find(
        (entry: any) => entry.id === view.routes?.text,
      );
      if (!profile || input.profileId !== profile.id)
        throw new Error("请明确选择当前文字配置后保存，未猜测其他配置");
      const saved = await this.profiles.update(
        profile.id,
        {
          label: profile.label,
          protocol: profile.protocol,
          baseURL: input.baseURL,
          model: input.model,
          budget: input.budget,
          apiKey: input.apiKey,
          clearKey: input.clearKey,
        },
        input.modelChoice,
      );
      return this.modernPublic(saved);
    }
    const config = validateSettings(input),
      existing = snapshot.data,
      plan = modelCredentialPlan(
        existing.credentialScope,
        config.baseURL,
        input,
      );
    let encryptedKey = existing.encryptedKey || "";
    if (plan.action === "clear") encryptedKey = "";
    if (plan.action === "replace") {
      if (!available()) throw new Error("系统安全存储不可用，未保存 API Key");
      encryptedKey = safeStorage
        .encryptString(input.apiKey!.trim())
        .toString("base64");
    }
    const data = {
      schemaVersion: 1,
      ...config,
      encryptedKey,
      credentialScope: plan.credentialScope,
    };
    await atomicWriteText(
      join(this.root, "model.json"),
      JSON.stringify(data, null, 2),
    );
    return this.legacyPublic(data);
  }
  private async backup(snapshot: any) {
    const bytes: Buffer =
        snapshot.bytes ||
        Buffer.from(
          JSON.stringify({ schemaVersion: 1, ...snapshot.data }, null, 2),
        ),
      legacyHash = hash(bytes),
      legacyBackup = ".model-legacy-" + legacyHash + ".json",
      path = join(this.root, legacyBackup),
      temporary = join(this.root, ".model-legacy-" + randomUUID() + ".tmp");
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (hash(await this.bytes(path)) !== legacyHash)
          throw new Error("迁移备份已存在但不匹配，原文件已保留");
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return { legacyHash, legacyBackup };
  }
  private async fromBackup(pointer: any) {
    try {
      const bytes = await this.bytes(join(this.root, pointer.legacyBackup));
      if (hash(bytes) !== pointer.legacyHash)
        throw new Error("backup checksum");
      return this.legacy(JSON.parse(decodeUtf8(bytes)));
    } catch {
      throw new Error("迁移前配置备份不可读或已改变，未自动回退旧服务");
    }
  }
  async profileList() {
    const { snapshot, view } = await this.state();
    if (view.initialized) return { ...view, encryptionAvailable: available() };
    const legacy =
      snapshot.mode === "profiles"
        ? await this.fromBackup(snapshot.pointer)
        : snapshot.data;
    return {
      initialized: false,
      recoveryNeeded: snapshot.mode === "profiles",
      legacy: {
        baseURL: legacy.baseURL,
        model: legacy.model,
        hasKey:
          !!legacy.encryptedKey && legacy.credentialScope === legacy.baseURL,
      },
      legacyToken: snapshot.diskHash,
      encryptionAvailable: available(),
    };
  }
  migrateProfiles(input: { legacyToken: string; restoreMissing?: boolean }) {
    return this.serial(async () => {
      const { snapshot, view } = await this.state();
      if (view.initialized) throw new Error("模型配置已建立，未再次迁移");
      if (snapshot.diskHash !== input.legacyToken)
        throw new Error("迁移前配置已变化，请刷新后重新确认");
      if ((snapshot.mode === "profiles") !== (input.restoreMissing === true))
        throw new Error("请明确确认迁移或恢复缺失列表");
      const legacy =
        snapshot.mode === "profiles"
          ? await this.fromBackup(snapshot.pointer)
          : snapshot.data;
      const backup =
        snapshot.mode === "profiles"
          ? {
              legacyHash: snapshot.pointer.legacyHash,
              legacyBackup: snapshot.pointer.legacyBackup,
            }
          : await this.backup(snapshot);
      const saved = await this.profiles.initializeFromLegacy(legacy, {
        beforeCommit: async (next) => {
          const current = await this.snapshot();
          if (current.diskHash !== snapshot.diskHash)
            throw new Error("迁移期间旧配置已变化，未覆盖原文件");
          await atomicWriteText(
            join(this.root, "model.json"),
            JSON.stringify(
              {
                format: pointerFormat,
                schemaVersion: 2,
                storeId: next.storeId,
                ...backup,
              },
              null,
              2,
            ),
          );
        },
      });
      return { ...saved, encryptionAvailable: available() };
    });
  }
  mutateProfiles(action: string, payload: any) {
    return this.serial(async () => {
      const { snapshot, view } = await this.state();
      if (snapshot.mode !== "profiles" || !view.initialized)
        throw new Error("请先明确建立或恢复模型配置");
      let result;
      if (action === "profiles.add")
        result = await this.profiles.add(payload.input, payload.expected);
      else if (action === "profiles.update")
        result = await this.profiles.update(
          payload.id,
          payload.input,
          payload.expected,
        );
      else if (action === "profiles.select")
        result = await this.profiles.select(
          payload.capability,
          payload.id,
          payload.expected,
        );
      else if (action === "profiles.remove")
        result = await this.profiles.remove(payload.id, payload.expected);
      else throw new Error("模型配置操作不支持");
      return { ...result, encryptionAvailable: available() };
    });
  }
}
