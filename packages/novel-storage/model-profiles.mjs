import { mkdir, lstat, readFile, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { decodeUtf8 } from "./encoding.mjs";
import { atomicWriteText } from "./atomic.mjs";
import { acquireVaultWriteLock } from "./vault-lock.mjs";
import {
  modelServiceURL,
  modelCredentialPlan,
} from "../novel-domain/model-service.mjs";
import { validateSettings } from "../novel-harness/runtime.mjs";
import {
  imageGenerationBudget as imageBudget,
  imageAdapterOptions,
} from "../novel-domain/image-generation.mjs";

const LIMIT = 2 * 1024 * 1024,
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const protocols = {
  "anthropic-text": { capability: "text", runnable: true },
  "openai-images": { capability: "image", runnable: true },
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => structuredClone(value);
const ownKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
function label(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("模型配置名称无效或过长");
  return value.trim().normalize("NFC");
}
function configuration(input) {
  if (!Object.hasOwn(protocols, input.protocol))
    throw new Error("模型协议不支持");
  if (
    typeof input.baseURL !== "string" ||
    !input.baseURL.trim() ||
    typeof input.model !== "string" ||
    !input.model
  )
    throw new Error("请明确填写模型服务地址和模型标识");
  if (
    (input.protocol === "anthropic-text" &&
      (input.imageBudget !== undefined || input.imageOptions !== undefined)) ||
    (input.protocol === "openai-images" && input.budget !== undefined)
  )
    throw new Error("文字和图像预算不能混用");
  const text = validateSettings({
    baseURL: input.baseURL,
    model: input.model,
    budget: input.protocol === "anthropic-text" ? input.budget : undefined,
  });
  if (input.protocol === "anthropic-text") return { ...text };
  return {
    baseURL: text.baseURL,
    model: text.model,
    imageBudget: imageBudget(input.imageBudget),
    ...(input.imageOptions !== undefined
      ? { imageOptions: imageAdapterOptions(input.imageOptions) }
      : {}),
  };
}
function profileRecord(input) {
  if (
    !ownKeys(input, [
      "id",
      "label",
      "protocol",
      "baseURL",
      "model",
      "budget",
      "imageBudget",
      "imageOptions",
      "encryptedKey",
      "credentialScope",
    ]) ||
    !uuid.test(input.id) ||
    typeof input.encryptedKey !== "string" ||
    input.encryptedKey.length > 131072
  )
    throw new Error("模型配置记录无效");
  const scope = input.credentialScope;
  if (
    !ownKeys(scope, ["profileId", "protocol", "service"]) ||
    scope.profileId !== input.id ||
    scope.protocol !== input.protocol ||
    typeof scope.service !== "string"
  )
    throw new Error("模型凭据绑定记录无效");
  return {
    id: input.id,
    label: label(input.label),
    protocol: input.protocol,
    ...configuration(input),
    encryptedKey: input.encryptedKey,
    credentialScope: {
      profileId: input.id,
      protocol: input.protocol,
      service: modelServiceURL(scope.service),
    },
  };
}
function documentRecord(input) {
  if (
    !ownKeys(input, [
      "format",
      "schemaVersion",
      "storeId",
      "revision",
      "updatedAt",
      "routes",
      "profiles",
    ]) ||
    input.format !== "zinovel-model-profiles" ||
    input.schemaVersion !== 1 ||
    !uuid.test(input.storeId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    typeof input.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.updatedAt)) ||
    !ownKeys(input.routes, ["text", "image"]) ||
    !Object.hasOwn(input.routes, "text") ||
    !Object.hasOwn(input.routes, "image") ||
    !Array.isArray(input.profiles) ||
    input.profiles.length > 20
  )
    throw new Error("模型配置文件格式或版本不支持");
  const profiles = input.profiles.map(profileRecord),
    ids = new Set(),
    names = new Set();
  for (const profile of profiles) {
    const name = profile.label.toLowerCase();
    if (ids.has(profile.id) || names.has(name))
      throw new Error("模型配置身份或名称重复");
    ids.add(profile.id);
    names.add(name);
  }
  for (const capability of ["text", "image"]) {
    const id = input.routes[capability];
    if (
      id !== null &&
      (!uuid.test(id) ||
        !profiles.some(
          (profile) =>
            profile.id === id &&
            protocols[profile.protocol].capability === capability,
        ))
    )
      throw new Error("当前模型选择与能力不匹配");
  }
  return {
    format: "zinovel-model-profiles",
    schemaVersion: 1,
    storeId: input.storeId,
    revision: input.revision,
    updatedAt: input.updatedAt,
    routes: { ...input.routes },
    profiles,
  };
}
function expectedRecord(expected) {
  if (
    !ownKeys(expected, ["revision", "diskHash"]) ||
    !Number.isSafeInteger(expected.revision) ||
    expected.revision < 1 ||
    typeof expected.diskHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(expected.diskHash)
  )
    throw new Error("请重新读取模型配置后保存");
}
function publicProfile(profile) {
  const spec = protocols[profile.protocol],
    mismatch =
      !!profile.encryptedKey &&
      profile.credentialScope.service !== profile.baseURL;
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    capability: spec.capability,
    runnable:
      spec.runnable && (spec.capability === "text" || !!profile.imageOptions),
    baseURL: profile.baseURL,
    model: profile.model,
    ...(profile.protocol === "anthropic-text"
      ? { budget: clone(profile.budget) }
      : {
          imageBudget: clone(profile.imageBudget),
          imageOptions: clone(profile.imageOptions ?? null),
        }),
    hasKey: !!profile.encryptedKey && !mismatch,
    credentialMismatch: mismatch,
  };
}

/** App-global profiles, separate from book data. Crypto functions are supplied by the desktop OS adapter. */
export class ModelProfiles {
  #queue = Promise.resolve();
  constructor(root, codec) {
    this.root = root;
    this.path = join(root, "model-profiles.json");
    this.codec = codec;
  }
  async #read() {
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT)
        throw new Error("invalid profile file");
      const bytes = await readFile(this.path);
      if (bytes.length > LIMIT) throw new Error("profile file grew");
      return {
        record: documentRecord(JSON.parse(decodeUtf8(bytes))),
        diskHash: digest(bytes),
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error("模型配置无法读取或版本不支持，原文件已保留");
    }
  }
  #view(state) {
    return state
      ? {
          initialized: true,
          storeId: state.record.storeId,
          revision: state.record.revision,
          diskHash: state.diskHash,
          routes: { ...state.record.routes },
          profiles: state.record.profiles.map(publicProfile),
        }
      : { initialized: false };
  }
  inspect() {
    return this.#read().then((state) => this.#view(state));
  }
  #locked(operation) {
    const next = this.#queue.then(async () => {
      if (process.platform !== "win32")
        throw new Error("模型配置写入暂仅支持Windows");
      await mkdir(this.root, { recursive: true });
      let lock;
      try {
        lock = acquireVaultWriteLock(
          join(this.root, ".model-profiles.lock"),
          JSON.stringify({ operation: randomUUID(), pid: process.pid }),
        );
      } catch {
        throw new Error("模型配置正在被占用或无法获得写入锁，原文件已保留");
      }
      let result,
        committed = false;
      try {
        result = await operation();
        committed = true;
        return result;
      } finally {
        try {
          lock.close();
        } catch (error) {
          if (committed) result.lockReleaseFailed = true;
          else throw error;
        }
      }
    });
    this.#queue = next.catch(() => {});
    return next;
  }
  #serialized(record) {
    const text = JSON.stringify(documentRecord(record), null, 2) + "\n";
    if (Buffer.byteLength(text) > LIMIT)
      throw new Error("模型配置总量超过2MiB，原文件已保留");
    return text;
  }
  async #createOnly(record, beforeCommit) {
    const temporary = join(this.root, `.model-profiles-${randomUUID()}.tmp`),
      text = this.#serialized(record);
    let committed = false,
      cleanupPending = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await beforeCommit?.(
        this.#view({ record: documentRecord(record), diskHash: digest(text) }),
      );
      await link(temporary, this.path);
      committed = true;
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") {
          if (committed) cleanupPending = true;
          else throw error;
        }
      });
    }
    return {
      ...this.#view({ record: documentRecord(record), diskHash: digest(text) }),
      ...(cleanupPending ? { cleanupPending: true } : {}),
    };
  }
  /** @param {any} legacy @param {{beforeCommit?: (view: any) => Promise<void>}} [options] */
  async initializeFromLegacy(legacy, { beforeCommit } = {}) {
    return this.#locked(async () => {
      if (await this.#read()) throw new Error("模型配置已经建立，未再次迁移");
      const config = validateSettings(legacy),
        encryptedKey = legacy.encryptedKey ?? "";
      if (typeof encryptedKey !== "string" || encryptedKey.length > 131072)
        throw new Error("旧模型凭据格式无效");
      const id = randomUUID(),
        profile = {
          id,
          label: "默认文字服务",
          protocol: "anthropic-text",
          ...config,
          encryptedKey,
          credentialScope: {
            profileId: id,
            protocol: "anthropic-text",
            service: modelServiceURL(legacy.credentialScope ?? config.baseURL),
          },
        };
      return this.#createOnly(
        {
          format: "zinovel-model-profiles",
          schemaVersion: 1,
          storeId: randomUUID(),
          revision: 1,
          updatedAt: new Date().toISOString(),
          routes: { text: id, image: null },
          profiles: [profile],
        },
        beforeCommit,
      );
    });
  }
  async #mutate(expected, operation) {
    expectedRecord(expected);
    return this.#locked(async () => {
      const state = await this.#read();
      if (
        !state ||
        state.record.revision !== expected.revision ||
        state.diskHash !== expected.diskHash
      )
        throw new Error("模型配置已变化，请刷新后重新操作");
      if (state.record.revision === Number.MAX_SAFE_INTEGER)
        throw new Error("模型配置版本已达上限");
      const record = clone(state.record);
      await operation(record);
      record.revision++;
      record.updatedAt = new Date().toISOString();
      const text = this.#serialized(record);
      const latest = await this.#read();
      if (!latest || latest.diskHash !== state.diskHash)
        throw new Error("模型配置被外部修改，未覆盖原文件");
      await atomicWriteText(this.path, text);
      return this.#view({
        record: documentRecord(record),
        diskHash: digest(text),
      });
    });
  }
  async #encodedKey(previous, input, service) {
    const plan = modelCredentialPlan(
      previous?.credentialScope.service ?? service,
      service,
      input,
    );
    if (plan.action === "clear") return "";
    if (plan.action === "keep") return previous?.encryptedKey || "";
    if (!this.codec.available())
      throw new Error("系统安全存储不可用，未保存模型密钥");
    const encoded = await this.codec.encode(input.apiKey.trim());
    if (typeof encoded !== "string" || !encoded || encoded.length > 131072)
      throw new Error("系统加密返回格式无效");
    return encoded;
  }
  add(input, expected) {
    return this.#mutate(expected, async (record) => {
      if (
        !ownKeys(input, [
          "label",
          "protocol",
          "baseURL",
          "model",
          "budget",
          "imageBudget",
          "imageOptions",
          "apiKey",
          "clearKey",
        ])
      )
        throw new Error("模型配置输入字段不支持");
      if (record.profiles.length >= 20)
        throw new Error("模型配置数量已达20个上限");
      const config = configuration(input),
        id = randomUUID();
      record.profiles.push({
        id,
        label: label(input.label),
        protocol: input.protocol,
        ...config,
        encryptedKey: await this.#encodedKey(null, input, config.baseURL),
        credentialScope: {
          profileId: id,
          protocol: input.protocol,
          service: config.baseURL,
        },
      });
    });
  }
  update(id, input, expected) {
    return this.#mutate(expected, async (record) => {
      if (
        !ownKeys(input, [
          "label",
          "protocol",
          "baseURL",
          "model",
          "budget",
          "imageBudget",
          "imageOptions",
          "apiKey",
          "clearKey",
        ])
      )
        throw new Error("模型配置输入字段不支持");
      const index = record.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) throw new Error("模型配置不存在");
      const previous = record.profiles[index];
      if (input.protocol !== previous.protocol)
        throw new Error("更换能力类型请建立独立配置，不能复用原凭据");
      const config = configuration(input);
      record.profiles[index] = {
        id,
        label: label(input.label),
        protocol: previous.protocol,
        ...config,
        encryptedKey: await this.#encodedKey(previous, input, config.baseURL),
        credentialScope: {
          profileId: id,
          protocol: previous.protocol,
          service: config.baseURL,
        },
      };
    });
  }
  select(capability, id, expected) {
    return this.#mutate(expected, async (record) => {
      if (!["text", "image"].includes(capability))
        throw new Error("模型能力不支持");
      if (
        id !== null &&
        !record.profiles.some(
          (profile) =>
            profile.id === id &&
            protocols[profile.protocol].capability === capability,
        )
      )
        throw new Error("所选模型配置与能力不匹配");
      record.routes[capability] = id;
    });
  }
  remove(id, expected) {
    return this.#mutate(expected, async (record) => {
      if (Object.values(record.routes).includes(id))
        throw new Error("请先切换或取消选择，再删除模型配置");
      const index = record.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) throw new Error("模型配置不存在");
      record.profiles.splice(index, 1);
    });
  }
  async resolve(capability, expected, { secret = false } = {}) {
    if (!["text", "image"].includes(capability))
      throw new Error("模型能力不支持");
    const state = await this.#read();
    if (!state) throw new Error("尚未建立模型配置");
    expectedRecord(expected);
    if (
      state.record.revision !== expected.revision ||
      state.diskHash !== expected.diskHash
    )
      throw new Error("模型配置已变化，请刷新选择后再发送");
    const profile = state.record.profiles.find(
      (profile) => profile.id === state.record.routes[capability],
    );
    if (!profile) throw new Error("未选择该能力的模型服务");
    const view = publicProfile(profile);
    if (!view.runnable) throw new Error("图像响应模式尚未确认，未发送任何请求");
    if (view.credentialMismatch)
      throw new Error("模型服务与已存凭据不匹配，未使用旧密钥");
    const result = {
      profile: view,
      revision: state.record.revision,
      diskHash: state.diskHash,
    };
    if (!secret) return result;
    if (!profile.encryptedKey) throw new Error("请先为所选模型配置保存API Key");
    if (!this.codec.available())
      throw new Error("系统安全存储不可用，未读取模型密钥");
    try {
      const apiKey = await this.codec.decode(profile.encryptedKey);
      if (typeof apiKey !== "string" || !apiKey.trim())
        throw new Error("invalid key");
      return { ...result, apiKey };
    } catch {
      throw new Error("模型密钥无法解密，原配置已保留，请重新输入");
    }
  }
}
