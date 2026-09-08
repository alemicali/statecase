import { GitLfsContentUnavailable, WorkspaceBaselineUnavailable } from "@statecase/workspace";
import { describe, expect, it } from "vitest";

import { exitCodeFor, selectedVault } from "../src/runtime.js";
import { CredentialStorageError } from "../src/credentials.js";

describe("CLI error contract", () => {
  it("maps local credential failures to stable integrity, retry, conflict and unsupported exit codes (AU-013)", () => {
    for (const code of ["CREDENTIAL_STATE_CHANGED", "CREDENTIAL_STORE_LOCKED"] as const) expect(exitCodeFor(new CredentialStorageError(code))).toBe(5);
    for (const code of ["CREDENTIAL_STORE_UNAVAILABLE", "CREDENTIAL_COMMIT_FAILED"] as const) expect(exitCodeFor(new CredentialStorageError(code))).toBe(7);
    for (const code of ["CREDENTIAL_DOCUMENT_INVALID", "CREDENTIAL_DOCUMENT_UNSAFE", "CREDENTIAL_KEY_MISMATCH", "CREDENTIAL_INTEGRITY_FAILED"] as const) expect(exitCodeFor(new CredentialStorageError(code))).toBe(6);
    expect(exitCodeFor(new CredentialStorageError("CREDENTIAL_BACKEND_UNSUPPORTED"))).toBe(2);
  });

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
