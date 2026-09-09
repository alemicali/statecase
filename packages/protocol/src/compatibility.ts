import { z } from "zod";

export const CLIENT_CONTRACT_VERSION = 1;
export const CLIENT_CAPABILITIES = Object.freeze([
  "namespace-provenance-v1", "native-context-v1", "memory-references-v1", "local-write-guards-v1",
]);
export const CLIENT_HEADERS = Object.freeze({
  "x-statecase-client-contract": String(CLIENT_CONTRACT_VERSION),
  "x-statecase-capabilities": CLIENT_CAPABILITIES.join(","),
});
export const SERVICE_HEALTH = Object.freeze({
  protocolVersion: "1.1", legacyProtocolVersion: "1.0", service: "statecase", status: "ok",
  compatibility: Object.freeze({ minimumClientContract: 1, maximumClientContract: 1, requiredCapabilities: CLIENT_CAPABILITIES }),
});
const capabilityName = /^[a-z][a-z0-9-]{0,63}$/u;
const serviceSchema = z.object({
  protocolVersion: z.string().regex(/^1\.[1-9][0-9]{0,3}$/u), service: z.literal("statecase"), status: z.literal("ok"),
  compatibility: z.object({
    minimumClientContract: z.number().int().positive(), maximumClientContract: z.number().int().positive(),
    requiredCapabilities: z.array(z.string().regex(capabilityName)).max(32),
  }),
});

/** Compatibility declarations prevent accidental old-client access. They are
 * not authentication or attestation of a malicious client's implementation. */
export function acceptsClientContract(headers: Headers): boolean {
  if (headers.get("x-statecase-client-contract") !== CLIENT_HEADERS["x-statecase-client-contract"]) return false;
  const raw = headers.get("x-statecase-capabilities");
  if (!raw || raw.length > 2048) return false;
  const capabilities = raw.split(",").map((value) => value.trim());
  return capabilities.length <= 32 && new Set(capabilities).size === capabilities.length &&
    capabilities.every((value) => capabilityName.test(value)) && CLIENT_CAPABILITIES.every((value) => capabilities.includes(value));
}
export function acceptsServiceContract(value: unknown): boolean {
  const parsed = serviceSchema.safeParse(value);
  if (!parsed.success) return false;
  const contract = parsed.data.compatibility;
  return contract.minimumClientContract <= CLIENT_CONTRACT_VERSION && contract.maximumClientContract >= CLIENT_CONTRACT_VERSION &&
    new Set(contract.requiredCapabilities).size === contract.requiredCapabilities.length &&
    contract.requiredCapabilities.every((capability) => CLIENT_CAPABILITIES.includes(capability));
}
