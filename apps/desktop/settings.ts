import { safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSettings } from '../../packages/novel-harness/runtime.mjs';
export class ModelSettings {
  constructor(private root: string) {}
  private async read() {
    try { return JSON.parse(await readFile(join(this.root, 'model.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...validateSettings({}), encryptedKey: '' }; throw error; }
  }
  async public() { const { encryptedKey, ...value } = await this.read(); return { ...value, hasKey: !!encryptedKey, encryptionAvailable: safeStorage.isEncryptionAvailable() }; }
  async secret() {
    const data = await this.read();
    return { settings: validateSettings(data), apiKey: data.encryptedKey ? safeStorage.decryptString(Buffer.from(data.encryptedKey, 'base64')) : '' };
  }
  async save(input: { baseURL: string; model: string; apiKey?: string; clearKey?: boolean }) {
    const config = validateSettings(input), existing = await this.read();
    let encryptedKey = existing.encryptedKey || '';
    if (input.clearKey) encryptedKey = '';
    if (input.apiKey?.trim()) {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用，未保存 API Key');
      encryptedKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
    }
    await mkdir(this.root, {recursive:true});
    await writeFile(join(this.root, 'model.json'), JSON.stringify({ ...config, encryptedKey }, null, 2), { encoding:'utf8', mode:0o600 });
    return this.public();
  }
}
