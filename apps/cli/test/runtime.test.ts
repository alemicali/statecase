import { GitLfsContentUnavailable, WorkspaceBaselineUnavailable } from "@statecase/workspace";
import { describe, expect, it } from "vitest";

import { exitCodeFor, selectedVault } from "../src/runtime.js";

describe("CLI error contract", () => {
  it("maps an unavailable Git baseline to the conflict/action-required exit code", () => {
    expect(exitCodeFor(new WorkspaceBaselineUnavailable("0".repeat(40), "approval-required"))).toBe(5);
    expect(exitCodeFor(new GitLfsContentUnavailable(["asset.bin"], "pointer"))).toBe(5);
    expect(new GitLfsContentUnavailable([], "checkout-filter").message).not.toContain(": :");
    expect(new GitLfsContentUnavailable(["a", "b", "c", "d"], "pointer").message).toContain("(+1 more)");
  });

  it("selects a vault backed only by the versioned keyring", () => {
    expect(selectedVault(
      { version: 1, apiUrl: "https://statecase.test", selectedVaultId: "vlt_keyring", mappings: [], workspaces: [], applied: {} },
      { version: 1, vaultKeys: {}, vaultKeyrings: { vlt_keyring: { currentEpoch: 2, keys: { 1: "old", 2: "current" } } } },
    )).toBe("vlt_keyring");
  });
});
