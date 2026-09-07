import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertTemporarySpace, createStagingDirectory } from "../src/disk-space.js";

describe("temporary disk-space preflight (PERF-002, PERF-003)", () => {
  it("accepts sufficient numeric or bigint filesystem capacity", async () => {
    await expect(assertTemporarySpace("/tmp", 100, 2, {
      reserveBytes: 50,
      statfs: async () => ({ bavail: 25, bsize: 10 }),
    })).resolves.toBeUndefined();
    await expect(assertTemporarySpace("/tmp", 100, 2, {
      reserveBytes: 50,
      statfs: async () => ({ bavail: 25n, bsize: 10n }),
    })).resolves.toBeUndefined();
  });

  it("fails before staging when free capacity cannot hold copies plus reserve", async () => {
    await expect(assertTemporarySpace("/tmp", 100, 2, {
      reserveBytes: 51,
      statfs: async () => ({ bavail: 25, bsize: 10 }),
    })).rejects.toMatchObject({
      name: "InsufficientDiskSpace",
      requiredBytes: 251n,
      availableBytes: 250n,
    });
  });

  it.each([
    { payloadBytes: -1, copies: 1, reserveBytes: 0 },
    { payloadBytes: 1, copies: 0, reserveBytes: 0 },
    { payloadBytes: 1, copies: 1, reserveBytes: -1 },
    { payloadBytes: Number.MAX_SAFE_INTEGER + 1, copies: 1, reserveBytes: 0 },
  ])("rejects invalid sizing input: %o", async ({ payloadBytes, copies, reserveBytes }) => {
    await expect(assertTemporarySpace("/tmp", payloadBytes, copies, {
      reserveBytes,
      statfs: async () => ({ bavail: 1, bsize: 1 }),
    })).rejects.toThrow("safe non-negative integer");
  });

  it("recreates a missing temporary root before allocating a staging directory", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "statecase-disk-root-"));
    const missingRoot = join(fixture, "vanished-tmp");
    try {
      const staging = await createStagingDirectory(missingRoot, "download-", 100, 1, {
        reserveBytes: 0,
        statfs: async (path) => {
          await expect(access(path)).resolves.toBeUndefined();
          return { bavail: 100, bsize: 1 };
        },
      });
      await expect(access(staging)).resolves.toBeUndefined();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("removes the empty staging directory when its capacity preflight fails", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "statecase-disk-cleanup-"));
    try {
      await expect(createStagingDirectory(fixture, "merge-", 100, 1, {
        reserveBytes: 1,
        statfs: async () => ({ bavail: 100, bsize: 1 }),
      })).rejects.toBeInstanceOf(Error);
      await expect(readdir(fixture)).resolves.toEqual([]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
