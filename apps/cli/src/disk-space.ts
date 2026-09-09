import { mkdir, mkdtemp, rm, statfs as readStatfs } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_RESERVE_BYTES = 64 * 1024 * 1024;

interface FilesystemCapacity {
  bavail: number | bigint;
  bsize: number | bigint;
}

interface DiskSpaceOptions {
  reserveBytes?: number;
  statfs?: (path: string) => Promise<FilesystemCapacity>;
}

export class InsufficientDiskSpace extends Error {
  readonly requiredBytes: bigint;
  readonly availableBytes: bigint;

  constructor(requiredBytes: bigint, availableBytes: bigint) {
    super(`insufficient temporary disk space: ${requiredBytes} bytes required, ${availableBytes} bytes available`);
    this.name = "InsufficientDiskSpace";
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

/**
 * Reserves a safety floor before creating plaintext staging copies. This is a
 * preflight, not a filesystem reservation; ENOSPC handling and cleanup remain
 * mandatory because capacity can change after the check.
 */
export async function assertTemporarySpace(
  path: string,
  payloadBytes: number,
  copies = 1,
  options: DiskSpaceOptions = {},
): Promise<void> {
  const reserveBytes = options.reserveBytes ?? DEFAULT_RESERVE_BYTES;
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 ||
      !Number.isSafeInteger(copies) || copies <= 0 ||
      !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new RangeError("disk-space sizes must be safe non-negative integers and copies must be positive");
  }
  const filesystem = await (options.statfs ?? readStatfs)(path);
  const availableBytes = BigInt(filesystem.bavail) * BigInt(filesystem.bsize);
  const requiredBytes = BigInt(payloadBytes) * BigInt(copies) + BigInt(reserveBytes);
  if (availableBytes < requiredBytes) throw new InsufficientDiskSpace(requiredBytes, availableBytes);
}

/**
 * Creates the private empty directory before checking capacity. Some remote
 * filesystems discard an empty TMPDIR after its last child is removed, so the
 * preflight must target the newly materialized child rather than its parent.
 */
export async function createStagingDirectory(
  basePath: string,
  prefix: string,
  payloadBytes: number,
  copies = 1,
  options: DiskSpaceOptions = {},
): Promise<string> {
  await mkdir(basePath, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(basePath, prefix));
  try {
    await assertTemporarySpace(root, payloadBytes, copies, options);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
