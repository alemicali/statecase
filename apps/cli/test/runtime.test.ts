import { GitLfsContentUnavailable, WorkspaceBaselineUnavailable } from "@statecase/workspace";
import { describe, expect, it } from "vitest";

import { exitCodeFor } from "../src/runtime.js";

describe("CLI error contract", () => {
  it("maps an unavailable Git baseline to the conflict/action-required exit code", () => {
    expect(exitCodeFor(new WorkspaceBaselineUnavailable("0".repeat(40), "approval-required"))).toBe(5);
    expect(exitCodeFor(new GitLfsContentUnavailable(["asset.bin"], "pointer"))).toBe(5);
    expect(new GitLfsContentUnavailable([], "checkout-filter").message).not.toContain(": :");
    expect(new GitLfsContentUnavailable(["a", "b", "c", "d"], "pointer").message).toContain("(+1 more)");
  });
});
