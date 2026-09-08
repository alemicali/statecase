import { describe, expect, it } from "vitest";
import { CLIENT_HEADERS, SERVICE_HEALTH, acceptsClientContract, acceptsServiceContract } from "../src/compatibility.js";
// @ts-expect-error Standalone Node UAT fixture intentionally uses an explicit golden contract.
import { contractHeaders } from "../../../scripts/uat/contract.mjs";

describe("required client/service contract negotiation (PR-014)", () => {
  it("accepts the current contract and ignores optional future fields/capabilities", () => {
    expect(acceptsClientContract(new Headers(CLIENT_HEADERS))).toBe(true);
    expect(contractHeaders).toEqual(CLIENT_HEADERS);
    expect(acceptsClientContract(new Headers({ ...CLIENT_HEADERS, "x-statecase-capabilities": CLIENT_HEADERS["x-statecase-capabilities"] + ",future-optional-v1" }))).toBe(true);
    expect(acceptsServiceContract(SERVICE_HEALTH)).toBe(true);
    expect(acceptsServiceContract({ ...SERVICE_HEALTH, protocolVersion: "1.9", optionalFutureField: true })).toBe(true);
  });
  it.each([null, "", "0", "01", "2", "1,1", "1.0", "x".repeat(4096)])("rejects missing or malformed client contract %j", (version) => {
    const headers = new Headers(CLIENT_HEADERS);
    if (version === null) headers.delete("x-statecase-client-contract"); else headers.set("x-statecase-client-contract", version);
    expect(acceptsClientContract(headers)).toBe(false);
  });
  it("requires each mandatory capability and bounds untrusted header data", () => {
    for (const capabilities of ["", "unknown-v1", CLIENT_HEADERS["x-statecase-capabilities"] + ",bad!", CLIENT_HEADERS["x-statecase-capabilities"] + ",memory-references-v1", "x".repeat(4096)]) {
      expect(acceptsClientContract(new Headers({ ...CLIENT_HEADERS, "x-statecase-capabilities": capabilities }))).toBe(false);
    }
    const missing = new Headers(CLIENT_HEADERS); missing.delete("x-statecase-capabilities");
    expect(acceptsClientContract(missing)).toBe(false);
    const caps = CLIENT_HEADERS["x-statecase-capabilities"].split(",");
    for (const omitted of caps) expect(acceptsClientContract(new Headers({ ...CLIENT_HEADERS,
      "x-statecase-capabilities": caps.filter((value) => value !== omitted).join(",") }))).toBe(false);
    expect(acceptsClientContract(new Headers({ ...CLIENT_HEADERS,
      "x-statecase-capabilities": [...caps, ...Array.from({ length: 29 }, (_, index) => `optional-${index}`)].join(",") }))).toBe(false);
    expect(acceptsClientContract(new Headers({ ...CLIENT_HEADERS, "x-statecase-capabilities": caps.join(", ") }))).toBe(true);
  });
  it("fails on legacy, malformed, unknown required capabilities and incompatible protocol generations", () => {
    for (const value of [null, {}, { ...SERVICE_HEALTH, protocolVersion: "2.0" }, { ...SERVICE_HEALTH, protocolVersion: "1.0" },
      { ...SERVICE_HEALTH, service: "unrelated" }, { ...SERVICE_HEALTH, compatibility: { ...SERVICE_HEALTH.compatibility, minimumClientContract: 2 } },
      { ...SERVICE_HEALTH, compatibility: { ...SERVICE_HEALTH.compatibility, maximumClientContract: 0 } },
      { ...SERVICE_HEALTH, compatibility: { ...SERVICE_HEALTH.compatibility, requiredCapabilities: ["memory-references-v1", "memory-references-v1"] } },
      { ...SERVICE_HEALTH, compatibility: { ...SERVICE_HEALTH.compatibility, requiredCapabilities: ["future-required-v1"] } }]) {
      expect(acceptsServiceContract(value)).toBe(false);
    }
  });
});
