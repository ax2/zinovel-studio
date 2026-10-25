import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  WINDOWS_CREDENTIAL_PREFIX as prefix,
  windowsCredentialAvailable,
  protectWindowsCredential,
  unprotectWindowsCredential,
} from "../packages/novel-storage/windows-credentials.mjs";
import { createCredentialCodec } from "../packages/novel-storage/credential-codec.mjs";
const windows = { skip: process.platform !== "win32" };

test(
  "real CurrentUser DPAPI round trips Unicode, produces opaque self-contained ciphertext and needs no Electron preference store",
  windows,
  () => {
    assert.equal(windowsCredentialAvailable(), true);
    for (const value of [
      "synthetic-short-key",
      "synthetic-中文𠮷🌊-key",
      "a".repeat(16384),
    ]) {
      const encoded = protectWindowsCredential(value);
      assert.ok(encoded.startsWith(prefix));
      assert.ok(encoded.length < 131072);
      assert.equal(encoded.includes(value), false);
      assert.equal(unprotectWindowsCredential(encoded), value);
    }
  },
);

test(
  "a credential written then immediately terminated by a real process remains decryptable without Local State or a graceful exit",
  windows,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zinovel-dpapi-crash-")),
      file = join(root, "credential.txt");
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [resolve("tests/fixtures/credential-crash.mjs"), file],
        { windowsHide: true, timeout: 15000 },
      ),
      (error) => error.code === 91,
    );
    const encoded = await readFile(file, "utf8");
    assert.equal(
      unprotectWindowsCredential(encoded),
      "synthetic-dpapi-crash-key𠮷",
    );
    assert.deepEqual(await readdir(root), ["credential.txt"]);
  },
);

test(
  "unsupported envelope versions, malformed/truncated encodings and corrupted protected payload refuse without revealing a key",
  windows,
  () => {
    const key = "synthetic-private-key-should-not-be-logged",
      encoded = protectWindowsCredential(key),
      cipher = Buffer.from(encoded.slice(prefix.length), "base64");
    cipher[cipher.length - 1] ^= 255;
    for (const value of [
      encoded.replace(prefix, "win-dpapi-v2:"),
      prefix + "%%%%",
      prefix + "A".repeat(131072),
      prefix + cipher.toString("base64"),
      prefix + Buffer.from([1, 2, 3]).toString("base64"),
    ]) {
      assert.throws(
        () => unprotectWindowsCredential(value),
        (error) => !error.message.includes(key),
      );
    }
  },
);

test(
  "empty, control-bearing, overlong or malformed Unicode keys refuse before encryption",
  windows,
  () => {
    for (const value of [
      "",
      " ",
      "a".repeat(16385),
      "synthetic\u0000key",
      "synthetic\ud800key",
      "synthetic\nkey",
    ])
      assert.throws(() => protectWindowsCredential(value), /为空|过长|不支持/);
  },
);

test(
  "new Windows ciphertext never falls back to Electron on decode errors or version changes; valid legacy ciphertext uses only the legacy decoder",
  windows,
  () => {
    let decrypts = 0;
    const codec = createCredentialCodec({
      isEncryptionAvailable: () => true,
      encryptString() {
        throw new Error("Must not encrypt through Electron on Windows");
      },
      decryptString(bytes) {
        decrypts++;
        assert.equal(bytes.toString(), "v10-synthetic-fixture");
        return "synthetic-legacy-key";
      },
    });
    const encoded = codec.encode("synthetic-independent-key");
    assert.equal(codec.decode(encoded), "synthetic-independent-key");
    assert.equal(decrypts, 0);
    for (const bad of [
      prefix + "%%%%",
      "win-dpapi-v2:AAAA",
      "plaintext:not-a-cipher",
    ])
      assert.throws(() => codec.decode(bad));
    assert.equal(decrypts, 0);
    assert.equal(
      codec.decode(Buffer.from("v10-synthetic-fixture").toString("base64")),
      "synthetic-legacy-key",
    );
    assert.equal(decrypts, 1);
  },
);

test("Linux basic_text and unavailable backends cannot store or decode keys; Windows envelopes cannot cross into a different OS codec", () => {
  const storage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString() {
        throw new Error("Unexpected weak backend");
      },
      decryptString() {
        throw new Error("Unexpected weak backend");
      },
    },
    codec = createCredentialCodec(storage, "linux");
  assert.equal(codec.available(), false);
  assert.throws(() => codec.encode("synthetic-key"), /不可用/);
  assert.throws(() => codec.decode("YWJj"), /无法读取/);
  assert.throws(() => codec.decode(prefix + "AAAA"), /系统不支持/);
});
