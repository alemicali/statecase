import { describe, expect, it } from "vitest";

import { assertTemporarySpace } from "../src/disk-space.js";

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
});
