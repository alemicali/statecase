import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { decryptEnvelope, deriveRecoveryKey, encryptEnvelope } from "@statecase/crypto";

interface RecoveryKitV1 {
  version: 1;
  vaultId: string;
  salt: string;
  envelope: string;
}

export async function writeRecoveryKit(path: string, vaultId: string, vaultKey: Uint8Array, passphrase: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const salt = randomBytes(16);
  const recoveryKey = await deriveRecoveryKey(passphrase, salt);
  const envelope = await encryptEnvelope({
    plaintext: vaultKey,
    key: recoveryKey,
    dedupKey: recoveryKey,
    context: { vaultId, scopeId: "recovery-kit", compression: "none" },
  });
  const kit: RecoveryKitV1 = {
    version: 1,
    vaultId,
    salt: Buffer.from(salt).toString("base64url"),
    envelope: Buffer.from(envelope).toString("base64url"),
  };
  await writeFile(path, `${JSON.stringify(kit, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  recoveryKey.fill(0);
}

export async function readRecoveryKit(path: string, expectedVaultId: string, passphrase: string): Promise<Uint8Array> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RecoveryKitV1>;
  if (parsed.version !== 1 || parsed.vaultId !== expectedVaultId || !parsed.salt || !parsed.envelope) {
    throw new Error("recovery kit does not match the selected vault");
  }
  const recoveryKey = await deriveRecoveryKey(passphrase, Buffer.from(parsed.salt, "base64url"));
  try {
    return await decryptEnvelope({
      envelope: Buffer.from(parsed.envelope, "base64url"),
      key: recoveryKey,
      dedupKey: recoveryKey,
      expected: { vaultId: expectedVaultId, scopeId: "recovery-kit", compression: "none" },
    });
  } finally {
    recoveryKey.fill(0);
  }
}
