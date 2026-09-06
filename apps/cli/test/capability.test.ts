import { describe, expect, it } from "vitest";

import { randomKey } from "@statecase/crypto";

import { createBootstrapCapability, openBootstrapCapability } from "../src/capability.js";

describe("ephemeral bootstrap capability (AU-003..AU-007)", () => {
  it("wraps only explicitly authorized namespace keys and opens them with the one-time secret", async () => {
    const rootKey = await randomKey();
    const expiresAt = Date.now() + 60_000;
    const created = await createBootstrapCapability({
      vaultId: "vlt_test",
      vaultKey: rootKey,
      namespaces: ["workspace:ws_01", "harness:codex:default"],
      actions: ["read", "append"],
      expiresAt,
    });

    expect(created.bootstrapToken).toMatch(/^stc_boot_[A-Za-z0-9_-]{43}$/u);
    expect(created.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.keyEnvelope).not.toContain("workspace:ws_01");
    expect(created.keyEnvelope).not.toContain(Buffer.from(rootKey).toString("base64url"));

    const opened = await openBootstrapCapability({
      bootstrapToken: created.bootstrapToken,
      keyEnvelope: created.keyEnvelope,
      vaultId: "vlt_test",
      namespaces: ["workspace:ws_01", "harness:codex:default"],
      actions: ["read", "append"],
      expiresAt,
    });
    expect(Object.keys(opened.namespaceKeys)).toEqual(["harness:codex:default", "workspace:ws_01"]);
    expect(opened).not.toHaveProperty("vaultKey");
    expect(opened.expiresAt).toBe(expiresAt);
  });

  it("rejects a wrong secret, response scope escalation, and secret namespaces", async () => {
    const rootKey = await randomKey();
    const input = { vaultId: "vlt_test", vaultKey: rootKey, namespaces: ["workspace:ws_01"], actions: ["read" as const], expiresAt: Date.now() + 60_000 };
    const created = await createBootstrapCapability(input);
    await expect(openBootstrapCapability({
      bootstrapToken: `stc_boot_${"a".repeat(43)}`,
      keyEnvelope: created.keyEnvelope,
      vaultId: input.vaultId,
      namespaces: input.namespaces,
      actions: input.actions,
      expiresAt: input.expiresAt,
    })).rejects.toThrow();
    await expect(openBootstrapCapability({
      bootstrapToken: created.bootstrapToken,
      keyEnvelope: created.keyEnvelope,
      vaultId: input.vaultId,
      namespaces: [...input.namespaces, "drop:private"],
      actions: input.actions,
      expiresAt: input.expiresAt,
    })).rejects.toThrow("does not match");
    await expect(createBootstrapCapability({ ...input, namespaces: ["secrets"] })).rejects.toThrow("secrets");
    await expect(createBootstrapCapability({ ...input, namespaces: [] })).rejects.toThrow("unique and non-empty");
    await expect(createBootstrapCapability({ ...input, namespaces: ["drop:a", "drop:a"] })).rejects.toThrow("unique and non-empty");
    await expect(createBootstrapCapability({ ...input, actions: [] })).rejects.toThrow("unique and non-empty");
    await expect(createBootstrapCapability({ ...input, actions: ["read", "read"] })).rejects.toThrow("unique and non-empty");
    await expect(createBootstrapCapability({ ...input, actions: ["append"] })).rejects.toThrow("include read");
    await expect(openBootstrapCapability({
      bootstrapToken: "invalid",
      keyEnvelope: created.keyEnvelope,
      vaultId: input.vaultId,
      namespaces: input.namespaces,
      actions: input.actions,
      expiresAt: input.expiresAt,
    })).rejects.toThrow("invalid bootstrap token");
    await expect(openBootstrapCapability({
      bootstrapToken: created.bootstrapToken,
      keyEnvelope: created.keyEnvelope,
      vaultId: input.vaultId,
      namespaces: input.namespaces,
      actions: ["read", "append"],
      expiresAt: input.expiresAt,
    })).rejects.toThrow("does not match");
    await expect(openBootstrapCapability({
      bootstrapToken: created.bootstrapToken,
      keyEnvelope: created.keyEnvelope,
      vaultId: input.vaultId,
      namespaces: input.namespaces,
      actions: input.actions,
      expiresAt: input.expiresAt + 1,
    })).rejects.toThrow("does not match");
  });
});
