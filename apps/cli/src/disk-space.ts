import { statfs as readStatfs } from "node:fs/promises";

const DEFAULT_RESERVE_BYTES = 64 * 1024 * 1024;

interface FilesystemCapacity {
  bavail: number | bigint;
  bsize: number | bigint;
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
  options: {
    reserveBytes?: number;
    statfs?: (path: string) => Promise<FilesystemCapacity>;
  } = {},
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
